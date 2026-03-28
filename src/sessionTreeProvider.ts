import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession } from './types';
import { loadAllSessions } from './sessionLoader';
import * as dataStore from './dataStore';

// 日付グループヘッダー
export class DateGroupItem extends vscode.TreeItem {
	constructor(public readonly label: string, public readonly sessionCount: number) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${sessionCount}件`;
		this.contextValue = 'dateGroup';
	}
}

type TreeNode = DateGroupItem | SessionItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private sessions: ParsedSession[] = [];
	private filteredSessions: ParsedSession[] | null = null;
	private groupedSessions: Map<string, ParsedSession[]> = new Map();
	private previewSessionId: string | undefined;
	private liveSessionIds: Set<string> = new Set();
	private watcher: fs.FSWatcher | undefined;

	// プレビュー中のセッションを設定
	setActiveSession(sessionId: string): void {
		this.previewSessionId = sessionId;
		this._onDidChangeTreeData.fire(undefined);
	}

	getActiveSessionId(): string | undefined {
		return this.previewSessionId;
	}

	// sessions/ ディレクトリを監視してライブセッションを自動検出
	startWatching(): void {
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		if (!fs.existsSync(sessionsDir)) { return; }

		this.updateLiveSessions(sessionsDir);

		this.watcher = fs.watch(sessionsDir, () => {
			this.updateLiveSessions(sessionsDir);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	stopWatching(): void {
		this.watcher?.close();
	}

	private updateLiveSessions(sessionsDir: string): void {
		this.liveSessionIds.clear();
		try {
			const files = fs.readdirSync(sessionsDir);
			for (const file of files) {
				if (!file.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
					const data = JSON.parse(content);
					if (data.sessionId) {
						this.liveSessionIds.add(data.sessionId);
					}
				} catch {
					// 読み込みエラーはスキップ
				}
			}
		} catch {
			// ディレクトリ読み込みエラー
		}
	}

	isLiveSession(sessionId: string): boolean {
		return this.liveSessionIds.has(sessionId);
	}

	refresh(): void {
		this.sessions = loadAllSessions();
		const customNames = dataStore.getAllCustomNames();
		for (const session of this.sessions) {
			if (customNames[session.id]) {
				session.customName = customNames[session.id];
			}
		}
		this.filteredSessions = null;
		this.buildGroups(this.sessions);
		this._onDidChangeTreeData.fire(undefined);
	}

	setFilter(keyword: string): void {
		if (!keyword) {
			this.filteredSessions = null;
			this.buildGroups(this.sessions);
		} else {
			const lower = keyword.toLowerCase();
			this.filteredSessions = this.sessions.filter((s) =>
				(s.customName || s.firstMessage).toLowerCase().includes(lower) ||
				s.project.toLowerCase().includes(lower) ||
				s.gitBranch?.toLowerCase().includes(lower)
			);
			this.buildGroups(this.filteredSessions);
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	getSessions(): ParsedSession[] {
		return this.sessions;
	}

	getSessionById(id: string): ParsedSession | undefined {
		return this.sessions.find((s) => s.id === id);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (this.sessions.length === 0) {
			this.sessions = loadAllSessions();
			const customNames = dataStore.getAllCustomNames();
			for (const session of this.sessions) {
				if (customNames[session.id]) {
					session.customName = customNames[session.id];
				}
			}
			this.buildGroups(this.sessions);
		}

		if (!element) {
			// 日付グループを返す
			const groups: DateGroupItem[] = [];
			for (const [label, sessions] of this.groupedSessions) {
				groups.push(new DateGroupItem(label, sessions.length));
			}
			return groups;
		}

		if (element instanceof DateGroupItem) {
			const sessions = this.groupedSessions.get(element.label) || [];
			return sessions.map((session) => {
				const isBookmarked = dataStore.isBookmarked(session.id);
				const tags = dataStore.getTagsForSession(session.id);
				const isPreviewing = session.id === this.previewSessionId;
				const isLive = this.liveSessionIds.has(session.id);
				return new SessionItem(session, isBookmarked, tags, isPreviewing, isLive);
			});
		}

		return [];
	}

	private buildGroups(sessions: ParsedSession[]): void {
		this.groupedSessions = new Map();
		const now = new Date();
		const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const yesterdayStart = new Date(todayStart);
		yesterdayStart.setDate(yesterdayStart.getDate() - 1);
		const weekStart = new Date(todayStart);
		weekStart.setDate(weekStart.getDate() - 7);
		const monthStart = new Date(todayStart);
		monthStart.setDate(monthStart.getDate() - 30);

		for (const session of sessions) {
			const t = session.lastTimestamp.getTime();
			let group: string;
			if (t >= todayStart.getTime()) {
				group = '📅 今日';
			} else if (t >= yesterdayStart.getTime()) {
				group = '📅 昨日';
			} else if (t >= weekStart.getTime()) {
				group = '📅 今週';
			} else if (t >= monthStart.getTime()) {
				group = '📅 今月';
			} else {
				group = '📅 それ以前';
			}

			if (!this.groupedSessions.has(group)) {
				this.groupedSessions.set(group, []);
			}
			this.groupedSessions.get(group)!.push(session);
		}
	}
}

// モデル名からアイコンと色を決定
function getModelIcon(model?: string): { icon: string; color: string } {
	if (!model) { return { icon: 'comment-discussion', color: 'foreground' }; }
	if (model.includes('opus')) { return { icon: 'sparkle', color: 'charts.purple' }; }
	if (model.includes('sonnet')) { return { icon: 'zap', color: 'charts.blue' }; }
	if (model.includes('haiku')) { return { icon: 'flame', color: 'charts.green' }; }
	return { icon: 'comment-discussion', color: 'foreground' };
}

export class SessionItem extends vscode.TreeItem {
	constructor(
		public readonly session: ParsedSession,
		public readonly isBookmarked: boolean,
		public readonly tags: string[],
		public readonly isPreviewing: boolean = false,
		public readonly isLive: boolean = false,
		public readonly inBookmarkView: boolean = false
	) {
		const displayName = session.customName || session.claudeTitle || session.firstMessage;
		// モデル頭文字（全角で等幅）
		const modelChar = session.model?.includes('opus') ? 'Ｏ'
			: session.model?.includes('sonnet') ? 'Ｓ'
			: session.model?.includes('haiku') ? 'Ｈ'
			: '\u3000';
		// 件数を5桁右揃え（Figure Space U+2007 で等幅パディング）
		const figureSpace = '\u2007';
		const countStr = String(session.messageCount).padStart(5, figureSpace);
		super(`${modelChar}${countStr} ${displayName}`, vscode.TreeItemCollapsibleState.None);

		// 時刻フォーマット
		const date = session.lastTimestamp;
		const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

		// タグ表示
		const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

		// モデル短縮名
		const modelShort = session.model
			? session.model.replace('claude-', '').replace(/-\d.*$/, '')
			: '';

		// 元のメッセージ（タイトルが変わっている場合のみ表示）
		const hasCustomTitle = !!(session.customName || session.claudeTitle);
		const originalMsg = hasCustomTitle ? session.firstMessage.substring(0, 30) : '';

		// ステータス表示
		const statusPrefix = isLive ? '● ' : '';
		this.description = `${statusPrefix}${originalMsg ? originalMsg + ' ' : ''}${timeStr} ${modelShort}${tagStr}`;

		this.tooltip = new vscode.MarkdownString(
			`${isLive ? '🟢 Claude Codeで使用中\n\n' : ''}` +
			`${isPreviewing ? '▶ プレビュー中\n\n' : ''}` +
			`${isBookmarked ? '★ ' : ''}**${displayName}**\n\n` +
			`| | |\n|---|---|\n` +
			`| プロジェクト | ${session.project} |\n` +
			`| 日時 | ${date.toLocaleString('ja-JP')} |\n` +
			`| メッセージ | ${session.messageCount}件 |\n` +
			`| モデル | ${session.model || '不明'} |\n` +
			(session.gitBranch ? `| ブランチ | ${session.gitBranch} |\n` : '') +
			(tags.length > 0 ? `| タグ | ${tags.join(', ')} |\n` : '')
		);

		this.contextValue = isBookmarked ? 'bookmarkedSession' : 'session';

		// アイコン（形で状態を区別、選択時に白くなっても判別可能）:
		// プレビュー+利用中 → target（緑）
		// 利用中のみ → circle-filled（緑）
		// プレビュー中 → eye（白）
		// ブックマーク → star-full（黄）
		// 通常 → モデル別アイコン
		if (isPreviewing && isLive) {
			this.iconPath = new vscode.ThemeIcon('target', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (isLive) {
			this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (isPreviewing) {
			this.iconPath = new vscode.ThemeIcon('eye', new vscode.ThemeColor('foreground'));
		} else if (isBookmarked && !inBookmarkView) {
			this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
		} else {
			this.iconPath = new vscode.ThemeIcon('primitive-dot', new vscode.ThemeColor('foreground'));
		}

		// 他プロジェクトの色分け用URI
		this.resourceUri = vscode.Uri.parse(`claude-session:///${session.id}?project=${encodeURIComponent(session.project)}`);

		this.command = {
			command: 'claudeManager.previewSession',
			title: '会話をプレビュー',
			arguments: [this],
		};
	}
}

// 他プロジェクトのセッションを薄く表示するデコレーションプロバイダー
export class SessionDecorationProvider implements vscode.FileDecorationProvider {
	private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	private currentProject: string = '';

	constructor() {
		this.updateCurrentProject();
	}

	updateCurrentProject(): void {
		const folders = vscode.workspace.workspaceFolders;
		if (folders && folders.length > 0) {
			this.currentProject = folders[0].uri.fsPath;
		}
	}

	refresh(): void {
		this.updateCurrentProject();
		this._onDidChangeFileDecorations.fire(undefined);
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== 'claude-session') {
			return undefined;
		}

		const params = new URLSearchParams(uri.query);
		const project = params.get('project') || '';

		// 現在のプロジェクトと一致しない場合は薄く表示
		if (this.currentProject && !this.currentProject.toLowerCase().includes(project.toLowerCase()) && !project.toLowerCase().includes(this.currentProject.toLowerCase())) {
			return {
				color: new vscode.ThemeColor('disabledForeground'),
			};
		}

		return undefined;
	}
}
