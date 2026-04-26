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

interface TabBarMessage {
	type: 'tabChanged';
	tab: TabId;
}

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

		// タブ切り替えメッセージ受信
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
    height: 36px;
    display: flex;
    align-items: stretch;
    overflow: hidden;
    user-select: none;
  }
  .tab-bar {
    display: flex;
    width: 100%;
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
  /* 幅が狭い場合はラベルを非表示 */
  @media (max-width: 200px) {
    .tab-label { display: none; }
  }
</style>
</head>
<body>
<nav class="tab-bar" role="tablist" aria-label="CSM タブ">
${tabButtons}
</nav>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      // UI 更新
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
        b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
      });
      // VS Code 側に通知
      vscode.postMessage({ type: 'tabChanged', tab });
    });
  });
</script>
</body>
</html>`;
	}
}
