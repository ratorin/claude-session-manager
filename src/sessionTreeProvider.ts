import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession } from './types';
import { loadAllSessions } from './sessionLoader';
import { getMemoryStats, getMemoryDirs } from './memoryManager';
import * as dataStore from './dataStore';

// メモリ行数インジケーター
export class MemoryIndicatorItem extends vscode.TreeItem {
	constructor() {
		const dirs = getMemoryDirs();
		let totalLines = 0;
		const maxLines = 200;
		for (const dir of dirs) {
			const stats = getMemoryStats(dir);
			totalLines += stats.indexLines;
		}
		const pct = Math.round((totalLines / maxLines) * 100);
		const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));

		super(`${bar} ${totalLines}/${maxLines}行 (${pct}%)`, vscode.TreeItemCollapsibleState.None);

		if (pct >= 80) {
			this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
		} else {
			this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
		}
		this.tooltip = `MEMORY.md インデックス使用率: ${totalLines}/${maxLines}行 (${pct}%)`;
		this.contextValue = 'indicator';
	}
}

// 日付グループヘッダー
export class DateGroupItem extends vscode.TreeItem {
	constructor(public readonly label: string, public readonly sessionCount: number) {
		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${sessionCount}件`;
		this.contextValue = 'dateGroup';
	}
}

type TreeNode = MemoryIndicatorItem | DateGroupItem | SessionItem;

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
			const items: TreeNode[] = [];
			// メモリ行数インジケーター
			items.push(new MemoryIndicatorItem());
			// 日付グループ
			for (const [label, sessions] of this.groupedSessions) {
				items.push(new DateGroupItem(label, sessions.length));
			}
			return items;
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
		public readonly isLive: boolean = false
	) {
		const displayName = session.customName || session.claudeTitle || session.firstMessage;
		super(displayName, vscode.TreeItemCollapsibleState.None);

		// 時刻フォーマット
		const date = session.lastTimestamp;
		const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

		// タグ表示
		const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';

		// モデル短縮名
		const modelShort = session.model
			? session.model.replace('claude-', '').replace(/-\d.*$/, '')
			: '';

		// ステータス表示
		const statusPrefix = isLive ? '● ' : '';
		this.description = `${statusPrefix}${timeStr} ${session.messageCount}件 ${modelShort}${tagStr}`;

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

		// アイコン:
		// プレビュー+利用中 → 緑の三角
		// 利用中のみ → 緑の丸
		// プレビュー中のみ → 白い再生
		// ブックマーク → 黄色の星
		// 通常 → モデル別アイコン
		if (isPreviewing && isLive) {
			this.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (isLive) {
			this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (isPreviewing) {
			this.iconPath = new vscode.ThemeIcon('play', new vscode.ThemeColor('foreground'));
		} else if (isBookmarked) {
			this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
		} else {
			const { icon, color } = getModelIcon(session.model);
			this.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
		}

		this.command = {
			command: 'claudeManager.previewSession',
			title: '会話をプレビュー',
			arguments: [this],
		};
	}
}
