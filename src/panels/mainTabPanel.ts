/**
 * mainTabPanel.ts — v0.5.0 Sprint 2 T2.1〜T2.15
 * claudeMain WebviewView Container — 3タブ完全実装
 *
 * タブ構成:
 *   0: セッション (sessions)
 *   1: エージェント (agents)  — T2.12〜T2.15: ブックマーク/最終使用/フィルタ/スコープ
 *   2: プロジェクト (projects) — T2.1〜T2.9: カード/詳細ペイン/進捗/メモリ/紐づけ
 *
 * アーキテクチャ:
 *   - WebviewViewProvider として登録
 *   - タブ切り替えは Webview 内 JS で管理
 *   - 各タブのデータ取得は postMessage でサービス層に委譲
 *   - TreeView providers はそのまま残す（後方互換）
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { t } from '../services/i18nService';
import { discoverProjects, registerProject, removeProject } from '../services/projectService';
import { computeProgress } from '../services/progressCalculator';
import {
	getBookmarks,
	toggleBookmark,
	getRecentlyUsed,
	relativeTime,
	getAllLastUsed,
} from '../services/bookmarkService';
import * as dataStore from '../models/dataStore';
import { loadMemoryFiles, loadGlobalMemoryFiles } from '../utils/memoryManager';
import { loadAllSessions } from '../utils/sessionLoader';
import { buildMiniOrgChartData } from './orgChartPanel';

// -------------------------------------------------------------------
// MainTabPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class MainTabPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'claudeMain';

	private _view?: vscode.WebviewView;
	private readonly _extensionUri: vscode.Uri;

	constructor(extensionUri: vscode.Uri) {
		this._extensionUri = extensionUri;
	}

	// ----------------------------------------------------------------
	// resolveWebviewView — VSCode が呼び出す
	// ----------------------------------------------------------------

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtml(webviewView.webview);

		// メッセージハンドラ
		webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			await this._handleMessage(message);
		});
	}

	// ----------------------------------------------------------------
	// 外部からビューを更新する（TreeView更新連動）
	// ----------------------------------------------------------------

	public postMessage(message: unknown): void {
		this._view?.webview.postMessage(message);
	}

	// ----------------------------------------------------------------
	// メッセージハンドラ
	// ----------------------------------------------------------------

	private async _handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this._sendInitialData();
				break;

			case 'tab-changed':
				if (message.payload?.tab === 'agents') {
					await this._sendAgentsData();
				} else if (message.payload?.tab === 'memory') {
					await this._sendMemoriesData();
				}
				break;

			// ---------- プロジェクトタブ (T2.1〜T2.9) ----------

			case 'refresh-projects':
				this._sendProjects();
				break;

			case 'getProjectTree':
				// TT3: ツリーモード用まとめデータ
				await this._sendProjectTree();
				break;

			case 'add-project': {
				// T2.9: フォルダ選択ダイアログ
				const folderUris = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					title: 'プロジェクトフォルダを選択',
				});
				if (folderUris && folderUris.length > 0) {
					registerProject(folderUris[0].fsPath);
					this._sendProjects();
				}
				break;
			}

			case 'remove-project':
				if (message.payload?.id) {
					removeProject(String(message.payload.id));
					this._sendProjects();
				}
				break;

			case 'open-project':
				// T2.8: VS Codeで開く
				if (message.payload?.path) {
					const uri = vscode.Uri.file(String(message.payload.path));
					await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
				}
				break;

			case 'open-memory-file':
				// TT4: メモリファイルをプレビュー表示
				if (message.payload?.filePath) {
					try {
						const uri = vscode.Uri.file(String(message.payload.filePath));
						await vscode.commands.executeCommand('vscode.open', uri, {
							preview: true,
							viewColumn: vscode.ViewColumn.Beside,
						});
					} catch {
						// ファイルが存在しない場合は無視
					}
				}
				break;

			case 'open-terminal':
				// T2.8: ターミナルで開く
				if (message.payload?.path) {
					const terminal = vscode.window.createTerminal({
						name: path.basename(String(message.payload.path)),
						cwd: String(message.payload.path),
					});
					terminal.show();
				}
				break;

			case 'select-project':
				// T2.2/T2.3: プロジェクト詳細を送信
				if (message.payload?.id) {
					await this._sendProjectDetail(String(message.payload.id));
				}
				break;

			case 'assign-agent': {
				// T2.4: エージェント割当
				const { projectId, agentName } = (message.payload ?? {}) as Record<string, string>;
				if (projectId && agentName) {
					await this._assignAgentToProject(projectId, agentName);
					await this._sendProjectDetail(projectId);
				}
				break;
			}

			case 'unassign-agent': {
				// T2.4: エージェント解除
				const { projectId: pid, agentName: an } = (message.payload ?? {}) as Record<string, string>;
				if (pid && an) {
					await this._unassignAgentFromProject(pid, an);
					await this._sendProjectDetail(pid);
				}
				break;
			}

			// ---------- セッションタブ ----------

			case 'new-session':
				await vscode.commands.executeCommand('claudeManager.newSession');
				break;

			case 'open-agent-session':
				if (message.payload?.agentName) {
					await vscode.commands.executeCommand(
						'claudeManager.openAgentSession',
						{ name: String(message.payload.agentName) }
					);
				}
				break;

			// ---------- エージェントタブ (T2.12〜T2.15) ----------

			case 'toggle-bookmark-agent':
				// T2.12: ブックマークトグル
				if (message.payload?.agentName) {
					const isNowBookmarked = toggleBookmark(String(message.payload.agentName));
					this._view?.webview.postMessage({
						type: 'bookmark-updated',
						agentName: message.payload.agentName,
						bookmarked: isNowBookmarked,
					});
					await this._sendAgentsData();
				}
				break;

			case 'refresh-agents':
				await this._sendAgentsData();
				break;

			case 'run-org-builder':
				// T3.13: エージェントタブの組織診断ボタン → orgBuilderService 呼び出し
				await vscode.commands.executeCommand('claudeManager.runOrgBuilder');
				break;

			// ---------- セッションタブ (TF1〜TF3) ----------

			case 'refresh-sessions':
				await this._sendSessionsData();
				break;

			case 'open-session':
				// セッションファイルをプレビューで開く
				if (message.payload?.filePath) {
					await vscode.commands.executeCommand(
						'claudeManager.previewSession',
						{ session: { filePath: String(message.payload.filePath), id: String(message.payload.id ?? '') } }
					);
				}
				break;

			case 'toggle-bookmark-session': {
				// セッションのブックマークトグル
				const sid = String(message.payload?.sessionId ?? '');
				if (sid) {
					const currentBookmarks = await dataStore.getBookmarks();
					if (currentBookmarks.includes(sid)) {
						await dataStore.removeBookmark(sid);
					} else {
						await dataStore.addBookmark(sid);
					}
					await this._sendSessionsData();
				}
				break;
			}

			// ---------- メモリタブ (TF5) ----------

			case 'refresh-memory':
				await this._sendMemoriesData();
				break;
		}
	}

	// ----------------------------------------------------------------
	// データ送信ヘルパー
	// ----------------------------------------------------------------

	private async _sendInitialData(): Promise<void> {
		this._sendProjects();
		await this._sendSessionsData();
		// エージェント・メモリタブはアクティブになったときに送信
	}

	private _sendProjects(): void {
		const projects = discoverProjects();
		this._view?.webview.postMessage({ type: 'projects-data', projects });
	}

	/** TT3: ツリーモード用まとめデータ送信 */
	private async _sendProjectTree(): Promise<void> {
		const projects = discoverProjects();
		const allAgentAssignments = this._loadProjectAgentsAll();
		const maxSessions = vscode.workspace
			.getConfiguration('claudeManager')
			.get<number>('maxSessionsShown', 500);
		const [allSessions, memoryGroups] = await Promise.all([
			loadAllSessions(maxSessions),
			loadMemoryFiles(),
		]);

		const trees = projects.map(p => {
			const agentNames = allAgentAssignments[p.id] ?? [];

			// セッション: project フィールドがプロジェクトパスに一致するもの（最大 20 件）
			const projectSessions = allSessions
				.filter(s => !s.isSidechain && s.project === p.path)
				.slice(0, 20)
				.map(s => ({
					id: s.id,
					filePath: s.filePath,
					title: s.customName ?? s.claudeTitle ?? s.firstMessage ?? s.id,
					lastTimestamp: s.lastTimestamp?.getTime() ?? 0,
				}));

			// メモリ: dir がプロジェクトパスに対応するグループ
			const memGroup = memoryGroups.find(g =>
				g.project === p.path || g.dir.startsWith(p.path + '/')
			);
			const memories = memGroup?.files.map(f => ({
				name: f.name,
				description: f.description ?? '',
				type: f.type ?? 'project',
				filePath: f.filePath ?? '',
			})) ?? [];

			return {
				projectId: p.id,
				name: p.name,
				path: p.path,
				isCurrent: p.isCurrent ?? false,
				agents: agentNames,
				sessions: projectSessions,
				memories,
			};
		});

		this._view?.webview.postMessage({ type: 'project-tree-data', trees });
	}

	private async _sendProjectDetail(projectId: string): Promise<void> {
		const projects = discoverProjects();
		const project = projects.find(p => p.id === projectId);
		if (!project) { return; }

		// 進捗データ (T2.7)
		const progress = computeProgress(project);

		// エージェント一覧 (T2.4)
		const allAgents = await dataStore.getAgents();

		// メモリファイル (T2.5)
		const memoryGroups = await loadMemoryFiles();
		const globalMemory = await loadGlobalMemoryFiles();

		// プロジェクト紐づけエージェント名一覧
		const assignedAgentNames = this._loadProjectAgents(projectId);

		// T2.21: ミニ組織図データ
		const miniOrgNodes = await buildMiniOrgChartData(assignedAgentNames);

		this._view?.webview.postMessage({
			type: 'project-detail',
			project,
			progress,
			allAgents: allAgents.map(a => ({
				name: a.name,
				displayName: a.displayName,
				role: a.role,
				model: a.model,
				scope: a.scope,
			})),
			assignedAgentNames,
			miniOrgNodes,
			memoryGroups: memoryGroups.map(g => ({
				project: g.project,
				files: g.files.map(f => ({ name: f.name, description: f.description, type: f.type })),
			})),
			globalMemoryFiles: globalMemory?.files.map(f => ({
				name: f.name,
				description: f.description,
				type: f.type,
			})) ?? [],
		});
	}

	private async _sendAgentsData(): Promise<void> {
		// T2.12〜T2.15
		const allAgents = await dataStore.getAgents();
		const bookmarks = getBookmarks();
		const recentNames = getRecentlyUsed(5);
		const lastUsedMap = getAllLastUsed();

		this._view?.webview.postMessage({
			type: 'agents-data',
			agents: allAgents.map(a => ({
				name: a.name,
				displayName: a.displayName,
				role: a.role,
				displayRole: a.displayRole,
				model: a.model,
				scope: a.scope ?? 'global',
				parentAgent: a.parentAgent,
				allowedTools: a.allowedTools ?? [],
				status: a.status ?? 'active',
				bookmarked: bookmarks.includes(a.name),
				lastUsed: lastUsedMap[a.name] ?? 0,
				lastUsedLabel: relativeTime(lastUsedMap[a.name] ?? 0),
			})),
			bookmarkedNames: bookmarks,
			recentNames,
		});
	}

	// ----------------------------------------------------------------
	// TF1〜TF3: セッションデータ送信
	// ----------------------------------------------------------------

	private async _sendSessionsData(): Promise<void> {
		const maxSessions = vscode.workspace.getConfiguration('claudeManager').get<number>('maxSessionsShown', 500);
		const allSessions = await loadAllSessions(maxSessions);
		const bookmarks = await dataStore.getBookmarks();
		const allTags = await dataStore.getAllTags();

		const bookmarkSet = new Set(bookmarks);
		// タグ逆引きマップ: sessionId → タグ名[]
		const tagsBySession = new Map<string, string[]>();
		for (const [tag, ids] of Object.entries(allTags)) {
			for (const id of ids) {
				const existing = tagsBySession.get(id) ?? [];
				existing.push(tag);
				tagsBySession.set(id, existing);
			}
		}

		// 親セッションのみ（isSidechain を除外）
		const parentSessions = allSessions.filter(s => !s.isSidechain);

		this._view?.webview.postMessage({
			type: 'sessions-data',
			sessions: parentSessions.map(s => ({
				id: s.id,
				filePath: s.filePath,
				title: s.customName ?? s.claudeTitle ?? s.firstMessage,
				project: s.project,
				lastTimestamp: s.lastTimestamp.getTime(),
				firstTimestamp: s.firstTimestamp.getTime(),
				fileSize: s.fileSize,
				model: s.model ?? '',
				gitBranch: s.gitBranch ?? '',
				bookmarked: bookmarkSet.has(s.id),
				tags: tagsBySession.get(s.id) ?? [],
			})),
			bookmarkIds: bookmarks,
			allTags,
		});
	}

	// ----------------------------------------------------------------
	// TF5: メモリデータ送信
	// ----------------------------------------------------------------

	private async _sendMemoriesData(): Promise<void> {
		const [memoryGroups, globalMemory] = await Promise.all([
			loadMemoryFiles(),
			loadGlobalMemoryFiles(),
		]);

		this._view?.webview.postMessage({
			type: 'memories-data',
			globalFiles: globalMemory?.files.map(f => ({
				name: f.name,
				description: f.description,
				type: f.type,
				filePath: f.filePath,
			})) ?? [],
			projectGroups: memoryGroups.map(g => ({
				project: g.project,
				dir: g.dir,
				files: g.files.map(f => ({
					name: f.name,
					description: f.description,
					type: f.type,
					filePath: f.filePath,
				})),
			})),
		});
	}

	// ----------------------------------------------------------------
	// プロジェクト↔エージェント紐づけ永続化
	// (T2.4: csm-project-agents.json に保存)
	// ----------------------------------------------------------------

	private _getProjectAgentsFile(): string {
		return path.join(os.homedir(), '.claude', 'csm-project-agents.json');
	}

	private _loadProjectAgentsAll(): Record<string, string[]> {
		const filePath = this._getProjectAgentsFile();
		try {
			const raw = require('fs').readFileSync(filePath, 'utf-8');
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === 'object') {
				return parsed as Record<string, string[]>;
			}
		} catch { /* ファイルなし or エラー */ }
		return {};
	}

	private _loadProjectAgents(projectId: string): string[] {
		return this._loadProjectAgentsAll()[projectId] ?? [];
	}

	private _saveProjectAgentsAll(data: Record<string, string[]>): void {
		const filePath = this._getProjectAgentsFile();
		try {
			require('fs').mkdirSync(path.dirname(filePath), { recursive: true });
			require('fs').writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf-8');
		} catch { /* 書き込み失敗は無視 */ }
	}

	private async _assignAgentToProject(projectId: string, agentName: string): Promise<void> {
		const all = this._loadProjectAgentsAll();
		const current = all[projectId] ?? [];
		if (!current.includes(agentName)) {
			const updated = { ...all, [projectId]: [...current, agentName] };
			this._saveProjectAgentsAll(updated);
		}
	}

	private async _unassignAgentFromProject(projectId: string, agentName: string): Promise<void> {
		const all = this._loadProjectAgentsAll();
		const current = all[projectId] ?? [];
		const updated = { ...all, [projectId]: current.filter(n => n !== agentName) };
		this._saveProjectAgentsAll(updated);
	}

	// ----------------------------------------------------------------
	// HTML生成
	// ----------------------------------------------------------------

	private _getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();

		const tabSessions = t('tabs.sessions');
		const tabAgents   = t('tabs.agents');
		const tabProjects = t('tabs.projects');
		const tabMemory   = t('tabs.memory') || 'メモリ';

		const homeDir = os.homedir().replace(/\\/g, '/');

		return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude Session Manager</title>
	<style nonce="${nonce}">
		*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		/* ---- タブバー ---- */
		.tab-bar {
			display: flex;
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		.tab-btn {
			flex: 1;
			padding: 6px 4px;
			background: transparent;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
			transition: color 0.1s;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tab-btn:hover { color: var(--vscode-foreground); }
		.tab-btn.active {
			color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
			border-bottom-color: var(--vscode-focusBorder, #007acc);
		}

		/* ---- タブコンテンツ ---- */
		.tab-content {
			flex: 1;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}
		.tab-pane {
			display: none;
			flex: 1;
			overflow-y: auto;
			padding: 8px;
			flex-direction: column;
			gap: 6px;
		}
		.tab-pane.active { display: flex; }

		/* ---- アクションボタン ---- */
		.action-bar {
			display: flex;
			gap: 4px;
			flex-shrink: 0;
		}
		.btn {
			flex: 1;
			padding: 4px 8px;
			background: var(--vscode-button-secondaryBackground, transparent);
			color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
			border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
			border-radius: 2px;
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
		}
		.btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
		}
		.btn.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border-color: transparent;
		}
		.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
		.btn.icon-btn {
			flex: none;
			padding: 3px 6px;
		}

		/* ---- セクションヘッダー ---- */
		.section-header {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
			padding: 6px 2px 2px;
			border-bottom: 1px solid var(--vscode-panel-border);
			margin-bottom: 4px;
		}

		/* ---- プレースホルダー ---- */
		.placeholder {
			text-align: center;
			color: var(--vscode-descriptionForeground);
			padding: 24px 8px;
			font-size: 12px;
		}
		.placeholder .icon { font-size: 24px; margin-bottom: 8px; }

		.info-text {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			padding: 4px 2px;
		}

		/* ==========================================
		   プロジェクトタブ (T2.1〜T2.9)
		   ========================================== */

		/* ---- プロジェクトカードグリッド ---- */
		.project-grid {
			display: grid;
			grid-template-columns: 1fr;
			gap: 6px;
		}
		.project-card {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			padding: 8px 10px;
			cursor: pointer;
			transition: border-color 0.15s;
		}
		.project-card:hover {
			border-color: var(--vscode-focusBorder, #007acc);
		}
		.project-card.selected {
			border-color: var(--vscode-focusBorder, #007acc);
			background: var(--vscode-list-activeSelectionBackground);
		}
		.project-card-header {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-bottom: 4px;
		}
		.project-card-name {
			font-weight: 600;
			font-size: 12px;
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.project-card-badges {
			display: flex;
			gap: 3px;
			flex-shrink: 0;
		}
		.badge {
			font-size: 9px;
			padding: 1px 5px;
			border-radius: 9px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			white-space: nowrap;
		}
		.badge-current {
			background: var(--vscode-statusBarItem-remoteBackground, #007acc);
			color: var(--vscode-statusBarItem-remoteForeground, #fff);
		}
		.badge-manual {
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.project-card-meta {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			display: flex;
			gap: 8px;
			flex-wrap: wrap;
		}
		.project-card-path {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-top: 2px;
		}
		.project-card-actions {
			display: flex;
			gap: 4px;
			margin-top: 6px;
		}
		.project-card-btn {
			padding: 2px 6px;
			font-size: 10px;
			background: var(--vscode-button-secondaryBackground, transparent);
			color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
			border: 1px solid var(--vscode-panel-border);
			border-radius: 2px;
			cursor: pointer;
			font-family: inherit;
		}
		.project-card-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
		}
		.project-card-btn.danger:hover {
			background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.1));
			border-color: var(--vscode-errorForeground);
			color: var(--vscode-errorForeground);
		}

		/* ---- プロジェクト詳細ペイン ---- */
		.detail-pane {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			background: var(--vscode-editor-background);
			overflow: hidden;
		}
		.detail-pane-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 6px 10px;
			background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
			border-bottom: 1px solid var(--vscode-panel-border);
			font-size: 11px;
			font-weight: 600;
		}
		.detail-pane-close {
			background: transparent;
			border: none;
			cursor: pointer;
			color: var(--vscode-descriptionForeground);
			font-size: 14px;
			line-height: 1;
			padding: 0 2px;
		}
		.detail-pane-close:hover { color: var(--vscode-foreground); }
		.detail-section {
			padding: 8px 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.detail-section:last-child { border-bottom: none; }
		.detail-section-title {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 6px;
		}
		.detail-meta-row {
			display: flex;
			gap: 4px;
			font-size: 11px;
			margin-bottom: 3px;
			align-items: flex-start;
		}
		.detail-meta-label {
			color: var(--vscode-descriptionForeground);
			min-width: 60px;
			flex-shrink: 0;
			font-size: 10px;
		}
		.detail-meta-value {
			color: var(--vscode-foreground);
			word-break: break-all;
		}

		/* ---- 進捗ダッシュボード ---- */
		.progress-bar-wrap {
			background: var(--vscode-progressBar-background, rgba(255,255,255,0.1));
			border-radius: 2px;
			height: 4px;
			margin: 4px 0;
			overflow: hidden;
		}
		.progress-bar-fill {
			height: 100%;
			background: var(--vscode-focusBorder, #007acc);
			transition: width 0.3s;
		}
		.progress-stat {
			display: flex;
			gap: 8px;
			font-size: 11px;
			flex-wrap: wrap;
		}
		.progress-stat-item {
			display: flex;
			align-items: center;
			gap: 4px;
		}
		.stat-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			flex-shrink: 0;
		}
		.stat-dot-todo { background: var(--vscode-charts-yellow, #e9c46a); }
		.stat-dot-done { background: var(--vscode-charts-green, #4caf50); }
		.stat-dot-pending { background: var(--vscode-charts-orange, #f4a261); }
		.history-item {
			font-size: 10px;
			padding: 3px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			gap: 4px;
		}
		.history-item:last-child { border-bottom: none; }
		.history-agent { color: var(--vscode-descriptionForeground); min-width: 50px; flex-shrink: 0; }
		.history-text { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* ---- エージェント割当 ---- */
		.agent-chip {
			display: inline-flex;
			align-items: center;
			gap: 4px;
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 10px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			margin: 2px;
			cursor: pointer;
		}
		.agent-chip:hover { opacity: 0.8; }
		.agent-chip-remove {
			font-size: 10px;
			opacity: 0.7;
		}
		.agent-assign-list {
			display: flex;
			flex-wrap: wrap;
			gap: 2px;
			margin-top: 4px;
		}
		.agent-assign-item {
			font-size: 10px;
			padding: 2px 6px;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 3px;
			cursor: pointer;
			background: transparent;
			color: var(--vscode-foreground);
			font-family: inherit;
		}
		.agent-assign-item:hover {
			background: var(--vscode-list-hoverBackground);
		}

		/* ---- メモリリスト ---- */
		.memory-item {
			font-size: 10px;
			padding: 3px 0;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			gap: 4px;
			align-items: baseline;
		}
		.memory-item:last-child { border-bottom: none; }
		.memory-type-badge {
			font-size: 8px;
			padding: 1px 4px;
			border-radius: 2px;
			flex-shrink: 0;
		}
		.memory-type-user { background: rgba(100,181,246,0.15); color: #64b5f6; }
		.memory-type-feedback { background: rgba(255,183,77,0.15); color: #ffb74d; }
		.memory-type-project { background: rgba(129,199,132,0.15); color: #81c784; }
		.memory-type-reference { background: rgba(206,147,216,0.15); color: #ce93d8; }
		.memory-name { color: var(--vscode-foreground); font-weight: 500; }
		.memory-desc { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

		/* ==========================================
		   エージェントタブ (T2.12〜T2.15)
		   ========================================== */

		.agent-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 6px;
			border-radius: 3px;
			cursor: pointer;
			min-width: 0;
		}
		.agent-item:hover { background: var(--vscode-list-hoverBackground); }
		.agent-info { flex: 1; min-width: 0; }
		.agent-name {
			font-weight: 500;
			font-size: 11px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.agent-meta {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.agent-badges {
			display: flex;
			gap: 3px;
			flex-shrink: 0;
			align-items: center;
		}
		.model-badge {
			font-size: 9px;
			padding: 1px 4px;
			border-radius: 3px;
			font-weight: 600;
		}
		.model-opus { background: rgba(179,136,255,0.15); color: #b388ff; border: 1px solid rgba(179,136,255,0.3); }
		.model-sonnet { background: rgba(100,181,246,0.15); color: #64b5f6; border: 1px solid rgba(100,181,246,0.3); }
		.model-haiku { background: rgba(129,199,132,0.15); color: #81c784; border: 1px solid rgba(129,199,132,0.3); }
		.scope-badge {
			font-size: 9px;
			padding: 1px 4px;
			border-radius: 3px;
		}
		.scope-global { color: var(--vscode-descriptionForeground); }
		.scope-project {
			background: rgba(100,181,246,0.1);
			color: #64b5f6;
		}
		.bookmark-btn {
			background: transparent;
			border: none;
			cursor: pointer;
			font-size: 12px;
			padding: 2px 3px;
			color: var(--vscode-descriptionForeground);
			line-height: 1;
		}
		.bookmark-btn:hover { color: var(--vscode-foreground); }
		.bookmark-btn.bookmarked { color: #ffb74d; }

		/* ---- フィルタチップ (T2.14) ---- */
		.filter-section {
			padding: 0 0 4px;
		}
		.filter-label {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 3px;
		}
		.filter-chips {
			display: flex;
			flex-wrap: wrap;
			gap: 3px;
		}
		.filter-chip {
			font-size: 10px;
			padding: 2px 6px;
			border-radius: 10px;
			border: 1px solid var(--vscode-panel-border);
			background: transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			font-family: inherit;
			white-space: nowrap;
		}
		.filter-chip:hover { background: var(--vscode-list-hoverBackground); }
		.filter-chip.active {
			background: var(--vscode-focusBorder, #007acc);
			color: #fff;
			border-color: transparent;
		}
		.filter-clear {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			background: transparent;
			border: none;
			cursor: pointer;
			padding: 2px 4px;
			font-family: inherit;
		}
		.filter-clear:hover { color: var(--vscode-foreground); }

		/* ---- ミニ組織図 (T2.21) ---- */
		.mini-org-tree {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.mini-org-node {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 2px 4px;
			border-radius: 3px;
			font-size: 10px;
			border: 1px solid var(--vscode-panel-border);
			background: var(--vscode-editor-background);
		}
		.mini-org-node.indent-1 { margin-left: 16px; }
		.mini-org-node.indent-2 { margin-left: 32px; }
		.mini-org-indent {
			color: var(--vscode-descriptionForeground);
			font-size: 9px;
		}
		.mini-org-model {
			font-size: 8px;
			padding: 1px 3px;
			border-radius: 2px;
			flex-shrink: 0;
		}
		.mini-org-name {
			font-weight: 500;
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		/* ==========================================
		   セッションタブ (TF1〜TF3)
		   ========================================== */

		/* ---- 検索ボックス ---- */
		.search-bar {
			flex-shrink: 0;
		}
		.search-input {
			width: 100%;
			padding: 4px 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
			border-radius: 3px;
			font-size: 11px;
			font-family: inherit;
			outline: none;
		}
		.search-input:focus {
			border-color: var(--vscode-focusBorder, #007acc);
		}
		.search-input::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}

		/* ---- ソート/フィルタバー ---- */
		.sort-filter-bar {
			display: flex;
			gap: 4px;
			align-items: center;
			flex-shrink: 0;
			flex-wrap: wrap;
		}
		.sort-select {
			padding: 2px 4px;
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
			border-radius: 3px;
			font-size: 10px;
			font-family: inherit;
			cursor: pointer;
		}

		/* ---- セッションカード ---- */
		.session-card {
			padding: 5px 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
			cursor: pointer;
			display: flex;
			align-items: flex-start;
			gap: 6px;
			min-width: 0;
		}
		.session-card:hover { background: var(--vscode-list-hoverBackground); }
		.session-card:last-child { border-bottom: none; }
		.session-card-body { flex: 1; min-width: 0; }
		.session-card-title {
			font-size: 11px;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			color: var(--vscode-foreground);
		}
		.session-card-meta {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			margin-top: 1px;
		}
		.session-card-tags {
			display: flex;
			gap: 2px;
			flex-wrap: wrap;
			margin-top: 2px;
		}
		.tag-chip {
			font-size: 8px;
			padding: 1px 4px;
			border-radius: 8px;
			background: rgba(100,181,246,0.1);
			color: #64b5f6;
			border: 1px solid rgba(100,181,246,0.2);
			white-space: nowrap;
		}
		.session-card-actions {
			display: flex;
			align-items: center;
			gap: 2px;
			flex-shrink: 0;
		}
		.session-bm-btn {
			background: transparent;
			border: none;
			cursor: pointer;
			font-size: 12px;
			padding: 2px;
			color: var(--vscode-descriptionForeground);
			line-height: 1;
			flex-shrink: 0;
		}
		.session-bm-btn:hover { color: var(--vscode-foreground); }
		.session-bm-btn.bookmarked { color: #ffb74d; }
		.session-model-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			flex-shrink: 0;
			margin-top: 4px;
		}
		.dot-opus   { background: #b388ff; }
		.dot-sonnet { background: #64b5f6; }
		.dot-haiku  { background: #81c784; }
		.dot-other  { background: var(--vscode-descriptionForeground); }

		/* ---- 折りたたみセクション (details/summary) ---- */
		.collapse-section {
			flex-shrink: 0;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 3px;
			overflow: hidden;
		}
		.collapse-section[open] { flex-shrink: 0; }
		.collapse-summary {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 5px 8px;
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
			background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background));
			cursor: pointer;
			user-select: none;
			list-style: none;
		}
		.collapse-summary::-webkit-details-marker { display: none; }
		.collapse-summary::before {
			content: '▶';
			font-size: 8px;
			margin-right: 4px;
			transition: transform 0.15s;
		}
		details[open] > .collapse-summary::before {
			transform: rotate(90deg);
		}
		.collapse-count {
			font-size: 9px;
			padding: 1px 5px;
			border-radius: 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.collapse-body {
			padding: 4px 0;
			background: var(--vscode-editor-background);
			max-height: 200px;
			overflow-y: auto;
		}

		/* ---- タググループ ---- */
		.tag-group {
			margin-bottom: 4px;
		}
		.tag-group-header {
			font-size: 10px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
			padding: 3px 8px;
			display: flex;
			align-items: center;
			gap: 4px;
		}
		.tag-group-sessions { padding: 0 8px; }
		.tag-session-item {
			font-size: 10px;
			padding: 2px 0 2px 12px;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 4px;
			border-radius: 2px;
			color: var(--vscode-foreground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tag-session-item:hover { background: var(--vscode-list-hoverBackground); }

		/* ==========================================
		   メモリタブ (TF5)
		   ========================================== */

		.memory-section { margin-bottom: 8px; }
		.memory-file-row {
			display: flex;
			align-items: baseline;
			gap: 6px;
			padding: 3px 8px;
			font-size: 10px;
			border-bottom: 1px solid var(--vscode-panel-border);
			cursor: default;
		}
		.memory-file-row:last-child { border-bottom: none; }
		.memory-file-row:hover { background: var(--vscode-list-hoverBackground); }
		.memory-file-name {
			font-weight: 500;
			color: var(--vscode-foreground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex: 1;
		}
		.memory-file-desc {
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			flex: 2;
		}
		.memory-project-header {
			font-size: 10px;
			font-weight: 600;
			color: var(--vscode-descriptionForeground);
			padding: 4px 8px 2px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			align-items: center;
			gap: 4px;
		}

		/* ==========================================
		   プロジェクトツリーモード (TT1〜TT4)
		   ========================================== */

		.project-mode-toggle {
			display: flex;
			gap: 2px;
			flex-shrink: 0;
		}
		.mode-toggle-btn {
			padding: 3px 7px;
			font-size: 11px;
			background: transparent;
			color: var(--vscode-descriptionForeground);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 2px;
			cursor: pointer;
			font-family: inherit;
			line-height: 1;
		}
		.mode-toggle-btn.active {
			background: var(--vscode-focusBorder, #007acc);
			color: #fff;
			border-color: transparent;
		}
		.mode-toggle-btn:hover:not(.active) {
			background: var(--vscode-list-hoverBackground);
			color: var(--vscode-foreground);
		}

		/* ---- ツリー本体 ---- */
		.project-tree { display: flex; flex-direction: column; gap: 4px; }
		.project-tree-item {
			border: 1px solid var(--vscode-panel-border);
			border-radius: 3px;
			overflow: hidden;
		}
		.project-tree-summary {
			display: flex;
			align-items: center;
			gap: 5px;
			padding: 5px 8px;
			font-size: 11px;
			font-weight: 600;
			cursor: pointer;
			user-select: none;
			background: var(--vscode-editor-background);
			list-style: none;
			min-width: 0;
		}
		.project-tree-summary:hover { background: var(--vscode-list-hoverBackground); }
		.project-tree-summary::-webkit-details-marker { display: none; }
		.project-tree-chevron {
			font-size: 8px;
			color: var(--vscode-descriptionForeground);
			flex-shrink: 0;
			display: inline-block;
			transition: transform 0.15s;
		}
		details.project-tree-item[open] > .project-tree-summary .project-tree-chevron {
			transform: rotate(90deg);
		}
		.project-tree-name {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.project-tree-badges { display: flex; gap: 3px; flex-shrink: 0; }
		.project-tree-actions {
			display: flex;
			gap: 2px;
			flex-shrink: 0;
			opacity: 0;
			transition: opacity 0.1s;
		}
		.project-tree-item:hover .project-tree-actions { opacity: 1; }
		.tree-action-btn {
			padding: 1px 5px;
			font-size: 9px;
			background: transparent;
			color: var(--vscode-descriptionForeground);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 2px;
			cursor: pointer;
			font-family: inherit;
			white-space: nowrap;
		}
		.tree-action-btn:hover {
			background: var(--vscode-list-hoverBackground);
			color: var(--vscode-foreground);
		}

		/* ---- ツリー子ノード ---- */
		.project-tree-body { background: var(--vscode-sideBar-background); }
		.tree-category {
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		.tree-category:last-child { border-bottom: none; }
		.tree-category-summary {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 3px 8px 3px 20px;
			font-size: 10px;
			font-weight: 600;
			cursor: pointer;
			user-select: none;
			color: var(--vscode-descriptionForeground);
			list-style: none;
			background: transparent;
		}
		.tree-category-summary:hover { background: var(--vscode-list-hoverBackground); }
		.tree-category-summary::-webkit-details-marker { display: none; }
		.tree-category-summary::before {
			content: '▶';
			font-size: 7px;
			color: var(--vscode-descriptionForeground);
			transition: transform 0.1s;
			flex-shrink: 0;
		}
		details.tree-category[open] > .tree-category-summary::before {
			transform: rotate(90deg);
		}
		.tree-category-count {
			font-size: 8px;
			padding: 1px 4px;
			border-radius: 6px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
		}
		.tree-leaf {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 2px 8px 2px 36px;
			font-size: 10px;
			cursor: pointer;
			color: var(--vscode-foreground);
			min-width: 0;
		}
		.tree-leaf:hover { background: var(--vscode-list-hoverBackground); }
		.tree-leaf-icon { flex-shrink: 0; font-size: 10px; }
		.tree-leaf-name {
			flex: 1;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tree-leaf-meta {
			font-size: 9px;
			color: var(--vscode-descriptionForeground);
			flex-shrink: 0;
			white-space: nowrap;
		}
		.tree-empty-msg {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			padding: 2px 8px 4px 36px;
		}
	</style>
</head>
<body>
	<!-- タブバー -->
	<div class="tab-bar" role="tablist">
		<button class="tab-btn active" data-tab="sessions" role="tab" aria-selected="true">${tabSessions}</button>
		<button class="tab-btn" data-tab="agents" role="tab" aria-selected="false">${tabAgents}</button>
		<button class="tab-btn" data-tab="projects" role="tab" aria-selected="false">${tabProjects}</button>
		<button class="tab-btn" data-tab="memory" role="tab" aria-selected="false">${tabMemory}</button>
	</div>

	<!-- タブコンテンツ -->
	<div class="tab-content">

		<!-- ===== セッションタブ (TF1〜TF3) ===== -->
		<div class="tab-pane active" id="pane-sessions" role="tabpanel">

			<!-- アクションバー -->
			<div class="action-bar">
				<button class="btn primary" id="btn-new-session">＋ 新規セッション</button>
				<button class="btn icon-btn" id="btn-refresh-sessions" title="更新" aria-label="セッションを更新">↻</button>
			</div>

			<!-- 検索 -->
			<div class="search-bar">
				<input type="text" id="session-search" class="search-input"
					placeholder="タイトル・プロジェクト・ブランチ…" aria-label="セッションを検索">
			</div>

			<!-- ソート/フィルタ -->
			<div class="sort-filter-bar">
				<select id="session-sort" class="sort-select" aria-label="ソート順">
					<option value="updated-desc">新しい順</option>
					<option value="updated-asc">古い順</option>
					<option value="size-desc">サイズ順</option>
					<option value="name">名前順</option>
				</select>
				<div class="filter-chips" id="session-period-chips">
					<button class="filter-chip active" data-period="all" aria-pressed="true">全て</button>
					<button class="filter-chip" data-period="today" aria-pressed="false">今日</button>
					<button class="filter-chip" data-period="week" aria-pressed="false">今週</button>
				</div>
			</div>

			<!-- セッション一覧 -->
			<div id="session-list">
				<div class="placeholder"><div class="icon">💬</div><div>読み込み中...</div></div>
			</div>

			<!-- ブックマークセクション (TF2) -->
			<details class="collapse-section" id="session-bookmarks-section" open>
				<summary class="collapse-summary" aria-label="ブックマークセクション">
					★ ブックマーク
					<span class="collapse-count" id="session-bm-count">0</span>
				</summary>
				<div class="collapse-body" id="session-bookmarks-list">
					<div class="placeholder" style="padding:8px;">ブックマークなし</div>
				</div>
			</details>

			<!-- タグセクション (TF3) -->
			<details class="collapse-section" id="session-tags-section">
				<summary class="collapse-summary" aria-label="タグセクション">
					🏷️ タグ
					<span class="collapse-count" id="session-tags-count">0</span>
				</summary>
				<div class="collapse-body" id="session-tags-list">
					<div class="placeholder" style="padding:8px;">タグなし</div>
				</div>
			</details>

		</div>

		<!-- ===== エージェントタブ (T2.12〜T2.15) ===== -->
		<div class="tab-pane" id="pane-agents" role="tabpanel">
			<!-- T3.13: 組織診断ボタン -->
			<div class="action-bar" style="padding:6px 8px;">
				<button class="btn primary" id="btn-run-org-builder"
					title="組織構成を診断して改善提案を表示"
					aria-label="組織診断を実行">
					組織診断
				</button>
			</div>
			<!-- フィルタセクション (T2.14) -->
			<div class="filter-section" id="agent-filter-section">
				<div class="filter-label">モデル:</div>
				<div class="filter-chips" id="filter-model-chips"></div>
				<div class="filter-label" style="margin-top:4px;">スコープ:</div>
				<div class="filter-chips" id="filter-scope-chips"></div>
				<div style="margin-top:4px; display:flex; align-items:center; gap:4px;">
					<span class="filter-label" style="margin:0;">親:</span>
					<div class="filter-chips" id="filter-parent-chips" style="flex:1;"></div>
					<button class="filter-clear" id="btn-clear-filters">✕ クリア</button>
				</div>
			</div>

			<!-- ブックマークセクション (T2.12) -->
			<div class="section-header">★ ブックマーク</div>
			<div id="agent-bookmarks-list">
				<div class="placeholder" style="padding:12px 8px;">
					<div>読み込み中...</div>
				</div>
			</div>

			<!-- 最終使用日順 Top 5 (T2.13) -->
			<div class="section-header" style="margin-top:4px;">最近使用 (Top5)</div>
			<div id="agent-recent-list">
				<div class="placeholder" style="padding:12px 8px;">
					<div>読み込み中...</div>
				</div>
			</div>

			<!-- 全エージェント (グローバル/プロジェクト分離 T2.15) -->
			<div class="section-header" style="margin-top:4px;">🌐 グローバル</div>
			<div id="agent-global-list"></div>

			<div class="section-header" style="margin-top:4px;" id="agent-project-header">プロジェクト</div>
			<div id="agent-project-list"></div>
		</div>

		<!-- ===== プロジェクトタブ (T2.1〜T2.9 / TT1〜TT4) ===== -->
		<div class="tab-pane" id="pane-projects" role="tabpanel">
			<div class="action-bar">
				<button class="btn primary" id="btn-add-project">＋ 追加</button>
				<button class="btn icon-btn" id="btn-refresh-projects" title="更新">↻</button>
				<!-- TT1: モード切替トグル -->
				<div class="project-mode-toggle" role="group" aria-label="表示モード">
					<button class="mode-toggle-btn active" id="btn-mode-card"
						title="カード表示" aria-pressed="true">📋</button>
					<button class="mode-toggle-btn" id="btn-mode-tree"
						title="ツリー表示" aria-pressed="false">🌲</button>
				</div>
			</div>

			<!-- カードモード (T2.1/T2.2) -->
			<div id="project-list">
				<div class="placeholder">
					<div class="icon">📁</div>
					<div>読み込み中...</div>
				</div>
			</div>

			<!-- ツリーモード (TT2) -->
			<div id="project-tree" style="display:none;" role="tree" aria-label="プロジェクトツリー">
				<div class="placeholder"><div class="icon">🌲</div><div>読み込み中...</div></div>
			</div>

			<!-- 詳細ペイン (T2.3〜T2.8) -->
			<div id="project-detail-pane" style="display:none;" aria-label="プロジェクト詳細">
				<div class="detail-pane">
					<div class="detail-pane-header">
						<span id="detail-project-name">プロジェクト詳細</span>
						<button class="detail-pane-close" id="btn-close-detail" title="閉じる" aria-label="詳細を閉じる">✕</button>
					</div>

					<!-- T2.3: 概要 -->
					<div class="detail-section">
						<div class="detail-section-title">概要</div>
						<div id="detail-meta"></div>
					</div>

					<!-- T2.8: クイックアクション -->
					<div class="detail-section">
						<div class="detail-section-title">クイックアクション</div>
						<div style="display:flex; gap:4px; flex-wrap:wrap;">
							<button class="project-card-btn" id="btn-detail-open-vscode">VS Codeで開く</button>
							<button class="project-card-btn" id="btn-detail-open-terminal">ターミナル</button>
						</div>
					</div>

					<!-- T2.4: 紐づけエージェント -->
					<div class="detail-section">
						<div class="detail-section-title">割当エージェント</div>
						<div id="detail-assigned-agents"></div>
						<div class="detail-section-title" style="margin-top:8px;">エージェントを追加</div>
						<div id="detail-agent-candidates"></div>
					</div>

					<!-- T2.7: 進捗ダッシュボード -->
					<div class="detail-section">
						<div class="detail-section-title">進捗ダッシュボード</div>
						<div id="detail-progress"></div>
					</div>

					<!-- T2.21: ミニ組織図 -->
					<div class="detail-section">
						<div class="detail-section-title">ミニ組織図</div>
						<div id="detail-mini-org" style="overflow-x:auto;"></div>
					</div>

					<!-- T2.5: メモリ管理 -->
					<div class="detail-section">
						<div class="detail-section-title">メモリファイル</div>
						<div id="detail-memory"></div>
					</div>
				</div>
			</div>
		</div>

		<!-- ===== メモリタブ (TF5) ===== -->
		<div class="tab-pane" id="pane-memory" role="tabpanel">

			<div class="action-bar">
				<button class="btn icon-btn" id="btn-refresh-memory" title="更新" aria-label="メモリを更新">↻</button>
			</div>

			<!-- グローバルメモリ -->
			<div class="section-header">🌐 グローバルメモリ</div>
			<div id="memory-global-list">
				<div class="placeholder" style="padding:8px;">読み込み中...</div>
			</div>

			<!-- プロジェクト別メモリ -->
			<div id="memory-projects-list">
			</div>

		</div>

	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const HOME = '${homeDir}';

		// ----------------------------------------------------------------
		// タブ切り替え
		// ----------------------------------------------------------------
		const tabBtns  = document.querySelectorAll('.tab-btn');
		const tabPanes = document.querySelectorAll('.tab-pane');

		tabBtns.forEach(btn => {
			btn.addEventListener('click', () => {
				const target = btn.dataset.tab;
				tabBtns.forEach(b => {
					b.classList.toggle('active', b.dataset.tab === target);
					b.setAttribute('aria-selected', b.dataset.tab === target ? 'true' : 'false');
				});
				tabPanes.forEach(p => p.classList.toggle('active', p.id === 'pane-' + target));
				vscode.postMessage({ type: 'tab-changed', payload: { tab: target } });
			});
		});

		// ----------------------------------------------------------------
		// セッションタブ (TF1〜TF3)
		// ----------------------------------------------------------------
		document.getElementById('btn-new-session').addEventListener('click', () => {
			vscode.postMessage({ type: 'new-session' });
		});
		document.getElementById('btn-refresh-sessions').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh-sessions' });
		});

		// ---- 検索 ----
		let _sessionSearchTimer = null;
		document.getElementById('session-search').addEventListener('input', (e) => {
			clearTimeout(_sessionSearchTimer);
			_sessionSearchTimer = setTimeout(() => {
				renderSessionLists();
			}, 180);
		});

		// ---- ソート ----
		document.getElementById('session-sort').addEventListener('change', () => {
			renderSessionLists();
		});

		// ---- 期間フィルタチップ ----
		document.getElementById('session-period-chips').addEventListener('click', (e) => {
			const chip = e.target.closest('[data-period]');
			if (!chip) return;
			document.querySelectorAll('#session-period-chips .filter-chip').forEach(c => {
				const active = c === chip;
				c.classList.toggle('active', active);
				c.setAttribute('aria-pressed', active ? 'true' : 'false');
			});
			renderSessionLists();
		});

		// ================================================================
		// セッションデータ管理
		// ================================================================
		let _sessionsCache = [];
		let _sessionBookmarkIds = [];
		let _sessionAllTags = {};

		function getActivePeriod() {
			const chip = document.querySelector('#session-period-chips .filter-chip.active');
			return chip ? chip.dataset.period : 'all';
		}

		function getSessionKeyword() {
			const el = document.getElementById('session-search');
			return el ? el.value.trim().toLowerCase() : '';
		}

		function getSessionSort() {
			const el = document.getElementById('session-sort');
			return el ? el.value : 'updated-desc';
		}

		function formatFileSize(bytes) {
			if (bytes < 1024) return bytes + 'B';
			if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
			return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
		}

		function formatRelTime(ms) {
			if (!ms) return '';
			const diff = Date.now() - ms;
			const sec = Math.floor(diff / 1000);
			if (sec < 60) return 'たった今';
			const min = Math.floor(sec / 60);
			if (min < 60) return min + '分前';
			const hr = Math.floor(min / 60);
			if (hr < 24) return hr + '時間前';
			const day = Math.floor(hr / 24);
			if (day < 30) return day + '日前';
			return Math.floor(day / 30) + 'ヶ月前';
		}

		function isInPeriod(ts, period) {
			const now = Date.now();
			if (period === 'today') {
				const todayStart = new Date();
				todayStart.setHours(0, 0, 0, 0);
				return ts >= todayStart.getTime();
			}
			if (period === 'week') {
				return ts >= now - 7 * 24 * 60 * 60 * 1000;
			}
			return true;
		}

		function applySessionFilters(sessions) {
			const keyword = getSessionKeyword();
			const period  = getActivePeriod();
			return sessions.filter(s => {
				if (!isInPeriod(s.lastTimestamp, period)) return false;
				if (keyword) {
					const haystack = (s.title + ' ' + s.project + ' ' + (s.gitBranch || '')).toLowerCase();
					if (!haystack.includes(keyword)) return false;
				}
				return true;
			});
		}

		function applySortSessions(sessions) {
			const sort = getSessionSort();
			const arr = sessions.slice();
			switch (sort) {
				case 'updated-desc': arr.sort((a, b) => b.lastTimestamp - a.lastTimestamp); break;
				case 'updated-asc':  arr.sort((a, b) => a.lastTimestamp - b.lastTimestamp); break;
				case 'size-desc':    arr.sort((a, b) => b.fileSize - a.fileSize); break;
				case 'name':         arr.sort((a, b) => a.title.localeCompare(b.title, 'ja')); break;
			}
			return arr;
		}

		function modelDotClass(model) {
			if (!model) return 'dot-other';
			if (model.includes('opus'))   return 'dot-opus';
			if (model.includes('sonnet')) return 'dot-sonnet';
			if (model.includes('haiku'))  return 'dot-haiku';
			return 'dot-other';
		}

		function makeSessionCard(s, showBookmarkBtn) {
			const card = document.createElement('div');
			card.className = 'session-card';
			card.setAttribute('role', 'listitem');
			card.dataset.id = s.id;

			const dot = document.createElement('div');
			dot.className = 'session-model-dot ' + modelDotClass(s.model);
			dot.title = s.model || '';

			const body = document.createElement('div');
			body.className = 'session-card-body';

			const titleEl = document.createElement('div');
			titleEl.className = 'session-card-title';
			titleEl.textContent = s.title;
			titleEl.title = s.title;

			const metaEl = document.createElement('div');
			metaEl.className = 'session-card-meta';
			const projShort = s.project.replace(HOME, '~').split('/').slice(-2).join('/');
			metaEl.textContent = projShort + ' · ' + formatFileSize(s.fileSize) + ' · ' + formatRelTime(s.lastTimestamp);

			body.appendChild(titleEl);
			body.appendChild(metaEl);

			if (s.tags && s.tags.length > 0) {
				const tagsEl = document.createElement('div');
				tagsEl.className = 'session-card-tags';
				s.tags.forEach(tag => {
					const chip = document.createElement('span');
					chip.className = 'tag-chip';
					chip.textContent = tag;
					tagsEl.appendChild(chip);
				});
				body.appendChild(tagsEl);
			}

			const actions = document.createElement('div');
			actions.className = 'session-card-actions';

			if (showBookmarkBtn) {
				const bmBtn = document.createElement('button');
				bmBtn.className = 'session-bm-btn' + (s.bookmarked ? ' bookmarked' : '');
				bmBtn.textContent = s.bookmarked ? '★' : '☆';
				bmBtn.title = s.bookmarked ? 'ブックマーク解除' : 'ブックマーク追加';
				bmBtn.setAttribute('aria-label', (s.bookmarked ? 'ブックマーク解除: ' : 'ブックマーク追加: ') + s.title);
				bmBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'toggle-bookmark-session', payload: { sessionId: s.id } });
				});
				actions.appendChild(bmBtn);
			}

			card.appendChild(dot);
			card.appendChild(body);
			card.appendChild(actions);

			card.addEventListener('click', () => {
				vscode.postMessage({ type: 'open-session', payload: { id: s.id, filePath: s.filePath } });
			});

			return card;
		}

		// ---- セッション一覧をレンダリング ----
		function renderSessionLists() {
			const filtered = applySessionFilters(_sessionsCache);
			const sorted   = applySortSessions(filtered);

			const list = document.getElementById('session-list');
			if (sorted.length === 0) {
				list.innerHTML = '<div class="placeholder"><div class="icon">💬</div><div>該当するセッションがありません</div></div>';
			} else {
				list.innerHTML = '';
				sorted.forEach(s => list.appendChild(makeSessionCard(s, true)));
			}
		}

		// ---- TF2: ブックマーク一覧 ----
		function renderBookmarksList(sessions, bookmarkIds) {
			const bookmarked = sessions.filter(s => bookmarkIds.includes(s.id));
			const countEl = document.getElementById('session-bm-count');
			if (countEl) countEl.textContent = String(bookmarked.length);

			const list = document.getElementById('session-bookmarks-list');
			if (bookmarked.length === 0) {
				list.innerHTML = '<div style="font-size:10px; color:var(--vscode-descriptionForeground); padding:6px 8px;">ブックマークなし</div>';
				return;
			}
			list.innerHTML = '';
			bookmarked.forEach(s => {
				const card = makeSessionCard(s, true);
				list.appendChild(card);
			});
		}

		// ---- TF3: タグ一覧 ----
		function renderTagsList(sessions, allTags) {
			const tagNames = Object.keys(allTags).sort();
			const countEl = document.getElementById('session-tags-count');
			if (countEl) countEl.textContent = String(tagNames.length);

			const list = document.getElementById('session-tags-list');
			if (tagNames.length === 0) {
				list.innerHTML = '<div style="font-size:10px; color:var(--vscode-descriptionForeground); padding:6px 8px;">タグなし</div>';
				return;
			}
			list.innerHTML = '';
			tagNames.forEach(tag => {
				const sessionIds = allTags[tag] || [];
				const tagSessions = sessionIds
					.map(id => sessions.find(s => s.id === id))
					.filter(Boolean);
				if (tagSessions.length === 0) return;

				const group = document.createElement('div');
				group.className = 'tag-group';

				const header = document.createElement('div');
				header.className = 'tag-group-header';
				header.innerHTML = '<span>🏷️</span><span>' + escHtml(tag) + '</span>' +
					'<span class="collapse-count">' + tagSessions.length + '</span>';
				group.appendChild(header);

				const sessionListEl = document.createElement('div');
				sessionListEl.className = 'tag-group-sessions';
				tagSessions.forEach(s => {
					const item = document.createElement('div');
					item.className = 'tag-session-item';
					item.title = s.title;
					item.innerHTML = '<span style="font-size:9px;">' + modelDotChar(s.model) + '</span>' +
						'<span style="overflow:hidden;text-overflow:ellipsis;">' + escHtml(s.title) + '</span>';
					item.addEventListener('click', () => {
						vscode.postMessage({ type: 'open-session', payload: { id: s.id, filePath: s.filePath } });
					});
					sessionListEl.appendChild(item);
				});
				group.appendChild(sessionListEl);
				list.appendChild(group);
			});
		}

		function modelDotChar(model) {
			if (!model) return '●';
			if (model.includes('opus'))   return '<span style="color:#b388ff;">●</span>';
			if (model.includes('sonnet')) return '<span style="color:#64b5f6;">●</span>';
			if (model.includes('haiku'))  return '<span style="color:#81c784;">●</span>';
			return '●';
		}

		// ---- セッションデータ受信時にレンダリング ----
		function renderSessionsData(data) {
			_sessionsCache     = data.sessions || [];
			_sessionBookmarkIds = data.bookmarkIds || [];
			_sessionAllTags    = data.allTags || {};

			renderSessionLists();
			renderBookmarksList(_sessionsCache, _sessionBookmarkIds);
			renderTagsList(_sessionsCache, _sessionAllTags);
		}

		// ================================================================
		// メモリタブ (TF5)
		// ================================================================
		document.getElementById('btn-refresh-memory').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh-memory' });
		});

		function makeMemoryTypeClass(type) {
			switch (type) {
				case 'user':      return 'memory-type-user';
				case 'feedback':  return 'memory-type-feedback';
				case 'project':   return 'memory-type-project';
				case 'reference': return 'memory-type-reference';
				default:          return 'memory-type-project';
			}
		}

		function makeMemoryFileRow(f) {
			const row = document.createElement('div');
			row.className = 'memory-file-row';
			row.title = f.description || f.name;

			const badge = document.createElement('span');
			badge.className = 'memory-type-badge ' + makeMemoryTypeClass(f.type);
			badge.textContent = f.type || 'project';

			const nameEl = document.createElement('span');
			nameEl.className = 'memory-file-name';
			nameEl.textContent = f.name;

			const descEl = document.createElement('span');
			descEl.className = 'memory-file-desc';
			descEl.textContent = f.description || '';

			row.appendChild(badge);
			row.appendChild(nameEl);
			row.appendChild(descEl);
			return row;
		}

		function renderMemoriesData(data) {
			// グローバルメモリ
			const globalList = document.getElementById('memory-global-list');
			if (!data.globalFiles || data.globalFiles.length === 0) {
				globalList.innerHTML = '<div style="font-size:10px; color:var(--vscode-descriptionForeground); padding:6px 8px;">グローバルメモリなし</div>';
			} else {
				globalList.innerHTML = '';
				data.globalFiles.forEach(f => globalList.appendChild(makeMemoryFileRow(f)));
			}

			// プロジェクト別メモリ
			const projectsList = document.getElementById('memory-projects-list');
			projectsList.innerHTML = '';
			if (!data.projectGroups || data.projectGroups.length === 0) {
				projectsList.innerHTML = '<div style="font-size:10px; color:var(--vscode-descriptionForeground); padding:6px 8px;">プロジェクトメモリなし</div>';
				return;
			}
			data.projectGroups.forEach(g => {
				const sec = document.createElement('div');
				sec.className = 'memory-section';

				const hdr = document.createElement('div');
				hdr.className = 'memory-project-header section-header';
				const projName = g.project.replace(HOME, '~');
				hdr.innerHTML = '📁 ' + escHtml(projName) +
					' <span class="collapse-count">' + (g.files ? g.files.length : 0) + '</span>';
				sec.appendChild(hdr);

				if (g.files && g.files.length > 0) {
					g.files.forEach(f => sec.appendChild(makeMemoryFileRow(f)));
				} else {
					const empty = document.createElement('div');
					empty.style.cssText = 'font-size:10px; color:var(--vscode-descriptionForeground); padding:4px 8px;';
					empty.textContent = 'ファイルなし';
					sec.appendChild(empty);
				}
				projectsList.appendChild(sec);
			});
		}

		// ================================================================
		// プロジェクトタブ (T2.1〜T2.9 / TT1〜TT4)
		// ================================================================

		let selectedProjectId = null;

		// ---- TT1: モード切替 ----
		const PROJECT_MODE_KEY = 'csm.projectTab.mode';
		let _projectMode = localStorage.getItem(PROJECT_MODE_KEY) || 'card';
		let _projectTreeCache = null;

		function applyProjectMode(mode) {
			_projectMode = mode;
			localStorage.setItem(PROJECT_MODE_KEY, mode);

			const isCard = mode === 'card';
			document.getElementById('project-list').style.display = isCard ? '' : 'none';
			document.getElementById('project-tree').style.display  = isCard ? 'none' : '';

			// 詳細ペインはカードモード専用 → ツリーに切り替えたら閉じる
			if (!isCard) {
				document.getElementById('project-detail-pane').style.display = 'none';
				selectedProjectId = null;
				document.querySelectorAll('.project-card').forEach(c => c.classList.remove('selected'));
			}

			const btnCard = document.getElementById('btn-mode-card');
			const btnTree = document.getElementById('btn-mode-tree');
			btnCard.classList.toggle('active', isCard);
			btnCard.setAttribute('aria-pressed', isCard ? 'true' : 'false');
			btnTree.classList.toggle('active', !isCard);
			btnTree.setAttribute('aria-pressed', !isCard ? 'true' : 'false');

			if (!isCard) {
				if (_projectTreeCache) {
					renderProjectTree(_projectTreeCache);
				} else {
					vscode.postMessage({ type: 'getProjectTree' });
				}
			}
		}

		document.getElementById('btn-mode-card').addEventListener('click', () => applyProjectMode('card'));
		document.getElementById('btn-mode-tree').addEventListener('click', () => applyProjectMode('tree'));

		// ---- TT2: ツリーレンダリング ----
		function renderProjectTree(trees) {
			_projectTreeCache = trees;
			const container = document.getElementById('project-tree');
			if (!trees || trees.length === 0) {
				container.innerHTML = '<div class="placeholder"><div class="icon">📁</div><div>プロジェクトがありません</div></div>';
				return;
			}

			container.innerHTML = '';
			const treeEl = document.createElement('div');
			treeEl.className = 'project-tree';

			// 現在のプロジェクトを先頭に
			const sorted = trees.slice().sort((a, b) => {
				if (a.isCurrent && !b.isCurrent) { return -1; }
				if (!a.isCurrent && b.isCurrent) { return 1; }
				return a.name.localeCompare(b.name, 'ja');
			});

			sorted.forEach(p => treeEl.appendChild(makeProjectTreeNode(p)));
			container.appendChild(treeEl);
		}

		function makeProjectTreeNode(p) {
			const item = document.createElement('details');
			item.className = 'project-tree-item';
			item.dataset.projectId = p.projectId;

			const currentBadge = p.isCurrent
				? '<span class="badge badge-current" style="font-size:8px;">現在</span>'
				: '';

			const summary = document.createElement('summary');
			summary.className = 'project-tree-summary';
			summary.setAttribute('aria-label', escHtml(p.name) + 'プロジェクト');
			summary.innerHTML =
				'<span class="project-tree-chevron" aria-hidden="true">▶</span>' +
				'<span aria-hidden="true" style="font-size:12px;">📁</span>' +
				'<span class="project-tree-name" title="' + escHtml(p.path) + '">' + escHtml(p.name) + '</span>' +
				'<div class="project-tree-badges">' + currentBadge + '</div>' +
				'<div class="project-tree-actions">' +
					'<button class="tree-action-btn" data-action="detail" aria-label="詳細を表示">詳細</button>' +
					'<button class="tree-action-btn" data-action="vscode" aria-label="VS Codeで開く">VS Code</button>' +
				'</div>';

			summary.addEventListener('click', (e) => {
				const btn = e.target.closest('[data-action]');
				if (!btn) { return; }
				const action = btn.dataset.action;
				e.preventDefault();

				if (action === 'detail') {
					// カードモードへ戻して詳細ペインを開く
					applyProjectMode('card');
					// 少し遅延してプロジェクトカードが描画されてから詳細を開く
					setTimeout(() => {
						selectedProjectId = p.projectId;
						document.getElementById('project-detail-pane').style.display = 'block';
						document.getElementById('detail-project-name').textContent = p.name;
						const projData = _projectsCache.find(pc => pc.id === p.projectId);
						if (projData) { renderDetailMeta(projData); }
						vscode.postMessage({ type: 'select-project', payload: { id: p.projectId } });
					}, 50);
				} else if (action === 'vscode') {
					vscode.postMessage({ type: 'open-project', payload: { path: p.path } });
				}
			});

			item.appendChild(summary);

			const body = document.createElement('div');
			body.className = 'project-tree-body';

			// エージェントカテゴリ
			body.appendChild(makeTreeCategory(
				'👤 エージェント', p.agents.length,
				p.agents.map(name => ({
					icon: '👤',
					name: name,
					meta: '',
					onClick() { vscode.postMessage({ type: 'open-agent-session', payload: { agentName: name } }); }
				}))
			));

			// メモリカテゴリ
			body.appendChild(makeTreeCategory(
				'🧠 メモリ', p.memories.length,
				p.memories.map(m => ({
					icon: '📄',
					name: m.name,
					meta: m.type || '',
					onClick() { vscode.postMessage({ type: 'open-memory-file', payload: { filePath: m.filePath, name: m.name } }); }
				}))
			));

			// セッションカテゴリ
			body.appendChild(makeTreeCategory(
				'💬 セッション', p.sessions.length,
				p.sessions.map(s => ({
					icon: '💬',
					name: s.title || s.id,
					meta: s.lastTimestamp ? formatRelTime(s.lastTimestamp) : '',
					onClick() { vscode.postMessage({ type: 'open-session', payload: { filePath: s.filePath, id: s.id } }); }
				}))
			));

			item.appendChild(body);
			return item;
		}

		function makeTreeCategory(label, count, leafDefs) {
			const cat = document.createElement('details');
			cat.className = 'tree-category';

			const summary = document.createElement('summary');
			summary.className = 'tree-category-summary';
			summary.innerHTML =
				escHtml(label) +
				'<span class="tree-category-count">' + count + '</span>';
			cat.appendChild(summary);

			if (leafDefs.length === 0) {
				const empty = document.createElement('div');
				empty.className = 'tree-empty-msg';
				empty.textContent = 'なし';
				cat.appendChild(empty);
			} else {
				leafDefs.forEach(leaf => {
					const el = document.createElement('div');
					el.className = 'tree-leaf';
					el.setAttribute('role', 'treeitem');
					el.setAttribute('tabindex', '0');
					el.innerHTML =
						'<span class="tree-leaf-icon" aria-hidden="true">' + leaf.icon + '</span>' +
						'<span class="tree-leaf-name">' + escHtml(leaf.name) + '</span>' +
						(leaf.meta ? '<span class="tree-leaf-meta">' + escHtml(leaf.meta) + '</span>' : '');
					el.addEventListener('click', leaf.onClick);
					el.addEventListener('keydown', (e) => {
						if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); leaf.onClick(); }
					});
					cat.appendChild(el);
				});
			}

			return cat;
		}

		document.getElementById('btn-add-project').addEventListener('click', () => {
			vscode.postMessage({ type: 'add-project' });
		});
		document.getElementById('btn-refresh-projects').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh-projects' });
			// ツリーモードなら再取得
			if (_projectMode === 'tree') {
				_projectTreeCache = null;
				vscode.postMessage({ type: 'getProjectTree' });
			}
		});
		document.getElementById('btn-close-detail').addEventListener('click', () => {
			closeDetail();
		});
		document.getElementById('btn-detail-open-vscode').addEventListener('click', () => {
			if (selectedProjectId) {
				vscode.postMessage({ type: 'open-project', payload: { path: getSelectedProjectPath() } });
			}
		});
		document.getElementById('btn-detail-open-terminal').addEventListener('click', () => {
			if (selectedProjectId) {
				vscode.postMessage({ type: 'open-terminal', payload: { path: getSelectedProjectPath() } });
			}
		});

		let _projectsCache = [];

		function getSelectedProjectPath() {
			const p = _projectsCache.find(p => p.id === selectedProjectId);
			return p ? p.path : '';
		}

		function closeDetail() {
			document.getElementById('project-detail-pane').style.display = 'none';
			document.querySelectorAll('.project-card').forEach(c => c.classList.remove('selected'));
			selectedProjectId = null;
		}

		// ---- T2.1/T2.2: プロジェクト一覧レンダリング ----
		function renderProjects(projects) {
			_projectsCache = projects || [];
			const list = document.getElementById('project-list');
			if (!projects || projects.length === 0) {
				list.innerHTML = '<div class="placeholder"><div class="icon">📁</div><div>プロジェクトがありません<br><small>＋ 追加でフォルダを登録できます</small></div></div>';
				return;
			}

			list.innerHTML = '';
			const currentItems = projects.filter(p => p.isCurrent);
			const otherItems   = projects.filter(p => !p.isCurrent);

			function renderSection(items, label) {
				if (items.length === 0) return;
				const hdr = document.createElement('div');
				hdr.className = 'section-header';
				hdr.textContent = label;
				list.appendChild(hdr);

				const grid = document.createElement('div');
				grid.className = 'project-grid';
				items.forEach(p => grid.appendChild(makeProjectCard(p)));
				list.appendChild(grid);
			}

			renderSection(currentItems, '現在のプロジェクト');
			renderSection(otherItems, 'その他');
		}

		function makeProjectCard(p) {
			const card = document.createElement('div');
			card.className = 'project-card';
			card.dataset.id = p.id;
			card.setAttribute('role', 'button');
			card.setAttribute('aria-label', p.name + 'プロジェクト');
			card.title = p.path;

			const currentBadge = p.isCurrent ? '<span class="badge badge-current">現在</span>' : '';
			const sourceBadge  = p.source === 'manual' ? '<span class="badge badge-manual">手動</span>' : '';

			card.innerHTML =
				'<div class="project-card-header">' +
					'<span style="font-size:14px;" aria-hidden="true">📁</span>' +
					'<span class="project-card-name">' + escHtml(p.name) + '</span>' +
					'<div class="project-card-badges">' + currentBadge + sourceBadge + '</div>' +
				'</div>' +
				'<div class="project-card-path">' + escHtml(shortenPath(p.path)) + '</div>' +
				'<div class="project-card-actions">' +
					'<button class="project-card-btn" data-action="select">詳細</button>' +
					'<button class="project-card-btn" data-action="vscode">VS Code</button>' +
					'<button class="project-card-btn" data-action="terminal">端末</button>' +
					(p.source === 'manual' ? '<button class="project-card-btn danger" data-action="remove">削除</button>' : '') +
				'</div>';

			card.addEventListener('click', (e) => {
				const action = e.target.dataset && e.target.dataset.action;
				if (action === 'vscode') {
					vscode.postMessage({ type: 'open-project', payload: { path: p.path } });
					return;
				}
				if (action === 'terminal') {
					vscode.postMessage({ type: 'open-terminal', payload: { path: p.path } });
					return;
				}
				if (action === 'remove') {
					vscode.postMessage({ type: 'remove-project', payload: { id: p.id } });
					if (selectedProjectId === p.id) { closeDetail(); }
					return;
				}
				// カード全体クリック or 詳細ボタン → 詳細ペイン
				document.querySelectorAll('.project-card').forEach(c => c.classList.remove('selected'));
				card.classList.add('selected');
				selectedProjectId = p.id;
				document.getElementById('project-detail-pane').style.display = 'block';
				document.getElementById('detail-project-name').textContent = p.name;
				// メタデータ描画 (T2.3)
				renderDetailMeta(p);
				// 詳細データ要求
				vscode.postMessage({ type: 'select-project', payload: { id: p.id } });
			});

			return card;
		}

		// ---- T2.3: 詳細ペイン — 概要 ----
		function renderDetailMeta(p) {
			const el = document.getElementById('detail-meta');
			const rows = [
				['パス', p.path],
				['ソース', p.source === 'workspace' ? 'ワークスペース' : p.source === 'manual' ? '手動登録' : 'Claudeプロジェクト'],
				['登録日', p.addedAt ? new Date(p.addedAt).toLocaleDateString('ja-JP') : '-'],
			];
			el.innerHTML = rows.map(([label, value]) =>
				'<div class="detail-meta-row">' +
					'<span class="detail-meta-label">' + escHtml(label) + '</span>' +
					'<span class="detail-meta-value">' + escHtml(String(value)) + '</span>' +
				'</div>'
			).join('');
		}

		// ---- T2.7: 進捗ダッシュボード ----
		function renderDetailProgress(progress) {
			const el = document.getElementById('detail-progress');
			if (!progress) { el.innerHTML = '<div class="info-text">データなし</div>'; return; }

			const totalPending = progress.todos.reduce((s, t) => s + t.pending, 0);
			const totalDone    = progress.todos.reduce((s, t) => s + t.done, 0);
			const totalAll     = totalPending + totalDone;
			const pct = totalAll > 0 ? Math.round(totalDone / totalAll * 100) : 0;

			let html = '<div class="progress-stat">' +
				'<span class="progress-stat-item"><span class="stat-dot stat-dot-todo"></span>TODO残 ' + totalPending + '件</span>' +
				'<span class="progress-stat-item"><span class="stat-dot stat-dot-done"></span>完了 ' + totalDone + '件</span>' +
				'<span class="progress-stat-item"><span class="stat-dot stat-dot-pending"></span>確認待ち ' +
					progress.pendingTasks.reduce((s, t) => s + t.count, 0) + '件</span>' +
			'</div>';

			if (totalAll > 0) {
				html += '<div class="progress-bar-wrap" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
					'<div class="progress-bar-fill" style="width:' + pct + '%;"></div>' +
				'</div>' +
				'<div style="font-size:10px; color:var(--vscode-descriptionForeground); text-align:right;">' + pct + '% 完了</div>';
			}

			if (progress.history && progress.history.length > 0) {
				html += '<div style="margin-top:6px; font-size:10px; font-weight:600; color:var(--vscode-descriptionForeground);">直近履歴</div>';
				html += progress.history.slice(0, 5).map(h =>
					'<div class="history-item">' +
						'<span class="history-agent">' + escHtml(h.agent) + '</span>' +
						'<span class="history-text">' + escHtml(h.lastEntry) + '</span>' +
					'</div>'
				).join('');
			}

			el.innerHTML = html;
		}

		// ---- T2.4: 紐づけエージェント管理 ----
		function renderDetailAgents(assignedNames, allAgents, projectId) {
			const assignedEl   = document.getElementById('detail-assigned-agents');
			const candidatesEl = document.getElementById('detail-agent-candidates');

			// 割当済みチップ
			if (assignedNames.length === 0) {
				assignedEl.innerHTML = '<div class="info-text">割当なし</div>';
			} else {
				assignedEl.innerHTML = '';
				const wrap = document.createElement('div');
				wrap.className = 'agent-assign-list';
				assignedNames.forEach(name => {
					const chip = document.createElement('span');
					chip.className = 'agent-chip';
					chip.innerHTML = escHtml(name) + ' <span class="agent-chip-remove" aria-label="' + escHtml(name) + 'を解除">✕</span>';
					chip.title = name + ' — クリックで解除';
					chip.addEventListener('click', () => {
						vscode.postMessage({ type: 'unassign-agent', payload: { projectId, agentName: name } });
					});
					wrap.appendChild(chip);
				});
				assignedEl.appendChild(wrap);
			}

			// 未割当候補
			const unassigned = allAgents.filter(a => !assignedNames.includes(a.name));
			if (unassigned.length === 0) {
				candidatesEl.innerHTML = '<div class="info-text">すべてのエージェントが割当済みです</div>';
			} else {
				candidatesEl.innerHTML = '';
				const wrap = document.createElement('div');
				wrap.className = 'agent-assign-list';
				unassigned.slice(0, 10).forEach(a => {
					const btn = document.createElement('button');
					btn.className = 'agent-assign-item';
					btn.textContent = '＋ ' + (a.displayName || a.name);
					btn.title = a.role || a.name;
					btn.setAttribute('aria-label', (a.displayName || a.name) + 'を割当');
					btn.addEventListener('click', () => {
						vscode.postMessage({ type: 'assign-agent', payload: { projectId, agentName: a.name } });
					});
					wrap.appendChild(btn);
				});
				candidatesEl.appendChild(wrap);
			}
		}

		// ---- T2.5: メモリ管理 ----
		function renderDetailMemory(memoryGroups, globalFiles) {
			const el = document.getElementById('detail-memory');
			let html = '';

			if (globalFiles && globalFiles.length > 0) {
				html += '<div style="font-size:10px; font-weight:600; color:var(--vscode-descriptionForeground); margin-bottom:3px;">グローバル</div>';
				html += globalFiles.map(f => renderMemoryItem(f)).join('');
			}

			if (memoryGroups && memoryGroups.length > 0) {
				memoryGroups.forEach(g => {
					if (g.files && g.files.length > 0) {
						html += '<div style="font-size:10px; font-weight:600; color:var(--vscode-descriptionForeground); margin:5px 0 3px;">' + escHtml(g.project) + '</div>';
						html += g.files.map(f => renderMemoryItem(f)).join('');
					}
				});
			}

			if (!html) { html = '<div class="info-text">メモリファイルなし</div>'; }
			el.innerHTML = html;
		}

		function renderMemoryItem(f) {
			const typeClass = 'memory-type-' + (f.type || 'project');
			return '<div class="memory-item">' +
				'<span class="memory-type-badge ' + typeClass + '">' + escHtml(f.type || 'project') + '</span>' +
				'<span class="memory-name">' + escHtml(f.name) + '</span>' +
				(f.description ? ' <span class="memory-desc">— ' + escHtml(f.description) + '</span>' : '') +
			'</div>';
		}

		// ---- T2.21: ミニ組織図 ----
		function renderDetailMiniOrg(nodes) {
			const el = document.getElementById('detail-mini-org');
			if (!nodes || nodes.length === 0) {
				el.innerHTML = '<div class="info-text">割当エージェントなし</div>';
				return;
			}

			// 簡易ツリー: parent=null → ルート、それ以外 → 子
			const roots   = nodes.filter(n => !n.parent);
			const children = nodes.filter(n => n.parent);

			function modelClass(model) {
				if (model === 'opus')  return 'model-opus';
				if (model === 'haiku') return 'model-haiku';
				return 'model-sonnet';
			}

			function nodeHtml(n, indent) {
				const indentClass = indent === 1 ? 'indent-1' : indent === 2 ? 'indent-2' : '';
				const prefix = indent > 0 ? '<span class="mini-org-indent">└─</span>' : '';
				return '<div class="mini-org-node ' + indentClass + '">' +
					prefix +
					'<span class="mini-org-model model-badge ' + modelClass(n.model) + '">' + escHtml(n.model) + '</span>' +
					'<span class="mini-org-name" title="' + escHtml(n.role || n.id) + '">' + escHtml(n.label || n.id) + '</span>' +
				'</div>';
			}

			let html = '<div class="mini-org-tree">';
			for (const root of roots) {
				html += nodeHtml(root, 0);
				const level1 = children.filter(c => c.parent === root.id);
				for (const c1 of level1) {
					html += nodeHtml(c1, 1);
					const level2 = children.filter(c => c.parent === c1.id);
					for (const c2 of level2) {
						html += nodeHtml(c2, 2);
					}
				}
			}
			// 孤立ノード（parent指定あるが実際の親が一覧にない）
			const rootIds = new Set(roots.map(r => r.id));
			const orphans = children.filter(c => !rootIds.has(c.parent));
			for (const o of orphans) {
				html += nodeHtml(o, 0);
			}
			html += '</div>';
			el.innerHTML = html;
		}

		// ================================================================
		// エージェントタブ (T2.12〜T2.15)
		// ================================================================

		let _agentsCache = [];
		let _activeFilters = { model: null, scope: null, parent: null };

		// ---- T2.14: フィルタチップ初期化 ----
		function initFilterChips(agents) {
			const models  = [...new Set(agents.map(a => a.model))].sort();
			const scopes  = [...new Set(agents.map(a => a.scope || 'global'))].sort();
			const parents = [...new Set(agents.filter(a => a.parentAgent).map(a => a.parentAgent))].sort();

			renderChips('filter-model-chips',  models,  'model');
			renderChips('filter-scope-chips',  scopes,  'scope');
			renderChips('filter-parent-chips', parents, 'parent');
		}

		function renderChips(containerId, values, filterKey) {
			const container = document.getElementById(containerId);
			container.innerHTML = '';
			values.forEach(v => {
				const chip = document.createElement('button');
				chip.className = 'filter-chip';
				chip.textContent = v;
				chip.dataset.value = v;
				chip.setAttribute('aria-pressed', 'false');
				chip.addEventListener('click', () => {
					const isActive = chip.classList.contains('active');
					// 同グループの他をクリア
					container.querySelectorAll('.filter-chip').forEach(c => {
						c.classList.remove('active');
						c.setAttribute('aria-pressed', 'false');
					});
					if (!isActive) {
						chip.classList.add('active');
						chip.setAttribute('aria-pressed', 'true');
						_activeFilters[filterKey] = v;
					} else {
						_activeFilters[filterKey] = null;
					}
					renderAgentLists(_agentsCache);
				});
				container.appendChild(chip);
			});
		}

		document.getElementById('btn-clear-filters').addEventListener('click', () => {
			_activeFilters = { model: null, scope: null, parent: null };
			document.querySelectorAll('.filter-chip').forEach(c => {
				c.classList.remove('active');
				c.setAttribute('aria-pressed', 'false');
			});
			renderAgentLists(_agentsCache);
		});

		// T3.13: 組織診断ボタン
		document.getElementById('btn-run-org-builder').addEventListener('click', () => {
			vscode.postMessage({ type: 'run-org-builder' });
		});

		function applyFilters(agents) {
			return agents.filter(a => {
				if (_activeFilters.model  && a.model !== _activeFilters.model)  return false;
				if (_activeFilters.scope  && (a.scope || 'global') !== _activeFilters.scope) return false;
				if (_activeFilters.parent && a.parentAgent !== _activeFilters.parent) return false;
				return true;
			});
		}

		// ---- T2.12〜T2.15: エージェント一覧レンダリング ----
		function renderAgentData(data) {
			_agentsCache = data.agents || [];
			initFilterChips(_agentsCache);

			// T2.12: ブックマーク
			renderAgentSection('agent-bookmarks-list',
				_agentsCache.filter(a => a.bookmarked),
				'まだブックマークがありません'
			);

			// T2.13: 最終使用日 Top5
			const recentNames = data.recentNames || [];
			const recentAgents = recentNames
				.map(n => _agentsCache.find(a => a.name === n))
				.filter(Boolean);
			renderAgentSection('agent-recent-list',
				recentAgents,
				'使用履歴がありません',
				true
			);

			renderAgentLists(_agentsCache);
		}

		function renderAgentLists(agents) {
			const filtered = applyFilters(agents);

			// T2.15: グローバル/プロジェクト分離
			const globalAgents  = filtered.filter(a => (a.scope || 'global') === 'global');
			const projectAgents = filtered.filter(a => a.scope === 'project');

			renderAgentSection('agent-global-list',  globalAgents,  'グローバルエージェントなし');
			renderAgentSection('agent-project-list', projectAgents, 'プロジェクトエージェントなし');

			// プロジェクトセクションヘッダーを出し入れ
			const pHdr = document.getElementById('agent-project-header');
			if (pHdr) pHdr.style.display = projectAgents.length > 0 ? 'block' : 'none';
		}

		function renderAgentSection(containerId, agents, emptyMsg, showLastUsed) {
			const el = document.getElementById(containerId);
			if (!agents || agents.length === 0) {
				el.innerHTML = '<div style="font-size:10px; color:var(--vscode-descriptionForeground); padding:4px 6px;">' + escHtml(emptyMsg) + '</div>';
				return;
			}
			el.innerHTML = '';
			agents.forEach(a => el.appendChild(makeAgentItem(a, showLastUsed)));
		}

		function makeAgentItem(a, showLastUsed) {
			const item = document.createElement('div');
			item.className = 'agent-item';
			item.setAttribute('role', 'listitem');

			// T2.15: グローバルバッジ or プロジェクト名ラベル
			const scopeHtml = a.scope === 'project'
				? '<span class="scope-badge scope-project" title="プロジェクトスコープ">proj</span>'
				: '<span class="scope-badge scope-global" title="グローバルスコープ">🌐</span>';

			const modelClass = 'model-' + (a.model === 'sonnet-1m' ? 'sonnet' : (a.model || 'sonnet'));
			const modelBadge = '<span class="model-badge ' + modelClass + '">' + escHtml(a.model || 'sonnet') + '</span>';

			const lastUsedHtml = showLastUsed && a.lastUsed
				? ' <span style="font-size:10px; color:var(--vscode-descriptionForeground);">(' + escHtml(a.lastUsedLabel) + ')</span>'
				: '';

			// T2.12: ブックマークボタン
			const bookmarkBtn = document.createElement('button');
			bookmarkBtn.className = 'bookmark-btn' + (a.bookmarked ? ' bookmarked' : '');
			bookmarkBtn.textContent = a.bookmarked ? '★' : '☆';
			bookmarkBtn.title = a.bookmarked ? 'ブックマーク解除' : 'ブックマーク追加';
			bookmarkBtn.setAttribute('aria-label', (a.bookmarked ? 'ブックマーク解除: ' : 'ブックマーク追加: ') + a.name);
			bookmarkBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: 'toggle-bookmark-agent', payload: { agentName: a.name } });
			});

			item.innerHTML =
				'<div class="agent-info">' +
					'<div class="agent-name">' + escHtml(a.displayName || a.name) + lastUsedHtml + '</div>' +
					'<div class="agent-meta">' + escHtml(a.displayRole || a.role || '') + '</div>' +
				'</div>' +
				'<div class="agent-badges">' + scopeHtml + modelBadge + '</div>';

			item.appendChild(bookmarkBtn);

			item.addEventListener('click', () => {
				vscode.postMessage({ type: 'open-agent-session', payload: { agentName: a.name } });
			});

			return item;
		}

		// ================================================================
		// メッセージ受信
		// ================================================================
		window.addEventListener('message', event => {
			const msg = event.data;
			switch (msg.type) {

				case 'sessions-data':
					renderSessionsData(msg);
					break;

				case 'memories-data':
					renderMemoriesData(msg);
					break;

				case 'projects-data':
					renderProjects(msg.projects);
					// ツリーモードで起動した場合はツリーデータも要求
					if (_projectMode === 'tree' && !_projectTreeCache) {
						vscode.postMessage({ type: 'getProjectTree' });
					}
					break;

				case 'project-tree-data':
					renderProjectTree(msg.trees);
					break;

				case 'project-detail':
					// T2.3: 概要（既にrenderDetailMetaが呼ばれているので更新のみ）
					renderDetailMeta(msg.project);
					// T2.7: 進捗
					renderDetailProgress(msg.progress);
					// T2.4: エージェント割当
					renderDetailAgents(msg.assignedAgentNames, msg.allAgents, msg.project.id);
					// T2.21: ミニ組織図
					renderDetailMiniOrg(msg.miniOrgNodes || []);
					// T2.5: メモリ
					renderDetailMemory(msg.memoryGroups, msg.globalMemoryFiles);
					break;

				case 'agents-data':
					renderAgentData(msg);
					break;

				case 'bookmark-updated':
					// 即時UI反映（再レンダリングより軽量）
					if (_agentsCache.length > 0) {
						const agent = _agentsCache.find(a => a.name === msg.agentName);
						if (agent) { agent.bookmarked = msg.bookmarked; }
					}
					break;
			}
		});

		// ================================================================
		// ユーティリティ
		// ================================================================
		function escHtml(str) {
			if (!str) return '';
			return String(str)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');
		}

		function shortenPath(p) {
			if (p.startsWith(HOME)) { return '~' + p.slice(HOME.length); }
			return p;
		}

		// ---- TT1: 保存モードを初期適用（カード以外の場合のみ） ----
		if (_projectMode === 'tree') {
			applyProjectMode('tree');
		}

		// ---- 準備完了 ----
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

interface WebviewMessage {
	type: string;
	payload?: Record<string, unknown>;
}

// -------------------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------------------

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars[Math.floor(Math.random() * chars.length)];
	}
	return nonce;
}
