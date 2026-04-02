import * as vscode from 'vscode';
import { AgentConfig } from './types';
import * as dataStore from './dataStore';

// フォームパネルの参照
let formPanel: vscode.WebviewPanel | undefined;

// エージェント設定フォームをWebviewで表示
export function showAgentFormPanel(
	existing: AgentConfig | undefined,
	sessionId: string,
	onSave: (config: AgentConfig) => void
): void {
	const title = existing ? `🤖 ${existing.name} の設定` : '🤖 エージェント登録';

	if (formPanel) {
		formPanel.reveal(vscode.ViewColumn.One);
		formPanel.title = title;
		formPanel.webview.html = getFormHtml(existing, sessionId);
		return;
	}

	formPanel = vscode.window.createWebviewPanel(
		'claudeAgentForm',
		title,
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	formPanel.webview.html = getFormHtml(existing, sessionId);
	formPanel.onDidDispose(() => { formPanel = undefined; });

	formPanel.webview.onDidReceiveMessage(async (message) => {
		if (message.type === 'save') {
			onSave(message.config as AgentConfig);
			formPanel?.dispose();
		} else if (message.type === 'cancel') {
			formPanel?.dispose();
		} else if (message.type === 'browseFolder') {
			const folders = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				openLabel: '作業フォルダを選択',
			});
			if (folders && folders.length > 0) {
				formPanel?.webview.postMessage({ type: 'folderSelected', path: folders[0].fsPath });
			}
		} else if (message.type === 'browseRuleFile') {
			const files = await vscode.window.showOpenDialog({
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				filters: { 'Markdown': ['md'], 'すべて': ['*'] },
				openLabel: 'ルールファイルを選択',
			});
			if (files && files.length > 0) {
				formPanel?.webview.postMessage({ type: 'ruleFileSelected', path: files[0].fsPath });
			}
		} else if (message.type === 'generateRuleFile') {
			const config = message.config as AgentConfig;
			const defaultFolder = dataStore.getRuleFolder();
			const uri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(`${defaultFolder}/${config.name}.md`),
				filters: { 'Markdown': ['md'] },
				title: 'ルールファイルの保存先',
			});
			if (uri) {
				const template = `あなたは${config.name}所属のエンジニアです。\n- ${config.role || '（役割未設定）'}を担当する\n- 変更前に既存コードを確認し、既存の設計方針を尊重する\n`;
				const fs = require('fs');
				fs.writeFileSync(uri.fsPath, template, 'utf-8');
				formPanel?.webview.postMessage({ type: 'ruleFileSelected', path: uri.fsPath });
				vscode.window.showInformationMessage(`ルールファイルを生成しました`);
			}
		}
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getFormHtml(existing: AgentConfig | undefined, sessionId: string): string {
	// ルールフォルダ
	const ruleFolder = dataStore.getRuleFolder();

	// 親エージェント候補
	const agents = dataStore.getAgents();
	const parentOptions = agents
		.filter((a) => a.name !== existing?.name)
		.map((a) => `<option value="${escapeHtml(a.name)}" ${existing?.parentAgent === a.name ? 'selected' : ''}>${escapeHtml(a.name)} — ${escapeHtml(a.role)}</option>`)
		.join('');

	const v = existing || {} as Partial<AgentConfig>;

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	:root {
		--accent: #e27e4a;
		--bg: var(--vscode-editor-background);
		--surface: var(--vscode-textBlockQuote-background);
		--border: var(--vscode-panel-border);
		--text: var(--vscode-foreground);
		--text-dim: var(--vscode-descriptionForeground);
		--input-bg: var(--vscode-input-background);
		--input-border: var(--vscode-input-border);
		--input-fg: var(--vscode-input-foreground);
		--focus: var(--vscode-focusBorder);
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
		max-width: 640px;
		margin: 0 auto;
	}
	h1 {
		font-size: 18px;
		color: var(--accent);
		margin-bottom: 24px;
		font-weight: 500;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.form-group {
		margin-bottom: 20px;
	}
	.form-label {
		display: block;
		font-size: 13px;
		font-weight: 600;
		margin-bottom: 4px;
	}
	.form-label .required {
		color: #f44336;
		margin-left: 2px;
	}
	.form-desc {
		font-size: 11px;
		color: var(--text-dim);
		margin-bottom: 6px;
		line-height: 1.4;
	}
	input[type="text"], select {
		width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--input-border);
		background: var(--input-bg);
		color: var(--input-fg);
		border-radius: 4px;
		font-size: 13px;
		font-family: var(--vscode-font-family);
	}
	input[type="text"]:focus, select:focus {
		outline: none;
		border-color: var(--focus);
	}
	.input-row {
		display: flex;
		gap: 6px;
	}
	.input-row input[type="text"] { flex: 1; }
	.btn-browse {
		padding: 6px 12px;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		white-space: nowrap;
	}
	.btn-browse:hover { background: var(--border); }

	/* ラジオグループ */
	.radio-group {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.radio-option {
		flex: 1;
		min-width: 120px;
	}
	.radio-option input[type="radio"] { display: none; }
	.radio-option label {
		display: block;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
		text-align: center;
		font-size: 12px;
		transition: all 0.15s;
		background: var(--surface);
	}
	.radio-option label:hover { border-color: var(--accent); }
	.radio-option input:checked + label {
		border-color: var(--accent);
		background: rgba(226, 126, 74, 0.12);
		color: var(--accent);
		font-weight: 600;
	}
	.radio-option .radio-sub {
		font-size: 10px;
		color: var(--text-dim);
		margin-top: 2px;
	}

	/* ボタン */
	.form-actions {
		display: flex;
		gap: 8px;
		margin-top: 28px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}
	.btn-save {
		padding: 8px 24px;
		background: var(--btn-bg);
		color: var(--btn-fg);
		border: none;
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
		font-weight: 600;
	}
	.btn-save:hover { background: var(--btn-hover); }
	.btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-cancel {
		padding: 8px 16px;
		background: transparent;
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
		font-size: 13px;
	}
	.btn-cancel:hover { background: var(--surface); }
	.btn-generate {
		margin-left: auto;
		padding: 8px 12px;
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
	}
	.btn-generate:hover { background: rgba(226, 126, 74, 0.08); }
</style>
</head>
<body>
<h1>🤖 ${existing ? 'エージェント設定を編集' : 'エージェント登録'}</h1>

<div class="form-group">
	<label class="form-label">部署名<span class="required">*</span></label>
	<div class="form-desc">エージェントの識別名（例: CSM開発部、テスト部）</div>
	<input type="text" id="name" value="${escapeHtml(v.name || '')}" placeholder="CSM開発部">
</div>

<div class="form-group">
	<label class="form-label">役割の説明</label>
	<div class="form-desc">このエージェントが担当する業務内容</div>
	<input type="text" id="role" value="${escapeHtml(v.role || '')}" placeholder="TypeScript開発・品質管理">
</div>

<div class="form-group">
	<label class="form-label">モデル選択<span class="required">*</span></label>
	<div class="form-desc">使用するClaudeモデル</div>
	<div class="radio-group">
		<div class="radio-option">
			<input type="radio" name="model" id="model-opus" value="opus" ${v.model === 'opus' || !v.model ? 'checked' : ''}>
			<label for="model-opus">Opus<div class="radio-sub">高度な判断・複雑な開発</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="model" id="model-sonnet" value="sonnet" ${v.model === 'sonnet' ? 'checked' : ''}>
			<label for="model-sonnet">Sonnet<div class="radio-sub">定型作業・補助（コスト効率◎）</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="model" id="model-haiku" value="haiku" ${v.model === 'haiku' ? 'checked' : ''}>
			<label for="model-haiku">Haiku<div class="radio-sub">軽量タスク・高速応答</div></label>
		</div>
	</div>
</div>

<div class="form-group">
	<label class="form-label">セッション運用<span class="required">*</span></label>
	<div class="form-desc">セッションの使い方を選択</div>
	<div class="radio-group">
		<div class="radio-option">
			<input type="radio" name="sessionMode" id="mode-fixed" value="fixed" ${v.sessionMode !== 'disposable' ? 'checked' : ''}>
			<label for="mode-fixed">固定<div class="radio-sub">同じセッションを継続使用（推奨）</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="sessionMode" id="mode-disposable" value="disposable" ${v.sessionMode === 'disposable' ? 'checked' : ''}>
			<label for="mode-disposable">使い捨て<div class="radio-sub">タスクごとに新しいセッション</div></label>
		</div>
	</div>
</div>

<div class="form-group">
	<label class="form-label">親エージェント</label>
	<div class="form-desc">このエージェントの上位エージェント（階層構造がある場合）</div>
	<select id="parentAgent">
		<option value="">なし（トップレベル）</option>
		${parentOptions}
	</select>
</div>

<div class="form-group">
	<label class="form-label">作業フォルダ</label>
	<div class="form-desc">エージェントの作業ディレクトリ</div>
	<div class="input-row">
		<input type="text" id="workDir" value="${escapeHtml(v.workDir || '')}" placeholder="C:\\xampp\\Project\\...">
		<button class="btn-browse" onclick="browseFolder()">選択</button>
	</div>
	<div class="form-desc" style="margin-top: 4px; opacity: 0.7;">※ エージェントのcwd（作業ディレクトリ）になります。ルールファイルの編集対象フォルダ制限にも使用されます。</div>
</div>

<div class="form-group">
	<label class="form-label">ルールファイル</label>
	<div class="form-desc">エージェントのルール定義ファイル（.md）— ルールフォルダ設定時はファイル名のみでOK</div>
	<div class="input-row">
		<input type="text" id="ruleFile" value="${escapeHtml(v.ruleFile || '')}" placeholder="${escapeHtml(ruleFolder ? '例: CSM開発部.md' : 'C:\\\\xampp\\\\Project\\\\.agent-rules\\\\...')}">
		<button class="btn-browse" onclick="browseRuleFile()">選択</button>
	</div>
	${ruleFolder ? '<div class="form-desc" style="margin-top: 4px; opacity: 0.7;">ルールフォルダ: ' + escapeHtml(ruleFolder) + '</div>' : ''}
</div>

<div class="form-actions">
	<button class="btn-save" id="btnSave" onclick="save()">保存</button>
	<button class="btn-cancel" onclick="cancel()">キャンセル</button>
	<button class="btn-generate" onclick="generateRule()">ひな形を自動生成</button>
</div>

<script>
	const vscode = acquireVsCodeApi();
	const sessionId = '${escapeHtml(sessionId)}';

	function getFormData() {
		return {
			name: document.getElementById('name').value.trim(),
			sessionId: sessionId,
			role: document.getElementById('role').value.trim(),
			model: document.querySelector('input[name="model"]:checked')?.value || 'opus',
			sessionMode: document.querySelector('input[name="sessionMode"]:checked')?.value || 'fixed',
			parentAgent: document.getElementById('parentAgent').value || undefined,
			workDir: document.getElementById('workDir').value.trim() || undefined,
			ruleFile: document.getElementById('ruleFile').value.trim() || undefined,
			allowedTools: ${JSON.stringify(v.allowedTools || undefined)},
			status: '${v.status || 'idle'}',
		};
	}

	function save() {
		const data = getFormData();
		if (!data.name) {
			document.getElementById('name').focus();
			return;
		}
		vscode.postMessage({ type: 'save', config: data });
	}

	function cancel() {
		vscode.postMessage({ type: 'cancel' });
	}

	function browseFolder() {
		vscode.postMessage({ type: 'browseFolder' });
	}

	function browseRuleFile() {
		vscode.postMessage({ type: 'browseRuleFile' });
	}

	function generateRule() {
		const data = getFormData();
		if (!data.name) {
			document.getElementById('name').focus();
			return;
		}
		vscode.postMessage({ type: 'generateRuleFile', config: data });
	}

	// 拡張機能からのメッセージ受信
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'folderSelected') {
			document.getElementById('workDir').value = msg.path;
		} else if (msg.type === 'ruleFileSelected') {
			document.getElementById('ruleFile').value = msg.path;
		}
	});

	// 部署名必須バリデーション
	document.getElementById('name').addEventListener('input', () => {
		document.getElementById('btnSave').disabled = !document.getElementById('name').value.trim();
	});
</script>
</body>
</html>`;
}
