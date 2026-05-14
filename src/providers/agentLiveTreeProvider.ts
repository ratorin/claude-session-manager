// agentLiveTreeProvider.ts — ライブ状態エージェント専用 TreeDataProvider
// claudeAgentsLive ビューに表示される「claude agents」コマンドの結果

import * as vscode from 'vscode';
import * as path from 'path';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import {
	ClaudeAgentsService,
	LiveAgentView,
	ClaudeAgentEntry,
	formatElapsed,
	AvailabilityStatus,
} from '../services/claudeAgentsService';

type LiveTreeNode = LiveAgentItem | LiveStatusMessageItem;

// -------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------

export class AgentLiveTreeProvider
	implements vscode.TreeDataProvider<LiveTreeNode>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<LiveTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private _claudeAgentsService: ClaudeAgentsService | undefined;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	setClaudeAgentsService(service: ClaudeAgentsService): void {
		this._claudeAgentsService = service;
		service.onDidChange(() => this.refresh());
	}

	notifyTabVisible(visible: boolean): void {
		this._claudeAgentsService?.setTabVisible(visible);
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

		const service = this._claudeAgentsService;
		if (!service) { return []; }

		const availability = service.getAvailability();
		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		const showUnregistered = config.get<boolean>('showUnregistered', true);

		if (availability === 'unavailable') {
			return [new LiveStatusMessageItem(
				'claude agents が使えません',
				'Claude Code 2.1.139+ または対応ターミナルが必要です',
				'warning',
			)];
		}
		if (availability === 'unknown') {
			return [new LiveStatusMessageItem('確認中...', '', 'loading')];
		}
		if (availability === 'disabled') {
			return [];
		}

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
		return filtered.map(v => new LiveAgentItem(v));
	}
}

// -------------------------------------------------------------------
// ヘルパー: ClaudeAgentEntry[] × AgentConfig[] → LiveAgentView[]
// -------------------------------------------------------------------

export function buildLiveAgentViews(
	entries: ClaudeAgentEntry[],
	agents: AgentConfig[],
): LiveAgentView[] {
	const sidMap = new Map<string, AgentConfig>();
	for (const a of agents) {
		if (a.sessionId) { sidMap.set(a.sessionId, a); }
	}

	const cwdMap = new Map<string, AgentConfig>();
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
		const cwdShort = path.basename(entry.cwd) || entry.cwd;
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
			`| 作業ディレクトリ | \`${entry.cwd}\` |\n` +
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
