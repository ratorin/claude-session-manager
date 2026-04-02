import * as vscode from 'vscode';
import { AgentConfig, ParsedSession } from './types';
import * as dataStore from './dataStore';
import { getRuleFileInfo } from './agentManager';

type AgentTreeNode = AgentItem;

// エージェント管理サイドバーのTreeDataProvider（ツリー構造対応）
export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private getSessionsFn: () => ParsedSession[];
	private isLiveFn: (id: string) => boolean;

	constructor(
		getSessions: () => ParsedSession[],
		isLive: (id: string) => boolean
	) {
		this.getSessionsFn = getSessions;
		this.isLiveFn = isLive;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: AgentTreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: AgentTreeNode): AgentTreeNode[] {
		const agents = dataStore.getAgents();
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

		if (!element) {
			// トップレベル: parentAgent 未設定、または存在しない親を参照しているもの（孤児防止）
			const topLevel = agents.filter((a) => !a.parentAgent || !agentNames.has(a.parentAgent));
			// 「取締役」を最上位にソート
			topLevel.sort((a, b) => {
				if (a.name === '取締役') { return -1; }
				if (b.name === '取締役') { return 1; }
				return 0;
			});
			return topLevel.map((agent) => {
				const isLive = agent.sessionId ? this.isLiveFn(agent.sessionId) : false;
				const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
				const hasChildren = childMap.has(agent.name);
				return new AgentItem(agent, isLive, sessionTitle, false, hasChildren);
			});
		}

		// 子エージェント: parentAgent が element.agent.name のもの
		const children = agents.filter((a) => a.parentAgent === element.agent.name);
		return children.map((agent) => {
			const isLive = agent.sessionId ? this.isLiveFn(agent.sessionId) : false;
			const sessionTitle = agent.sessionId ? titleMap.get(agent.sessionId) : undefined;
			const hasChildren = childMap.has(agent.name);
			return new AgentItem(agent, isLive, sessionTitle, true, hasChildren);
		});
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
		hasChildren: boolean = false
	) {
		// モデル頭文字（会話一覧と同じ全角表記）
		const modelChar = agent.model === 'opus' ? 'Ｏ'
			: agent.model === 'haiku' ? 'Ｈ'
			: 'Ｓ';

		// ルールファイル行数
		let ruleStr = '';
		if (agent.ruleFile) {
			const info = getRuleFileInfo(agent.ruleFile);
			if (info) {
				ruleStr = `${info.lines}行`;
			} else {
				ruleStr = '未検出';
			}
		}

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

		// アイコン: ライブ状態
		if (isLive) {
			this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('terminal.ansiGreen'));
		} else if (!agent.sessionId) {
			this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
		} else {
			this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('foreground'));
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
