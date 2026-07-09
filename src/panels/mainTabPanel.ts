/**
 * mainTabPanel.ts — v0.5.0 Sprint 2 T2.1〜T2.15
 *
 * v0.5.17 §4-12 で実態に合わせて記述を更新:
 *   本 WebviewView は **プロジェクト詳細タブ専用** のペインになっている。
 *   セッション / エージェント / メモリはそれぞれ独立した TreeView 実装 (sessionTreeProvider,
 *   agentTreeProvider, memoryTreeProvider) で提供され、activeTab の切替で claudeMain の可視性
 *   自体が変わる（package.json の view when 句を参照）。
 *
 * 過去バージョンの「3タブ完全実装」表記は WebView 内でセッション/エージェント/プロジェクトを
 *   統合表示するプロトタイプ実装時の名残。現在は projects ペインのみアクティブに描画される。
 *
 * アーキテクチャ:
 *   - WebviewViewProvider として登録
 *   - activeTab='projects' の間だけ表示される（claudeTabBar TreeView が切替の実体）
 *   - プロジェクト一覧のデータ取得は postMessage でサービス層に委譲
 *   - TreeView providers はそのまま残す（セッション/エージェント/メモリの本体）
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
import { showProjectDetail } from './projectDetailPanel';
import { generateModelCss } from '../models/modelCatalog';

// -------------------------------------------------------------------
// MainTabPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class MainTabPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'claudeMain';

	private _view?: vscode.WebviewView;
	private readonly _extensionUri: vscode.Uri;
	/** 現在 claudeMain 内でアクティブなタブ (claudeMain は projects 時のみ表示) */
	private _activeTab = 'projects';

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

		// プロジェクトタブが再度表示されたとき projects タブをリセット
		// (claudeMain は activeTab == 'projects' のときのみ表示される)
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this._activeTab = 'projects';
				webviewView.webview.html = this._getHtml(webviewView.webview);
			}
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

			case 'tab-changed': {
				const newTab = String(message.payload?.tab ?? 'projects');
				this._activeTab = newTab;
				// claudeManager.activeTab コンテキストを更新
				// → claudeTabBar の when 句 (activeTab != 'projects') に反映される
				void vscode.commands.executeCommand('setContext', 'claudeManager.activeTab', newTab);
				if (newTab === 'agents') {
					await this._sendAgentsData();
				} else if (newTab === 'memory') {
					await this._sendMemoriesData();
				}
				break;
			}

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
				// T2.8: VS Codeで開く — 別フォルダは常に新ウィンドウ
				if (message.payload?.path) {
					const uri = vscode.Uri.file(String(message.payload.path));
					await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
				}
				break;

			case 'open-project-detail':
				// クリック → 詳細を WebView Editor で開く
				if (message.payload?.id) {
					await this._openProjectDetail(String(message.payload.id));
				}
				break;

			case 'open-explorer':
				// 📂 エクスプローラで開く
				if (message.payload?.path) {
					const explorerUri = vscode.Uri.file(String(message.payload.path));
					await vscode.commands.executeCommand('revealFileInOS', explorerUri);
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
				// 後方互換: open-project-detail に同じ
				if (message.payload?.id) {
					await this._openProjectDetail(String(message.payload.id));
				}
				break;

			case 'assign-agent': {
				// T2.4: エージェント割当
				const { projectId, agentName } = (message.payload ?? {}) as Record<string, string>;
				if (projectId && agentName) {
					await this._assignAgentToProject(projectId, agentName);
					await this._openProjectDetail(projectId);
				}
				break;
			}

			case 'unassign-agent': {
				// T2.4: エージェント解除
				const { projectId: pid, agentName: an } = (message.payload ?? {}) as Record<string, string>;
				if (pid && an) {
					await this._unassignAgentFromProject(pid, an);
					await this._openProjectDetail(pid);
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

			// ---------- アクション行 (tabBarPanel.ts と同一コマンド) ----------

			case 'action-clicked': {
				const actionCmdMap: Record<string, string> = {
					'search-sessions': 'claudeManager.searchSessions',
					'settings':        'claudeManager.openSettings',
					'new-agent':       'claudeManager.addAgent',
					'org-chart':       'claudeManager.openOrgChart',
					'pending-tasks':   'claudeManager.showPendingTasks',
					'merge-memories':  'claudeManager.mergeMemories',
				};
				const act = String(message.payload?.action ?? '');
				const cmd = actionCmdMap[act];
				if (cmd) {
					void vscode.commands.executeCommand(cmd);
				}
				break;
			}
		}
	}

	// ----------------------------------------------------------------
	// データ送信ヘルパー
	// ----------------------------------------------------------------

	private async _sendInitialData(): Promise<void> {
		this._sendProjects();
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

	private async _openProjectDetail(projectId: string): Promise<void> {
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

		showProjectDetail(
			{
				project: {
					id: project.id,
					name: project.name,
					path: project.path,
					source: project.source,
					addedAt: project.addedAt,
					isCurrent: project.isCurrent,
				},
				progress,
				allAgents: allAgents.map(a => ({
					name: a.name,
					displayName: a.displayName,
					role: a.role,
					model: a.model,
				})),
				assignedAgentNames,
				// MiniOrgChartNode.parent は string|null なので undefined に正規化
				miniOrgNodes: miniOrgNodes.map(n => ({
					...n,
					parent: n.parent ?? undefined,
				})),
				memoryGroups: memoryGroups.map(g => ({
					project: g.project,
					files: g.files.map(f => ({ name: f.name, description: f.description, type: f.type })),
				})),
				globalMemoryFiles: globalMemory?.files.map(f => ({
					name: f.name,
					description: f.description,
					type: f.type,
				})) ?? [],
			},
			{
				onOpenInVSCode: async (projectPath) => {
					await vscode.commands.executeCommand(
						'vscode.openFolder',
						vscode.Uri.file(projectPath),
						{ forceNewWindow: true }
					);
				},
				onOpenInTerminal: (projectPath) => {
					const terminal = vscode.window.createTerminal({
						name: project.name,
						cwd: projectPath,
					});
					terminal.show();
				},
				onOpenInExplorer: (projectPath) => {
					void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(projectPath));
				},
				onAssignAgent: async (pid, agentName) => {
					await this._assignAgentToProject(pid, agentName);
					await this._openProjectDetail(pid);
				},
				onUnassignAgent: async (pid, agentName) => {
					await this._unassignAgentFromProject(pid, agentName);
					await this._openProjectDetail(pid);
				},
			}
		);
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

		/* ---- タブバー (tabBarPanel.ts と統一: 36px 高さ) ---- */
		.tab-bar {
			display: flex;
			height: 36px;
			flex-shrink: 0;
			border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d);
			user-select: none;
		}
		.tab-btn {
			flex: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 3px;
			background: transparent;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--vscode-tab-inactiveForeground, #969696);
			cursor: pointer;
			padding: 0 4px;
			font-size: 11px;
			font-family: inherit;
			transition: color 0.1s, border-color 0.1s;
			white-space: nowrap;
			outline: none;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tab-btn:hover {
			color: var(--vscode-tab-activeForeground, #fff);
			background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07));
		}
		.tab-btn.active {
			color: var(--vscode-tab-activeForeground, #fff);
			border-bottom-color: var(--vscode-focusBorder, #007fd4);
		}

		/* ---- タブアクション行 (tabBarPanel.ts と統一: 32px 高さ) ---- */
		.tab-action-bar {
			display: flex;
			height: 32px;
			flex-shrink: 0;
			border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d);
			background: var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,0.1));
		}
		.action-btn-tab {
			flex: 1;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 3px;
			background: transparent;
			border: none;
			border-right: 1px solid var(--vscode-panel-border, #2d2d2d);
			color: var(--vscode-descriptionForeground, #858585);
			cursor: pointer;
			padding: 0 4px;
			font-size: 10px;
			font-family: inherit;
			white-space: nowrap;
			transition: color 0.1s, background 0.1s;
			outline: none;
			min-width: 0;
		}
		.action-btn-tab:last-child { border-right: none; }
		.action-btn-tab:hover {
			color: var(--vscode-foreground, #ccc);
			background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07));
		}
		.action-btn-tab:active {
			background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.12));
		}
		@media (max-width: 200px) {
			.tab-btn .tab-icon { display: none; }
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
		/* v0.5.18 §4-10: メモリタイプ色を charts.* テーマ変数へ */
		.memory-type-user { background: rgba(100,181,246,0.15); color: var(--vscode-charts-blue, #64b5f6); }
		.memory-type-feedback { background: rgba(255,183,77,0.15); color: var(--vscode-charts-orange, #ffb74d); }
		.memory-type-project { background: rgba(129,199,132,0.15); color: var(--vscode-charts-green, #81c784); }
		.memory-type-reference { background: rgba(206,147,216,0.15); color: var(--vscode-charts-purple, #ce93d8); }
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
		/* v0.5.14 レビュー修正 (8): modelCatalog.generateModelCss() から一括生成（[1m] 分も含む） */
		${generateModelCss('model')}
		.scope-badge {
			font-size: 9px;
			padding: 1px 4px;
			border-radius: 3px;
		}
		.scope-global { color: var(--vscode-descriptionForeground); }
		/* v0.5.18 レビュー修正 (6): 隣接する .memory-type-user と同じ charts.blue に統一 */
		.scope-project {
			background: rgba(100,181,246,0.1);
			color: var(--vscode-charts-blue, #64b5f6);
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
		.bookmark-btn.bookmarked { color: var(--vscode-charts-orange, #ffb74d); }

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
		/* v0.5.18 レビュー修正 (6): tag-chip 直書きも charts.blue に統一 */
		.tag-chip {
			font-size: 8px;
			padding: 1px 4px;
			border-radius: 8px;
			background: rgba(100,181,246,0.1);
			color: var(--vscode-charts-blue, #64b5f6);
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
		.session-bm-btn.bookmarked { color: var(--vscode-charts-orange, #ffb74d); }
		.session-model-dot {
			width: 6px;
			height: 6px;
			border-radius: 50%;
			flex-shrink: 0;
			margin-top: 4px;
		}
		/* v0.5.14 レビュー修正 (8): modelCatalog.generateModelCss() から一括生成 */
		${generateModelCss('dot')}
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

		/* ---- プロジェクトコンパクトリスト ---- */
		.project-list-row {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 6px;
			border-bottom: 1px solid var(--vscode-panel-border);
			cursor: pointer;
			min-width: 0;
		}
		.project-list-row:last-child { border-bottom: none; }
		.project-list-row:hover { background: var(--vscode-list-hoverBackground); }
		.project-list-name {
			flex: 1;
			font-size: 11px;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.project-list-actions {
			display: flex;
			gap: 2px;
			flex-shrink: 0;
			opacity: 0;
			transition: opacity 0.1s;
		}
		.project-list-row:hover .project-list-actions { opacity: 1; }
		.project-row-btn {
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
		.project-row-btn:hover {
			background: var(--vscode-list-hoverBackground);
			color: var(--vscode-foreground);
		}
		.project-row-btn.danger:hover {
			background: var(--vscode-inputValidation-errorBackground, rgba(200,0,0,0.1));
			border-color: var(--vscode-errorForeground);
			color: var(--vscode-errorForeground);
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
	<!-- プロジェクトコンテンツ (claudeTabBar TreeView が上部に常時表示) -->
	<div class="tab-content">

		<!-- ===== プロジェクト一覧 (T2.1〜T2.9 / TT1〜TT4) ===== -->
		<div class="tab-pane active" id="pane-projects" role="main">
			<div class="action-bar">
				<button class="btn primary" id="btn-add-project">＋ 追加</button>
				<button class="btn icon-btn" id="btn-refresh-projects" title="更新">↻</button>
				<!-- TT1: モード切替トグル -->
				<div class="project-mode-toggle" role="group" aria-label="表示モード">
					<button class="mode-toggle-btn active" id="btn-mode-card"
						title="コンパクト表示" aria-pressed="true">📋</button>
					<button class="mode-toggle-btn" id="btn-mode-tree"
						title="ツリー表示" aria-pressed="false">🌲</button>
				</div>
			</div>

			<!-- コンパクトリストモード (T2.1/T2.2) — クリックで詳細パネルを開く -->
			<div id="project-list" role="list" aria-label="プロジェクト一覧">
				<div class="placeholder">
					<div class="icon">📁</div>
					<div>読み込み中...</div>
				</div>
			</div>

			<!-- ツリーモード (TT2) -->
			<div id="project-tree" style="display:none;" role="tree" aria-label="プロジェクトツリー">
				<div class="placeholder"><div class="icon">🌲</div><div>読み込み中...</div></div>
			</div>
		</div>

	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const HOME = '${homeDir}';

		// ================================================================
		// プロジェクトタブ初期化
		// ================================================================


		// (セッション/メモリ/エージェントタブは claudeTabBar TreeView 側に移動)

		// ================================================================
		// プロジェクトタブ (T2.1〜T2.9 / TT1〜TT4)
		// ================================================================

		// ---- TT1: モード切替 ----
		const PROJECT_MODE_KEY = 'csm.projectTab.mode';
		let _projectMode = localStorage.getItem(PROJECT_MODE_KEY) || 'tree';
		let _projectTreeCache = null;

		function applyProjectMode(mode) {
			_projectMode = mode;
			localStorage.setItem(PROJECT_MODE_KEY, mode);

			const isCard = mode === 'card';
			document.getElementById('project-list').style.display = isCard ? '' : 'none';
			document.getElementById('project-tree').style.display  = isCard ? 'none' : '';

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
					// 詳細を WebView Editor で開く
					vscode.postMessage({ type: 'open-project-detail', payload: { id: p.projectId } });
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

		let _projectsCache = [];

		// ---- T2.1/T2.2: コンパクトリストレンダリング ----
		// クリックで詳細を WebView Editor (projectDetailPanel) で開く
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
				items.forEach(p => list.appendChild(makeProjectRow(p)));
			}

			renderSection(currentItems, '現在のプロジェクト');
			renderSection(otherItems, 'その他');
		}

		function makeProjectRow(p) {
			const row = document.createElement('div');
			row.className = 'project-list-row';
			row.setAttribute('role', 'listitem');
			row.title = p.path;

			const currentBadge = p.isCurrent ? '<span class="badge badge-current" style="font-size:8px;">現在</span>' : '';
			const manualBadge  = p.source === 'manual' ? '<span class="badge badge-manual" style="font-size:8px;">手動</span>' : '';

			row.innerHTML =
				'<span aria-hidden="true" style="font-size:12px;flex-shrink:0;">📁</span>' +
				'<span class="project-list-name">' + escHtml(p.name) + '</span>' +
				'<span style="display:flex;gap:2px;flex-shrink:0;">' + currentBadge + manualBadge + '</span>' +
				'<div class="project-list-actions">' +
					'<button class="project-row-btn" data-action="detail" aria-label="' + escHtml(p.name) + 'の詳細を開く">詳細</button>' +
					'<button class="project-row-btn" data-action="explorer" aria-label="エクスプローラで開く">📂</button>' +
					(p.source === 'manual' ? '<button class="project-row-btn danger" data-action="remove" aria-label="登録を解除">削除</button>' : '') +
				'</div>';

			row.addEventListener('click', (e) => {
				const btn = e.target.closest('[data-action]');
				const action = btn ? btn.dataset.action : null;
				if (action === 'remove') {
					vscode.postMessage({ type: 'remove-project', payload: { id: p.id } });
					return;
				}
				if (action === 'explorer') {
					vscode.postMessage({ type: 'open-explorer', payload: { path: p.path } });
					return;
				}
				// 行全体クリック or 詳細ボタン → WebView Editor で開く
				vscode.postMessage({ type: 'open-project-detail', payload: { id: p.id } });
			});

			return row;
		}

		// ================================================================
		// メッセージ受信
		// ================================================================
		window.addEventListener('message', event => {
			const msg = event.data;
			switch (msg.type) {

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
