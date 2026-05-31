/**
 * orchestrationTreeProvider.ts — v0.5.x T7.2
 * 🎼 オーケストレーション可視化タブの TreeDataProvider。
 *
 * ツリー構成:
 *   [サマリーバー] 🎼 N セッション / M サブエージェント (最終更新)
 *   [グループ] 🟢 インタラクティブ (N)
 *     [セッション] ● セッション名 — cwd [経過時間]
 *       [サブエージェント] ◆ Task: description...
 *   [グループ] ⚙️ バックグラウンド/ワークフロー (N)
 *     ...
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { ClaudeAgentsService, formatElapsed } from '../services/claudeAgentsService';
import { AgentWatcher } from '../watchers/agentWatcher';
import {
	buildOrchestrationViewModel,
	OrchestrationViewModel,
	OrchestrationSession,
} from '../services/orchestrationViewModel';
import { SubagentInfo } from '../models/types';

// -------------------------------------------------------------------
// ノード型
// -------------------------------------------------------------------

type OrchNode =
	| SummaryItem
	| GroupItem
	| SessionItem
	| SubagentItem
	| EmptyItem;

// -------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------

export class OrchestrationTreeProvider
	implements vscode.TreeDataProvider<OrchNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<OrchNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _claudeAgentsService: ClaudeAgentsService | undefined;
	private _agentWatcher: AgentWatcher | undefined;
	private _serviceDisposable: vscode.Disposable | undefined;
	private _watcherDisposable: vscode.Disposable | undefined;

	/** キャッシュ済みビューモデル */
	private _viewModel: OrchestrationViewModel | null = null;
	/** タブが可視かどうか */
	private _visible = false;
	/** ポーリングタイマー */
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private readonly POLL_INTERVAL_MS = 5000;

	dispose(): void {
		this._stopTimer();
		this._serviceDisposable?.dispose();
		this._watcherDisposable?.dispose();
		this._onDidChangeTreeData.dispose();
	}

	setClaudeAgentsService(service: ClaudeAgentsService): void {
		this._serviceDisposable?.dispose();
		this._claudeAgentsService = service;
		// サービスのデータ変化を即時反映
		this._serviceDisposable = service.onDidChange(() => this._invalidateAndRefresh());
	}

	setAgentWatcher(watcher: AgentWatcher): void {
		this._watcherDisposable?.dispose();
		this._agentWatcher = watcher;
		this._watcherDisposable = watcher.onDidChange(() => this._invalidateAndRefresh());
	}

	/** タブ可視性の変化を通知（ポーリング制御） */
	setVisible(visible: boolean): void {
		const wasVisible = this._visible;
		this._visible = visible;
		if (visible && !wasVisible) {
			this._invalidateAndRefresh();
			this._startPolling();
		} else if (!visible && wasVisible) {
			this._stopTimer();
		}
	}

	/** 手動リフレッシュ */
	refresh(): void {
		this._invalidateAndRefresh();
	}

	// -------------------------------------------------------------------
	// TreeDataProvider
	// -------------------------------------------------------------------

	getTreeItem(element: OrchNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: OrchNode): Promise<OrchNode[]> {
		// 子ノード
		if (element instanceof GroupItem) {
			return this._buildSessionChildren(element.sessions);
		}
		if (element instanceof SessionItem) {
			return this._buildSubagentChildren(element.session);
		}
		if (element instanceof SummaryItem
			|| element instanceof SubagentItem
			|| element instanceof EmptyItem) {
			return [];
		}

		// ルート
		return this._buildRoot();
	}

	// -------------------------------------------------------------------
	// 内部ビルド
	// -------------------------------------------------------------------

	private async _buildRoot(): Promise<OrchNode[]> {
		if (!this._claudeAgentsService || !this._agentWatcher) {
			return [new EmptyItem('初期化中...', '依存サービス待機', 'loading')];
		}

		// ビューモデルが未取得または古い場合は再構築
		if (!this._viewModel) {
			try {
				this._viewModel = await buildOrchestrationViewModel(
					this._claudeAgentsService,
					this._agentWatcher,
				);
			} catch {
				return [new EmptyItem('取得エラー', 'データの取得に失敗しました', 'warning')];
			}
		}

		const vm = this._viewModel;
		const result: OrchNode[] = [];

		// サマリーバー
		result.push(new SummaryItem(vm));

		if (vm.sessions.length === 0) {
			result.push(new EmptyItem(
				'稼働中のセッションなし',
				'バックグラウンドエージェントが起動すると表示されます',
				'info',
			));
			return result;
		}

		// インタラクティブグループ
		const interactive = vm.sessions.filter(s => !s.isWorkflowLike);
		if (interactive.length > 0) {
			result.push(new GroupItem('interactive', interactive));
		}

		// バックグラウンド/ワークフローグループ
		const background = vm.sessions.filter(s => s.isWorkflowLike);
		if (background.length > 0) {
			result.push(new GroupItem('background', background));
		}

		return result;
	}

	private _buildSessionChildren(sessions: OrchestrationSession[]): OrchNode[] {
		return sessions.map(s => new SessionItem(s));
	}

	private _buildSubagentChildren(session: OrchestrationSession): OrchNode[] {
		if (session.subagents.length === 0) {
			return [new EmptyItem('サブエージェントなし', '', 'info')];
		}
		return session.subagents.map(sa => new SubagentItem(sa));
	}

	// -------------------------------------------------------------------
	// ポーリング
	// -------------------------------------------------------------------

	private _invalidateAndRefresh(): void {
		this._viewModel = null;
		this._onDidChangeTreeData.fire(undefined);
	}

	private _stopTimer(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _startPolling(): void {
		this._stopTimer();
		this._timer = setTimeout(() => {
			this._timer = undefined;
			if (this._visible) {
				this._invalidateAndRefresh();
				this._startPolling();
			}
		}, this.POLL_INTERVAL_MS);
	}
}

// -------------------------------------------------------------------
// ツリーアイテム
// -------------------------------------------------------------------

/** サマリーバー (ルート先頭の集計ノード) */
class SummaryItem extends vscode.TreeItem {
	constructor(vm: OrchestrationViewModel) {
		const sessionCount = vm.sessions.length;
		const subCount = vm.totalSubagentCount;
		const label = sessionCount === 0
			? '🎼 オーケストレーション — 待機中'
			: `🎼 ${sessionCount} セッション / ${subCount} サブエージェント`;

		super(label, vscode.TreeItemCollapsibleState.None);

		const age = Math.floor((Date.now() - vm.updatedAt) / 1000);
		this.description = `更新 ${age}秒前 (${vm.source === 'claude-agents-json' ? 'JSON API' : 'PID 監視'})`;
		this.iconPath = new vscode.ThemeIcon('circuit-board', new vscode.ThemeColor(
			sessionCount > 0 ? 'terminal.ansiGreen' : 'foreground'
		));
		this.tooltip = new vscode.MarkdownString(
			`**🎼 オーケストレーション**\n\n` +
			`| | |\n|---|---|\n` +
			`| セッション数 | ${sessionCount} |\n` +
			`| インタラクティブ | ${vm.interactiveCount} |\n` +
			`| バックグラウンド | ${vm.backgroundCount} |\n` +
			`| サブエージェント | ${subCount} |\n` +
			`| データソース | ${vm.source} |\n`,
		);
		this.contextValue = 'orchestrationSummary';
	}
}

/** グループノード (interactive / background) */
export class GroupItem extends vscode.TreeItem {
	public readonly sessions: OrchestrationSession[];

	constructor(kind: 'interactive' | 'background', sessions: OrchestrationSession[]) {
		const label = kind === 'interactive'
			? `🟢 インタラクティブ (${sessions.length})`
			: `⚙️ バックグラウンド / ワークフロー (${sessions.length})`;

		super(label, vscode.TreeItemCollapsibleState.Expanded);
		this.sessions = sessions;

		this.iconPath = new vscode.ThemeIcon(
			kind === 'interactive' ? 'person' : 'gear',
			new vscode.ThemeColor(kind === 'interactive' ? 'terminal.ansiGreen' : 'terminal.ansiYellow'),
		);
		this.description = `${sessions.length} セッション`;
		this.contextValue = `orchestrationGroup_${kind}`;
	}
}

/** セッションノード */
export class SessionItem extends vscode.TreeItem {
	public readonly session: OrchestrationSession;

	constructor(session: OrchestrationSession) {
		const name = session.linkedDisplayName
			|| (session.sessionId ? session.sessionId.substring(0, 8) : '(不明)');
		const hasSubagents = session.subagents.length > 0;

		super(name, hasSubagents
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None
		);
		this.session = session;

		const cwdShort = session.cwd ? (path.basename(session.cwd) || session.cwd) : '—';
		const elapsed = formatElapsed(session.elapsedSec);
		const subCount = session.subagents.length;

		this.description = `${cwdShort}  ${elapsed}${subCount > 0 ? `  [${subCount} sub]` : ''}`;
		this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(
			session.kind === 'background' || session.isWorkflowLike
				? 'terminal.ansiYellow'
				: 'terminal.ansiGreen'
		));

		this.tooltip = new vscode.MarkdownString(
			`**${name}**\n\n` +
			`| | |\n|---|---|\n` +
			`| セッション ID | \`${session.sessionId || '—'}\` |\n` +
			`| 作業ディレクトリ | \`${session.cwd || '—'}\` |\n` +
			`| kind | \`${session.kind}\` |\n` +
			`| 経過時間 | ${elapsed} |\n` +
			(session.pid !== undefined ? `| PID | ${session.pid} |\n` : '') +
			`| サブエージェント | ${subCount} |\n` +
			(session.linkedAgentName ? `| CSM エージェント | ${session.linkedAgentName} |\n` : ''),
		);
		this.tooltip.isTrusted = true;

		// クリックでセッションプレビュー（セッション ID が分かる場合）
		if (session.sessionId) {
			this.command = {
				command: 'claudeManager.openSessionInOrchestration',
				title: 'セッション操作',
				arguments: [session],
			};
		}

		this.contextValue = session.linkedAgentName
			? 'orchestrationSessionLinked'
			: 'orchestrationSession';
	}
}

/** サブエージェントノード */
export class SubagentItem extends vscode.TreeItem {
	public readonly subagentInfo: SubagentInfo;

	constructor(info: SubagentInfo) {
		const desc = info.description
			? (info.description.length > 60 ? `${info.description.substring(0, 60)}…` : info.description)
			: `${info.name} (no description)`;

		super(desc, vscode.TreeItemCollapsibleState.None);
		this.subagentInfo = info;

		const elapsedSec = Math.floor((Date.now() - info.startedAt) / 1000);
		this.description = formatElapsed(elapsedSec);

		this.iconPath = new vscode.ThemeIcon('layers', new vscode.ThemeColor('charts.purple'));
		this.tooltip = new vscode.MarkdownString(
			`**${info.name}**\n\n` +
			(info.description ? `${info.description}\n\n` : '') +
			`| | |\n|---|---|\n` +
			`| Tool Use ID | \`${info.toolUseId.substring(0, 16)}…\` |\n` +
			`| 経過時間 | ${formatElapsed(elapsedSec)} |\n`,
		);
		this.contextValue = 'orchestrationSubagent';
	}
}

/** 空/メッセージ/ローディングノード */
class EmptyItem extends vscode.TreeItem {
	constructor(label: string, description: string, kind: 'info' | 'warning' | 'loading') {
		super(label, vscode.TreeItemCollapsibleState.None);
		this.description = description;
		this.iconPath = new vscode.ThemeIcon(
			kind === 'loading' ? 'sync~spin'
			: kind === 'warning' ? 'warning'
			: 'info',
			kind === 'warning' ? new vscode.ThemeColor('terminal.ansiYellow') : undefined,
		);
		this.contextValue = 'orchestrationEmpty';
	}
}
