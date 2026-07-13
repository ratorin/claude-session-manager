import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentConfig } from '../models/types';
import { getModelChar, getModelLabel } from '../models/modelCatalog';
import * as dataStore from '../models/dataStore';

// プレビューパネルの参照
let previewPanel: vscode.WebviewPanel | undefined;
let messageListenerDisposable: vscode.Disposable | undefined;
let currentSessionTitle: string | undefined;

export interface AgentPreviewCallbacks {
	onEdit: (agent: AgentConfig) => void;
	onEditRuleFile: (agent: AgentConfig) => void;
	onOpenInClaude: (sessionId: string) => void;
	onOpenInTerminal: (agent: AgentConfig) => void;
	onRenewSession: (agent: AgentConfig) => void;
	onLinkSession: (agent: AgentConfig) => void;
	/**
	 * v0.5.27: フォルダパス行のクリックで呼ばれる。実装は
	 *   `vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(...))`
	 * を期待。workDir は空でない前提（HTML 側で空なら非リンク化する）。
	 */
	onRevealFolder?: (workDir: string) => void;
}

export async function showAgentPreview(
	agent: AgentConfig,
	isLive: boolean,
	sessionTitle: string | undefined,
	callbacks: AgentPreviewCallbacks
): Promise<void> {
	currentSessionTitle = sessionTitle;
	const displayName = agent.displayName ? `${agent.displayName}（${agent.name}）` : agent.name;
	const title = `🤖 ${displayName}`;
	const html = await getPreviewHtml(agent, isLive, sessionTitle);

	if (previewPanel) {
		previewPanel.reveal(vscode.ViewColumn.One);
		previewPanel.title = title;
		previewPanel.webview.html = html;
		rebindMessages(previewPanel, agent, callbacks);
		return;
	}

	previewPanel = vscode.window.createWebviewPanel(
		'claudeAgentPreview',
		title,
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	previewPanel.webview.html = html;
	previewPanel.onDidDispose(() => {
		previewPanel = undefined;
		if (messageListenerDisposable) {
			messageListenerDisposable.dispose();
			messageListenerDisposable = undefined;
		}
	});
	rebindMessages(previewPanel, agent, callbacks);
}

function rebindMessages(
	panel: vscode.WebviewPanel,
	agent: AgentConfig,
	cb: AgentPreviewCallbacks
): void {
	if (messageListenerDisposable) {
		messageListenerDisposable.dispose();
		messageListenerDisposable = undefined;
	}
	messageListenerDisposable = panel.webview.onDidReceiveMessage((message) => {
		switch (message.type) {
			case 'edit': cb.onEdit(agent); break;
			case 'editRuleFile': cb.onEditRuleFile(agent); break;
			case 'openInClaude':
				if (agent.sessionId) { cb.onOpenInClaude(agent.sessionId); }
				break;
			case 'openInTerminal': cb.onOpenInTerminal(agent); break;
			case 'renewSession': cb.onRenewSession(agent); break;
			case 'linkSession': cb.onLinkSession(agent); break;
			case 'revealFolder':
				// v0.5.27: 基本情報のフォルダリンクから OS のエクスプローラで開く
				if (agent.workDir && cb.onRevealFolder) { cb.onRevealFolder(agent.workDir); }
				break;
			case 'openFile':
				if (message.path) {
					vscode.workspace.openTextDocument(vscode.Uri.file(message.path)).then(doc => {
						vscode.window.showTextDocument(doc);
					});
				}
				break;
			case 'toggleFeature':
				// TODO/HISTORY の ON/OFF切り替え（フロントマターのフラグ変更）
				{
					const isTodo = message.feature === 'todo';
					const currentValue = isTodo ? agent.todoEnabled : agent.historyEnabled;
					const newValue = !currentValue;

					// フラグを更新
					if (isTodo) { agent.todoEnabled = newValue; } else { agent.historyEnabled = newValue; }
					dataStore.addAgent(agent).then(async () => {
						// ONにした時、ファイルがなければ作成
						if (newValue) {
							const agentDir = path.join(os.homedir(), '.claude', 'agents', agent.name);
							const fileName = isTodo ? 'TODO.md' : 'HISTORY.md';
							const filePath = path.join(agentDir, fileName);
							try {
								await fs.promises.access(filePath);
							} catch {
								await fs.promises.mkdir(agentDir, { recursive: true });
								const template = isTodo
									? `# ${agent.displayName || agent.name} — TODO\n\n## 確認待ち\n\n## タスク\n`
									: `# ${agent.displayName || agent.name} — 歴代セッション記録\n`;
								await fs.promises.writeFile(filePath, template, 'utf-8');
							}
						}
						// プレビューを再表示（sessionTitleを保持）
						const html = await getPreviewHtml(agent, false, currentSessionTitle);
						panel.webview.html = html;
					});
				}
				break;
			case 'toggleTodo':
				// TODO.mdのチェックボックスを切り替え（非同期）
				{
					const todoPath = path.join(os.homedir(), '.claude', 'agents', agent.name, 'TODO.md');
					fs.promises.readFile(todoPath, 'utf-8').then(content => {
						const lines = content.split('\n');
						const lineIdx = message.line as number;
						if (lineIdx >= 0 && lineIdx < lines.length) {
							if (message.checked) {
								lines[lineIdx] = lines[lineIdx].replace('- [ ]', '- [x]');
							} else {
								lines[lineIdx] = lines[lineIdx].replace(/- \[[xX]\]/, '- [ ]');
							}
							return fs.promises.writeFile(todoPath, lines.join('\n'), 'utf-8');
						}
					}).catch(() => { /* 失敗は無視 */ });
				}
				break;
			case 'openCollaborator':
				if (message.name) {
					// 連携先エージェントのプレビューを開く（再帰的に自分を呼ぶ）
					dataStore.getAgents().then(async (agents) => {
						const target = agents.find(a => a.name === message.name);
						if (target) {
							await showAgentPreview(target, false, undefined, cb);
						}
					});
				}
				break;
		}
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// TODO.md をチェックボックス付きHTMLにレンダリング
function renderTodoMarkdown(content: string): string {
	return content.split('\n').map((line, i) => {
		const stripped = line.trim();
		// 見出し
		if (stripped.startsWith('### ')) {
			return `<div class="todo-h3">${escapeHtml(stripped.substring(4))}</div>`;
		}
		if (stripped.startsWith('## ')) {
			return `<div class="todo-h2">${escapeHtml(stripped.substring(3))}</div>`;
		}
		if (stripped.startsWith('# ')) {
			return `<div class="todo-h1">${escapeHtml(stripped.substring(2))}</div>`;
		}
		// チェックボックス
		const checkMatch = stripped.match(/^- \[([ xX])\] (.+)$/);
		if (checkMatch) {
			const checked = checkMatch[1] !== ' ';
			const text = checkMatch[2];
			return `<label class="todo-item${checked ? ' done' : ''}"><input type="checkbox" data-line="${i}" ${checked ? 'checked' : ''}> ${escapeHtml(text)}</label>`;
		}
		// 通常のリスト
		if (stripped.startsWith('- ')) {
			return `<div class="todo-list-item">• ${escapeHtml(stripped.substring(2))}</div>`;
		}
		// 空行
		if (!stripped) { return '<div class="todo-spacer"></div>'; }
		// その他
		return `<div class="todo-text">${escapeHtml(stripped)}</div>`;
	}).join('\n');
}

// HISTORY.md を簡易HTMLにレンダリング
function renderHistoryMarkdown(content: string): string {
	return content.split('\n').map(line => {
		const stripped = line.trim();
		if (stripped.startsWith('### ')) {
			return `<div class="history-date">${escapeHtml(stripped.substring(4))}</div>`;
		}
		if (stripped.startsWith('## ')) {
			return `<div class="history-h2">${escapeHtml(stripped.substring(3))}</div>`;
		}
		if (stripped.startsWith('# ')) {
			return `<div class="history-h1">${escapeHtml(stripped.substring(2))}</div>`;
		}
		if (stripped.startsWith('- ')) {
			return `<div class="history-item">• ${escapeHtml(stripped.substring(2))}</div>`;
		}
		if (!stripped) { return ''; }
		return `<div class="history-text">${escapeHtml(stripped)}</div>`;
	}).join('\n');
}

// HISTORY.md / TODO.md の読み込み
async function readAgentFile(agentName: string, fileName: string): Promise<string> {
	const agentDir = path.join(os.homedir(), '.claude', 'agents', agentName);
	const filePath = path.join(agentDir, fileName);
	try {
		return await fs.promises.readFile(filePath, 'utf-8');
	} catch {
		return '';
	}
}

async function getPreviewHtml(agent: AgentConfig, isLive: boolean, sessionTitle: string | undefined): Promise<string> {
	const displayName = agent.displayName ? `${agent.displayName}（${agent.name}）` : agent.name;
	// v0.5.14: modelCatalog に一元化。1M の全角『１』は sessionTreeProvider が使う
	//          "Ｓ +『１』" のペアで意味を持つため、agent プレビューは母体モデル頭文字のみ表示。
	const modelChar = getModelChar(agent.model);
	const modelLabel = getModelLabel(agent.model);
	const statusLabel = isLive ? '🟢 稼働中' : '⚪ 停止中';

	// 役割（日本語優先）
	const roleText = agent.displayRole || agent.role || '未設定';

	// 親エージェント
	const allAgents = await dataStore.getAgents();
	const parent = agent.parentAgent ? allAgents.find(a => a.name === agent.parentAgent) : undefined;
	const parentLabel = parent
		? (parent.displayName ? `${parent.displayName}（${parent.name}）` : parent.name)
		: agent.parentAgent || 'なし';

	// 子エージェント（再帰ツリー構築）
	const children = allAgents.filter(a => a.parentAgent === agent.name);
	function buildChildTree(parentName: string, depth: number): string {
		const kids = allAgents.filter(a => a.parentAgent === parentName);
		if (kids.length === 0) { return ''; }
		return kids.map(c => {
			const cName = c.displayName ? `${c.displayName}（${c.name}）` : c.name;
			const indent = '\u2003'.repeat(depth); // 全角スペースでインデント
			const prefix = depth === 0 ? '├─' : '└─';
			const subtree = buildChildTree(c.name, depth + 1);
			return `<div class="child-item">${indent}${prefix} <button class="agent-link" data-name="${escapeHtml(c.name)}">${escapeHtml(cName)}</button> <span class="dim">— ${escapeHtml(c.role || '')}</span></div>${subtree}`;
		}).join('');
	}
	const childTreeHtml = buildChildTree(agent.name, 0);

	// 連携先（兄弟 + qa/researcher）
	const childNames = new Set(children.map(c => c.name));
	const siblings = agent.parentAgent
		? allAgents.filter(a => a.parentAgent === agent.parentAgent && a.name !== agent.name && !childNames.has(a.name))
		: [];
	const alreadyListed = new Set([agent.name, ...childNames, ...siblings.map(s => s.name)]);
	const commons = allAgents.filter(a => ['qa', 'researcher'].includes(a.name) && !alreadyListed.has(a.name));
	const collaborators = [...siblings, ...commons];

	// セッション: 名前とIDを併記
	const sessionLabel = agent.sessionId
		? (sessionTitle
			? `${sessionTitle}  \`${agent.sessionId.substring(0, 8)}...\``
			: `\`${agent.sessionId.substring(0, 16)}...\``)
		: '未紐づけ';

	// TODO.md / HISTORY.md
	const todoContent = await readAgentFile(agent.name, 'TODO.md');
	const historyContent = await readAgentFile(agent.name, 'HISTORY.md');
	const hasTodo = todoContent.length > 0;
	const hasHistory = historyContent.length > 0;
	const todoOn = agent.todoEnabled === true;
	const historyOn = agent.historyEnabled === true;

	const nonce = crypto.randomBytes(16).toString('hex');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
	:root {
		--accent: #e27e4a;
		--bg: var(--vscode-editor-background);
		--surface: var(--vscode-textBlockQuote-background);
		--border: var(--vscode-panel-border);
		--text: var(--vscode-foreground);
		--text-dim: var(--vscode-descriptionForeground);
		--btn-bg: var(--vscode-button-background);
		--btn-fg: var(--vscode-button-foreground);
		--btn-hover: var(--vscode-button-hoverBackground);
		--btn-secondary-bg: var(--vscode-button-secondaryBackground);
		--btn-secondary-fg: var(--vscode-button-secondaryForeground);
		--btn-secondary-hover: var(--vscode-button-secondaryHoverBackground);
	}
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		background: var(--bg);
		color: var(--text);
		padding: 20px 24px;
		max-width: 720px;
		margin: 0 auto;
	}

	/* ヘッダー */
	.header {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 12px;
	}
	.header-name { font-size: 18px; font-weight: 600; }
	.header-model {
		font-size: 12px;
		padding: 2px 10px;
		border-radius: 12px;
		background: rgba(226, 126, 74, 0.15);
		color: var(--accent);
		font-weight: 600;
	}
	.header-status { font-size: 12px; margin-left: auto; }
	.btn-settings {
		background: none; border: none; cursor: pointer;
		font-size: 16px; color: var(--text-dim); padding: 4px;
	}
	.btn-settings:hover { color: var(--text); }

	/* アクションボタン */
	.actions { margin-bottom: 16px; }
	.btn-primary {
		display: inline-block;
		padding: 8px 24px;
		background: var(--btn-bg);
		color: var(--btn-fg);
		border: none; border-radius: 4px;
		cursor: pointer; font-size: 13px; font-weight: 600;
		margin-bottom: 8px;
	}
	.btn-primary:hover { background: var(--btn-hover); }
	.btn-secondary {
		padding: 4px 12px;
		background: var(--btn-secondary-bg);
		color: var(--btn-secondary-fg);
		border: none; border-radius: 3px;
		cursor: pointer; font-size: 11px;
		margin-right: 6px;
	}
	.btn-secondary:hover { background: var(--btn-secondary-hover); }

	/* セクション */
	.section {
		margin-bottom: 16px;
		border-top: 1px solid var(--border);
		padding-top: 12px;
	}
	.section-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
	}
	.section-title {
		font-size: 13px; font-weight: 600;
	}
	.section-badge {
		font-size: 10px;
		padding: 1px 6px;
		border-radius: 8px;
		background: rgba(100,200,100,0.15);
		color: #6c6;
	}
	.section-action {
		margin-left: auto;
		color: var(--accent);
		cursor: pointer;
		font-size: 11px;
		background: none; border: none;
	}
	.section-action:hover { text-decoration: underline; }

	/* 情報グリッド */
	.info-grid {
		display: grid;
		grid-template-columns: 90px 1fr;
		gap: 4px 12px;
		font-size: 12px;
	}
	.info-label { color: var(--text-dim); }
	.dim { color: var(--text-dim); }

	/* リスト */
	.agent-link {
		color: var(--accent); cursor: pointer;
		background: none; border: none; font-size: 12px;
		padding: 0;
	}
	.agent-link:hover { text-decoration: underline; }
	/* v0.5.27: フォルダパスのリンク（OS エクスプローラで開く） */
	.folder-link {
		color: var(--accent); cursor: pointer;
		background: none; border: none; font-size: 12px;
		padding: 0; font-family: ui-monospace, Consolas, monospace;
		text-align: left; word-break: break-all;
	}
	.folder-link:hover { text-decoration: underline; }
	.child-item, .collab-item { font-size: 12px; padding: 2px 0; }

	/* コンテンツブロック */
	.content-block {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 10px 14px;
		font-size: 12px;
		font-family: var(--vscode-editor-font-family);
		white-space: pre-wrap;
		max-height: 200px;
		overflow-y: auto;
		line-height: 1.5;
	}
	.empty-msg { font-size: 12px; color: var(--text-dim); font-style: italic; }

	/* ON/OFFトグルボタン */
	.toggle-btn {
		font-size: 10px; padding: 1px 8px; border-radius: 8px;
		border: 1px solid; cursor: pointer; font-weight: 600;
	}
	.toggle-btn.on {
		background: rgba(100,200,100,0.15); color: #6c6; border-color: rgba(100,200,100,0.3);
	}
	.toggle-btn.off {
		background: rgba(150,150,150,0.1); color: var(--text-dim); border-color: rgba(150,150,150,0.2);
	}
	.toggle-btn:hover { opacity: 0.8; }

	/* TODO */
	.todo-block {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 10px 14px;
		max-height: 300px;
		overflow-y: auto;
	}
	.todo-h1 { font-size: 14px; font-weight: 700; margin: 8px 0 4px; }
	.todo-h2 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; color: var(--accent); }
	.todo-h3 { font-size: 12px; font-weight: 600; margin: 6px 0 2px; }
	.todo-item {
		display: block; font-size: 12px; padding: 2px 0; cursor: pointer;
	}
	.todo-item:hover { background: rgba(255,255,255,0.03); }
	.todo-item.done { text-decoration: line-through; opacity: 0.5; }
	.todo-item input { margin-right: 6px; cursor: pointer; }
	.todo-list-item { font-size: 12px; padding: 1px 0 1px 8px; }
	.todo-text { font-size: 12px; padding: 1px 0; }
	.todo-spacer { height: 6px; }

	/* HISTORY */
	.history-block {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 10px 14px;
		max-height: 300px;
		overflow-y: auto;
		font-size: 12px;
	}
	.history-h1 { font-size: 14px; font-weight: 700; margin: 6px 0 4px; }
	.history-h2 { font-size: 13px; font-weight: 600; margin: 6px 0 4px; }
	.history-date {
		font-size: 12px; font-weight: 600; margin: 8px 0 2px;
		color: var(--accent);
		border-bottom: 1px solid var(--border);
		padding-bottom: 2px;
	}
	.history-item { padding: 1px 0 1px 8px; }
	.history-text { padding: 1px 0; }
</style>
</head>
<body>

<!-- ヘッダー -->
<div class="header">
	<div class="header-name">🤖 ${escapeHtml(displayName)}</div>
	<div class="header-model">${modelChar} ${modelLabel}</div>
	<div class="header-status">${statusLabel}</div>
	<button class="btn-settings" id="btn-settings" title="設定">⚙</button>
</div>

<!-- アクションボタン -->
<div class="actions">
	${agent.sessionId
		? '<button class="btn-primary" id="btn-claude">▶ Claudeで開く</button><br>'
		: '<button class="btn-primary" id="btn-link" style="background:var(--btn-secondary-bg);color:var(--btn-secondary-fg)">🔗 セッションを紐づけ</button><br>'
	}
	${agent.ruleFile ? '<button class="btn-secondary" id="btn-rule">📄 ルール</button>' : ''}
	${agent.sessionId ? '<button class="btn-secondary" id="btn-terminal">💻 ターミナル</button>' : ''}
	${agent.sessionId ? '<button class="btn-secondary" id="btn-renew">🔄 引き継ぎ</button>' : ''}
	${agent.sessionId ? '<button class="btn-secondary" id="btn-link">🔗 紐づけ</button>' : ''}
	<button class="btn-secondary" id="btn-settings2">⚙ 設定</button>
</div>

<!-- 基本情報 -->
<div class="section">
	<div class="section-title">基本情報</div>
	<div class="info-grid">
		<div class="info-label">役割</div>
		<div>${escapeHtml(roleText)}</div>
		<div class="info-label">親</div>
		<div>${escapeHtml(parentLabel)}</div>
		<div class="info-label">セッション</div>
		<div>${escapeHtml(sessionLabel)}</div>
		<!-- v0.5.27: フォルダパス（クリックで OS エクスプローラを開く） -->
		<div class="info-label">フォルダ</div>
		<div>${agent.workDir
			? `<button class="folder-link" id="btn-reveal-folder" title="OS のファイルエクスプローラで開く">${escapeHtml(agent.workDir)}</button>`
			: '<span class="dim">（未設定）</span>'}</div>
		${agent.permissionMode ? `<div class="info-label">権限モード</div><div>${escapeHtml(agent.permissionMode)}</div>` : ''}
	</div>
</div>

<!-- 子エージェント（ツリー表示） -->
${children.length > 0 ? `
<div class="section">
	<div class="section-title">👥 配下エージェント</div>
	${childTreeHtml}
</div>
` : ''}

<!-- 連携先 -->
${collaborators.length > 0 ? `
<div class="section">
	<div class="section-title">🔗 連携先エージェント</div>
	${collaborators.map(c => {
		const cName = c.displayName ? `${c.displayName}（${c.name}）` : c.name;
		return `<div class="collab-item"><button class="agent-link" data-name="${escapeHtml(c.name)}">${escapeHtml(cName)}</button> <span class="dim">— ${escapeHtml(c.role || '')}</span></div>`;
	}).join('')}
</div>
` : ''}

<!-- TODO -->
<div class="section">
	<div class="section-header">
		<div class="section-title">📋 TODO</div>
		<button class="toggle-btn ${todoOn ? 'on' : 'off'}" id="btn-toggle-todo">${todoOn ? 'ON' : 'OFF'}</button>
		${hasTodo ? '<button class="section-action" id="btn-edit-todo">編集</button>' : ''}
	</div>
	${hasTodo
		? `<div class="todo-block">${renderTodoMarkdown(todoContent)}</div>`
		: (todoOn
			? `<div class="empty-msg">ON状態です。TODO.md はまだ空です（エージェントがタスクを追加すると反映されます）</div>`
			: `<div class="empty-msg">OFF状態です。ONにするとTODO管理が有効になります</div>`)
	}
</div>

<!-- HISTORY -->
<div class="section">
	<div class="section-header">
		<div class="section-title">📜 HISTORY</div>
		<button class="toggle-btn ${historyOn ? 'on' : 'off'}" id="btn-toggle-history">${historyOn ? 'ON' : 'OFF'}</button>
		${hasHistory ? '<button class="section-action" id="btn-edit-history">編集</button>' : ''}
	</div>
	${hasHistory
		? `<div class="history-block">${renderHistoryMarkdown(historyContent)}</div>`
		: (historyOn
			? `<div class="empty-msg">ON状態です。HISTORY.md はまだ空です（セッション終了時に自動追記されます）</div>`
			: `<div class="empty-msg">OFF状態です。ONにするとセッション履歴記録が有効になります</div>`)
	}
</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.getElementById('btn-settings')?.addEventListener('click', () => vscode.postMessage({ type: 'edit' }));
	document.getElementById('btn-settings2')?.addEventListener('click', () => vscode.postMessage({ type: 'edit' }));
	document.getElementById('btn-claude')?.addEventListener('click', () => vscode.postMessage({ type: 'openInClaude' }));
	document.getElementById('btn-rule')?.addEventListener('click', () => vscode.postMessage({ type: 'editRuleFile' }));
	document.getElementById('btn-terminal')?.addEventListener('click', () => vscode.postMessage({ type: 'openInTerminal' }));
	document.getElementById('btn-renew')?.addEventListener('click', () => vscode.postMessage({ type: 'renewSession' }));
	document.getElementById('btn-link')?.addEventListener('click', () => vscode.postMessage({ type: 'linkSession' }));
	// v0.5.27: フォルダパスクリック → OS エクスプローラで開く
	document.getElementById('btn-reveal-folder')?.addEventListener('click', () => vscode.postMessage({ type: 'revealFolder' }));

	// TODO/HISTORY 編集
	document.getElementById('btn-edit-todo')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'openFile', path: '${escapeHtml(path.join(os.homedir(), '.claude', 'agents', agent.name, 'TODO.md').replace(/\\/g, '/'))}' });
	});
	document.getElementById('btn-edit-history')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'openFile', path: '${escapeHtml(path.join(os.homedir(), '.claude', 'agents', agent.name, 'HISTORY.md').replace(/\\/g, '/'))}' });
	});

	// 連携先・子エージェントリンク
	document.querySelectorAll('.agent-link').forEach(el => {
		el.addEventListener('click', () => {
			vscode.postMessage({ type: 'openCollaborator', name: el.dataset.name });
		});
	});

	// TODO チェックボックスのトグル
	document.querySelectorAll('.todo-item input[type="checkbox"]').forEach(cb => {
		cb.addEventListener('change', (e) => {
			const input = e.target;
			const line = parseInt(input.dataset.line);
			const checked = input.checked;
			const label = input.parentElement;
			if (checked) { label.classList.add('done'); } else { label.classList.remove('done'); }
			vscode.postMessage({ type: 'toggleTodo', line: line, checked: checked });
		});
	});

	// TODO/HISTORY ON/OFFトグル
	document.getElementById('btn-toggle-todo')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'toggleFeature', feature: 'todo' });
	});
	document.getElementById('btn-toggle-history')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'toggleFeature', feature: 'history' });
	});

	// HISTORYを最下部にスクロール
	const historyBlock = document.querySelector('.history-block');
	if (historyBlock) {
		historyBlock.scrollTop = historyBlock.scrollHeight;
	}
</script>
</body>
</html>`;
}
