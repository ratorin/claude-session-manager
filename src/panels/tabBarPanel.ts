/**
 * tabBarPanel.ts — v0.5.0 ハイブリッドタブ TH1
 *
 * 小さな WebView (高さ 40px) のタブバー。
 * タブクリック時に vscode context `claudeManager.activeTab` を更新し、
 * 配下のネイティブ TreeView の when 句切り替えを制御する。
 *
 * タブ一覧: sessions / agents / memory / projects
 */

import * as vscode from 'vscode';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

type TabId = 'sessions' | 'agents' | 'memory' | 'projects';

type ActionId = 'refresh' | 'new-agent' | 'org-chart' | 'settings';

type TabBarMessage =
	| { type: 'tabChanged'; tab: TabId }
	| { type: 'actionClicked'; action: ActionId };

// -------------------------------------------------------------------
// TabBarPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class TabBarPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'claudeTabBar';

	private _view?: vscode.WebviewView;
	private _activeTab: TabId;

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

		// タブ切り替え・アクションメッセージ受信
		webviewView.webview.onDidReceiveMessage((message: TabBarMessage) => {
			if (message.type === 'tabChanged') {
				const tab = message.tab;
				if (this._isValidTab(tab)) {
					this._activeTab = tab;
					void vscode.commands.executeCommand('setContext', 'claudeManager.activeTab', tab);
					// 他のビューに通知 (例: settings への永続化)
					void vscode.workspace
						.getConfiguration('claudeManager')
						.update('ui.lastActiveTab', tab, vscode.ConfigurationTarget.Global)
						.then(undefined, () => {/* ignore */});
				}
			} else if (message.type === 'actionClicked') {
				this._handleAction(message.action);
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
	// バリデーション
	// ----------------------------------------------------------------

	private _isValidTab(tab: unknown): tab is TabId {
		return ['sessions', 'agents', 'memory', 'projects'].includes(tab as string);
	}

	// ----------------------------------------------------------------
	// クイックアクション処理
	// ----------------------------------------------------------------

	private _handleAction(action: ActionId): void {
		switch (action) {
			case 'refresh':
				void vscode.commands.executeCommand('claudeManager.refreshSessions');
				break;
			case 'new-agent':
				void vscode.commands.executeCommand('claudeManager.addAgent');
				break;
			case 'org-chart':
				void vscode.commands.executeCommand('claudeManager.openOrgChart');
				break;
			case 'settings':
				void vscode.commands.executeCommand('claudeManager.openSettings');
				break;
		}
	}

	// ----------------------------------------------------------------
	// HTML 生成 — VS Code テーマカラー連動
	// ----------------------------------------------------------------

	private _getHtml(activeTab: TabId): string {
		const tabs: { id: TabId; label: string; icon: string }[] = [
			{ id: 'sessions',  label: 'セッション', icon: '💬' },
			{ id: 'agents',    label: 'エージェント', icon: '👤' },
			{ id: 'memory',    label: 'メモリ',       icon: '🧠' },
			{ id: 'projects',  label: 'プロジェクト', icon: '📁' },
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

		const actions: { id: ActionId; icon: string; label: string }[] = [
			{ id: 'refresh',   icon: '🔄', label: '更新'         },
			{ id: 'new-agent', icon: '➕', label: '新規エージェント' },
			{ id: 'org-chart', icon: '🌐', label: '組織図'        },
			{ id: 'settings',  icon: '⚙️', label: '設定'         },
		];

		const actionButtons = actions.map(({ id, icon, label }) =>
			`<button class="action-btn" data-action="${id}" title="${label}">${icon} <span class="action-label">${label}</span></button>`
		).join('');

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
    height: 72px;
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
  .tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* ---- クイックアクション行 ---- */
  .action-bar {
    display: flex;
    height: 36px;
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
  .action-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* 幅が狭い場合はラベルを非表示 */
  @media (max-width: 200px) {
    .tab-label { display: none; }
    .action-label { display: none; }
  }
</style>
</head>
<body>
<nav class="tab-bar" role="tablist" aria-label="CSM タブ">
${tabButtons}
</nav>
<div class="action-bar" role="toolbar" aria-label="クイックアクション">
${actionButtons}
</div>
<script>
  const vscode = acquireVsCodeApi();

  // タブ切り替え
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
        b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
      });
      vscode.postMessage({ type: 'tabChanged', tab });
    });
  });

  // クイックアクション
  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'actionClicked', action: btn.dataset.action });
    });
  });
</script>
</body>
</html>`;
	}
}
