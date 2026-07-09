import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, ParsedSession, TaskLog } from '../models/types';
import * as dataStore from '../models/dataStore';
import { getRuleFileInfo, resolveRuleFilePath } from '../agents/agentManager';
import { isLegacyAutoFormat, hasFrontmatter } from '../utils/frontmatterUtils';
import { shouldShowInOrgChart, translateWorkDirPath } from '../utils/agentUtils';
import { getModelChar } from '../models/modelCatalog';
import { resolveExternalSessionTitles } from '../utils/sessionLoader';
import { isBookmarked, addBookmark, removeBookmark } from '../services/bookmarkService';

type AgentTreeNode = AgentItem | TaskLogItem | MigrationBannerItem | GlobalAgentsSectionItem | CsmAskAgentInstallBannerItem | AskAgentMigrationBannerItem | SessionInjectInstallBannerItem | GroupNodeItem;

// D&DのMIMEタイプ
const AGENT_MIME = 'application/vnd.csm.agent';

// エージェント管理サイドバーのTreeDataProvider（ツリー構造対応 + D&D）
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeNode>, vscode.TreeDragAndDropController<AgentTreeNode>, vscode.Disposable {
	// D&D対応
	readonly dropMimeTypes = [AGENT_MIME];
	readonly dragMimeTypes = [AGENT_MIME];
	private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
		// v0.5.18 レビュー修正 (5): バッジ更新用 EventEmitter も dispose する
		this._onDidChangeBadge.dispose();
	}

	private getSessionsFn: () => ParsedSession[];
	private isLiveFn: (id: string) => boolean;
	private watcherStates: Map<string, import('../models/types').AgentWatcherState> = new Map();

	setWatcherStates(states: Map<string, import('../models/types').AgentWatcherState>): void {
		this.watcherStates = states;
		// v0.5.18 §4-4: バッジ更新イベントを発火（TreeView.badge の同期用）
		this.updateBadge();
	}
	private activeAgentNamesFn: () => Set<string>;
	private getSessionMtimeFn: ((sessionId: string) => number | undefined) | undefined;
	private getVisibleTasksFn: ((agentName: string) => TaskLog[]) | undefined;
	private hideOtherProjects: boolean = false;

	setHideOtherProjects(hide: boolean): void {
		this.hideOtherProjects = hide;
		this.refresh();
	}
	getHideOtherProjects(): boolean { return this.hideOtherProjects; }

	// v0.5.18 §4-4: 稼働中のみ表示するフィルタ
	private activeOnly: boolean = false;
	setActiveOnly(active: boolean): void {
		this.activeOnly = active;
		this.refresh();
	}
	getActiveOnly(): boolean { return this.activeOnly; }

	// v0.5.18 §4-8: グルーピングモード
	private groupMode: 'org' | 'model' | 'status' | 'flat' = 'org';
	setGroupMode(mode: 'org' | 'model' | 'status' | 'flat'): void {
		this.groupMode = mode;
		this.refresh();
	}
	getGroupMode(): 'org' | 'model' | 'status' | 'flat' { return this.groupMode; }

	// v0.5.18 §4-4: バッジ更新通知（TreeView.badge の text 更新）
	private _onDidChangeBadge = new vscode.EventEmitter<{ count: number; total: number }>();
	readonly onDidChangeBadge = this._onDidChangeBadge.event;
	private lastBadge: { count: number; total: number } = { count: 0, total: 0 };
	getLastBadge(): { count: number; total: number } { return this.lastBadge; }
	// エージェント状態の更新後、バッジデータを再計算して通知する
	private updateBadge(): void {
		let active = 0;
		let total = 0;
		const activeNames = this.activeAgentNamesFn();
		for (const s of this.watcherStates.values()) {
			total++;
			if (s.isLive || activeNames.has(s.agentName)) { active++; }
		}
		// watcherStates が空でも UI からの refresh 直後は total を維持
		const next = { count: active, total: Math.max(total, this.lastBadge.total) };
		if (next.count !== this.lastBadge.count || next.total !== this.lastBadge.total) {
			this.lastBadge = next;
			this._onDidChangeBadge.fire(next);
		}
	}

	constructor(
		getSessions: () => ParsedSession[],
		isLive: (id: string) => boolean,
		getActiveAgentNames?: () => Set<string>,
		getSessionMtime?: (sessionId: string) => number | undefined,
	) {
		this.getSessionsFn = getSessions;
		this.isLiveFn = isLive;
		this.activeAgentNamesFn = getActiveAgentNames || (() => new Set());
		this.getSessionMtimeFn = getSessionMtime;
	}

	// TaskTracker 連携用セッター（循環依存回避のため後付け）
	setTaskProvider(fn: (agentName: string) => TaskLog[]): void {
		this.getVisibleTasksFn = fn;
	}

	// マイグレーション不要になったらバナーを非表示にする
	private migrationNeeded = false;
	getMigrationNeeded(): boolean { return this.migrationNeeded; }

	// ルートノードの短期キャッシュ（タブ切り替え時の IO 抑制）
	private _rootChildrenCache: { nodes: AgentTreeNode[]; ts: number } | undefined;
	private readonly ROOT_CACHE_TTL_MS = 5000;

	refresh(): void {
		this._rootChildrenCache = undefined;
		this.lastAgentItemsByName.clear(); // v0.5.17 §4-1: reveal 用キャッシュも初期化
		this.lastGlobalSectionItem = undefined; // v0.5.18 レビュー修正 (3): global セクションキャッシュも初期化
		this._onDidChangeTreeData.fire(undefined);
	}

	// D&D: ドラッグ開始 — エージェント名をDataTransferに格納
	handleDrag(sources: readonly AgentTreeNode[], dataTransfer: vscode.DataTransfer): void {
		const agentItems = sources.filter((s): s is AgentItem => s instanceof AgentItem);
		if (agentItems.length === 0) { return; }
		dataTransfer.set(AGENT_MIME, new vscode.DataTransferItem(agentItems[0].agent.name));
	}

	// D&D: ドロップ — 親子関係を変更
	async handleDrop(target: AgentTreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const item = dataTransfer.get(AGENT_MIME);
		if (!item) { return; }
		const draggedName = item.value as string;
		if (!draggedName) { return; }

		const agents = await dataStore.getAgents();
		const dragged = agents.find(a => a.name === draggedName);
		if (!dragged) { return; }

		let newParent: string | undefined;
		let newShowInOrgChart: boolean | undefined;

		if (!target) {
			// トップレベルにドロップ → 組織図トップ（親なし）
			newParent = undefined;
			newShowInOrgChart = true;
		} else if (target instanceof AgentItem) {
			// エージェントの上にドロップ → そのエージェントを親に
			if (target.agent.name === draggedName) { return; } // 自分自身にはドロップ不可
			newParent = target.agent.name;
			newShowInOrgChart = true;

			// 循環参照チェック
			const { hasCircularRef } = await import('../agents/parentChildSync');
			if (hasCircularRef(draggedName, target.agent.name, agents)) {
				vscode.window.showWarningMessage('循環参照になるため設定できません');
				return;
			}
		} else if (target instanceof GlobalAgentsSectionItem) {
			// グローバルセクションにドロップ → グローバルエージェント
			newParent = undefined;
			newShowInOrgChart = false;
		} else {
			return; // バナー等へのドロップは無視
		}

		// 旧親の同期用
		const oldParent = dragged.parentAgent;

		// 更新
		const updated: AgentConfig = {
			...dragged,
			parentAgent: newParent,
			showInOrgChart: newShowInOrgChart,
		};
		await dataStore.addAgent(updated);

		// 親子ルール同期
		const { syncParentRuleFile } = await import('../agents/parentChildSync');
		const ch = vscode.window.createOutputChannel('CSM D&D');
		if (oldParent && oldParent !== newParent) {
			await syncParentRuleFile(oldParent, ch);
		}
		if (newParent) {
			await syncParentRuleFile(newParent, ch);
		}

		this.refresh();
		const targetLabel = newParent || (newShowInOrgChart ? '組織図トップ' : 'グローバル');
		vscode.window.showInformationMessage(`「${dragged.displayName || dragged.name}」を「${targetLabel}」に移動しました`);
	}

	getTreeItem(element: AgentTreeNode): vscode.TreeItem {
		return element;
	}

	// v0.5.17 §4-1: reveal(item) で該当 AgentItem までツリーを辿るための getParent 実装。
	//   AgentItem のみ親子関係を持つ（parentAgent 名 → 親 AgentItem）。
	//   GlobalAgentsSectionItem 配下のエージェントは仮想セクションを親として扱う。
	//   本 getParent は同期的に「そのノードが所属する親のインスタンス」を要求する。
	//   直近の getChildren 実行時のキャッシュを見て一致するインスタンスを返す。
	getParent(element: AgentTreeNode): AgentTreeNode | undefined {
		if (!(element instanceof AgentItem)) { return undefined; }
		// v0.5.18 レビュー修正 (3): グローバルエージェント（parentAgent 無し + shouldShowInOrgChart=false）は
		//   GlobalAgentsSectionItem 配下に描画されるため、undefined を返すと TreeView.reveal が
		//   「該当要素が見つかりません」で失敗する。仮想セクションのキャッシュ済みインスタンスを返す。
		const parentName = element.agent.parentAgent;
		if (parentName) {
			return this.lastAgentItemsByName.get(parentName);
		}
		// parentAgent なし: グローバルセクション配下かトップレベルかで分岐
		if (!shouldShowInOrgChart(element.agent) && this.lastGlobalSectionItem) {
			return this.lastGlobalSectionItem;
		}
		return undefined; // トップレベル（ルート）はundefinedでOK
	}
	/** getParent が使うキャッシュ（getChildren 内で更新） */
	private lastAgentItemsByName = new Map<string, AgentItem>();
	/** v0.5.18 レビュー修正 (3): GlobalAgentsSectionItem の単一インスタンス（reveal の親参照用） */
	private lastGlobalSectionItem: GlobalAgentsSectionItem | undefined;

	/**
	 * v0.5.17 §4-1: エージェント名で AgentItem インスタンスを取得（reveal 用）。
	 * 直近の getChildren 実行時のキャッシュを見る。未展開のツリー階層の項目は取得できない可能性があるため、
	 * 呼び出し側で reveal 失敗時に catch すること。
	 */
	getAgentItemByName(name: string): AgentItem | undefined {
		return this.lastAgentItemsByName.get(name);
	}

	async getChildren(element?: AgentTreeNode): Promise<AgentTreeNode[]> {
		// TaskLogItem / MigrationBannerItem / GlobalAgentsSectionItem は子を持たない（GlobalAgentsSectionItem は特別処理）
		if (element instanceof TaskLogItem) { return []; }
		if (element instanceof MigrationBannerItem) { return []; }
		if (element instanceof CsmAskAgentInstallBannerItem) { return []; }
		if (element instanceof AskAgentMigrationBannerItem) { return []; }
		if (element instanceof SessionInjectInstallBannerItem) { return []; }

		// v0.5.18 §4-8: グループノード配下 → 対応する AgentItem を返す
		// v0.5.18 レビュー修正 (4): hasChildren=false 固定を撤去し、childMap + タスクログ判定で
		//   サブエージェント・タスクログを展開可能に。AgentItem.getChildren（下の instanceof AgentItem 分岐）で
		//   親子連鎖を再帰的に描画するため、hasChildrenFlag が正しくないと展開できない。
		if (element instanceof GroupNodeItem) {
			const allAgents = await dataStore.getAgents();
			const byName = new Map(allAgents.map((a) => [a.name, a]));
			const agentNames = new Set(allAgents.map((a) => a.name));
			// childMap（親名 → 子エージェント[]）
			const childMap = new Map<string, AgentConfig[]>();
			for (const a of allAgents) {
				if (a.parentAgent && agentNames.has(a.parentAgent)) {
					const arr = childMap.get(a.parentAgent) || [];
					arr.push(a);
					childMap.set(a.parentAgent, arr);
				}
			}
			const result: AgentTreeNode[] = [];
			const activeNames = this.activeAgentNamesFn();
			const isLive = (a: AgentConfig) =>
				activeNames.has(a.name) || (a.sessionId ? this.isLiveFn(a.sessionId) : false);
			const sessionsAll = this.getSessionsFn();
			const titles = new Map<string, string>();
			for (const s of sessionsAll) { titles.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40)); }
			for (const name of element.childrenAgentNames) {
				const a = byName.get(name);
				if (!a) { continue; }
				const ws = this.watcherStates.get(a.name);
				const mtimeMs = a.sessionId ? this.getSessionMtimeFn?.(a.sessionId) : undefined;
				const sessionTitle = a.sessionId ? titles.get(a.sessionId) : undefined;
				const hasTasks = this.getVisibleTasksFn ? this.getVisibleTasksFn(a.name).length > 0 : false;
				const hasChildrenFlag = childMap.has(a.name) || hasTasks;
				const item = new AgentItem(a, isLive(a), sessionTitle, false, hasChildrenFlag, '', ws?.modelMismatch ?? false, ws?.actualModel, false, mtimeMs);
				this.lastAgentItemsByName.set(a.name, item);
				result.push(item);
			}
			return result;
		}

		if (element instanceof GlobalAgentsSectionItem) {
			// グローバルエージェント を返す
			const allAgents = await dataStore.getAgents();
			const globalAgents = allAgents.filter((a) => !shouldShowInOrgChart(a));

			const sessions = this.getSessionsFn();
			const titleMap = new Map<string, string>();
			for (const s of sessions) {
				titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
			}
			// 現ワークスペースに無いセッションID（他プロジェクト）を全プロジェクト横断で解決
			const missingSessionIds = globalAgents
				.map(a => a.sessionId)
				.filter((sid): sid is string => !!sid && !titleMap.has(sid));
			if (missingSessionIds.length > 0) {
				const externalTitles = await resolveExternalSessionTitles(missingSessionIds);
				for (const [sid, title] of externalTitles) { titleMap.set(sid, title); }
			}

			const activeNames = this.activeAgentNamesFn();
			const checkLive = (agent: AgentConfig): boolean => {
				if (activeNames.has(agent.name)) { return true; }
				return agent.sessionId ? this.isLiveFn(agent.sessionId) : false;
			};

			// グローバルエージェント をソート
			globalAgents.sort((a, b) => {
				const aLive = checkLive(a) ? 0 : 1;
				const bLive = checkLive(b) ? 0 : 1;
				if (aLive !== bLive) { return aLive - bLive; }
				return a.name.localeCompare(b.name);
			});

			const result: AgentTreeNode[] = [];
			for (const agent of globalAgents) {
				const isLive = checkLive(agent);
				const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
				const ws = this.watcherStates.get(agent.name);
				const mtimeMs = agent.sessionId ? this.getSessionMtimeFn?.(agent.sessionId) : undefined;
				result.push(new AgentItem(agent, isLive, sessionTitle, true, false, '', ws?.modelMismatch ?? false, ws?.actualModel, false, mtimeMs));
			}
			return result;
		}

		const allAgents = await dataStore.getAgents();

		// 現在のワークスペースパス（小文字・スラッシュ統一）
		const currentWorkspace = (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '')
			.toLowerCase().replace(/\\/g, '/');

		// scope: "project" のエージェントはワークスペース一致判定（フィルタON時は非表示、OFF時は灰色表示）
		const isOtherProject = (a: AgentConfig): boolean => {
			if (!currentWorkspace) { return false; }
			// workDirが設定されていて、現在のワークスペースと一致しない場合は「他プロジェクト」
			if (a.workDir) {
				const agentDir = translateWorkDirPath(a.workDir).toLowerCase().replace(/\\/g, '/');
				return !(agentDir.startsWith(currentWorkspace) || currentWorkspace.startsWith(agentDir));
			}
			// プロジェクトスコープ: ruleFileのパスでワークスペース一致判定
			if (a.scope === 'project' && a.ruleFile) {
				const checkPath = a.ruleFile.toLowerCase().replace(/\\/g, '/');
				return !checkPath.startsWith(currentWorkspace);
			}
			return false; // workDir未設定のグローバルエージェントは「他プロジェクト」扱いしない
		};
		// v0.5.18 §4-4: activeOnly フィルタ（稼働中のみ表示）
		const activeNamesEarly = this.activeAgentNamesFn();
		const isLiveEarly = (a: AgentConfig): boolean => {
			if (activeNamesEarly.has(a.name)) { return true; }
			return a.sessionId ? this.isLiveFn(a.sessionId) : false;
		};
		let agents = this.hideOtherProjects
			? allAgents.filter((a) => !isOtherProject(a))
			: allAgents;
		if (this.activeOnly) {
			// 稼働中のエージェント + その先祖ノード（親子関係の維持）
			const liveNames = new Set<string>();
			for (const a of agents) { if (isLiveEarly(a)) { liveNames.add(a.name); } }
			// 親を辿って追加
			const byName = new Map(agents.map((a) => [a.name, a]));
			const shouldKeep = new Set<string>(liveNames);
			for (const name of liveNames) {
				let cur = byName.get(name);
				while (cur?.parentAgent && byName.has(cur.parentAgent)) {
					if (shouldKeep.has(cur.parentAgent)) { break; }
					shouldKeep.add(cur.parentAgent);
					cur = byName.get(cur.parentAgent);
				}
			}
			agents = agents.filter((a) => shouldKeep.has(a.name));
		}

		if (agents.length === 0) { return []; }

		// セッションタイトル対応表
		const sessions = this.getSessionsFn();
		const titleMap = new Map<string, string>();
		for (const s of sessions) {
			titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
		}
		// 他プロジェクトのセッションIDを全プロジェクト横断で解決
		const missingSessionIds = agents
			.map(a => a.sessionId)
			.filter((sid): sid is string => !!sid && !titleMap.has(sid));
		if (missingSessionIds.length > 0) {
			const externalTitles = await resolveExternalSessionTitles(missingSessionIds);
			for (const [sid, title] of externalTitles) { titleMap.set(sid, title); }
		}

		// エージェント名一覧（親の存在チェック用）
		const agentNames = new Set(agents.map((a) => a.name));
		agentNames.add('**global-agents**'); // 仮想親を登録

		// 子を持つかどうかを判定
		const childMap = new Map<string, AgentConfig[]>();
		for (const a of agents) {
			if (a.parentAgent && agentNames.has(a.parentAgent)) {
				const children = childMap.get(a.parentAgent) || [];
				children.push(a);
				childMap.set(a.parentAgent, children);
			}
		}

		// グローバルエージェント を仮想親にマッピング（parentAgent 未設定 かつ showInOrgChart 明示なし → グローバル）
		const globalAgents = agents.filter((a) => !shouldShowInOrgChart(a) && (!a.parentAgent || !agentNames.has(a.parentAgent)));
		if (globalAgents.length > 0) {
			childMap.set('**global-agents**', globalAgents);
		}

		// JSONL解析ベースの稼働中エージェント名
		const activeNames = this.activeAgentNamesFn();

		// isLive判定: sessionProviderのライブ検出 OR JSONL解析の稼働検出
		const checkLive = (agent: AgentConfig): boolean => {
			if (activeNames.has(agent.name)) { return true; }
			return agent.sessionId ? this.isLiveFn(agent.sessionId) : false;
		};

		// 新形式（agents/*.md）では ruleFile は不要。削除済み。
		const ruleStrMap = new Map<string, string>();

		if (!element) {
			// 短期キャッシュ: タブ切り替え時の IO 抑制
			const now = Date.now();
			if (this._rootChildrenCache && (now - this._rootChildrenCache.ts) < this.ROOT_CACHE_TTL_MS) {
				return this._rootChildrenCache.nodes;
			}

			const result: AgentTreeNode[] = [];

			// バナー判定を並列化して IO 待ちを最小化
			const [csmAskAgentInstalled, sessionInjectInstalled, hasOldFiles, legacyAgents] = await Promise.all([
				isCsmAskAgentInstalled(),
				isSessionAgentInjectInstalled(),
				hasOldAskAgentFiles(),
				detectLegacyAgents(agents),
			]);

			// /csm-ask-agent グローバルインストールバナー: 未インストール時のみ表示
			if (!csmAskAgentInstalled) {
				result.push(new CsmAskAgentInstallBannerItem());
			}

			// エージェント役割自動認識バナー: 未有効化かつエージェントが存在する時のみ
			if (!sessionInjectInstalled) {
				const allAgentsForBanner = await dataStore.getAgents();
				const hasLinkedAgent = allAgentsForBanner.some(a => !!a.sessionId);
				if (hasLinkedAgent) {
					result.push(new SessionInjectInstallBannerItem());
				}
			}

			// 旧ask-agent移行バナー
			if (hasOldFiles) {
				result.push(new AskAgentMigrationBannerItem());
			}

			// マイグレーションバナー: 旧形式のルールファイルがあれば表示
			this.migrationNeeded = legacyAgents.length > 0;
			if (this.migrationNeeded) {
				result.push(new MigrationBannerItem(legacyAgents.length));
			}

			// v0.5.18 §4-8: グルーピングモードが org 以外なら GroupNodeItem を返す（バナーは残す）
			if (this.groupMode !== 'org') {
				const groupNodes = buildGroupNodes(agents, checkLive, this.groupMode);
				result.push(...groupNodes);
				this._rootChildrenCache = { nodes: result, ts: now };
				return result;
			}

			// トップレベル: parentAgent 未設定（または孤児）かつ組織図表示対象
			// グローバルエージェント は仮想親の下に移動したので除外
			const topLevel = agents.filter((a) => (!a.parentAgent || !agentNames.has(a.parentAgent)) && shouldShowInOrgChart(a));
			// ソート: 子を持つ → 稼働中 → 名前順
			topLevel.sort((a, b) => {
				const aHasChildren = childMap.has(a.name) ? 0 : 1;
				const bHasChildren = childMap.has(b.name) ? 0 : 1;
				if (aHasChildren !== bHasChildren) { return aHasChildren - bHasChildren; }
				const aLive = checkLive(a) ? 0 : 1;
				const bLive = checkLive(b) ? 0 : 1;
				if (aLive !== bLive) { return aLive - bLive; }
				return a.name.localeCompare(b.name);
			});
			for (const agent of topLevel) {
				const isLive = checkLive(agent);
				const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
				const hasTasks = this.getVisibleTasksFn ? this.getVisibleTasksFn(agent.name).length > 0 : false;
				const hasChildrenFlag = childMap.has(agent.name) || hasTasks;
				const ws = this.watcherStates.get(agent.name);
				const mtimeMs = agent.sessionId ? this.getSessionMtimeFn?.(agent.sessionId) : undefined;
				const item = new AgentItem(agent, isLive, sessionTitle, false, hasChildrenFlag, ruleStrMap.get(agent.name) || '', ws?.modelMismatch ?? false, ws?.actualModel, isOtherProject(agent), mtimeMs);
				this.lastAgentItemsByName.set(agent.name, item); // v0.5.17 §4-1: reveal 用
				result.push(item);
			}

			// グローバルエージェント の仮想親ノード
			if (globalAgents.length > 0) {
				const globalAgentItem = new GlobalAgentsSectionItem();
				this.lastGlobalSectionItem = globalAgentItem; // v0.5.18 レビュー修正 (3): reveal 用
				result.push(globalAgentItem);
			} else {
				this.lastGlobalSectionItem = undefined;
			}

			// ルートノードをキャッシュ（TTL 5s）
			this._rootChildrenCache = { nodes: result, ts: Date.now() };
			return result;
		}

		// AgentItem の子: 子エージェント + タスクログ
		const result: AgentTreeNode[] = [];

		// 子エージェント
		const children = agents.filter((a) => a.parentAgent === element.agent.name);
		children.sort((a, b) => {
			const aLive = checkLive(a) ? 0 : 1;
			const bLive = checkLive(b) ? 0 : 1;
			if (aLive !== bLive) { return aLive - bLive; }
			return a.name.localeCompare(b.name);
		});
		for (const agent of children) {
			const isLive = checkLive(agent);
			const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
			const hasTasks = this.getVisibleTasksFn ? this.getVisibleTasksFn(agent.name).length > 0 : false;
			const hasChildren = childMap.has(agent.name) || hasTasks;
			const ws = this.watcherStates.get(agent.name);
			const mtimeMs = agent.sessionId ? this.getSessionMtimeFn?.(agent.sessionId) : undefined;
			const item = new AgentItem(agent, isLive, sessionTitle, true, hasChildren, ruleStrMap.get(agent.name) || '', ws?.modelMismatch ?? false, ws?.actualModel, isOtherProject(agent), mtimeMs);
			this.lastAgentItemsByName.set(agent.name, item); // v0.5.17 §4-1: reveal 用
			result.push(item);
		}

		// タスクログ
		if (this.getVisibleTasksFn) {
			const tasks = this.getVisibleTasksFn(element.agent.name);
			for (const task of tasks) {
				result.push(new TaskLogItem(task));
			}
		}

		return result;
	}

}

// ライブ経過時間を短い日本語形式に変換: 30秒 / 5分 / 2時間 / 3日
function formatLiveElapsed(ms: number): string {
	const sec = Math.floor(ms / 1000);
	if (sec < 60) { return `${sec}秒`; }
	const min = Math.floor(sec / 60);
	if (min < 60) { return `${min}分`; }
	const hr = Math.floor(min / 60);
	if (hr < 24) { return `${hr}時間`; }
	return `${Math.floor(hr / 24)}日`;
}

// エージェント管理サイドバーのTreeItem
export class AgentItem extends vscode.TreeItem {
	public readonly agent: AgentConfig;

	constructor(
		agent: AgentConfig,
		isLive: boolean,
		sessionTitle?: string,
		isChild: boolean = false,
		hasChildren: boolean = false,
		ruleStr: string = '',
		modelMismatch: boolean = false,
		actualModel?: string,
		public readonly isOtherProject: boolean = false,
		mtimeMs?: number,
	) {
		// v0.5.14 レビュー修正 (7): modelCatalog.getModelChar() に統一。
		//   旧: sonnet-1m を '１' 表示していたが、プレビュー（catalog char='Ｓ'）と食い違い。
		//   新: 母体モデルの頭文字を表示（1M情報はラベル/tooltipで担保）。
		//       これで agentTree / sessionTree / tagTree / agentPreview の頭文字が完全一致。
		const modelChar = getModelChar(agent.model);

		// 使い捨てラベル
		const disposableLabel = agent.sessionMode === 'disposable' ? ' 使い捨て' : '';
		// モデル不一致警告ラベル
		const mismatchLabel = modelMismatch ? ' ⚠️' : '';

		// ライブプレフィックス: [対話中] または [経過時間]
		// - isLive かつ mtime が 30 秒以内 → [対話中] (現在対話中と推定)
		// - isLive かつ mtime が古い      → [5分] のような経過時間
		// - 停止中                        → プレフィックスなし
		// v0.5.17 §4-5: [Open] → [対話中] へ和英統一
		let livePrefix = '';
		if (isLive && !isOtherProject) {
			if (mtimeMs !== undefined) {
				const elapsedMs = Date.now() - mtimeMs;
				livePrefix = elapsedMs < 30_000
					? '[対話中] '
					: `[${formatLiveElapsed(elapsedMs)}] `;
			} else {
				livePrefix = '[実行中] ';
			}
		}

		// 表示名: "[対話中] Ｏ  CSM開発部（csm-dev）使い捨て ⚠️"
		const agentDisplayName = agent.displayName
			? `${agent.displayName}（${agent.name}）`
			: agent.name;
		const displayName = `${livePrefix}${modelChar}\u2007${agentDisplayName}${disposableLabel}${mismatchLabel}`;

		// v0.5.18 §4-4: 起動時の展開状態を設定で制御
		//   claudeManager.agents.expandMode: 'all' | 'active-branches' | 'top-level'
		//   - all: 常に Expanded（従来動作）
		//   - active-branches: 稼働中の枝のみ Expanded、その他は Collapsed（既定）
		//   - top-level: 親ノードでも Collapsed で初期化する
		const expandMode = vscode.workspace.getConfiguration('claudeManager')
			.get<string>('agents.expandMode', 'active-branches');
		let collapsible: vscode.TreeItemCollapsibleState;
		if (!hasChildren) {
			collapsible = vscode.TreeItemCollapsibleState.None;
		} else if (expandMode === 'top-level') {
			collapsible = vscode.TreeItemCollapsibleState.Collapsed;
		} else if (expandMode === 'active-branches') {
			collapsible = isLive
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.Collapsed;
		} else {
			collapsible = vscode.TreeItemCollapsibleState.Expanded;
		}

		super(displayName, collapsible);
		this.agent = agent;

		// v0.5.18 §4-4: description をシンプルに『セッションタイトル + 経過時間』へ絞る。
		//   旧: `${orgChartFlag} ${sessionInfo}` — 👁/🙈 で行が混み合っていた
		//   新: セッション未紐づけなら「未紐づけ」、紐づけありならタイトル + 経過時間
		//        👁/🙈（組織図表示フラグ）は tooltip 側に移動。
		const sessionInfo = agent.sessionId
			? (sessionTitle || `${agent.sessionId.substring(0, 8)}...`)
			: '未紐づけ';
		const elapsedForDesc = (isLive && !isOtherProject && mtimeMs !== undefined)
			? formatLiveElapsed(Date.now() - mtimeMs)
			: '';
		this.description = elapsedForDesc
			? `${sessionInfo} · ${elapsedForDesc}`
			: sessionInfo;

		// ツールチップ
		const modelLine = modelMismatch && actualModel
			? `| モデル（設定） | ${agent.model} |\n| モデル（実際） | **⚠️ ${actualModel}** |\n`
			: `| モデル | ${agent.model} |\n`;
		const displayRoleStr = agent.displayRole || agent.role || '未設定';
		const orgChartFlag = shouldShowInOrgChart(agent) ? '👁 組織図に表示' : '🙈 組織図から除外';
		this.tooltip = new vscode.MarkdownString(
			`**${agent.name}**${modelMismatch ? ' ⚠️ モデル不一致' : ''}\n\n` +
			`| | |\n|---|---|\n` +
			`| 役割 | ${displayRoleStr} |\n` +
			(agent.displayDescription ? `| 説明 | ${agent.displayDescription} |\n` : '') +
			modelLine +
			`| 運用 | ${agent.sessionMode === 'disposable' ? '使い捨て' : '固定'} |\n` +
			`| セッション | ${sessionInfo} |\n` +
			`| 表示 | ${orgChartFlag} |\n` +
			(agent.parentAgent ? `| 親エージェント | ${agent.parentAgent} |\n` : '') +
			(agent.workDir ? `| 作業フォルダ | ${agent.workDir} |\n` : '')
		);

		// アイコン: エージェント状態表示
		// 🟢 動作中 = circle-filled + green
		// ⚪ 停止中（紐づけあり） = circle-outline + foreground
		// ⚪ 停止中（未紐づけ） = circle-outline + disabledForeground
		// 🟡 応答待ち（将来拡張用スタブ）= circle-filled + yellow
		// 他プロジェクトのエージェントは灰色表示
		if (isOtherProject) {
			this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
			this.description = `🔒 ${agent.scope === 'project' ? '他プロジェクト' : ''} ${this.description || ''}`.trim();
		} else {
			const agentStatus: 'running' | 'idle' | 'unlinked' =
				isLive ? 'running'
				: !agent.sessionId ? 'unlinked'
				: 'idle';
			switch (agentStatus) {
				case 'running':
					this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
					break;
				case 'idle':
					this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('foreground'));
					break;
				case 'unlinked':
					this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
					break;
			}
		}

		// contextValue: セッション紐づけ + ブックマーク状態で分岐
		// agentItem / agentItemLinked / agentItemBookmarked / agentItemLinkedBookmarked
		const linked = agent.sessionId ? 'Linked' : '';
		const bookmarked = isBookmarked(agent.name) ? 'Bookmarked' : '';
		this.contextValue = `agentItem${linked}${bookmarked}`;

		// 他プロジェクトは装飾プロバイダで灰色化する用のresourceUriを設定
		if (isOtherProject) {
			this.resourceUri = vscode.Uri.parse(`csm-agent-other://${agent.name}`);
		}

		// クリックでプレビューを表示
		this.command = {
			command: 'claudeManager.previewAgent',
			title: 'エージェントプレビュー',
			arguments: [this],
		};
	}
}

// 他プロジェクトのエージェントを灰色化する装飾プロバイダ
export class AgentDecorationProvider implements vscode.FileDecorationProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChange.event;

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme === 'csm-agent-other') {
			return {
				color: new vscode.ThemeColor('disabledForeground'),
				tooltip: '他プロジェクトのエージェント',
			};
		}
		return undefined;
	}

	refresh(): void { this._onDidChange.fire(undefined); }
}

// マイグレーションバナーのTreeItem
export class MigrationBannerItem extends vscode.TreeItem {
	constructor(legacyCount: number) {
		super(`⚠ 旧形式のルールファイルが${legacyCount}件あります`, vscode.TreeItemCollapsibleState.None);
		this.description = 'クリックで移行';
		this.tooltip = new vscode.MarkdownString(
			`**ルールファイル移行が必要です**\n\n` +
			`旧形式（CSM:AUTOマーカー / フロントマターなし / フラット構造）のルールファイルが **${legacyCount}件** 検出されました。\n\n` +
			`クリックすると以下を一括実行します:\n` +
			`- YAML フロントマター形式に変換\n` +
			`- フォルダ構造に移行（部署名/部署名.md）\n` +
			`- HISTORY.md テンプレート作成\n` +
			`- session-manager.json のパス更新`
		);
		this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('terminal.ansiYellow'));
		this.contextValue = 'migrationBanner';
		this.command = {
			command: 'claudeManager.migrateRuleFiles',
			title: 'ルールファイルを移行',
		};
	}
}

// グローバルエージェント セクションのTreeItem
export class GlobalAgentsSectionItem extends vscode.TreeItem {
	constructor() {
		super('📦 グローバルエージェント', vscode.TreeItemCollapsibleState.Collapsed);
		this.description = '組織図に含まれない汎用エージェント';
		this.tooltip = new vscode.MarkdownString(
			`**グローバルエージェント**\n\n` +
			`組織図とは無関係な汎用エージェント群。\n` +
			`コード審査、テスト、セキュリティ等の機能を提供します。`
		);
		// 装飾プロバイダで灰色化（メインの組織図と区別）
		this.resourceUri = vscode.Uri.parse('csm-agent-other://global-agents-section');
		this.iconPath = new vscode.ThemeIcon('package', new vscode.ThemeColor('disabledForeground'));
		this.contextValue = 'globalAgentsSection';
	}
}

/**
 * v0.5.18 §4-8: グルーピングモードごとに GroupNodeItem 配列を組み立てる。
 *   - model: モデルごとに集約
 *   - status: 稼働中 / 待機 / 未紐づけ
 *   - flat: 全エージェント 1 グループ（名前順）
 */
function buildGroupNodes(
	agents: AgentConfig[],
	checkLive: (a: AgentConfig) => boolean,
	mode: 'model' | 'status' | 'flat',
): GroupNodeItem[] {
	if (mode === 'flat') {
		const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
		return [new GroupNodeItem('📋 すべて', sorted, 'list-flat')];
	}
	if (mode === 'model') {
		const byModel = new Map<string, AgentConfig[]>();
		for (const a of agents) {
			const key = a.model || 'unknown';
			const arr = byModel.get(key) || [];
			arr.push(a);
			byModel.set(key, arr);
		}
		const order = ['fable', 'fable-1m', 'opus', 'opus-1m', 'sonnet', 'sonnet-1m', 'haiku', 'unknown'];
		const keys = Array.from(byModel.keys()).sort((a, b) => {
			const ai = order.indexOf(a); const bi = order.indexOf(b);
			return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
		});
		return keys.map((k) => new GroupNodeItem(`🎨 ${k}`, byModel.get(k)!.sort((a, b) => a.name.localeCompare(b.name)), 'symbol-color'));
	}
	// status
	const active: AgentConfig[] = [];
	const idle: AgentConfig[] = [];
	const unlinked: AgentConfig[] = [];
	for (const a of agents) {
		if (checkLive(a)) { active.push(a); }
		else if (!a.sessionId) { unlinked.push(a); }
		else { idle.push(a); }
	}
	const byName = (a: AgentConfig, b: AgentConfig) => a.name.localeCompare(b.name);
	return [
		new GroupNodeItem('🟢 稼働中', active.sort(byName), 'circle-filled', 'terminal.ansiGreen'),
		new GroupNodeItem('⚪ 待機', idle.sort(byName), 'circle-outline'),
		new GroupNodeItem('🔗 未紐づけ', unlinked.sort(byName), 'link', 'disabledForeground'),
	].filter((g) => g.childrenAgentNames.length > 0);
}

/**
 * v0.5.18 §4-8: 汎用グループノード（モデル別 / 状態別 / フラットモードで使用）。
 *   childrenAgentNames をこのノードに紐づけ、getChildren の element 分岐で対象 AgentItem を返す。
 */
export class GroupNodeItem extends vscode.TreeItem {
	public readonly childrenAgentNames: string[];
	constructor(label: string, agents: AgentConfig[], iconId: string, themeColor?: string) {
		super(`${label} (${agents.length})`, vscode.TreeItemCollapsibleState.Expanded);
		this.childrenAgentNames = agents.map((a) => a.name);
		this.iconPath = themeColor
			? new vscode.ThemeIcon(iconId, new vscode.ThemeColor(themeColor))
			: new vscode.ThemeIcon(iconId);
		this.contextValue = 'agentGroupNode';
	}
}

// /csm-ask-agent グローバルインストールバナー
// SessionStart エージェント役割注入hookの有効化バナー
export class SessionInjectInstallBannerItem extends vscode.TreeItem {
	constructor() {
		super('🤖 エージェント役割自動認識を有効化', vscode.TreeItemCollapsibleState.None);
		this.description = 'セッション開始時に役割を自動注入';
		this.tooltip = new vscode.MarkdownString(
			`**エージェント役割自動認識**\n\n` +
			`CSMで紐づけたエージェントの役割定義をセッション開始時に自動注入します。\n\n` +
			`有効化すると、次回セッション開始時からClaudeが自分の役割を自動認識します。`
		);
		this.iconPath = new vscode.ThemeIcon('sparkle', new vscode.ThemeColor('charts.purple'));
		this.contextValue = 'sessionInjectInstallBanner';
		this.command = {
			command: 'claudeManager.enableSessionAgentInject',
			title: 'エージェント役割自動認識を有効化',
		};
	}
}

export class CsmAskAgentInstallBannerItem extends vscode.TreeItem {
	constructor() {
		super('🔧 /csm-ask-agent をインストール', vscode.TreeItemCollapsibleState.None);
		this.description = 'コマンド・スクリプト・安全hook';
		this.tooltip = new vscode.MarkdownString(
			`**/csm-ask-agent のインストール**\n\n` +
			`エージェント指示スキルを ~/.claude/ にインストールします。\n\n` +
			`- \`commands/csm-ask-agent.md\` — スキル定義\n` +
			`- \`scripts/csm-ask-agent.py\` — エージェント情報取得\n` +
			`- \`hooks/check-csm-ask-agent.sh\` — 安全ガード`
		);
		this.iconPath = new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.blue'));
		this.contextValue = 'csmAskAgentInstallBanner';
		this.command = {
			command: 'claudeManager.installCsmAskAgent',
			title: '/csm-ask-agent をインストール',
		};
	}
}

// 旧ask-agent → csm-ask-agent 移行バナー
export class AskAgentMigrationBannerItem extends vscode.TreeItem {
	constructor() {
		super('🔄 ask-agent → csm-ask-agent に移行', vscode.TreeItemCollapsibleState.None);
		this.description = '旧ファイルを自動リネーム';
		this.tooltip = new vscode.MarkdownString(
			`**旧 ask-agent ファイルが検出されました**\n\n` +
			`クリックすると以下を自動リネームします:\n` +
			`- \`ask-agent.md\` → \`csm-ask-agent.md\`\n` +
			`- \`check-ask-agent.sh\` → \`check-csm-ask-agent.sh\`\n` +
			`- \`ask-agent.py\` → \`csm-ask-agent.py\`\n` +
			`- settings.json のhookパスも更新`
		);
		this.iconPath = new vscode.ThemeIcon('arrow-right', new vscode.ThemeColor('charts.orange'));
		this.contextValue = 'askAgentMigrationBanner';
		this.command = {
			command: 'claudeManager.migrateAskAgent',
			title: 'ask-agent → csm-ask-agent に移行',
		};
	}
}

// 旧ask-agentファイルが残っているかチェック
async function hasOldAskAgentFiles(): Promise<boolean> {
	const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!wsFolder) { return false; }
	const oldFiles = [
		path.join(wsFolder, '.claude', 'commands', 'ask-agent.md'),
		path.join(wsFolder, '.claude', 'hooks', 'check-ask-agent.sh'),
		path.join(wsFolder, '.claude', 'scripts', 'ask-agent.py'),
	];
	for (const f of oldFiles) {
		try {
			await fs.promises.access(f);
			return true;
		} catch { /* なし */ }
	}
	return false;
}

// /csm-ask-agent がグローバルにインストール済みかチェック
async function isCsmAskAgentInstalled(): Promise<boolean> {
	const homeDir = require('os').homedir();
	const targets = [
		path.join(homeDir, '.claude', 'commands', 'csm-ask-agent.md'),
		path.join(homeDir, '.claude', 'scripts', 'csm-ask-agent.py'),
	];
	for (const t of targets) {
		try {
			await fs.promises.access(t);
		} catch {
			return false;
		}
	}
	return true;
}

// SessionStart エージェント注入hookがNode.js版で設定済みかチェック
async function isSessionAgentInjectInstalled(): Promise<boolean> {
	const homeDir = require('os').homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	try {
		const raw = await fs.promises.readFile(settingsPath, 'utf-8');
		const settings = JSON.parse(raw);
		const sessionStart = settings?.hooks?.SessionStart;
		if (!Array.isArray(sessionStart)) { return false; }
		return sessionStart.some((entry: Record<string, unknown>) => {
			const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
			if (!Array.isArray(innerHooks)) { return false; }
			return innerHooks.some((hh: Record<string, unknown>) =>
				typeof hh.command === 'string' &&
				hh.command.includes('csm-session-agent-inject')
				// .sh版も.js版もインストール済みとみなす（マイグレーション中も非表示）
			);
		});
	} catch {
		return false;
	}
}

// 旧形式のルールファイルを持つエージェントを検出
async function detectLegacyAgents(agents: AgentConfig[]): Promise<AgentConfig[]> {
	const legacy: AgentConfig[] = [];
	for (const agent of agents) {
		if (!agent.ruleFile) { continue; }
		try {
			const resolved = await resolveRuleFilePath(agent.ruleFile);
			if (!resolved) { continue; }

			// 新形式（agents/*.md）からのエージェントは除外
			// パターン: /.claude/agents/... または \\.claude\\agents\\...
			if (resolved.includes('/.claude/agents/') || resolved.includes('\\.claude\\agents\\')) {
				// 新形式は自動的にYAMLフロントマター + 正しい構造なので、レガシーではない
				continue;
			}

			// フラット構造チェック: 親ディレクトリ名がエージェント名と一致しない
			const parentName = path.basename(path.dirname(resolved));
			const isFlat = parentName !== agent.name;

			// ファイル内容チェック
			const content = await fs.promises.readFile(resolved, 'utf-8');
			const hasLegacyMarker = isLegacyAutoFormat(content);
			const hasFm = hasFrontmatter(content);

			if (isFlat || hasLegacyMarker || !hasFm) {
				legacy.push(agent);
			}
		} catch {
			// ファイル読み込みエラーは無視
		}
	}
	return legacy;
}

// タスクログのTreeItem
export class TaskLogItem extends vscode.TreeItem {
	public readonly taskLog: TaskLog;

	constructor(taskLog: TaskLog) {
		// ステータスアイコン
		const statusIcon = taskLog.status === 'running' ? '$(sync~spin)'
			: taskLog.status === 'stalled' ? '$(warning)'
			: taskLog.status === 'completed' ? '$(check)'
			: taskLog.status === 'error' ? '$(error)'
			: '$(clock)'; // pending

		const label = `${statusIcon} ${taskLog.summary}`;
		super(label, vscode.TreeItemCollapsibleState.None);
		this.taskLog = taskLog;

		// description: 経過時間
		const elapsed = Date.now() - taskLog.createdAt;
		const minutes = Math.floor(elapsed / 60000);
		const hours = Math.floor(minutes / 60);
		this.description = hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;

		// ツールチップ
		const statusLabel = taskLog.status === 'running' ? '実行中'
			: taskLog.status === 'stalled' ? '応答停止'
			: taskLog.status === 'completed' ? '完了'
			: taskLog.status === 'error' ? 'エラー'
			: '待機中';
		this.tooltip = new vscode.MarkdownString(
			`**${taskLog.summary}**\n\n` +
			`| | |\n|---|---|\n` +
			`| 状態 | ${statusLabel} |\n` +
			`| エージェント | ${taskLog.agentName} |\n` +
			`| 作成 | ${new Date(taskLog.createdAt).toLocaleString('ja-JP')} |\n` +
			(taskLog.completedAt ? `| 完了 | ${new Date(taskLog.completedAt).toLocaleString('ja-JP')} |\n` : '') +
			(taskLog.outputFile ? `| 出力 | ${taskLog.outputFile} |\n` : '')
		);

		// アイコン
		switch (taskLog.status) {
			case 'running':
				this.iconPath = new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('terminal.ansiBlue'));
				break;
			case 'stalled':
				this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('terminal.ansiYellow'));
				break;
			case 'completed':
				this.iconPath = new vscode.ThemeIcon('check', new vscode.ThemeColor('terminal.ansiGreen'));
				break;
			case 'error':
				this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('terminal.ansiRed'));
				break;
			default: // pending
				this.iconPath = new vscode.ThemeIcon('clock', new vscode.ThemeColor('disabledForeground'));
				break;
		}

		// contextValue: タスクログ操作用
		const hasOutput = taskLog.outputFile ? 'WithOutput' : '';
		const isActive = (taskLog.status === 'running' || taskLog.status === 'stalled' || taskLog.status === 'pending') ? 'Active' : '';
		this.contextValue = `taskLogItem${isActive}${hasOutput}`;

		// クリックで出力ファイルを開く（あれば）
		if (taskLog.outputFile) {
			this.command = {
				command: 'claudeManager.openTaskOutput',
				title: '出力ファイルを開く',
				arguments: [taskLog],
			};
		}
	}
}
