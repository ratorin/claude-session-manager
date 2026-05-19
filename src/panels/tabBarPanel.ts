/**
 * tabBarPanel.ts — v0.5.0 TH1 改訂版: WebviewView → TreeView
 *
 * WebviewView は他の TreeView が折り畳まれると余剰スペースを受け取って
 * 大きな空白が生まれる問題があった。
 * TreeView に切り替えることで、コンテンツ行数分しか高さを取らなくなる。
 *
 * 構成:
 *   - タブ4行: セッション / エージェント / メモリ / プロジェクト
 *   - ステータス1行: 稼働数 | 更新時刻 | プロジェクト名
 *   - アクションボタン: view/title メニューに package.json で登録（タブ別 when 句）
 */

import * as vscode from 'vscode';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

type TabId = 'sessions' | 'agents' | 'memory' | 'projects';
type NodeId = TabId | 'status';

/** Extension 側から TabBarTreeProvider へ渡すステータス情報 */
export interface StatusInfo {
	runningAgents: number;
	lastRefresh: number;   // Date.now() タイムスタンプ
	projectName: string;
}

// -------------------------------------------------------------------
// TreeItem
// -------------------------------------------------------------------

class TabBarItem extends vscode.TreeItem {
	constructor(
		public readonly nodeId: NodeId,
		label: string,
		iconId: string | undefined,
		iconColor?: vscode.ThemeColor,
		description?: string,
		tooltip?: string,
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
		// iconId が指定された場合のみ ThemeIcon を設定 (タブは絵文字のみで揃え、status のみ icon)
		if (iconId) {
			this.iconPath = new vscode.ThemeIcon(iconId, iconColor);
		}
		this.description = description;
		this.tooltip = tooltip;
		this.contextValue = nodeId === 'status' ? 'tabBarStatus' : 'tabBarTab';
		// アクセシビリティ
		this.accessibilityInformation = { label };
	}
}

// -------------------------------------------------------------------
// TabBarTreeProvider — TreeDataProvider 実装
// -------------------------------------------------------------------

const TAB_DEFS: ReadonlyArray<{ id: TabId; label: string; icon: string }> = [
	{ id: 'sessions', label: '💬 セッション',    icon: 'comment-discussion' },
	{ id: 'agents',   label: '👤 エージェント',  icon: 'organization' },
	{ id: 'memory',   label: '🧠 メモリ',         icon: 'database' },
	{ id: 'projects', label: '📁 プロジェクト',   icon: 'folder' },
];

export class TabBarTreeProvider
	implements vscode.TreeDataProvider<TabBarItem>, vscode.Disposable
{
	private _activeTab: TabId;
	private _statusInfo: StatusInfo | undefined;
	private _statusProvider?: () => StatusInfo;

	private _onDidChangeTreeData = new vscode.EventEmitter<TabBarItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(initialTab: TabId = 'sessions') {
		this._activeTab = initialTab;
	}

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	// ----------------------------------------------------------------
	// 公開 API（extension.ts から呼ぶ）
	// ----------------------------------------------------------------

	/** 現在のアクティブタブを変更してツリーを再描画 */
	setActiveTab(tab: TabId): void {
		if (this._activeTab === tab) { return; }
		this._activeTab = tab;
		this._onDidChangeTreeData.fire(undefined);
	}

	getActiveTab(): TabId {
		return this._activeTab;
	}

	/** ステータス情報プロバイダを登録（requestStatus 受信時などに使用） */
	setStatusProvider(fn: () => StatusInfo): void {
		this._statusProvider = fn;
	}

	/** ステータス情報を即時反映（10秒タイマーから呼ぶ） */
	pushStatusInfo(info: StatusInfo): void {
		this._statusInfo = info;
		this._onDidChangeTreeData.fire(undefined);
	}

	// ----------------------------------------------------------------
	// TreeDataProvider
	// ----------------------------------------------------------------

	getTreeItem(element: TabBarItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TabBarItem): TabBarItem[] {
		if (element) { return []; }

		const info = this._statusInfo ?? this._statusProvider?.();

		const tabItems = TAB_DEFS.map(({ id, label }) => {
			const isActive = id === this._activeTab;
			// iconPath は設定しない (絵文字のみで揃える)。description ● でアクティブ表示。
			return new TabBarItem(
				id,
				label,
				undefined,
				undefined,
				isActive ? '●' : undefined,
				isActive ? `${label} (現在のタブ)` : label,
			);
		});

		const statusItem = new TabBarItem(
			'status',
			info ? _agentStr(info) : '—',
			'pulse',
			info && info.runningAgents > 0
				? new vscode.ThemeColor('terminal.ansiGreen')
				: undefined,
			info ? `${_timeAgo(info.lastRefresh)}  ${info.projectName || '—'}` : undefined,
			'エージェント稼働状況 / 最終更新 / プロジェクト名',
		);

		return [...tabItems, statusItem];
	}
}

// -------------------------------------------------------------------
// 内部ユーティリティ
// -------------------------------------------------------------------

function _agentStr(info: StatusInfo): string {
	return info.runningAgents > 0
		? `${info.runningAgents} 件稼働`
		: `待機中`;
}

function _timeAgo(ts: number): string {
	if (!ts) { return '—'; }
	const sec = Math.floor((Date.now() - ts) / 1000);
	if (sec < 5)  { return 'たった今'; }
	if (sec < 60) { return `${sec}秒前`; }
	const min = Math.floor(sec / 60);
	if (min < 60) { return `${min}分前`; }
	return `${Math.floor(min / 60)}時間前`;
}
