import * as vscode from 'vscode';
import { AgentConfig, ParsedSession, TaskLog } from './types';
import * as dataStore from './dataStore';
import { getRuleFileInfo } from './agentManager';

type AgentTreeNode = AgentItem | TaskLogItem;

// エージェント管理サイドバーのTreeDataProvider（ツリー構造対応）
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeNode>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	private getSessionsFn: () => ParsedSession[];
	private isLiveFn: (id: string) => boolean;
	private activeAgentNamesFn: () => Set<string>;
	private getVisibleTasksFn: ((agentName: string) => TaskLog[]) | undefined;

	constructor(
		getSessions: () => ParsedSession[],
		isLive: (id: string) => boolean,
		getActiveAgentNames?: () => Set<string>
	) {
		this.getSessionsFn = getSessions;
		this.isLiveFn = isLive;
		this.activeAgentNamesFn = getActiveAgentNames || (() => new Set());
	}

	// TaskTracker 連携用セッター（循環依存回避のため後付け）
	setTaskProvider(fn: (agentName: string) => TaskLog[]): void {
		this.getVisibleTasksFn = fn;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: AgentTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: AgentTreeNode): Promise<AgentTreeNode[]> {
		// TaskLogItem は子を持たない
		if (element instanceof TaskLogItem) { return []; }

		const agents = await dataStore.getAgents();
		if (agents.length === 0) { return []; }

		// セッションタイトル対応表
		const sessions = this.getSessionsFn();
		const titleMap = new Map<string, string>();
		for (const s of sessions) {
			titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
		}

		// エージェント名一覧（親の存在チェック用）
		const agentNames = new Set(agents.map((a) => a.name));

		// 子を持つかどうかを判定
		const childMap = new Map<string, AgentConfig[]>();
		for (const a of agents) {
			if (a.parentAgent && agentNames.has(a.parentAgent)) {
				const children = childMap.get(a.parentAgent) || [];
				children.push(a);
				childMap.set(a.parentAgent, children);
			}
		}

		// JSONL解析ベースの稼働中エージェント名
		const activeNames = this.activeAgentNamesFn();

		// isLive判定: sessionProviderのライブ検出 OR JSONL解析の稼働検出
		const checkLive = (agent: AgentConfig): boolean => {
			if (activeNames.has(agent.name)) { return true; }
			return agent.sessionId ? this.isLiveFn(agent.sessionId) : false;
		};

		// ルールファイル行数を非同期で一括取得
		const ruleStrMap = new Map<string, string>();
		const ruleAgents = agents.filter((a) => a.ruleFile);
		const ruleResults = await Promise.allSettled(
			ruleAgents.map(async (a) => {
				const info = await getRuleFileInfo(a.ruleFile!);
				return { name: a.name, str: info ? `${info.lines}行` : '未検出' };
			})
		);
		for (const r of ruleResults) {
			if (r.status === 'fulfilled') {
				ruleStrMap.set(r.value.name, r.value.str);
			}
		}

		if (!element) {
			// トップレベル: parentAgent 未設定、または存在しない親を参照しているもの（孤児防止）
			const topLevel = agents.filter((a) => !a.parentAgent || !agentNames.has(a.parentAgent));
			// ソート: 子を持つエージェントが上 → 稼働中を上 → 名前順
			topLevel.sort((a, b) => {
				const aHasChildren = childMap.has(a.name) ? 0 : 1;
				const bHasChildren = childMap.has(b.name) ? 0 : 1;
				if (aHasChildren !== bHasChildren) { return aHasChildren - bHasChildren; }
				const aLive = checkLive(a) ? 0 : 1;
				const bLive = checkLive(b) ? 0 : 1;
				if (aLive !== bLive) { return aLive - bLive; }
				return a.name.localeCompare(b.name);
			});
			return topLevel.map((agent) => {
				const isLive = checkLive(agent);
				const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
				const hasTasks = this.getVisibleTasksFn ? this.getVisibleTasksFn(agent.name).length > 0 : false;
				const hasChildren = childMap.has(agent.name) || hasTasks;
				return new AgentItem(agent, isLive, sessionTitle, false, hasChildren, ruleStrMap.get(agent.name) || '');
			});
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
			result.push(new AgentItem(agent, isLive, sessionTitle, true, hasChildren, ruleStrMap.get(agent.name) || ''));
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

// エージェント管理サイドバーのTreeItem
export class AgentItem extends vscode.TreeItem {
	public readonly agent: AgentConfig;

	constructor(
		agent: AgentConfig,
		isLive: boolean,
		sessionTitle?: string,
		isChild: boolean = false,
		hasChildren: boolean = false,
		ruleStr: string = ''
	) {
		// モデル頭文字（会話一覧と同じ全角表記）
		const modelChar = agent.model === 'opus' ? 'Ｏ'
			: agent.model === 'haiku' ? 'Ｈ'
			: 'Ｓ';

		// 使い捨てラベル
		const disposableLabel = agent.sessionMode === 'disposable' ? ' 使い捨て' : '';

		// 表示名: "Ｏ  CSM開発部 使い捨て"
		const displayName = `${modelChar}\u2007${agent.name}${disposableLabel}`;

		// 折りたたみ状態
		const collapsible = hasChildren
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None;

		super(displayName, collapsible);
		this.agent = agent;

		// description: ルール行数 + セッション情報
		const parts: string[] = [];
		if (ruleStr) {
			parts.push(`📄${ruleStr}`);
		}
		const sessionInfo = agent.sessionId
			? (sessionTitle || `${agent.sessionId.substring(0, 8)}...`)
			: '未紐づけ';
		parts.push(sessionInfo);
		this.description = parts.join(' ');

		// ツールチップ
		this.tooltip = new vscode.MarkdownString(
			`**${agent.name}**\n\n` +
			`| | |\n|---|---|\n` +
			`| 役割 | ${agent.role || '未設定'} |\n` +
			`| モデル | ${agent.model} |\n` +
			`| 運用 | ${agent.sessionMode === 'disposable' ? '使い捨て' : '固定'} |\n` +
			`| セッション | ${sessionInfo} |\n` +
			(agent.parentAgent ? `| 親エージェント | ${agent.parentAgent} |\n` : '') +
			(agent.workDir ? `| 作業フォルダ | ${agent.workDir} |\n` : '') +
			(agent.ruleFile ? `| ルールファイル | ${agent.ruleFile} |\n` : '')
		);

		// アイコン: エージェント状態表示
		// 🟢 動作中 = circle-filled + green
		// ⚪ 停止中（紐づけあり） = circle-outline + foreground
		// ⚪ 停止中（未紐づけ） = circle-outline + disabledForeground
		// 🟡 応答待ち（将来拡張用スタブ）= circle-filled + yellow
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

		// contextValue: セッション紐づけ・ルールファイルの有無で分岐
		// agentItemLinked / agentItemLinkedWithRule / agentItem / agentItemWithRule
		const linked = agent.sessionId ? 'Linked' : '';
		const withRule = agent.ruleFile ? 'WithRule' : '';
		this.contextValue = `agentItem${linked}${withRule}`;

		// クリックでプレビューを表示
		this.command = {
			command: 'claudeManager.previewAgent',
			title: 'エージェントプレビュー',
			arguments: [this],
		};
	}
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
