// agentLiveTreeProvider.ts — ライブ状態エージェント専用 TreeDataProvider
// データソース:
//   優先: ClaudeAgentsService (claude agents --json, 2.1.145+)
//   フォールバック: AgentWatcher (PID/JSONL 監視、claude agents 未対応環境)

import * as vscode from 'vscode';
import * as path from 'path';
import * as dataStore from '../models/dataStore';
import {
	LiveAgentView,
	ClaudeAgentEntry,
	ClaudeAgentsService,
	formatElapsed,
} from '../services/claudeAgentsService';
import { AgentWatcher } from '../watchers/agentWatcher';

type LiveTreeNode = LiveAgentItem | LiveStatusMessageItem;

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

	/** 後方互換: タブ可視性通知（agentWatcher は常時監視なので no-op） */
	notifyTabVisible(_visible: boolean): void {
		// agentWatcher はタブ可視性に依存しないため何もしない
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: LiveTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: LiveTreeNode): Promise<LiveTreeNode[]> {
		// フラットリスト — 子ノードなし
		if (element) { return []; }

		const watcher = this._agentWatcher;
		if (!watcher) { return []; }

		// エージェント監視が無効の場合
		if (!watcher.isEnabled()) {
			return [new LiveStatusMessageItem(
				'エージェント監視が無効です',
				'設定: claudeManager.enableAgentMonitor を有効にしてください',
				'info',
			)];
		}

		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		const showUnregistered = config.get<boolean>('showUnregistered', true);

		const states = watcher.getStates();
		const liveSessionIds = watcher.getLiveSessionIds();
		const cwdMap = watcher.getLiveSessionCwdMap();

		const entries: ClaudeAgentEntry[] = [];
		const registeredSessions = new Set<string>();

		// 登録済みエージェントのうちライブ状態のものを追加
		for (const [, state] of states) {
			if (state.isLive) {
				registeredSessions.add(state.sessionId);
				entries.push({
					sessionId: state.sessionId,
					agentName: state.agentName,
					status: 'running',
					cwd: cwdMap.get(state.sessionId) || '',
					source: 'json-api',
					rawLine: '',
				});
			}
		}

		// 未登録セッション（設定で表示が有効な場合のみ）
		if (showUnregistered) {
			for (const sessionId of liveSessionIds) {
				if (!registeredSessions.has(sessionId)) {
					entries.push({
						sessionId,
						agentName: undefined,
						status: 'running',
						cwd: cwdMap.get(sessionId) || '',
						source: 'json-api',
						rawLine: '',
					});
				}
			}
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
		return views.map(v => new LiveAgentItem(v));
	}
}

// -------------------------------------------------------------------
// ヘルパー: ClaudeAgentEntry[] × AgentConfig[] → LiveAgentView[]
// -------------------------------------------------------------------

export function buildLiveAgentViews(
	entries: ClaudeAgentEntry[],
	agents: Awaited<ReturnType<typeof dataStore.getAgents>>,
): LiveAgentView[] {
	const sidMap = new Map<string, (typeof agents)[number]>();
	for (const a of agents) {
		if (a.sessionId) { sidMap.set(a.sessionId, a); }
	}

	const cwdMap = new Map<string, (typeof agents)[number]>();
	for (const a of agents) {
		if (a.workDir) {
			const norm = a.workDir.replace(/\\/g, '/').toLowerCase();
			if (!cwdMap.has(norm)) { cwdMap.set(norm, a); }
		}
	}

	return entries.map(entry => {
		if (entry.sessionId) {
			const matched = sidMap.get(entry.sessionId);
			if (matched) {
				return {
					entry,
					linkedAgentName: matched.name,
					linkedDisplayName: matched.displayName || matched.name,
					matchLevel: 'session-id' as const,
				};
			}
		}

		if (entry.cwd) {
			const entryCwd = entry.cwd.replace(/\\/g, '/').toLowerCase();
			const cwdMatched = cwdMap.get(entryCwd)
				|| [...cwdMap.entries()].find(([k]) => entryCwd.startsWith(k) || k.startsWith(entryCwd))?.[1];
			if (cwdMatched) {
				return {
					entry,
					linkedAgentName: cwdMatched.name,
					linkedDisplayName: cwdMatched.displayName || cwdMatched.name,
					matchLevel: 'cwd' as const,
				};
			}
		}

		return { entry, matchLevel: 'none' as const };
	});
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

/** ライブ状態の個別エージェントアイテム */
export class LiveAgentItem extends vscode.TreeItem {
	public readonly view: LiveAgentView;

	constructor(view: LiveAgentView) {
		const entry = view.entry;

		const name = view.linkedDisplayName
			|| entry.agentName
			|| (entry.sessionId ? entry.sessionId.substring(0, 8) : '(未登録)');
		const matchSuffix = view.matchLevel === 'cwd' ? ' (推定)' : '';

		super(`${name}${matchSuffix}`, vscode.TreeItemCollapsibleState.None);
		this.view = view;

		const statusBadge = `[${entry.status}]`;
		const cwdShort = entry.cwd ? (path.basename(entry.cwd) || entry.cwd) : '—';
		const elapsed = entry.elapsedSec !== undefined ? `  ${formatElapsed(entry.elapsedSec)}` : '';
		this.description = `${statusBadge}  ${cwdShort}${elapsed}`;

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

		const elapsedStr = entry.elapsedSec !== undefined ? formatElapsed(entry.elapsedSec) : '不明';
		this.tooltip = new vscode.MarkdownString(
			`**${name}**\n\n` +
			`| | |\n|---|---|\n` +
			`| ステータス | \`${entry.status}\` |\n` +
			`| 作業ディレクトリ | \`${entry.cwd || '—'}\` |\n` +
			`| 経過時間 | ${elapsedStr} |\n` +
			(entry.sessionId ? `| セッション ID | \`${entry.sessionId}\` |\n` : '') +
			(view.linkedAgentName ? `| CSM エージェント | ${view.linkedAgentName} |\n` : '') +
			(view.matchLevel === 'cwd' ? '\n*cwd によるマッチング（推定）*' : '') +
			(view.matchLevel === 'none' ? '\n*CSM に未登録のセッションです*' : ''),
		);
		this.tooltip.isTrusted = true;

		const linked = view.matchLevel !== 'none' ? 'Linked' : '';
		this.contextValue = `liveAgent${linked}`;

		if (view.linkedAgentName) {
			this.command = {
				command: 'claudeManager.previewAgentByName',
				title: 'エージェントプレビュー',
				arguments: [view.linkedAgentName],
			};
		}
	}
}
