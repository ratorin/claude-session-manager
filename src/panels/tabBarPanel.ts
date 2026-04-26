/**
 * tabBarPanel.ts — v0.5.0 ハイブリッドタブ TH1
 *
 * 小さな WebView のタブバー。
 * タブクリック時に vscode context `claudeManager.activeTab` を更新し、
 * 配下のネイティブ TreeView の when 句切り替えを制御する。
 *
 * タブ一覧: sessions / agents / memory / projects
 *
 * v0.5.0 改善:
 *   - アクション行をタブ別に動的切替（JS 側でレンダリング）
 *   - body を min-height:100vh にして下部空白を解消
 *   - 最下部にステータス行（動作中エージェント数・最終更新・プロジェクト名）
 */

import * as vscode from 'vscode';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

type TabId = 'sessions' | 'agents' | 'memory' | 'projects';

type ActionId =
	| 'refresh'
	| 'settings'
	| 'search-sessions'
	| 'new-agent'
	| 'org-chart'
	| 'pending-tasks'
	| 'merge-memories';

type TabBarMessageIn =
	| { type: 'tabChanged'; tab: TabId }
	| { type: 'actionClicked'; action: ActionId }
	| { type: 'requestStatus' };

type TabBarMessageOut = {
	type: 'statusInfo';
	runningAgents: number;
	lastRefresh: number;
	projectName: string;
};

/** Extension 側から TabBarPanel へ渡すステータス情報 */
export interface StatusInfo {
	runningAgents: number;
	lastRefresh: number;   // Date.now() タイムスタンプ
	projectName: string;
}

// -------------------------------------------------------------------
// TabBarPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class TabBarPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'claudeTabBar';

	private _view?: vscode.WebviewView;
	private _activeTab: TabId;
	private _statusProvider?: () => StatusInfo;

	constructor(initialTab: TabId = 'sessions') {
		this._activeTab = initialTab;
	}

	// ----------------------------------------------------------------
	// resolveWebviewView — VS Code が呼び出す
	// ----------------------------------------------------------------

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.html = this._getHtml(this._activeTab);

		// タブ切り替え・アクション・ステータスリクエストを受信
		webviewView.webview.onDidReceiveMessage((message: TabBarMessageIn) => {
			if (message.type === 'tabChanged') {
				const tab = message.tab;
				if (this._isValidTab(tab)) {
					this._activeTab = tab;
					void vscode.commands.executeCommand('setContext', 'claudeManager.activeTab', tab);
					void vscode.workspace
						.getConfiguration('claudeManager')
						.update('ui.lastActiveTab', tab, vscode.ConfigurationTarget.Global)
						.then(undefined, () => {/* ignore */});
				}
			} else if (message.type === 'actionClicked') {
				this._handleAction(message.action);
			} else if (message.type === 'requestStatus') {
				this._pushStatus(webviewView.webview);
			}
		});

		// パネルが表示されたとき現在タブを反映
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				webviewView.webview.html = this._getHtml(this._activeTab);
			}
		});
	}

	// ----------------------------------------------------------------
	// タブをプログラムから切り替える（external API）
	// ----------------------------------------------------------------

	public setActiveTab(tab: TabId): void {
		if (!this._isValidTab(tab)) { return; }
		this._activeTab = tab;
		void vscode.commands.executeCommand('setContext', 'claudeManager.activeTab', tab);
		if (this._view?.visible) {
			this._view.webview.html = this._getHtml(tab);
		}
	}

	// ----------------------------------------------------------------
	// ステータス情報 API（extension.ts 側から設定・プッシュ）
	// ----------------------------------------------------------------

	/** ステータス情報プロバイダを登録。requestStatus 受信時に自動で呼び出される */
	public setStatusProvider(fn: () => StatusInfo): void {
		this._statusProvider = fn;
	}

	/** ステータス情報を Webview へ即時プッシュ（10秒タイマーから呼ぶ） */
	public pushStatusInfo(info: StatusInfo): void {
		if (this._view?.visible) {
			const msg: TabBarMessageOut = { type: 'statusInfo', ...info };
			void this._view.webview.postMessage(msg);
		}
	}

	// ----------------------------------------------------------------
	// 内部ヘルパー
	// ----------------------------------------------------------------

	private _pushStatus(webview: vscode.Webview): void {
		if (!this._statusProvider) { return; }
		const info = this._statusProvider();
		const msg: TabBarMessageOut = { type: 'statusInfo', ...info };
		void webview.postMessage(msg);
	}

	private _isValidTab(tab: unknown): tab is TabId {
		return ['sessions', 'agents', 'memory', 'projects'].includes(tab as string);
	}

	private _handleAction(action: ActionId): void {
		const cmdMap: Record<ActionId, string> = {
			'refresh':         'claudeManager.refreshSessions',
			'settings':        'claudeManager.openSettings',
			'search-sessions': 'claudeManager.searchSessions',
			'new-agent':       'claudeManager.addAgent',
			'org-chart':       'claudeManager.openOrgChart',
			'pending-tasks':   'claudeManager.showPendingTasks',
			'merge-memories':  'claudeManager.mergeMemories',
		};
		const cmd = cmdMap[action];
		if (cmd) {
			void vscode.commands.executeCommand(cmd);
		}
	}

	// ----------------------------------------------------------------
	// HTML 生成 — VS Code テーマカラー連動
	// ----------------------------------------------------------------

	private _getHtml(activeTab: TabId): string {
		const tabs: { id: TabId; label: string; icon: string }[] = [
			{ id: 'sessions',  label: 'セッション',   icon: '💬' },
			{ id: 'agents',    label: 'エージェント',  icon: '👤' },
			{ id: 'memory',    label: 'メモリ',        icon: '🧠' },
			{ id: 'projects',  label: 'プロジェクト',  icon: '📁' },
		];

		const tabButtons = tabs.map(({ id, label, icon }) => {
			const isActive = id === activeTab;
			return `<button
				class="tab-btn${isActive ? ' active' : ''}"
				data-tab="${id}"
				title="${label}"
				aria-pressed="${isActive}"
			>${icon} <span class="tab-label">${label}</span></button>`;
		}).join('');

		return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-sideBar-background, #252526);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 12px);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    user-select: none;
  }
  /* ---- タブバー ---- */
  .tab-bar {
    display: flex;
    height: 36px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d);
  }
  .tab-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vscode-tab-inactiveForeground, #969696);
    cursor: pointer;
    padding: 0 4px;
    font-size: 11px;
    font-family: inherit;
    white-space: nowrap;
    transition: color 0.1s, border-color 0.1s;
    outline: none;
    min-width: 0;
  }
  .tab-btn:hover {
    color: var(--vscode-tab-activeForeground, #ffffff);
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07));
  }
  .tab-btn.active {
    color: var(--vscode-tab-activeForeground, #ffffff);
    border-bottom-color: var(--vscode-focusBorder, #007fd4);
    background: var(--vscode-tab-activeBackground, transparent);
  }
  .tab-label { overflow: hidden; text-overflow: ellipsis; }
  /* ---- クイックアクション行（JS でレンダリング）---- */
  .action-bar {
    display: flex;
    height: 32px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #2d2d2d);
    background: var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,0.1));
  }
  .action-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    border: none;
    border-right: 1px solid var(--vscode-panel-border, #2d2d2d);
    color: var(--vscode-descriptionForeground, #858585);
    cursor: pointer;
    padding: 0 4px;
    font-size: 10px;
    font-family: inherit;
    white-space: nowrap;
    transition: color 0.1s, background 0.1s;
    outline: none;
    min-width: 0;
  }
  .action-btn:last-child { border-right: none; }
  .action-btn:hover {
    color: var(--vscode-foreground, #cccccc);
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07));
  }
  .action-btn:active {
    background: var(--vscode-toolbar-activeBackground, rgba(255,255,255,0.12));
  }
  .action-label { overflow: hidden; text-overflow: ellipsis; }
  /* ---- スペーサー ---- */
  .spacer { flex: 1; }
  /* ---- ステータス行 ---- */
  .status-bar {
    flex-shrink: 0;
    height: 22px;
    display: flex;
    align-items: center;
    padding: 0 8px;
    gap: 6px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #858585);
    border-top: 1px solid var(--vscode-panel-border, #2d2d2d);
    background: var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,0.08));
    overflow: hidden;
    white-space: nowrap;
  }
  .status-item { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .status-sep { opacity: 0.35; flex-shrink: 0; }
  /* 幅が狭い場合はラベルを非表示 */
  @media (max-width: 200px) {
    .tab-label { display: none; }
    .action-label { display: none; }
  }
</style>
</head>
<body>
<nav class="tab-bar" id="tabBar" role="tablist" aria-label="CSM タブ">
${tabButtons}
</nav>
<div class="action-bar" id="actionBar" role="toolbar" aria-label="クイックアクション"></div>
<div class="spacer"></div>
<div class="status-bar" id="statusBar">
  <span class="status-item" id="agentStatus">⚫ —</span>
  <span class="status-sep">|</span>
  <span class="status-item" id="refreshStatus">—</span>
  <span class="status-sep">|</span>
  <span class="status-item" id="projectStatus">—</span>
</div>
<script>
  const vscode = acquireVsCodeApi();
  let currentTab = '${activeTab}';

  // タブ別アクション定義
  const TAB_ACTIONS = {
    sessions: [
      { id: 'refresh',         icon: '🔄', label: '更新' },
      { id: 'search-sessions', icon: '🔍', label: '検索' },
      { id: 'settings',        icon: '⚙️', label: '設定' },
    ],
    agents: [
      { id: 'refresh',       icon: '🔄', label: '更新'     },
      { id: 'new-agent',     icon: '➕', label: '新規'     },
      { id: 'org-chart',     icon: '🌐', label: '組織図'   },
      { id: 'pending-tasks', icon: '✅', label: '確認待ち' },
      { id: 'settings',      icon: '⚙️', label: '設定'    },
    ],
    memory: [
      { id: 'refresh',        icon: '🔄', label: '更新'       },
      { id: 'merge-memories', icon: '🧬', label: 'メモリ統合' },
      { id: 'settings',       icon: '⚙️', label: '設定'      },
    ],
    projects: [
      { id: 'refresh',  icon: '🔄', label: '更新' },
      { id: 'settings', icon: '⚙️', label: '設定' },
    ],
  };

  // アクション行をレンダリング（タブ切り替え時に再呼び出し）
  function renderActions(tab) {
    const actions = TAB_ACTIONS[tab] || TAB_ACTIONS.sessions;
    const bar = document.getElementById('actionBar');
    bar.innerHTML = actions.map(a =>
      '<button class="action-btn" data-action="' + a.id + '" title="' + a.label + '">' +
      a.icon + ' <span class="action-label">' + a.label + '</span></button>'
    ).join('');
    bar.querySelectorAll('.action-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        vscode.postMessage({ type: 'actionClicked', action: btn.dataset.action });
      });
    });
  }

  // タブ切り替え
  document.getElementById('tabBar').querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      currentTab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.tab === currentTab);
        b.setAttribute('aria-pressed', String(b.dataset.tab === currentTab));
      });
      renderActions(currentTab);
      vscode.postMessage({ type: 'tabChanged', tab: currentTab });
    });
  });

  // 相対時間フォーマット
  function timeAgo(ts) {
    if (!ts) { return '—'; }
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 5)   { return 'たった今'; }
    if (sec < 60)  { return sec + '秒前'; }
    const min = Math.floor(sec / 60);
    if (min < 60)  { return min + '分前'; }
    return Math.floor(min / 60) + '時間前';
  }

  // ステータス行を更新
  function updateStatus(msg) {
    document.getElementById('agentStatus').textContent =
      msg.runningAgents > 0 ? ('🟢 ' + msg.runningAgents + '件稼働') : '⚫ 0件稼働';
    document.getElementById('refreshStatus').textContent = '更新 ' + timeAgo(msg.lastRefresh);
    document.getElementById('projectStatus').textContent = msg.projectName || '—';
  }

  // Extension からのメッセージ受信
  window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (msg.type === 'statusInfo') {
      updateStatus(msg);
    }
  });

  // 初期レンダリング & ステータスリクエスト
  renderActions(currentTab);
  vscode.postMessage({ type: 'requestStatus' });
</script>
</body>
</html>`;
	}
}
