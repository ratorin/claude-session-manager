// agentLiveTreeProvider.ts — ライブ状態エージェント専用 TreeDataProvider
//
// v0.5.24（本改修）:
//   - **cwd 推測マッチングを撤去**（同一 workDir を共有する複数エージェント間で
//     ユーザーの通常チャット窓 N 本が『取締役(推定)』『Daros開発部長(推定)』等に誤って
//     貼り付き、実運用で無視できない実害を出したため）。エージェント名を付けるのは
//     matchLevel==='session-id'（本物の sessionId 紐付け）のときだけ。
//   - **フラット→2 階層ツリー化**: ルートに「エージェントノード（本物紐付けあり）」と
//     「未定義グループ（本物紐付け無しの稼働セッション）」を並べ、その配下に各セッション行。
//     エージェント直下 = そのエージェントで動いている複数セッション（別窓・別ワークツリー等）。
//   - 未定義グループの ON/OFF は既存 `claudeManager.agents.showUnregisteredLive` を流用
//     （新設 `liveStatus.showUndefinedGroup` は重複回避のため導入せず・description を更新）。
//   - 「(推定)」文言と cwd tooltip 行を撤去。
//
// v0.5.22: claude agents --json 依存を撤去。agentWatcher（PID + sessions/*.json）が
//   唯一のライブデータソース。sessions/*.json の kind/name/nameSource/agent 等の
//   公式メタも tooltip / description に反映する。

import * as vscode from 'vscode';
import * as path from 'path';
import * as dataStore from '../models/dataStore';
import {
	LiveAgentView,
	LiveAgentGroup,
	ClaudeAgentEntry,
	formatElapsed,
	buildLiveTreeStructure,
	resolveLiveAgentViews,
} from '../services/liveAgentTypes';
import { AgentWatcher } from '../watchers/agentWatcher';

type LiveTreeNode =
	| LiveAgentGroupItem
	| LiveUndefinedGroupItem
	| LiveSessionItem
	| LiveStatusMessageItem;

// -------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------

export class AgentLiveTreeProvider
	implements vscode.TreeDataProvider<LiveTreeNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<LiveTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _agentWatcher: AgentWatcher | undefined;
	private _watcherDisposable: vscode.Disposable | undefined;

	dispose(): void {
		this._watcherDisposable?.dispose();
		this._onDidChangeTreeData.dispose();
	}

	setAgentWatcher(watcher: AgentWatcher): void {
		this._watcherDisposable?.dispose();
		this._agentWatcher = watcher;
		this._watcherDisposable = watcher.onDidChange(() => this.refresh());
	}

	/** タブ可視性通知（v0.5.22 以降は agentWatcher のみで完結するため実質 no-op） */
	notifyTabVisible(_visible: boolean): void {
		// agentWatcher はタブ可視性に依存しないため通知不要
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: LiveTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: LiveTreeNode): Promise<LiveTreeNode[]> {
		// --- 子要素展開 ---
		if (element instanceof LiveAgentGroupItem) {
			return element.group.sessions.map((v) => new LiveSessionItem(v));
		}
		if (element instanceof LiveUndefinedGroupItem) {
			return element.views.map((v) => new LiveSessionItem(v));
		}
		if (element) {
			// LiveSessionItem / LiveStatusMessageItem は葉ノード
			return [];
		}

		// --- ルート ---
		// v0.5.24: showUnregisteredLive は『未定義グループ』の ON/OFF に統合。
		//   （旧: フラットリストで未登録行を表示するかどうか）
		const showUndefinedGroup = vscode.workspace
			.getConfiguration('claudeManager')
			.get<boolean>('agents.showUnregisteredLive', true);

		const watcher = this._agentWatcher;
		if (!watcher) { return []; }

		if (!watcher.isEnabled()) {
			return [new LiveStatusMessageItem(
				'エージェント監視が無効です',
				'設定: claudeManager.enableAgentMonitor を有効にしてください',
				'info',
			)];
		}

		const now = Date.now();
		const states = watcher.getStates();
		const liveSessionIds = watcher.getLiveSessionIds();
		const cwdMap = watcher.getLiveSessionCwdMap();
		const metaMap = watcher.getLiveSessionMetaMap();

		const entries: ClaudeAgentEntry[] = [];
		const registeredSessions = new Set<string>();

		// 登録済みエージェントのうちライブ状態のもの
		for (const [, state] of states) {
			if (state.isLive) {
				registeredSessions.add(state.sessionId);
				const meta = metaMap.get(state.sessionId);
				const startedAt = meta?.startedAt;
				entries.push({
					sessionId: state.sessionId,
					agentName: state.agentName,
					status: 'running',
					cwd: cwdMap.get(state.sessionId) || '',
					pid: meta?.pid,
					kind: meta?.kind,
					sessionName: meta?.name,
					nameSource: meta?.nameSource,
					startedAt,
					elapsedSec: startedAt !== undefined
						? Math.max(0, Math.floor((now - startedAt) / 1000))
						: undefined,
					source: 'session-json',
				});
			}
		}

		// 本物紐付けの無いライブセッション（『未定義』候補、常に収集して後段でグループ化）
		for (const sessionId of liveSessionIds) {
			if (registeredSessions.has(sessionId)) { continue; }
			const meta = metaMap.get(sessionId);
			const startedAt = meta?.startedAt;
			entries.push({
				sessionId,
				agentName: undefined,
				status: 'running',
				cwd: cwdMap.get(sessionId) || '',
				pid: meta?.pid,
				kind: meta?.kind,
				sessionName: meta?.name,
				nameSource: meta?.nameSource,
				startedAt,
				elapsedSec: startedAt !== undefined
					? Math.max(0, Math.floor((now - startedAt) / 1000))
					: undefined,
				source: 'session-json',
			});
		}

		if (entries.length === 0) {
			return [new LiveStatusMessageItem(
				'ライブ状態のエージェントなし',
				'現在稼働中のバックグラウンドエージェントはありません',
				'info',
			)];
		}

		const allAgents = await dataStore.getAgents();
		const views = buildLiveAgentViews(entries, allAgents);
		const tree = buildLiveTreeStructure(views, allAgents);

		const nodes: LiveTreeNode[] = [];
		for (const g of tree.agents) {
			nodes.push(new LiveAgentGroupItem(g));
		}
		if (showUndefinedGroup && tree.undefined.length > 0) {
			nodes.push(new LiveUndefinedGroupItem(tree.undefined));
		}

		// エージェント配下も未定義もどちらも空 → 稼働エージェントは 0（未定義は非表示設定 or 0）
		if (nodes.length === 0) {
			return [new LiveStatusMessageItem(
				'ライブ状態のエージェントなし',
				'現在稼働中のバックグラウンドエージェントはありません',
				'info',
			)];
		}
		return nodes;
	}
}

// -------------------------------------------------------------------
// ヘルパー: ClaudeAgentEntry[] × AgentConfig[] → LiveAgentView[]
// -------------------------------------------------------------------

/**
 * v0.5.24: cwd 推測マッチングを撤去。sessionId 紐付けのみ。
 *
 * 撤去理由:
 *   複数エージェントが同一 workDir（例: c:/xampp）を共有していると、cwdMap は
 *   最初の 1 体（例: 取締役）しか保持できず、そのフォルダで動くユーザーの通常チャット
 *   窓 N 本すべてが『取締役』『Daros開発部長』等に誤って貼り付いた。
 *   ユーザー実害（動かしていないエージェントが稼働中に見える）が発生していたため撤去。
 *
 *   sessions/*.json には CC 2.1.207 時点で agent フィールドが存在しないため、
 *   agentSessions（sessionId 紐付け）だけが確実な同定手段。それ以外は none。
 *
 * 実装は `liveAgentTypes.resolveLiveAgentViews`（vscode 非依存の純関数）に集約し、
 * 本ファイルは互換用の再エクスポート層。
 */
export function buildLiveAgentViews(
	entries: ClaudeAgentEntry[],
	agents: Awaited<ReturnType<typeof dataStore.getAgents>>,
): LiveAgentView[] {
	return resolveLiveAgentViews(entries, agents);
}

// -------------------------------------------------------------------
// TreeItem クラス
// -------------------------------------------------------------------

/** ライブ状態メッセージ（空・エラー・ローディング） */
export class LiveStatusMessageItem extends vscode.TreeItem {
	constructor(label: string, description: string, kind: 'info' | 'warning' | 'loading') {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = new vscode.ThemeIcon(
			kind === 'loading' ? 'sync~spin'
			: kind === 'warning' ? 'warning'
			: 'info',
			kind === 'warning' ? new vscode.ThemeColor('terminal.ansiYellow') : undefined,
		);
		this.contextValue = 'liveStatusMessage';
	}
}

/**
 * v0.5.24: エージェントグループノード（ルート、Expanded）。
 * 直下に紐付いた稼働セッション行が並ぶ。
 */
export class LiveAgentGroupItem extends vscode.TreeItem {
	public readonly group: LiveAgentGroup;

	constructor(group: LiveAgentGroup) {
		super(group.linkedDisplayName, vscode.TreeItemCollapsibleState.Expanded);
		this.group = group;

		const n = group.sessions.length;
		this.description = `稼働 ${n}`;

		// 部門長: 配下エージェントを持つ → tooltip に補足
		const subordinate = group.subordinateAgentCount;
		const subordinateLine = subordinate > 0
			? `| 配下エージェント計 | ${subordinate} |\n`
			: '';

		this.tooltip = new vscode.MarkdownString(
			`**${group.linkedDisplayName}**\n\n` +
			`| | |\n|---|---|\n` +
			`| CSM エージェント | \`${group.linkedAgentName}\` |\n` +
			`| 稼働セッション数 | ${n} |\n` +
			subordinateLine +
			`\n*sessionId 紐付け（本物）*\n`,
		);
		this.tooltip.isTrusted = true;

		this.iconPath = new vscode.ThemeIcon('person', new vscode.ThemeColor('terminal.ansiGreen'));
		this.contextValue = 'liveAgentGroup';

		// クリックで該当エージェントプレビュー
		this.command = {
			command: 'claudeManager.previewAgentByName',
			title: 'エージェントプレビュー',
			arguments: [group.linkedAgentName],
		};
	}
}

/**
 * v0.5.24: 未定義グループノード（ルート、Collapsed 既定）。
 * CSM 未登録・sessionId 未紐付けのライブセッションが並ぶ。
 */
export class LiveUndefinedGroupItem extends vscode.TreeItem {
	public readonly views: LiveAgentView[];

	constructor(views: LiveAgentView[]) {
		super(`未定義（${views.length}）`, vscode.TreeItemCollapsibleState.Collapsed);
		this.views = views;
		this.description = 'CSM 未登録セッション';
		this.tooltip = new vscode.MarkdownString(
			`**未定義グループ**\n\n` +
			`CSM に登録されていないか、\`sessionId\` で紐付けられていない稼働セッション ${views.length} 件。\n\n` +
			`*設定 \`claudeManager.agents.showUnregisteredLive\` で表示 ON/OFF*\n`,
		);
		this.tooltip.isTrusted = true;
		this.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('terminal.ansiYellow'));
		this.contextValue = 'liveUndefinedGroup';
	}
}

/**
 * v0.5.24: セッション行（葉）。
 * エージェント配下 or 未定義配下のいずれにも並ぶ。
 * ラベル優先順位: CC 公式 sessionName → sid8 → '(未登録)'
 */
export class LiveSessionItem extends vscode.TreeItem {
	public readonly view: LiveAgentView;

	constructor(view: LiveAgentView) {
		const entry = view.entry;
		const isUndefined = view.matchLevel !== 'session-id';

		// ラベル: 未定義は CC 公式 name → sid8
		//         紐付け済みは CC 公式 name → sid8（agent 名は親ノードに出るため重複しない）
		const label = entry.sessionName
			|| (entry.sessionId ? entry.sessionId.substring(0, 8) : '(未登録)');
		super(label, vscode.TreeItemCollapsibleState.None);
		this.view = view;

		const cwdShort = entry.cwd ? (path.basename(entry.cwd) || entry.cwd) : '—';
		const pidStr = entry.pid !== undefined ? `PID ${entry.pid}` : '';
		const kindStr = entry.kind ? `[${entry.kind}]` : '';
		const elapsedStr = entry.elapsedSec !== undefined ? formatElapsed(entry.elapsedSec) : '';
		// description は簡潔に: フォルダ + PID + 経過（未定義はフォルダ名を目印にする）
		this.description = [isUndefined ? cwdShort : '', pidStr, kindStr, elapsedStr]
			.filter(Boolean)
			.join('  ');

		// アイコン: 稼働=緑、ブロック=黄、完了=白抜き
		switch (entry.status) {
			case 'running':
				this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
				break;
			case 'blocked':
				this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiYellow'));
				break;
			case 'done':
				this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('foreground'));
				break;
			default:
				this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
		}

		// tooltip
		const pidLine = entry.pid !== undefined ? `| PID | \`${entry.pid}\` |\n` : '';
		const kindLine = entry.kind ? `| 種別（CC 公式 kind） | \`${entry.kind}\` |\n` : '';
		const nameLine = entry.sessionName
			? `| セッション名（CC） | \`${entry.sessionName}\`${entry.nameSource ? `（${entry.nameSource}）` : ''} |\n`
			: '';
		const elapsedRow = entry.elapsedSec !== undefined
			? `| 経過時間 | ${formatElapsed(entry.elapsedSec)} |\n`
			: '';
		// -p 由来はレジューム不可
		//   kind==='background' または entrypoint に 'cli' 等が入る一時セッションの可能性が高い。
		//   sessions/*.json には現行 CC で entrypoint フィールドがあるので、それを目印にする。
		const isEphemeral = entry.kind === 'background'
			|| (typeof entry.source === 'string' && entry.source === 'session-json' && entry.kind === undefined);
		const resumeNote = isEphemeral
			? `\n*※ -p / background セッションはレジューム不可の場合があります*`
			: '';

		this.tooltip = new vscode.MarkdownString(
			`**${label}**\n\n` +
			`| | |\n|---|---|\n` +
			`| ステータス | \`${entry.status}\` |\n` +
			(entry.cwd ? `| 作業ディレクトリ | \`${entry.cwd}\` |\n` : '') +
			elapsedRow +
			(entry.sessionId ? `| セッション ID | \`${entry.sessionId}\` |\n` : '') +
			pidLine +
			kindLine +
			nameLine +
			(view.linkedAgentName ? `| CSM エージェント | ${view.linkedAgentName} |\n` : '') +
			`\n*sessions/*.json + JSONL 監視（PID ベース）*` +
			(isUndefined ? '\n*CSM に未登録のセッションです*' : '') +
			resumeNote,
		);
		this.tooltip.isTrusted = true;

		this.contextValue = isUndefined ? 'liveSessionUnlinked' : 'liveSessionLinked';

		// クリック: 紐付いていればエージェントプレビュー、未定義は Claude Code で開く
		if (view.linkedAgentName) {
			this.command = {
				command: 'claudeManager.previewAgentByName',
				title: 'エージェントプレビュー',
				arguments: [view.linkedAgentName],
			};
		} else if (entry.sessionId) {
			this.command = {
				command: 'claudeManager.openLiveSessionInClaude',
				title: 'Claude Code で開く',
				arguments: [entry.sessionId],
			};
		}
	}
}
