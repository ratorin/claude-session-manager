import * as vscode from 'vscode';
import { ParsedSession, SimpleMessage, MemoryFile } from './types';
import { loadSessionFull } from './sessionLoader';
import * as dataStore from './dataStore';

// 簡易Markdownレンダラー（外部依存なし、リンク対応）
function renderMarkdown(text: string): string {
	let html = escapeHtml(text);

	// リンクをプレースホルダーに退避（二重マッチ防止）
	const linkStore: string[] = [];
	function storeLink(linkHtml: string): string {
		const idx = linkStore.length;
		linkStore.push(linkHtml);
		return `\x01L${idx}\x01`;
	}

	// コードブロック（```lang ... ```）
	html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) =>
		`<pre class="md-code-block"><code class="lang-${lang}">${code.trim()}</code></pre>`);
	// インラインコード
	html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');

	// Markdownリンク: [text](URL)
	html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, t, url) =>
		storeLink(`<a class="md-link" data-type="url" data-href="${url}">${t}</a>`));
	// Markdownリンク: [text](path) — URL以外はファイルパスとして扱う
	html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, href) =>
		storeLink(`<a class="md-link" data-type="file" data-href="${href}">${t}</a>`));
	// 裸のURL
	html = html.replace(/(https?:\/\/[^\s<)]+)/g, (url) =>
		storeLink(`<a class="md-link" data-type="url" data-href="${url}">${url}</a>`));
	// Windows絶対ファイルパス（拡張子付き、オプション:行番号）
	html = html.replace(/([A-Za-z]:[/\\](?:[^\s<>*?|]+[/\\])*[^\s<>*?|]+\.\w+(?::\d+)?)/g, (p) =>
		storeLink(`<a class="md-link" data-type="file" data-href="${p}">${p}</a>`));

	// 見出し
	html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
	html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
	html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
	html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
	// 太字・斜体
	html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
	html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
	// リスト（- で始まる行）
	html = html.replace(/^(\s*)- (.+)$/gm, '$1<li>$2</li>');
	// 番号リスト
	html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
	// テーブル対応（ | で区切られた行）
	html = html.replace(/((?:^(?:\|.+\|)\n)+)/gm, (table) => {
		const rows = table.trim().split('\n');
		if (rows.length < 2) { return table; }
		let result = '<table class="md-table">';
		rows.forEach((row, i) => {
			if (row.match(/^\|[\s-:|]+\|$/)) { return; } // 区切り行スキップ
			const cells = row.split('|').filter(Boolean).map((c) => c.trim());
			const tag = i === 0 ? 'th' : 'td';
			result += '<tr>' + cells.map((c) => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
		});
		result += '</table>';
		return result;
	});
	// 残りの改行をbrに
	html = html.replace(/\n/g, '<br>');
	// <br>の連続をパラグラフ区切りに
	html = html.replace(/(<br>){2,}/g, '</p><p>');

	// プレースホルダーをリンクHTMLに復元
	html = html.replace(/\x01L(\d+)\x01/g, (_m, idx) => linkStore[parseInt(idx)]);
	return html;
}

// パネルを使い回すための参照
let previewPanel: vscode.WebviewPanel | undefined;

// プレビュー中のタブタイトルを更新
export function updatePreviewTitle(title: string): void {
	if (previewPanel) {
		previewPanel.title = `💬 ${title}`;
	}
}

// 会話プレビューパネル
export function showSessionPreview(session: ParsedSession, context: vscode.ExtensionContext, showThinking: boolean = false): void {
	const fullSession = loadSessionFull(session.filePath, showThinking);
	if (!fullSession) {
		vscode.window.showErrorMessage('会話の読み込みに失敗しました');
		return;
	}

	const note = dataStore.getNote(session.id);
	const tags = dataStore.getTagsForSession(session.id);
	const title = `💬 ${session.customName || session.claudeTitle || session.firstMessage.substring(0, 30)}`;

	if (previewPanel) {
		previewPanel.title = title;
		previewPanel.webview.html = getSessionHtml(fullSession, note, tags);
		previewPanel.reveal(vscode.ViewColumn.One);
	} else {
		previewPanel = vscode.window.createWebviewPanel(
			'claudePreview',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);
		previewPanel.webview.html = getSessionHtml(fullSession, note, tags);
		previewPanel.onDidDispose(() => { previewPanel = undefined; });
	}

	// Webviewからのメッセージを受信
	previewPanel.webview.onDidReceiveMessage(async (message) => {
		if (message.type === 'saveNote') {
			dataStore.setNote(session.id, message.note);
		} else if (message.type === 'addTag') {
			// 既存タグから選択 or 新規入力
			const existingTags = Object.keys(dataStore.getAllTags());
			const NEW_TAG = '+ 新しいタグを作成...';
			let tagName: string | undefined;
			if (existingTags.length > 0) {
				const picked = await vscode.window.showQuickPick([...existingTags, NEW_TAG], { placeHolder: 'タグを選択' });
				if (!picked) { return; }
				tagName = picked === NEW_TAG
					? await vscode.window.showInputBox({ prompt: '新しいタグ名を入力' })
					: picked;
			} else {
				tagName = await vscode.window.showInputBox({ prompt: 'タグ名を入力' });
			}
			if (tagName) {
				dataStore.addTag(tagName, session.id);
				// HTMLを更新
				const updatedTags = dataStore.getTagsForSession(session.id);
				const updatedNote = dataStore.getNote(session.id);
				previewPanel!.webview.html = getSessionHtml(fullSession!, updatedNote, updatedTags);
			}
		} else if (message.type === 'removeTag') {
			dataStore.removeTagFromSession(message.tag, session.id);
			const updatedTags = dataStore.getTagsForSession(session.id);
			const updatedNote = dataStore.getNote(session.id);
			previewPanel!.webview.html = getSessionHtml(fullSession!, updatedNote, updatedTags);
		} else if (message.type === 'editAgent') {
			vscode.commands.executeCommand('claudeManager.editAgentBySessionId', session.id);
		} else if (message.type === 'editRuleFile') {
			vscode.commands.executeCommand('claudeManager.editRuleFileBySessionId', session.id);
		} else if (message.type === 'openLink') {
			if (message.linkType === 'url') {
				// URLをブラウザで開く
				vscode.env.openExternal(vscode.Uri.parse(message.href));
			} else if (message.linkType === 'file') {
				// ファイルパスと行番号を分離（例: c:\path\file.ts:42）
				const lineMatch = message.href.match(/^(.+?):(\d+)$/);
				const filePath = lineMatch ? lineMatch[1] : message.href;
				const lineNum = lineMatch ? parseInt(lineMatch[2]) - 1 : 0;
				try {
					const doc = await vscode.workspace.openTextDocument(filePath);
					const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
					if (lineNum > 0) {
						const pos = new vscode.Position(lineNum, 0);
						editor.selection = new vscode.Selection(pos, pos);
						editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					}
				} catch {
					vscode.window.showErrorMessage(`ファイルを開けませんでした: ${filePath}`);
				}
			}
		}
	});
}

function getSessionHtml(session: ParsedSession, note: string, tags: string[]): string {
	// エージェント情報をヘッダに表示
	const agent = dataStore.getAgentBySessionId(session.id);
	const agentHeaderHtml = agent
		? `<div class="agent-badge">
			<span class="agent-model badge-${agent.model}">${agent.model.toUpperCase()}</span>
			<span class="agent-name">${escapeHtml(agent.name)}</span>
			<span class="agent-role">${escapeHtml(agent.role)}</span>
			<span class="agent-actions">
				<a class="agent-link" onclick="editAgent()">設定編集</a>
				${agent.ruleFile ? '<a class="agent-link" onclick="editRuleFile()">ルールファイル</a>' : ''}
			</span>
		</div>`
		: '';

	const messagesHtml = session.messages.map((msg) => {
		const isThinking = msg.role === 'system' && msg.content.startsWith('[思考]');
		const roleClass = isThinking ? 'thinking' : (msg.role === 'user' ? 'user' : 'assistant');
		const roleLabel = isThinking ? '💭 思考' : (msg.role === 'user' ? 'あなた' : 'Claude');
		const time = msg.timestamp.toLocaleString('ja-JP');
		const content = renderMarkdown(isThinking ? msg.content.substring(4) : msg.content);
		const modelTag = msg.model ? `<span class="model">${msg.model}</span>` : '';

		// ツール操作メッセージは小さくコンパクトに
		const isToolMsg = !isThinking && (
			msg.content.startsWith('📄') || msg.content.startsWith('✏️') ||
			msg.content.startsWith('📝') || msg.content.startsWith('💻') ||
			msg.content.startsWith('🔍') || msg.content.startsWith('📂') ||
			msg.content.startsWith('🤖') || msg.content.startsWith('📋') ||
			msg.content.startsWith('🌐') || msg.content.startsWith('🔧') ||
			msg.content.startsWith('✅'));
		const toolClass = isToolMsg ? ' tool-msg' : '';

		return `<div class="message ${roleClass}${toolClass}">
			<div class="message-header">
				<span class="role">${roleLabel}</span>
				${modelTag}
				<span class="time">${time}</span>
			</div>
			<div class="message-content">${content}</div>
		</div>`;
	}).join('\n');

	const displayName = session.customName || session.claudeTitle || session.firstMessage;
	const tagsHtml = tags.map((t) => `<span class="tag">${escapeHtml(t)}<span class="tag-remove" onclick="removeTag('${escapeHtml(t)}')">×</span></span>`).join('');
	const dateRange = `${session.firstTimestamp.toLocaleString('ja-JP')} 〜 ${session.lastTimestamp.toLocaleString('ja-JP')}`;

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		height: 100vh;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* === 上部: ヘッダ+メモ === */
	.header-panel {
		border-bottom: 2px solid var(--vscode-panel-border);
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		max-height: 40vh;
		overflow: hidden;
	}
	.session-info {
		padding: 12px 16px;
		background: var(--vscode-textBlockQuote-background);
		border-left: 3px solid var(--vscode-textLink-foreground);
		display: flex;
		gap: 16px;
		align-items: flex-start;
	}
	.info-main { flex: 1; }
	.info-main h2 { font-size: 1.1em; margin-bottom: 4px; }
	.meta-grid {
		display: flex;
		gap: 16px;
		flex-wrap: wrap;
		font-size: 0.8em;
		opacity: 0.7;
	}
	.meta-item { display: flex; align-items: center; gap: 4px; }
	.tags { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
	.tag {
		padding: 1px 8px;
		border-radius: 10px;
		font-size: 0.75em;
		background: var(--vscode-textLink-foreground);
		color: var(--vscode-editor-background);
		font-weight: 600;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.tag-remove {
		cursor: pointer;
		opacity: 0.6;
		font-size: 1.1em;
		line-height: 1;
	}
	.tag-remove:hover { opacity: 1; }
	.tag-add {
		background: transparent !important;
		border: 1px dashed var(--vscode-textLink-foreground);
		color: var(--vscode-textLink-foreground) !important;
		cursor: pointer;
		font-weight: 400;
	}
	.tag-add:hover {
		background: var(--vscode-textLink-foreground) !important;
		color: var(--vscode-editor-background) !important;
	}

	/* メモエリア */
	.note-area {
		padding: 8px 16px;
		background: var(--vscode-editor-background);
		border-top: 1px solid var(--vscode-panel-border);
	}
	.note-label {
		font-size: 0.75em;
		color: var(--vscode-descriptionForeground);
		margin-bottom: 4px;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.note-label .saved {
		color: var(--vscode-testing-iconPassed);
		font-size: 0.85em;
		opacity: 0;
		transition: opacity 0.3s;
	}
	.note-label .saved.show { opacity: 1; }
	.note-textarea {
		width: 100%;
		min-height: 48px;
		max-height: 120px;
		padding: 6px 10px;
		border: 1px solid var(--vscode-input-border);
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border-radius: 4px;
		font-family: var(--vscode-font-family);
		font-size: 0.85em;
		line-height: 1.4;
		resize: vertical;
	}
	.note-textarea:focus {
		outline: none;
		border-color: var(--vscode-focusBorder);
	}

	/* === 下部: 会話 === */
	.chat-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.search-bar {
		padding: 6px 16px;
		background: var(--vscode-editor-background);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0;
	}
	.search-bar input {
		width: 100%;
		padding: 5px 10px;
		border: 1px solid var(--vscode-input-border);
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border-radius: 4px;
		font-size: 0.85em;
	}
	.search-bar input:focus {
		outline: none;
		border-color: var(--vscode-focusBorder);
	}
	#messages {
		flex: 1;
		overflow-y: auto;
		padding: 8px 16px 16px;
	}

	/* メッセージ */
	.message {
		margin: 6px 0;
		padding: 10px 14px;
		border-radius: 8px;
	}
	.message.user {
		background: var(--vscode-textBlockQuote-background);
		margin-left: 40px;
	}
	.message.assistant {
		background: var(--vscode-editor-inactiveSelectionBackground);
		margin-right: 40px;
	}
	.message-header {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
		font-size: 0.8em;
	}
	.role { font-weight: bold; color: var(--vscode-textLink-foreground); }
	.model { opacity: 0.6; font-size: 0.85em; }
	.time { margin-left: auto; opacity: 0.5; font-size: 0.85em; }
	.message-content { line-height: 1.5; word-break: break-word; font-size: 0.9em; }
	.tool-msg {
		opacity: 0.6;
		padding: 4px 12px;
		font-size: 0.75em;
		margin-left: 0 !important;
		margin-right: 0 !important;
		border-left: 2px solid var(--vscode-textLink-foreground);
		border-radius: 0 4px 4px 0;
		background: transparent !important;
	}
	.tool-msg .message-header { margin-bottom: 2px; }
	.tool-msg .message-content { font-family: monospace; }
	.message.thinking {
		opacity: 0.6;
		padding: 6px 12px;
		font-size: 0.8em;
		border-left: 3px solid #ce93d8;
		border-radius: 0 6px 6px 0;
		background: rgba(206, 147, 216, 0.06) !important;
		margin-right: 40px;
	}
	.message.thinking .role { color: #ce93d8; }
	.message.thinking .message-content { font-style: italic; }

	/* エージェントバッジ */
	.agent-badge {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 16px;
		background: rgba(226, 126, 74, 0.08);
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.agent-badge .agent-model {
		font-size: 0.7em;
		padding: 1px 6px;
		border-radius: 3px;
		font-weight: 700;
		letter-spacing: 0.5px;
	}
	.badge-opus { background: rgba(179,136,255,0.15); color: #b388ff; border: 1px solid rgba(179,136,255,0.3); }
	.badge-sonnet { background: rgba(100,181,246,0.15); color: #64b5f6; border: 1px solid rgba(100,181,246,0.3); }
	.badge-haiku { background: rgba(129,199,132,0.15); color: #81c784; border: 1px solid rgba(129,199,132,0.3); }
	.agent-badge .agent-name { font-weight: 600; font-size: 0.85em; color: #e27e4a; }
	.agent-badge .agent-role { font-size: 0.75em; opacity: 0.6; }
	.agent-badge .agent-actions { margin-left: auto; display: flex; gap: 8px; }
	.agent-badge .agent-link {
		font-size: 0.75em;
		color: var(--vscode-textLink-foreground);
		cursor: pointer;
		text-decoration: none;
		border-bottom: 1px dotted currentColor;
	}
	.agent-badge .agent-link:hover { border-bottom-style: solid; }

	/* Markdownレンダリング */
	.message-content h1, .message-content h2, .message-content h3, .message-content h4 {
		margin: 8px 0 4px;
		line-height: 1.3;
	}
	.message-content h1 { font-size: 1.2em; }
	.message-content h2 { font-size: 1.1em; }
	.message-content h3 { font-size: 1.0em; }
	.message-content strong { font-weight: 700; }
	.message-content li { margin-left: 20px; list-style: disc; }
	.md-code-block {
		background: var(--vscode-textCodeBlock-background);
		padding: 8px 12px;
		border-radius: 4px;
		font-family: 'Cascadia Code', 'Consolas', monospace;
		font-size: 0.85em;
		overflow-x: auto;
		margin: 6px 0;
		white-space: pre;
	}
	.md-inline-code {
		background: var(--vscode-textCodeBlock-background);
		padding: 1px 4px;
		border-radius: 3px;
		font-family: 'Cascadia Code', 'Consolas', monospace;
		font-size: 0.9em;
	}
	.md-table {
		border-collapse: collapse;
		margin: 6px 0;
		font-size: 0.85em;
	}
	.md-table th, .md-table td {
		border: 1px solid var(--vscode-panel-border);
		padding: 4px 8px;
	}
	.md-table th {
		background: var(--vscode-textBlockQuote-background);
		font-weight: 600;
	}
	/* クリック可能リンク */
	.md-link {
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
		cursor: pointer;
		border-bottom: 1px dotted currentColor;
	}
	.md-link:hover {
		color: var(--vscode-textLink-activeForeground);
		border-bottom-style: solid;
	}
	.md-link[data-type="file"] {
		font-family: 'Cascadia Code', 'Consolas', monospace;
		font-size: 0.9em;
	}
</style>
</head>
<body>
	<!-- 上部: ヘッダ+メモ -->
	<div class="header-panel">
		${agentHeaderHtml}
		<div class="session-info">
			<div class="info-main">
				<h2>${escapeHtml(displayName)}</h2>
				<div class="meta-grid">
					<span class="meta-item">📁 ${escapeHtml(session.project)}</span>
					<span class="meta-item">💬 ${session.messageCount}件</span>
					<span class="meta-item">🤖 ${session.model || '不明'}</span>
					${session.gitBranch ? `<span class="meta-item">🔀 ${escapeHtml(session.gitBranch)}</span>` : ''}
					<span class="meta-item">📅 ${dateRange}</span>
				</div>
				<div class="tags">${tagsHtml}<span class="tag tag-add" onclick="addTag()">+ タグ追加</span></div>
			</div>
		</div>
		<div class="note-area">
			<div class="note-label">
				📝 メモ
				<span class="saved" id="savedIndicator">✓ 保存済み</span>
			</div>
			<textarea class="note-textarea" id="noteInput" placeholder="この会話の役割や目的をメモ...">${escapeHtml(note)}</textarea>
		</div>
	</div>

	<!-- 下部: 会話 -->
	<div class="chat-panel">
		<div class="search-bar">
			<input type="text" id="searchInput" placeholder="会話内を検索..." oninput="filterMessages(this.value)">
		</div>
		<div id="messages">
			${messagesHtml}
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		let saveTimer;

		// メモ自動保存（入力停止500ms後）
		document.getElementById('noteInput').addEventListener('input', (e) => {
			clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				vscode.postMessage({ type: 'saveNote', note: e.target.value });
				const indicator = document.getElementById('savedIndicator');
				indicator.classList.add('show');
				setTimeout(() => indicator.classList.remove('show'), 2000);
			}, 500);
		});

		function addTag() {
			vscode.postMessage({ type: 'addTag' });
		}
		function removeTag(tag) {
			vscode.postMessage({ type: 'removeTag', tag: tag });
		}

		function editAgent() {
			vscode.postMessage({ type: 'editAgent' });
		}
		function editRuleFile() {
			vscode.postMessage({ type: 'editRuleFile' });
		}

		function filterMessages(keyword) {
			const messages = document.querySelectorAll('.message');
			const lower = keyword.toLowerCase();
			messages.forEach(msg => {
				const text = msg.textContent.toLowerCase();
				msg.style.display = (!keyword || text.includes(lower)) ? '' : 'none';
			});
		}

		// リンクのクリックハンドラー（ファイルパス→エディタ、URL→ブラウザ）
		document.addEventListener('click', (e) => {
			const link = e.target.closest('.md-link');
			if (!link) return;
			e.preventDefault();
			vscode.postMessage({
				type: 'openLink',
				linkType: link.dataset.type,
				href: link.dataset.href
			});
		});

		// 最後のメッセージにスクロール
		window.addEventListener('load', () => {
			const msgs = document.querySelectorAll('.message');
			if (msgs.length > 0) {
				msgs[msgs.length - 1].scrollIntoView();
			}
		});
	</script>
</body>
</html>`;
}

// メモリプレビューパネル（同じタブを使い回す）
export function showMemoryPreview(memoryFile: MemoryFile): void {
	const title = `📝 ${memoryFile.name}`;

	if (previewPanel) {
		previewPanel.title = title;
		previewPanel.webview.html = getMemoryHtml(memoryFile);
		previewPanel.reveal(vscode.ViewColumn.One);
	} else {
		previewPanel = vscode.window.createWebviewPanel(
			'claudePreview',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);
		previewPanel.webview.html = getMemoryHtml(memoryFile);
		previewPanel.onDidDispose(() => { previewPanel = undefined; });
	}
}

function getMemoryHtml(file: MemoryFile): string {
	const typeLabels: Record<string, string> = {
		user: 'ユーザー情報',
		feedback: 'フィードバック',
		project: 'プロジェクト',
		reference: '外部リファレンス',
	};

	const typeColors: Record<string, string> = {
		user: '#4fc3f7',
		feedback: '#ffb74d',
		project: '#81c784',
		reference: '#ce93d8',
	};

	const content = escapeHtml(file.content).replace(/\n/g, '<br>');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<style>
	body {
		font-family: var(--vscode-font-family);
		padding: 16px;
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
	}
	.header {
		padding: 16px;
		margin-bottom: 16px;
		background: var(--vscode-textBlockQuote-background);
		border-left: 4px solid ${typeColors[file.type] || '#888'};
		border-radius: 4px;
	}
	.header h2 { margin: 0 0 8px 0; }
	.badge {
		display: inline-block;
		padding: 2px 8px;
		border-radius: 12px;
		font-size: 0.8em;
		background: ${typeColors[file.type] || '#888'}33;
		color: ${typeColors[file.type] || '#888'};
		border: 1px solid ${typeColors[file.type] || '#888'}66;
	}
	.meta { font-size: 0.85em; opacity: 0.7; margin-top: 8px; }
	.content {
		padding: 16px;
		line-height: 1.6;
		background: var(--vscode-editor-inactiveSelectionBackground);
		border-radius: 4px;
	}
</style>
</head>
<body>
	<div class="header">
		<h2>${escapeHtml(file.name)}</h2>
		<span class="badge">${typeLabels[file.type] || file.type}</span>
		<div class="meta">
			${escapeHtml(file.description)}<br>
			ファイル: ${escapeHtml(file.fileName)} (${formatBytes(file.sizeBytes)})
		</div>
	</div>
	<div class="content">${content}</div>
</body>
</html>`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
