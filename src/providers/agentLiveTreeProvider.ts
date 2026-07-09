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

	/** ClaudeAgentsService — JSON API (2.1.145+) */
	private _claudeAgentsService: ClaudeAgentsService | undefined;
	private _serviceDisposable: vscode.Disposable | undefined;

	dispose(): void {
		this._watcherDisposable?.dispose();
		this._serviceDisposable?.dispose();
		this._onDidChangeTreeData.dispose();
	}

	setAgentWatcher(watcher: AgentWatcher): void {
		this._watcherDisposable?.dispose();
		this._agentWatcher = watcher;
		this._watcherDisposable = watcher.onDidChange(() => this.refresh());
	}

	/**
	 * ClaudeAgentsService を注入する（優先データソース）。
	 * availability が 'available' のとき JSON API データを表示。
	 * 'unavailable' / 'disabled' のとき agentWatcher にフォールバック。
	 */
	setClaudeAgentsService(service: ClaudeAgentsService): void {
		this._serviceDisposable?.dispose();
		this._claudeAgentsService = service;
		this._serviceDisposable = service.onDidChange(() => this.refresh());
	}

	/** タブ可視性を ClaudeAgentsService に通知（ポーリング制御） */
	notifyTabVisible(visible: boolean): void {
		this._claudeAgentsService?.setTabVisible(visible);
		// agentWatcher はタブ可視性に依存しないため通知不要
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

		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		const showUnregistered = config.get<boolean>('showUnregistered', true);

		// --- 優先: ClaudeAgentsService (claude agents --json, 2.1.145+) ---
		const service = this._claudeAgentsService;
		if (service && service.isEnabled()) {
			const availability = service.getAvailability();

			if (availability === 'unknown') {
				return [new LiveStatusMessageItem(
					'確認中...',
					'claude agents --json を実行中',
					'loading',
				)];
			}

			if (availability === 'available') {
				// JSON API データを使用
				const entries = service.getEntries();
				if (entries.length === 0) {
					return [new LiveStatusMessageItem(
						'ライブ状態のエージェントなし',
						'現在稼働中のバックグラウンドエージェントはありません',
						'info',
					)];
				}
				const allAgents = await dataStore.getAgents();
				const views = buildLiveAgentViews(entries, allAgents);
				const filtered = showUnregistered ? views : views.filter(v => v.matchLevel !== 'none');
				if (filtered.length === 0) {
					return [new LiveStatusMessageItem(
						'ライブ状態のエージェントなし',
						'現在稼働中のバックグラウンドエージェントはありません',
						'info',
					)];
				}
				return filtered.map(v => new LiveAgentItem(v));
			}

			// 'unavailable' または 'disabled' → agentWatcher にフォールバック
		}

		// --- フォールバック: AgentWatcher (PID/JSONL 監視) ---
		const watcher = this._agentWatcher;
		if (!watcher) { return []; }

		if (!watcher.isEnabled()) {
			return [new LiveStatusMessageItem(
				'エージェント監視が無効です',
				'設定: claudeManager.enableAgentMonitor を有効にしてください',
				'info',
			)];
		}

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

		// v0.5.17 §4-5: 英語ステータスを日本語ラベルへ統一
		const statusJa = ((): string => {
			switch (entry.status) {
				case 'running': return '稼働';
				case 'blocked': return '承認待ち';
				case 'done':    return '完了';
				default:        return String(entry.status);
			}
		})();
		const statusBadge = `[${statusJa}]`;
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
		// JSON API 由来のフィールド（pid, kind）を表示
		const pidLine = entry.pid !== undefined ? `| PID | \`${entry.pid}\` |\n` : '';
		const kindLine = entry.kind ? `| 種別 | \`${entry.kind}\` |\n` : '';
		const sourceLine = entry.source === 'json-api'
			? '\n*claude agents --json (公式 API)* 🟢\n'
			: entry.source === 'text-parse'
			? '\n*claude agents テキスト解析*\n'
			: '';

		this.tooltip = new vscode.MarkdownString(
			`**${name}**\n\n` +
			`| | |\n|---|---|\n` +
			`| ステータス | \`${entry.status}\` |\n` +
			`| 作業ディレクトリ | \`${entry.cwd || '—'}\` |\n` +
			`| 経過時間 | ${elapsedStr} |\n` +
			(entry.sessionId ? `| セッション ID | \`${entry.sessionId}\` |\n` : '') +
			pidLine +
			kindLine +
			(view.linkedAgentName ? `| CSM エージェント | ${view.linkedAgentName} |\n` : '') +
			sourceLine +
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
