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
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private onLiveChangeCallback: (() => void) | undefined;
	// 親セッションID → 子エージェントセッション[] のマップ
	private subagentMap: Map<string, ParsedSession[]> = new Map();
	// ソートモード
	private sortMode: 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model' = 'updated-desc';
	// グループモード
	private groupMode: 'date' | 'tag' | 'agent' | 'flat' = 'date';

	// プレビュー中のセッションを設定
	setActiveSession(sessionId: string): void {
		this.previewSessionId = sessionId;
		this._onDidChangeTreeData.fire(undefined);
	}

	getActiveSessionId(): string | undefined {
		return this.previewSessionId;
	}

	// ソートモード設定
	setSortMode(mode: 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model'): void {
		this.sortMode = mode;
		const target = this.filteredSessions || this.sessions;
		this.sortSessions(target);
		this.buildGroups(target);
		this._onDidChangeTreeData.fire(undefined);
	}

	// グループモード設定
	setGroupMode(mode: 'date' | 'tag' | 'agent' | 'flat'): void {
		this.groupMode = mode;
		const target = this.filteredSessions || this.sessions;
		this.buildGroups(target);
		this._onDidChangeTreeData.fire(undefined);
	}

	// ライブセッション変化時のコールバック設定（ステータスバー更新用）
	onLiveChange(callback: () => void): void {
		this.onLiveChangeCallback = callback;
	}

	// sessions/ ディレクトリを監視してライブセッションを自動検出
	startWatching(): void {
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		if (!fs.existsSync(sessionsDir)) { return; }

		this.updateLiveSessions(sessionsDir);

		// fs.watch によるリアルタイム監視
		try {
			this.watcher = fs.watch(sessionsDir, () => {
				this.updateLiveSessions(sessionsDir);
				this._onDidChangeTreeData.fire(undefined);
				this.onLiveChangeCallback?.();
			});
		} catch {
			// watchが使えない環境もある
		}

		// フォールバック: 設定値に応じた間隔のポーリング（Windowsでfs.watchイベントが漏れる対策）
		const intervalSec = vscode.workspace.getConfiguration('claudeManager').get<number>('agentMonitorInterval', 5);
		this.pollTimer = setInterval(() => {
			const prevSize = this.liveSessionIds.size;
			const prevIds = new Set(this.liveSessionIds);
			this.updateLiveSessions(sessionsDir);
			// 変化があった場合のみツリーを更新
			if (this.liveSessionIds.size !== prevSize ||
				[...this.liveSessionIds].some((id) => !prevIds.has(id))) {
				this._onDidChangeTreeData.fire(undefined);
				this.onLiveChangeCallback?.();
			}
		}, intervalSec * 1000);
	}

	stopWatching(): void {
		this.watcher?.close();
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	// PIDが生存しているか確認
	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0); // シグナル0 = 存在確認のみ
			return true;
		} catch {
			return false;
		}
	}

	private updateLiveSessions(sessionsDir: string): void {
		this.liveSessionIds.clear();
		try {
			const files = fs.readdirSync(sessionsDir);
			for (const file of files) {
				if (!file.endsWith('.json')) { continue; }
				const filePath = path.join(sessionsDir, file);
				try {
					const content = fs.readFileSync(filePath, 'utf-8');
					const data = JSON.parse(content);
					if (!data.sessionId) { continue; }

					// PIDが記録されている場合、プロセス生存を確認
					if (data.pid && !this.isProcessAlive(data.pid)) {
						// プロセス終了済み → ゾンビJSONを削除
						try { fs.unlinkSync(filePath); } catch { /* 削除失敗は無視 */ }
						continue;
					}

					this.liveSessionIds.add(data.sessionId);
				} catch {
					// 読み込み/パースエラーはスキップ
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
		const maxSessions = vscode.workspace.getConfiguration('claudeManager').get<number>('maxSessionsShown', 500);
		const allSessions = loadAllSessions(maxSessions);
		const customNames = dataStore.getAllCustomNames();

		// サブエージェントマップを構築
		this.subagentMap.clear();
		const parentSessions: ParsedSession[] = [];

		for (const session of allSessions) {
			if (customNames[session.id]) {
				session.customName = customNames[session.id];
			}
			if (session.isSidechain && session.parentSessionId) {
				// 子エージェント: 親IDでグループ化
				const children = this.subagentMap.get(session.parentSessionId) || [];
				children.push(session);
				this.subagentMap.set(session.parentSessionId, children);
			} else {
				// 親セッション
				parentSessions.push(session);
			}
		}

		this.sessions = parentSessions;
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

	// 全セッション（子エージェント含む）を取得
	getAllSessionsIncludingSubagents(): ParsedSession[] {
		const all = [...this.sessions];
		for (const children of this.subagentMap.values()) {
			all.push(...children);
		}
		return all;
	}

	// 親セッションのサブエージェントを取得
	getSubagents(parentId: string): ParsedSession[] {
		return this.subagentMap.get(parentId) || [];
	}

	// 親セッションにサブエージェントがあるか
	hasSubagents(parentId: string): boolean {
		const children = this.subagentMap.get(parentId);
		return !!children && children.length > 0;
	}

	getSessionById(id: string): ParsedSession | undefined {
		// 親セッションから探す
		const parent = this.sessions.find((s) => s.id === id);
		if (parent) { return parent; }
		// 子エージェントからも探す
		for (const children of this.subagentMap.values()) {
			const child = children.find((s) => s.id === id);
			if (child) { return child; }
		}
		return undefined;
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeNode): TreeNode[] {
		if (this.sessions.length === 0) {
			this.refresh();
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
				const hasChildren = this.hasSubagents(session.id);
				return new SessionItem(session, isBookmarked, tags, isPreviewing, isLive, false, hasChildren);
			});
		}

		// SessionItemの子 = サブエージェント
		if (element instanceof SessionItem && !element.session.isSidechain) {
			const parentId = element.session.id;
			const children = this.getSubagents(parentId);
			return children.map((child) => {
				const isPreviewing = child.id === this.previewSessionId;
				return new SessionItem(child, false, [], isPreviewing, false, false, false);
			});
		}

		return [];
	}

	// ソート適用
	private sortSessions(sessions: ParsedSession[]): void {
		switch (this.sortMode) {
			case 'updated-desc':
				sessions.sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime());
				break;
			case 'updated-asc':
				sessions.sort((a, b) => a.lastTimestamp.getTime() - b.lastTimestamp.getTime());
				break;
			case 'created-desc':
				sessions.sort((a, b) => b.firstTimestamp.getTime() - a.firstTimestamp.getTime());
				break;
			case 'created-asc':
				sessions.sort((a, b) => a.firstTimestamp.getTime() - b.firstTimestamp.getTime());
				break;
			case 'name':
				sessions.sort((a, b) => {
					const na = a.customName || a.claudeTitle || a.firstMessage;
					const nb = b.customName || b.claudeTitle || b.firstMessage;
					return na.localeCompare(nb, 'ja');
				});
				break;
			case 'count':
				sessions.sort((a, b) => b.messageCount - a.messageCount);
				break;
			case 'model':
				sessions.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
				break;
		}
	}

	private buildGroups(sessions: ParsedSession[]): void {
		this.groupedSessions = new Map();

		switch (this.groupMode) {
			case 'flat':
				this.groupedSessions.set('📋 すべて', [...sessions]);
				break;

			case 'tag':
				this.buildTagGroups(sessions);
				break;

			case 'agent':
				this.buildAgentGroups(sessions);
				break;

			case 'date':
			default:
				this.buildDateGroups(sessions);
				break;
		}
	}

	private buildDateGroups(sessions: ParsedSession[]): void {
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

	private buildTagGroups(sessions: ParsedSession[]): void {
		const allTags = dataStore.getAllTags();
		const taggedIds = new Set<string>();

		for (const [tag, ids] of Object.entries(allTags)) {
			const grouped = sessions.filter((s) => ids.includes(s.id));
			if (grouped.length > 0) {
				this.groupedSessions.set(`🏷️ ${tag}`, grouped);
				grouped.forEach((s) => taggedIds.add(s.id));
			}
		}

		// タグなし
		const untagged = sessions.filter((s) => !taggedIds.has(s.id));
		if (untagged.length > 0) {
			this.groupedSessions.set('🏷️ タグなし', untagged);
		}
	}

	private buildAgentGroups(sessions: ParsedSession[]): void {
		const agentSessions = new Map<string, ParsedSession[]>();
		const unlinked: ParsedSession[] = [];

		for (const session of sessions) {
			const agent = dataStore.getAgentBySessionId(session.id);
			if (agent) {
				const key = `🤖 ${agent.name}`;
				if (!agentSessions.has(key)) {
					agentSessions.set(key, []);
				}
				agentSessions.get(key)!.push(session);
			} else {
				unlinked.push(session);
			}
		}

		for (const [key, group] of agentSessions) {
			this.groupedSessions.set(key, group);
		}
		if (unlinked.length > 0) {
			this.groupedSessions.set('🤖 未紐づけ', unlinked);
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

// サブエージェントタイプ別のアイコン
function getAgentTypeIcon(agentType?: string): { icon: string; color: string } {
	switch (agentType) {
		case 'Explore': return { icon: 'search', color: 'charts.blue' };
		case 'Plan': return { icon: 'notebook', color: 'charts.purple' };
		case 'general-purpose': return { icon: 'tools', color: 'charts.orange' };
		case 'claude-code-guide': return { icon: 'book', color: 'charts.green' };
		default: return { icon: 'arrow-small-right', color: 'foreground' };
	}
}

// サブエージェントタイプの短縮ラベル
function agentTypeLabel(agentType?: string): string {
	switch (agentType) {
		case 'Explore': return '🔍探索';
		case 'Plan': return '📋計画';
		case 'general-purpose': return '🔧汎用';
		case 'claude-code-guide': return '📖ガイド';
		default: return '⚡子';
	}
}

export class SessionItem extends vscode.TreeItem {
	constructor(
		public readonly session: ParsedSession,
		public readonly isBookmarked: boolean,
		public readonly tags: string[],
		public readonly isPreviewing: boolean = false,
		public readonly isLive: boolean = false,
		public readonly inBookmarkView: boolean = false,
		public readonly hasChildren: boolean = false
	) {
		const isSub = !!session.isSidechain;

		// 表示名の構築
		let displayName: string;
		if (isSub) {
			// サブエージェント: タイプラベル + description or firstMessage
			const typeTag = agentTypeLabel(session.agentType);
			const desc = session.agentDescription || session.firstMessage;
			displayName = `${typeTag} ${desc}`;
		} else {
			displayName = session.customName || session.claudeTitle || session.firstMessage;
		}

		// モデル頭文字（全角で等幅）— 親セッションのみ
		const modelChar = isSub ? '' : (
			session.model?.includes('opus') ? 'Ｏ'
			: session.model?.includes('sonnet') ? 'Ｓ'
			: session.model?.includes('haiku') ? 'Ｈ'
			: '\u3000'
		);
		// 件数を5桁右揃え（Figure Space U+2007 で等幅パディング）
		const figureSpace = '\u2007';
		const countStr = isSub ? '' : String(session.messageCount).padStart(5, figureSpace) + ' ';

		// サブエージェントがある親は展開可能
		const collapsible = hasChildren
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
		super(`${modelChar}${countStr}${displayName}`, collapsible);

		// 時刻フォーマット
		const date = session.lastTimestamp;
		const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

		// エージェント登録状態（descriptionで使うので先に取得）
		const agentConfig = !isSub ? dataStore.getAgentBySessionId(session.id) : undefined;

		if (isSub) {
			// サブエージェント用のdescription
			this.description = `${session.messageCount}件 ${timeStr}`;
		} else {
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
			const agentLabel = agentConfig ? `🤖${agentConfig.name} ` : '';
			this.description = `${statusPrefix}${agentLabel}${originalMsg ? originalMsg + ' ' : ''}${timeStr} ${modelShort}${tagStr}`;
		}

		// ツールチップ
		if (isSub) {
			this.tooltip = new vscode.MarkdownString(
				`**🤖 子エージェント** (${session.agentType || '不明'})\n\n` +
				(session.agentDescription ? `${session.agentDescription}\n\n` : '') +
				`| | |\n|---|---|\n` +
				`| タイプ | ${session.agentType || '不明'} |\n` +
				`| 日時 | ${date.toLocaleString('ja-JP')} |\n` +
				`| メッセージ | ${session.messageCount}件 |\n` +
				`| モデル | ${session.model || '不明'} |\n` +
				(session.agentId ? `| エージェントID | \`${session.agentId.substring(0, 12)}...\` |\n` : '')
			);
		} else {
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
		}

		const isRegistered = !!agentConfig;
		if (isSub) {
			this.contextValue = 'subagentSession';
		} else if (isRegistered && isBookmarked) {
			this.contextValue = 'sessionRegisteredBookmarked';
		} else if (isRegistered) {
			this.contextValue = 'sessionRegistered';
		} else if (isBookmarked) {
			this.contextValue = 'sessionBookmarked';
		} else {
			this.contextValue = 'session';
		}

		// アイコン
		if (isSub) {
			// サブエージェント: タイプ別アイコン
			const agentIcon = getAgentTypeIcon(session.agentType);
			this.iconPath = new vscode.ThemeIcon(agentIcon.icon, new vscode.ThemeColor(agentIcon.color));
		} else if (isPreviewing && isLive) {
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
