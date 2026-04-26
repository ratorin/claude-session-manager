/**
 * mainTabPanel.ts — v0.5.0 T1.9 / T1.10
 * claudeMain WebviewView Container — 3タブ骨格
 *
 * タブ構成:
 *   0: セッション (sessions)
 *   1: エージェント (agents)
 *   2: プロジェクト (projects)
 *
 * アーキテクチャ:
 *   - WebviewViewProvider として登録
 *   - タブ切り替えは Webview 内 JS で管理
 *   - 各タブのデータ取得は postMessage でサービス層に委譲
 *   - TreeView providers はそのまま残す（後方互換）
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { t } from '../services/i18nService';
import { discoverProjects, registerProject, removeProject } from '../services/projectService';

// -------------------------------------------------------------------
// MainTabPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class MainTabPanel implements vscode.WebviewViewProvider {
	public static readonly viewType = 'claudeMain';

	private _view?: vscode.WebviewView;
	private readonly _extensionUri: vscode.Uri;

	constructor(extensionUri: vscode.Uri) {
		this._extensionUri = extensionUri;
	}

	// ----------------------------------------------------------------
	// resolveWebviewView — VSCode が呼び出す
	// ----------------------------------------------------------------

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtml(webviewView.webview);

		// メッセージハンドラ
		webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
			await this._handleMessage(message);
		});
	}

	// ----------------------------------------------------------------
	// 外部からビューを更新する（TreeView更新連動）
	// ----------------------------------------------------------------

	public postMessage(message: unknown): void {
		this._view?.webview.postMessage(message);
	}

	// ----------------------------------------------------------------
	// メッセージハンドラ
	// ----------------------------------------------------------------

	private async _handleMessage(message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				// 初期データをまとめて送信
				await this._sendInitialData();
				break;

			case 'tab-changed':
				// タブ変更通知（将来: 設定保存）
				break;

			case 'refresh-projects':
				this._sendProjects();
				break;

			case 'add-project': {
				const folderUris = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					title: 'プロジェクトフォルダを選択',
				});
				if (folderUris && folderUris.length > 0) {
					registerProject(folderUris[0].fsPath);
					this._sendProjects();
				}
				break;
			}

			case 'remove-project':
				if (message.payload?.id) {
					removeProject(String(message.payload.id));
					this._sendProjects();
				}
				break;

			case 'open-project':
				if (message.payload?.path) {
					const uri = vscode.Uri.file(String(message.payload.path));
					await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false });
				}
				break;

			case 'new-session':
				await vscode.commands.executeCommand('claudeManager.newSession');
				break;

			case 'open-agent-session':
				if (message.payload?.agentName) {
					await vscode.commands.executeCommand('claudeManager.openAgentSession', { name: String(message.payload.agentName) });
				}
				break;
		}
	}

	// ----------------------------------------------------------------
	// データ送信ヘルパー
	// ----------------------------------------------------------------

	private async _sendInitialData(): Promise<void> {
		this._sendProjects();
	}

	private _sendProjects(): void {
		const projects = discoverProjects();
		this._view?.webview.postMessage({ type: 'projects-data', projects });
	}

	// ----------------------------------------------------------------
	// HTML生成
	// ----------------------------------------------------------------

	private _getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();

		const tabSessions = t('tabs.sessions');
		const tabAgents   = t('tabs.agents');
		const tabProjects = t('tabs.projects');

		return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy"
		content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Claude Session Manager</title>
	<style>
		*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

		body {
			font-family: var(--vscode-font-family);
			font-size: var(--vscode-font-size);
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			height: 100vh;
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		/* ---- タブバー ---- */
		.tab-bar {
			display: flex;
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		.tab-btn {
			flex: 1;
			padding: 6px 4px;
			background: transparent;
			border: none;
			border-bottom: 2px solid transparent;
			color: var(--vscode-tab-inactiveForeground, var(--vscode-foreground));
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
			transition: color 0.1s;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tab-btn:hover {
			color: var(--vscode-foreground);
		}
		.tab-btn.active {
			color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
			border-bottom-color: var(--vscode-focusBorder, #007acc);
		}

		/* ---- タブコンテンツ ---- */
		.tab-content {
			flex: 1;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}
		.tab-pane {
			display: none;
			flex: 1;
			overflow-y: auto;
			padding: 8px;
		}
		.tab-pane.active {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}

		/* ---- プロジェクトリスト ---- */
		.project-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 6px;
			border-radius: 3px;
			cursor: pointer;
			min-width: 0;
		}
		.project-item:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.project-icon { flex-shrink: 0; font-size: 14px; }
		.project-info { flex: 1; min-width: 0; }
		.project-name {
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.project-path {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.project-badge {
			font-size: 9px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 1px 4px;
			border-radius: 9px;
			flex-shrink: 0;
		}
		.project-remove {
			flex-shrink: 0;
			background: transparent;
			border: none;
			color: var(--vscode-descriptionForeground);
			cursor: pointer;
			padding: 2px 4px;
			border-radius: 2px;
			font-size: 12px;
			display: none;
		}
		.project-item:hover .project-remove { display: inline; }
		.project-remove:hover { color: var(--vscode-errorForeground); }

		/* ---- アクションボタン ---- */
		.action-bar {
			display: flex;
			gap: 4px;
			flex-shrink: 0;
		}
		.btn {
			flex: 1;
			padding: 4px 8px;
			background: var(--vscode-button-secondaryBackground, transparent);
			color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
			border: 1px solid var(--vscode-button-border, transparent);
			border-radius: 2px;
			cursor: pointer;
			font-size: 11px;
			font-family: inherit;
		}
		.btn:hover {
			background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
		}
		.btn.primary {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.btn.primary:hover {
			background: var(--vscode-button-hoverBackground);
		}

		/* ---- プレースホルダー ---- */
		.placeholder {
			text-align: center;
			color: var(--vscode-descriptionForeground);
			padding: 24px 8px;
			font-size: 12px;
		}
		.placeholder .icon { font-size: 24px; margin-bottom: 8px; }

		/* ---- セクションヘッダー ---- */
		.section-header {
			font-size: 10px;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
			padding: 4px 2px 2px;
			border-bottom: 1px solid var(--vscode-panel-border);
			margin-bottom: 4px;
		}

		.info-text {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			padding: 4px 2px;
		}
	</style>
</head>
<body>
	<!-- タブバー -->
	<div class="tab-bar">
		<button class="tab-btn active" data-tab="sessions">${tabSessions}</button>
		<button class="tab-btn" data-tab="agents">${tabAgents}</button>
		<button class="tab-btn" data-tab="projects">${tabProjects}</button>
	</div>

	<!-- タブコンテンツ -->
	<div class="tab-content">
		<!-- セッションタブ -->
		<div class="tab-pane active" id="pane-sessions">
			<div class="action-bar">
				<button class="btn primary" id="btn-new-session">＋ 新規セッション</button>
			</div>
			<div class="info-text">
				セッション一覧はサイドバーの「会話一覧」をご利用ください。
			</div>
			<div class="placeholder">
				<div class="icon">💬</div>
				<div>セッションはサイドバーから<br>管理できます</div>
			</div>
		</div>

		<!-- エージェントタブ -->
		<div class="tab-pane" id="pane-agents">
			<div class="info-text">
				エージェント一覧はサイドバーの「エージェント管理」をご利用ください。
			</div>
			<div class="placeholder">
				<div class="icon">🤖</div>
				<div>エージェントはサイドバーから<br>管理できます</div>
			</div>
		</div>

		<!-- プロジェクトタブ -->
		<div class="tab-pane" id="pane-projects">
			<div class="action-bar">
				<button class="btn primary" id="btn-add-project">＋ 追加</button>
				<button class="btn" id="btn-refresh-projects">↻ 更新</button>
			</div>
			<div id="project-list">
				<div class="placeholder">
					<div class="icon">📁</div>
					<div>読み込み中...</div>
				</div>
			</div>
		</div>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();

		// ---- タブ切り替え ----
		const tabBtns  = document.querySelectorAll('.tab-btn');
		const tabPanes = document.querySelectorAll('.tab-pane');

		tabBtns.forEach(btn => {
			btn.addEventListener('click', () => {
				const target = btn.dataset.tab;
				tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
				tabPanes.forEach(p => p.classList.toggle('active', p.id === 'pane-' + target));
				vscode.postMessage({ type: 'tab-changed', payload: { tab: target } });
			});
		});

		// ---- セッションタブ ----
		document.getElementById('btn-new-session').addEventListener('click', () => {
			vscode.postMessage({ type: 'new-session' });
		});

		// ---- プロジェクトタブ ----
		document.getElementById('btn-add-project').addEventListener('click', () => {
			vscode.postMessage({ type: 'add-project' });
		});
		document.getElementById('btn-refresh-projects').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh-projects' });
		});

		// ---- プロジェクト一覧レンダリング ----
		function renderProjects(projects) {
			const list = document.getElementById('project-list');
			if (!projects || projects.length === 0) {
				list.innerHTML = '<div class="placeholder"><div class="icon">📁</div><div>プロジェクトがありません</div></div>';
				return;
			}
			list.innerHTML = '';

			const currentItems = projects.filter(p => p.isCurrent);
			const otherItems   = projects.filter(p => !p.isCurrent);

			if (currentItems.length > 0) {
				const hdr = document.createElement('div');
				hdr.className = 'section-header';
				hdr.textContent = '現在のプロジェクト';
				list.appendChild(hdr);
				currentItems.forEach(p => list.appendChild(makeProjectItem(p)));
			}

			if (otherItems.length > 0) {
				const hdr = document.createElement('div');
				hdr.className = 'section-header';
				hdr.style.marginTop = '8px';
				hdr.textContent = 'その他のプロジェクト';
				list.appendChild(hdr);
				otherItems.forEach(p => list.appendChild(makeProjectItem(p)));
			}
		}

		function makeProjectItem(p) {
			const item = document.createElement('div');
			item.className = 'project-item';
			item.title = p.path;

			const badge = p.isCurrent ? '<span class="project-badge">現在</span>' : '';
			const canRemove = p.source === 'manual';

			item.innerHTML =
				'<span class="project-icon">📁</span>' +
				'<div class="project-info">' +
					'<div class="project-name">' + escHtml(p.name) + '</div>' +
					'<div class="project-path">' + escHtml(shortenPath(p.path)) + '</div>' +
				'</div>' +
				badge +
				(canRemove ? '<button class="project-remove" title="削除">✕</button>' : '');

			item.addEventListener('click', (e) => {
				if (e.target.classList.contains('project-remove')) { return; }
				vscode.postMessage({ type: 'open-project', payload: { path: p.path } });
			});

			const removeBtn = item.querySelector('.project-remove');
			if (removeBtn) {
				removeBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					vscode.postMessage({ type: 'remove-project', payload: { id: p.id } });
				});
			}

			return item;
		}

		function escHtml(str) {
			return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
		}

		function shortenPath(p) {
			const home = '${os.homedir().replace(/\\/g, '/')}';
			if (p.startsWith(home)) { return '~' + p.slice(home.length); }
			return p;
		}

		// ---- メッセージ受信 ----
		window.addEventListener('message', event => {
			const msg = event.data;
			switch (msg.type) {
				case 'projects-data':
					renderProjects(msg.projects);
					break;
			}
		});

		// ---- 準備完了 ----
		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

interface WebviewMessage {
	type: string;
	payload?: Record<string, unknown>;
}

// -------------------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------------------

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars[Math.floor(Math.random() * chars.length)];
	}
	return nonce;
}
