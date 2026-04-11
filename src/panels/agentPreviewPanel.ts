import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { getRuleFileInfo } from '../agents/agentManager';

// プレビューパネルの参照
let previewPanel: vscode.WebviewPanel | undefined;
// メッセージリスナーのDisposable（累積防止用）
let messageListenerDisposable: vscode.Disposable | undefined;

// エージェントプレビューを表示（読み取り専用・非同期）
export async function showAgentPreview(
	agent: AgentConfig,
	isLive: boolean,
	sessionTitle: string | undefined,
	onEdit: (agent: AgentConfig) => void,
	onEditRuleFile: (agent: AgentConfig) => void,
	onOpenSession: (sessionId: string) => void
): Promise<void> {
	const title = `🤖 ${agent.name}`;
	const html = await getPreviewHtml(agent, isLive, sessionTitle);

	if (previewPanel) {
		previewPanel.reveal(vscode.ViewColumn.One);
		previewPanel.title = title;
		previewPanel.webview.html = html;
		rebindMessages(previewPanel, agent, onEdit, onEditRuleFile, onOpenSession);
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
	rebindMessages(previewPanel, agent, onEdit, onEditRuleFile, onOpenSession);
}

function rebindMessages(
	panel: vscode.WebviewPanel,
	agent: AgentConfig,
	onEdit: (agent: AgentConfig) => void,
	onEditRuleFile: (agent: AgentConfig) => void,
	onOpenSession: (sessionId: string) => void
): void {
	// 古いリスナーを解除して累積を防止
	if (messageListenerDisposable) {
		messageListenerDisposable.dispose();
		messageListenerDisposable = undefined;
	}
	messageListenerDisposable = panel.webview.onDidReceiveMessage((message) => {
		if (message.type === 'edit') {
			onEdit(agent);
		} else if (message.type === 'editRuleFile') {
			onEditRuleFile(agent);
		} else if (message.type === 'openSession') {
			if (agent.sessionId) {
				onOpenSession(agent.sessionId);
			}
		}
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getPreviewHtml(agent: AgentConfig, isLive: boolean, sessionTitle: string | undefined): Promise<string> {
	const modelLabel = agent.model === 'opus' ? 'Opus' : agent.model === 'haiku' ? 'Haiku' : 'Sonnet';
	const modeLabel = agent.sessionMode === 'disposable' ? '使い捨て' : '固定';
	const statusLabel = isLive ? '🟢 動作中' : '⚪ 停止中';

	// 子エージェント一覧
	const allAgents = await dataStore.getAgents();
	const children = allAgents.filter((a) => a.parentAgent === agent.name);
	const childrenHtml = children.length > 0
		? children.map((c) => {
			const cModel = c.model === 'opus' ? 'Ｏ' : c.model === 'haiku' ? 'Ｈ' : 'Ｓ';
			return `<div class="child-item">${cModel}\u2007${escapeHtml(c.name)}<span class="dim"> — ${escapeHtml(c.role || '役割未設定')}</span></div>`;
		}).join('')
		: '<div class="dim">なし</div>';

	// 親エージェント
	const parentLabel = agent.parentAgent ? escapeHtml(agent.parentAgent) : 'なし（トップレベル）';

	// セッション情報
	const sessionLabel = agent.sessionId
		? (sessionTitle ? escapeHtml(sessionTitle) : `${agent.sessionId.substring(0, 8)}...`)
		: '未紐づけ';

	// ルールファイル内容（非同期）
	let ruleContent = '';
	let ruleInfoStr = '';
	if (agent.ruleFile) {
		const info = await getRuleFileInfo(agent.ruleFile);
		if (info) {
			ruleInfoStr = `📄 ${info.lines}行 (${info.sizeKb}KB)`;
			try {
				const raw = await fs.promises.readFile(agent.ruleFile, 'utf-8');
				ruleContent = escapeHtml(raw);
			} catch {
				ruleContent = '（読み込みエラー）';
			}
		} else {
			ruleInfoStr = '⚠ ファイル未検出';
		}
	} else {
		ruleInfoStr = '未設定';
	}

	// H-5: nonce付きCSPヘッダーを追加
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
	}
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		background: var(--bg);
		color: var(--text);
		padding: 24px;
		max-width: 720px;
		margin: 0 auto;
	}
	.header {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 20px;
		padding-bottom: 16px;
		border-bottom: 1px solid var(--border);
	}
	.header-name {
		font-size: 20px;
		font-weight: 600;
	}
	.header-model {
		font-size: 13px;
		padding: 2px 10px;
		border-radius: 12px;
		background: rgba(226, 126, 74, 0.15);
		color: var(--accent);
		font-weight: 600;
	}
	.header-status {
		font-size: 13px;
		margin-left: auto;
	}
	.btn-edit {
		padding: 6px 16px;
		background: var(--btn-bg);
		color: var(--btn-fg);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		font-weight: 600;
	}
	.btn-edit:hover { background: var(--btn-hover); }

	.section {
		margin-bottom: 20px;
	}
	.section-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-dim);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 8px;
	}
	.info-grid {
		display: grid;
		grid-template-columns: 100px 1fr;
		gap: 6px 12px;
		font-size: 13px;
	}
	.info-label {
		color: var(--text-dim);
		font-weight: 500;
	}
	.info-value {
		color: var(--text);
	}
	.dim { color: var(--text-dim); }

	.child-item {
		font-size: 13px;
		padding: 4px 0;
	}

	.session-link {
		color: var(--accent);
		cursor: pointer;
		text-decoration: none;
		font-size: 13px;
	}
	.session-link:hover { text-decoration: underline; }

	.rule-block {
		margin-top: 8px;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 12px 16px;
		font-size: 12px;
		font-family: var(--vscode-editor-font-family);
		white-space: pre-wrap;
		max-height: 400px;
		overflow-y: auto;
		line-height: 1.6;
	}
	.rule-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.rule-edit-link {
		color: var(--accent);
		cursor: pointer;
		font-size: 12px;
		margin-left: auto;
	}
	.rule-edit-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="header">
	<div class="header-name">🤖 ${escapeHtml(agent.name)}</div>
	<div class="header-model">${modelLabel}</div>
	<div class="header-status">${statusLabel}</div>
	<button class="btn-edit" id="btn-edit">設定</button>
</div>

<div class="section">
	<div class="section-title">基本情報</div>
	<div class="info-grid">
		<div class="info-label">役割</div>
		<div class="info-value">${escapeHtml(agent.role || '未設定')}</div>
		<div class="info-label">親エージェント</div>
		<div class="info-value">${parentLabel}</div>
		<div class="info-label">セッション運用</div>
		<div class="info-value">${modeLabel}</div>
		${agent.workDir ? `<div class="info-label">作業フォルダ</div><div class="info-value">${escapeHtml(agent.workDir)}</div>` : ''}
	</div>
</div>

<div class="section">
	<div class="section-title">セッション</div>
	${agent.sessionId
		? `<a class="session-link" id="link-session">${sessionLabel}</a>`
		: `<div class="dim">未紐づけ</div>`
	}
</div>

<div class="section">
	<div class="section-title">子エージェント</div>
	${childrenHtml}
</div>

<div class="section">
	<div class="rule-header">
		<div class="section-title">ルールファイル</div>
		<span class="dim" style="font-size:12px">${ruleInfoStr}</span>
		${agent.ruleFile ? '<a class="rule-edit-link" id="link-editRule">編集</a>' : ''}
	</div>
	${ruleContent ? `<div class="rule-block">${ruleContent}</div>` : ''}
</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	document.getElementById('btn-edit')?.addEventListener('click', () => vscode.postMessage({ type: 'edit' }));
	document.getElementById('link-editRule')?.addEventListener('click', () => vscode.postMessage({ type: 'editRuleFile' }));
	document.getElementById('link-session')?.addEventListener('click', () => vscode.postMessage({ type: 'openSession' }));
</script>
</body>
</html>`;
}
