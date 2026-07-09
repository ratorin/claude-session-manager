import * as vscode from 'vscode';
import * as path from 'path';
import { ParsedSession } from '../models/types';
import { loadAllSessions, invalidateSessionCache } from '../utils/sessionLoader';
import { getModelChar, getModelIconAndColor } from '../models/modelCatalog';
import { isContainedIn } from '../utils/pathUtils';
import * as dataStore from '../models/dataStore';

// 日付グループヘッダー
// v0.5.17 §4-6: 設定 `claudeManager.sessions.expandRecentDateGroupsOnly` (既定 true) が有効なら
//   「今日 / 昨日」ラベルのみ Expanded、それ以外は Collapsed で表示する。
//   ラベルの日本語（今日/昨日）は buildGroups で生成されるので、そこと同じ判定文字列を使用。
const RECENT_DATE_LABELS = new Set(['今日', '昨日']);
export class DateGroupItem extends vscode.TreeItem {
	constructor(public readonly label: string, public readonly sessionCount: number) {
		const expandOnlyRecent = vscode.workspace.getConfiguration('claudeManager')
			.get<boolean>('sessions.expandRecentDateGroupsOnly', true);
		const shouldExpand = expandOnlyRecent
			? RECENT_DATE_LABELS.has(label)
			: true;
		super(label, shouldExpand
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.Collapsed);
		this.description = `${sessionCount}件`;
		this.contextValue = 'dateGroup';
	}
}

type TreeNode = DateGroupItem | SessionItem;

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	// セッションロード完了イベント（bookmark/tagプロバイダーのリフレッシュ用）
	private _onDidRefresh = new vscode.EventEmitter<void>();
	readonly onDidRefresh = this._onDidRefresh.event;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		this._onDidRefresh.dispose();
	}

	private sessions: ParsedSession[] = [];
	private allParentSessions: ParsedSession[] = []; // フィルター前の全親セッション
	private filteredSessions: ParsedSession[] | null = null;
	private groupedSessions: Map<string, ParsedSession[]> = new Map();
	private previewSessionId: string | undefined;
	// ライブセッションIDセット（外部の AgentMonitor から setLiveSessionIds() で受け取る）
	private liveSessionIds = new Set<string>();
	// 親セッションID → 子エージェントセッション[] のマップ
	private subagentMap: Map<string, ParsedSession[]> = new Map();
	// ソートモード
	private sortMode: 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model' = 'updated-desc';
	// グループモード
	private groupMode: 'date' | 'tag' | 'agent' | 'flat' = 'date';
	// プロジェクトフィルター: true なら現在のワークスペースに関連するセッションのみ表示
	private projectFilterEnabled = true;

	// プロジェクトフィルターの設定
	setProjectFilter(enabled: boolean): void {
		this.projectFilterEnabled = enabled;
		this.refresh();
	}

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
		SessionItem._currentSortMode = mode; // v0.5.17 §4-6: ファイルサイズ列表示条件用に共有
		const target = this.filteredSessions || this.sessions;
		this.sortSessions(target);
		this.buildGroups(target);
		if (this.groupMode !== 'tag' && this.groupMode !== 'agent') {
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	// グループモード設定
	setGroupMode(mode: 'date' | 'tag' | 'agent' | 'flat'): void {
		this.groupMode = mode;
		const target = this.filteredSessions || this.sessions;
		this.buildGroups(target);
		// M-6: tag/agentモードはbuildGroups内の非同期完了後にfireするため、ここではスキップ
		if (mode !== 'tag' && mode !== 'agent') {
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	// 外部の AgentMonitor からライブセッションIDを受け取りツリーを更新する（H-3）
	setLiveSessionIds(ids: Set<string>): void {
		this.liveSessionIds = ids;
		this._onDidChangeTreeData.fire(undefined);
	}

	// sessions/ ディレクトリの監視（H-3: 監視ロジックは AgentMonitor に移譲済み）
	startWatching(): void {
		// エージェント監視が無効なら何もしない（H-2）
		const enabled = vscode.workspace.getConfiguration('claudeManager').get<boolean>('enableAgentMonitor', false);
		if (!enabled) { return; }
		// 監視ロジックは AgentMonitor が担当するため、ここでは何もしない
	}

	// ポーリング間隔の再設定（H-3: AgentMonitor に移譲済みのため何もしない）
	restartPolling(): void {
		// AgentMonitor 側で管理するため何もしない
	}

	// 監視停止（H-3: AgentMonitor に移譲済みのため何もしない）
	stopWatching(): void {
		// AgentMonitor 側で管理するため何もしない
	}

	isLiveSession(sessionId: string): boolean {
		return this.liveSessionIds.has(sessionId);
	}

	refresh(): void {
		// キャッシュを強制無効化して最新のファイル一覧を取得
		invalidateSessionCache();
		// 非同期でセッションをロードし、完了したらツリーを更新
		const maxSessions = vscode.workspace.getConfiguration('claudeManager').get<number>('maxSessionsShown', 500);
		loadAllSessions(maxSessions).then((allSessions) => {
			return this.applySessionData(allSessions);
		}).catch(() => {
			// ロードエラー時はツリーをクリア
			this.sessions = [];
			this.filteredSessions = null;
			this.buildGroups([]);
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	private async applySessionData(allSessions: ParsedSession[]): Promise<void> {
		const customNames = await dataStore.getAllCustomNames();

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

		// フィルター前の全親セッションを保持（ブックマーク等で使用）
		this.allParentSessions = parentSessions;

		// プロジェクトフィルター適用
		// v0.5.16 レビュー修正 (3):
		//   旧: workspaceFolders[0] 固定 + basename の生 includes 比較（Windows は '\'、
		//        session.project は JSONL 由来 '/' で永遠に不一致 → 灰色表示と同根）。
		//        マルチルート・サブフォルダも取りこぼしていた。
		//   新: DecorationProvider と同じ isSessionInAnyWorkspace(project, workspaceFolders)
		//        （normalize + isContainedIn）を全ワークスペースフォルダで走査。
		if (this.projectFilterEnabled) {
			const wsFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [];
			if (wsFolders.length > 0) {
				this.sessions = parentSessions.filter((s) => isSessionInAnyWorkspace(s.project, wsFolders));
			} else {
				this.sessions = parentSessions;
			}
		} else {
			this.sessions = parentSessions;
		}
		this.filteredSessions = null;
		this.buildGroups(this.sessions);
		if (this.groupMode !== 'tag' && this.groupMode !== 'agent') {
			this._onDidChangeTreeData.fire(undefined);
		}
		// ロード完了を通知（bookmark/tagプロバイダーが最新データでリフレッシュできるように）
		this._onDidRefresh.fire();
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

	// フィルター前の全親セッション（ブックマーク用）
	getAllParentSessions(): ParsedSession[] {
		return this.allParentSessions;
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

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		// セッションが空かつトップレベル呼び出しの場合はウェルカム表示（M-2: refresh()呼び出しによる無限ループ防止）
		if (this.sessions.length === 0 && !element) {
			return [new DateGroupItem('セッションがありません', 0)];
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
			// H-6: N+1解消 — ブックマーク・タグ・エージェントを一括取得
			const [bookmarks, allTags, agents] = await Promise.all([
				dataStore.getBookmarks(),
				dataStore.getAllTags(),
				dataStore.getAgents(),
			]);
			const bookmarkSet = new Set(bookmarks);
			// タグ逆引きマップ: sessionId → タグ名[]
			const tagsBySession = new Map<string, string[]>();
			for (const [tag, ids] of Object.entries(allTags)) {
				for (const id of ids) {
					const existing = tagsBySession.get(id) || [];
					existing.push(tag);
					tagsBySession.set(id, existing);
				}
			}
			// エージェント逆引き: sessionId → AgentConfig
			const agentBySession = new Map(agents.filter(a => a.sessionId).map(a => [a.sessionId, a]));

			const items: SessionItem[] = [];
			for (const session of sessions) {
				const isBookmarked = bookmarkSet.has(session.id);
				const tags = tagsBySession.get(session.id) || [];
				const isPreviewing = session.id === this.previewSessionId;
				const isLive = this.liveSessionIds.has(session.id);
				const hasChildren = this.hasSubagents(session.id);
				const agentConfig = agentBySession.get(session.id);
				items.push(new SessionItem(session, isBookmarked, tags, isPreviewing, isLive, false, hasChildren, agentConfig));
			}
			return items;
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
				sessions.sort((a, b) => b.fileSize - a.fileSize);
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
				// 非同期処理: Promiseを起動して完了後にツリーを再更新
				this.buildTagGroupsAsync(sessions).then(() => {
					this._onDidChangeTreeData.fire(undefined);
				}).catch(() => {/* ignore */});
				break;

			case 'agent':
				// 非同期処理: Promiseを起動して完了後にツリーを再更新
				this.buildAgentGroupsAsync(sessions).then(() => {
					this._onDidChangeTreeData.fire(undefined);
				}).catch(() => {/* ignore */});
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

	private async buildTagGroupsAsync(sessions: ParsedSession[]): Promise<void> {
		const allTags = await dataStore.getAllTags();
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

	private async buildAgentGroupsAsync(sessions: ParsedSession[]): Promise<void> {
		// H-6: N+1解消 — エージェント一覧を1回だけ取得
		const agents = await dataStore.getAgents();
		const agentBySessionId = new Map(agents.filter(a => a.sessionId).map(a => [a.sessionId, a]));

		const agentSessions = new Map<string, ParsedSession[]>();
		const unlinked: ParsedSession[] = [];

		for (const session of sessions) {
			const agent = agentBySessionId.get(session.id);
			if (agent) {
				const key = `🤖 ${agent.displayName || agent.name}`;
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

// v0.5.14 レビュー修正 (8): modelCatalog.getModelIconAndColor に一本化。
// 旧ローカル実装は撤去し、単一真実源からアイコン/色を取得する（fable→[1m]→opus... の順序も一致）。
function getModelIcon(model?: string): { icon: string; color: string } {
	return getModelIconAndColor(model);
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
// ファイルサイズを人間可読な形式に変換（KB/MB、小数1桁）
function formatFileSize(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(0)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

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
	/**
	 * v0.5.17 §4-6: 現在の sortMode を SessionTreeProvider から共有するための静的キャッシュ。
	 *   SessionItem のコンストラクタで参照して、ファイルサイズ列の表示条件（count-sort-only）判定に使う。
	 *   provider の setSortMode が更新する。
	 */
	public static _currentSortMode: string = 'updated-desc';

	constructor(
		public readonly session: ParsedSession,
		public readonly isBookmarked: boolean,
		public readonly tags: string[],
		public readonly isPreviewing: boolean = false,
		public readonly isLive: boolean = false,
		public readonly inBookmarkView: boolean = false,
		public readonly hasChildren: boolean = false,
		agentConfigArg?: import('../models/types').AgentConfig
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
		// v0.5.14 レビュー修正 (7): modelCatalog.getModelChar() に統一（agentTree/tag/preview と揃える）。
		const modelChar = isSub ? '' : getModelChar(session.model);
		// v0.5.17 §4-6: ファイルサイズ列の表示条件を設定化。
		//   claudeManager.sessions.showFileSize: 'always'|'count-sort-only'|'never'
		//   既定 'count-sort-only' — 会話件数ソート時のみ表示（sortMode='count'）。
		//   sortMode は provider 側で SessionItem._currentSortMode 静的プロパティに保存される。
		const cfgSt = vscode.workspace.getConfiguration('claudeManager');
		const sizeSetting = cfgSt.get<string>('sessions.showFileSize', 'count-sort-only');
		const currentSortMode = SessionItem._currentSortMode || 'updated-desc';
		const showSize = sizeSetting === 'always'
			|| (sizeSetting === 'count-sort-only' && currentSortMode === 'count');
		// ファイルサイズを5桁右揃え（Figure Space U+2007 で等幅パディング）
		const figureSpace = '\u2007';
		const sizeLabel = formatFileSize(session.fileSize);
		const countStr = (isSub || !showSize) ? '' : sizeLabel.padStart(5, figureSpace) + ' ';

		// サブエージェントがある親は展開可能
		const collapsible = hasChildren
			? vscode.TreeItemCollapsibleState.Collapsed
			: vscode.TreeItemCollapsibleState.None;
		super(`${modelChar}${countStr}${displayName}`, collapsible);

		// 時刻フォーマット
		const date = session.lastTimestamp;
		const timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

		// エージェント登録状態（descriptionで使うので先に取得）
		const agentConfig = !isSub ? agentConfigArg : undefined;

		if (isSub) {
			// サブエージェント用のdescription
			this.description = `${formatFileSize(session.fileSize)} ${timeStr}`;
		} else {
			// v0.5.17 §4-6: description 構成要素を設定駆動化。
			//   claudeManager.sessions.descriptionFields: 順序も反映
			//   既定 ['live','agent','originalMsg','time','tags'] — モデル短縮名はデフォルトから除外（頭文字と重複）
			const fields = cfgSt.get<string[]>('sessions.descriptionFields', ['live', 'agent', 'originalMsg', 'time', 'tags']);

			// モデル短縮名（[1m]は保持して区別できるようにする）
			const modelShort = session.model
				? session.model.replace('claude-', '').replace(/-\d+(\.\d+)?(-\d+)?(?=\[|$)/, () => '').replace(/^-/, '').replace(/-(?!\[).*$/, '')
				: '';

			const hasCustomTitle = !!(session.customName || session.claudeTitle);
			const originalMsg = hasCustomTitle ? session.firstMessage.substring(0, 30) : '';
			const tagStr = tags.length > 0 ? `[${tags.join(', ')}]` : '';

			// 各フィールドの表示文字列（該当データがなければ空）
			const fieldMap: Record<string, string> = {
				live: isLive ? '●' : '',
				agent: agentConfig ? `🤖${agentConfig.name}` : '',
				originalMsg,
				time: timeStr,
				model: modelShort,
				tags: tagStr,
			};
			this.description = fields.map((k) => fieldMap[k] || '').filter(Boolean).join(' ');
		}

		// ツールチップ
		if (isSub) {
			this.tooltip = new vscode.MarkdownString(
				`**🤖 子エージェント** (${session.agentType || '不明'})\n\n` +
				(session.agentDescription ? `${session.agentDescription}\n\n` : '') +
				`| | |\n|---|---|\n` +
				`| タイプ | ${session.agentType || '不明'} |\n` +
				`| 日時 | ${date.toLocaleString('ja-JP')} |\n` +
				`| サイズ | ${formatFileSize(session.fileSize)} |\n` +
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
				`| サイズ | ${formatFileSize(session.fileSize)} |\n` +
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

	// v0.5.16 新規バグ修正: 単一 workspaceFolders[0] 固定を撤廃し、
	//   全 workspaceFolders を候補に持つ。マルチルート・サブフォルダ配下も一致扱いにする。
	private workspaceFolders: string[] = [];

	constructor() {
		this.updateCurrentProject();
	}

	updateCurrentProject(): void {
		const folders = vscode.workspace.workspaceFolders;
		this.workspaceFolders = folders ? folders.map(f => f.uri.fsPath) : [];
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

		// v0.5.16 新規バグ修正:
		//   旧: `currentProject.toLowerCase().includes(project.toLowerCase())` の相互 includes 判定。
		//       currentProject は fsPath なので Windows で '\' 区切り、project は JSONL 由来で '/' 区切り
		//       のためどれだけ同一パスでも文字列比較が一致せず、ワークスペース内セッションまで
		//       disabledForeground（灰色）で表示されていた。
		//   新: pathUtils の normalize() + isContainedIn() で正規化して包含判定。
		//       - project === workspaceFolder（同一ディレクトリ）→ 一致
		//       - project が workspaceFolder のサブフォルダ → 一致（例: workspace=/repo, project=/repo/pkg/a）
		//       - workspaceFolder が project のサブフォルダ → 一致（1つ上を workspace で開いているケース）
		//       cliBuilder.ts の isWorkDirCompatible と同じ流儀。
		// v0.5.16 レビュー修正 (3): projectFilter と共通のヘルパーで判定
		if (!isSessionInAnyWorkspace(project, this.workspaceFolders)) {
			return {
				color: new vscode.ThemeColor('disabledForeground'),
			};
		}
		return undefined;
	}
}

// v0.5.16 新規バグ修正 + レビュー修正 (3):
//   セッションの project パスが workspaceFolders のいずれかと同一 or 包含関係にあるか判定。
//   ワークスペース側は fsPath（Windows なら '\' 区切り）、project は JSONL 由来（'/' 区切り）で
//   来ることが多いため、pathUtils.normalize() で正規化してから isContainedIn で判定する。
//
//   DecorationProvider の灰色化判定と、SessionTreeProvider の projectFilter 絞り込み双方で
//   同じヘルパーを使うことで表示ズレを排除。
export function isSessionInAnyWorkspace(project: string, workspaceFolders: string[]): boolean {
	if (workspaceFolders.length === 0 || !project) { return false; }
	return workspaceFolders.some((ws) => isContainedIn(project, ws) || isContainedIn(ws, project));
}

// v0.5.16 レビュー修正 (3) 後方互換: 旧テスト等の名前もそのまま export で残す
export const _isSessionInAnyWorkspace = isSessionInAnyWorkspace;
