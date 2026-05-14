// agentFavoritesTreeProvider.ts — お気に入りエージェント専用 TreeDataProvider
// claudeAgentsFavorites ビューに表示されるブックマーク済みエージェントのフラットリスト

import * as vscode from 'vscode';
import { AgentConfig, ParsedSession } from '../models/types';
import * as dataStore from '../models/dataStore';
import { getBookmarks } from '../services/bookmarkService';
import { AgentItem } from './agentTreeProvider';
import { resolveExternalSessionTitles } from '../utils/sessionLoader';

// -------------------------------------------------------------------
// Provider
// -------------------------------------------------------------------

export class AgentFavoritesTreeProvider
	implements vscode.TreeDataProvider<FavoriteAgentItem>, vscode.Disposable
{
	private _onDidChangeTreeData = new vscode.EventEmitter<FavoriteAgentItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private getSessionsFn: () => ParsedSession[];
	private isLiveFn: (id: string) => boolean;
	private activeAgentNamesFn: () => Set<string>;
	private watcherStates: Map<string, import('../models/types').AgentWatcherState> = new Map();

	constructor(
		getSessions: () => ParsedSession[],
		isLive: (id: string) => boolean,
		getActiveAgentNames?: () => Set<string>,
	) {
		this.getSessionsFn = getSessions;
		this.isLiveFn = isLive;
		this.activeAgentNamesFn = getActiveAgentNames || (() => new Set());
	}

	setWatcherStates(states: Map<string, import('../models/types').AgentWatcherState>): void {
		this.watcherStates = states;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: FavoriteAgentItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: FavoriteAgentItem): Promise<FavoriteAgentItem[]> {
		// フラットリスト — 子ノードなし
		if (element) { return []; }

		const bookmarkNames = getBookmarks();
		if (bookmarkNames.length === 0) { return []; }

		const allAgents = await dataStore.getAgents();
		const bookmarkSet = new Set(bookmarkNames);
		const favAgents = allAgents.filter(a => bookmarkSet.has(a.name));
		if (favAgents.length === 0) { return []; }

		const sessions = this.getSessionsFn();
		const titleMap = new Map<string, string>();
		for (const s of sessions) {
			titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
		}

		// 他プロジェクトのセッションIDを横断解決
		const missingIds = favAgents
			.map(a => a.sessionId)
			.filter((sid): sid is string => !!sid && !titleMap.has(sid));
		if (missingIds.length > 0) {
			const externalTitles = await resolveExternalSessionTitles(missingIds);
			for (const [sid, title] of externalTitles) { titleMap.set(sid, title); }
		}

		const activeNames = this.activeAgentNamesFn();
		const checkLive = (a: AgentConfig): boolean =>
			activeNames.has(a.name) || (a.sessionId ? this.isLiveFn(a.sessionId) : false);

		return favAgents
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(agent => new FavoriteAgentItem(
				agent,
				checkLive(agent),
				agent.sessionId ? titleMap.get(agent.sessionId) : undefined,
			));
	}
}

// -------------------------------------------------------------------
// TreeItem クラス
// -------------------------------------------------------------------

/** ⭐ お気に入りエージェント内のノード（フラットリスト） */
export class FavoriteAgentItem extends AgentItem {
	constructor(
		agent: AgentConfig,
		isLive: boolean,
		sessionTitle: string | undefined,
	) {
		super(agent, isLive, sessionTitle, true, false, '', false, undefined, false);

		// ★ 黄色い星アイコン
		this.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));

		// contextValue: 右クリックメニュー分岐用（削除ボタン表示に使用）
		const linked = agent.sessionId ? 'Linked' : '';
		this.contextValue = `favoriteAgent${linked}`;
	}
}
