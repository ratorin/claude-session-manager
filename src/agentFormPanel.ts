import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentConfig } from './types';
import * as dataStore from './dataStore';

// フォームパネルの参照
let formPanel: vscode.WebviewPanel | undefined;
// 最新のコールバックを保持（パネル再利用時に古いコールバックが残るバグ対策）
let currentOnSave: ((config: AgentConfig) => void) | undefined;

// エージェント設定フォームをWebviewで表示
export function showAgentFormPanel(
	existing: AgentConfig | undefined,
	sessionId: string,
	onSave: (config: AgentConfig) => void
): void {
	const title = existing ? `🤖 ${existing.name} の設定` : '🤖 エージェント登録';
	currentOnSave = onSave;

	if (formPanel) {
		formPanel.reveal(vscode.ViewColumn.One);
		formPanel.title = title;
		const currentPanel = formPanel;
		getFormHtml(existing, sessionId).then(html => { currentPanel.webview.html = html; }).catch(() => {/* ignore */});
		return;
	}

	formPanel = vscode.window.createWebviewPanel(
		'claudeAgentForm',
		title,
		vscode.ViewColumn.One,
		{ enableScripts: true }
	);

	getFormHtml(existing, sessionId).then(html => {
		if (formPanel) { formPanel.webview.html = html; }
	}).catch(() => {/* ignore */});
	formPanel.onDidDispose(() => { formPanel = undefined; currentOnSave = undefined; });

	formPanel.webview.onDidReceiveMessage(async (message) => {
		if (message.type === 'save') {
			currentOnSave?.(message.config as AgentConfig);
			formPanel?.dispose();
		} else if (message.type === 'cancel') {
			formPanel?.dispose();
		} else if (message.type === 'browseFolder') {
			// 初期パスをワークスペースフォルダに設定
			const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
			const folders = await vscode.window.showOpenDialog({
				canSelectFolders: true,
				canSelectFiles: false,
				canSelectMany: false,
				openLabel: '作業フォルダを選択',
				defaultUri: wsFolder,
			});
			if (folders && folders.length > 0) {
				formPanel?.webview.postMessage({ type: 'folderSelected', path: folders[0].fsPath });
			}
		}
	});
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function getFormHtml(existing: AgentConfig | undefined, sessionId: string): Promise<string> {
	// nonceを生成してCSPに使用（インラインスクリプト・スタイルを許可）
	const nonce = crypto.randomBytes(16).toString('hex');

	// スコープ別ルールフォルダ
	const globalFolder = await dataStore.getRuleFolderForScope('global');
	const projectFolder = await dataStore.getRuleFolderForScope('project');

	// 親エージェント候補
	const agents = await dataStore.getAgents();
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
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

	/* グレーアウト状態 */
	.radio-option.disabled label {
		opacity: 0.35;
		pointer-events: none;
		cursor: default;
	}

	/* トグルスイッチ */
	.toggle-row {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.toggle-switch {
		position: relative;
		width: 36px;
		height: 20px;
		flex-shrink: 0;
	}
	.toggle-switch input { display: none; }
	.toggle-slider {
		position: absolute;
		inset: 0;
		background: var(--input-border);
		border-radius: 10px;
		cursor: pointer;
		transition: background 0.2s;
	}
	.toggle-slider::before {
		content: '';
		position: absolute;
		width: 14px;
		height: 14px;
		left: 3px;
		top: 3px;
		background: var(--text);
		border-radius: 50%;
		transition: transform 0.2s;
	}
	.toggle-switch input:checked + .toggle-slider {
		background: var(--accent);
	}
	.toggle-switch input:checked + .toggle-slider::before {
		transform: translateX(16px);
	}
	.toggle-switch.disabled .toggle-slider {
		opacity: 0.35;
		pointer-events: none;
	}
	.toggle-label {
		font-size: 13px;
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
	<label class="form-label">推論努力レベル（Effort）</label>
	<div class="form-desc">モデルの推論にどれだけ努力させるか</div>
	<div class="radio-group" id="effortGroup">
		<div class="radio-option" id="effort-option-low">
			<input type="radio" name="effort" id="effort-low" value="low" ${v.effort === 'low' ? 'checked' : ''}>
			<label for="effort-low">Low<div class="radio-sub">最小限の推論</div></label>
		</div>
		<div class="radio-option" id="effort-option-medium">
			<input type="radio" name="effort" id="effort-medium" value="medium" ${v.effort === 'medium' ? 'checked' : ''}>
			<label for="effort-medium">Medium<div class="radio-sub">標準的な推論</div></label>
		</div>
		<div class="radio-option" id="effort-option-high">
			<input type="radio" name="effort" id="effort-high" value="high" ${!v.effort || v.effort === 'high' ? 'checked' : ''}>
			<label for="effort-high">High<div class="radio-sub">深い推論（推奨）</div></label>
		</div>
		<div class="radio-option" id="effort-option-max">
			<input type="radio" name="effort" id="effort-max" value="max" ${v.effort === 'max' ? 'checked' : ''}>
			<label for="effort-max">Max<div class="radio-sub">最大（Opus専用）</div></label>
		</div>
	</div>
</div>

<div class="form-group">
	<label class="form-label">Extended Thinking</label>
	<div class="form-desc">拡張思考モード（Haikuでは利用不可）</div>
	<div class="toggle-row" id="thinkingToggleRow">
		<div class="toggle-switch" id="thinkingSwitch">
			<input type="checkbox" id="thinkingEnabled" ${v.thinkingEnabled !== false ? 'checked' : ''}>
			<span class="toggle-slider"></span>
		</div>
		<span class="toggle-label" id="thinkingLabel">${v.thinkingEnabled !== false ? 'ON' : 'OFF'}</span>
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
		<button class="btn-browse" id="btnBrowseFolder">選択</button>
	</div>
	<div class="form-desc" style="margin-top: 4px; opacity: 0.7;">※ エージェントのcwd（作業ディレクトリ）になります。ルールファイルの編集対象フォルダ制限にも使用されます。</div>
</div>

<div class="form-group">
	<label class="form-label">ルールファイルのスコープ<span class="required">*</span></label>
	<div class="form-desc">ルールファイルの保存先を選択（保存時に自動生成されます）</div>
	<div class="radio-group">
		<div class="radio-option">
			<input type="radio" name="scope" id="scope-project" value="project" ${v.scope !== 'global' ? 'checked' : ''}>
			<label for="scope-project">プロジェクト<div class="radio-sub">${escapeHtml(projectFolder)}</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="scope" id="scope-global" value="global" ${v.scope === 'global' ? 'checked' : ''}>
			<label for="scope-global">グローバル<div class="radio-sub">${escapeHtml(globalFolder)}</div></label>
		</div>
	</div>
	<div class="form-desc" style="margin-top: 6px; opacity: 0.7;">ルールファイル: <span id="ruleFilePath">—</span></div>
	${v.ruleFile ? '<div class="form-desc" style="margin-top: 4px; opacity: 0.7;">現在のルールファイル: ' + escapeHtml(v.ruleFile) + '</div>' : ''}
</div>

<div class="form-actions">
	<button class="btn-save" id="btnSave">保存</button>
	<button class="btn-cancel" id="btnCancel">キャンセル</button>
</div>

<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	// JSON.stringifyでJS文字列リテラルのXSSを防止（シングルクォートエスケープ問題の回避）
	const sessionId = ${JSON.stringify(sessionId)};
	const existingRuleFile = ${JSON.stringify(v.ruleFile || '')};
	const globalFolder = ${JSON.stringify(globalFolder)};
	const projectFolder = ${JSON.stringify(projectFolder)};

	function updateRuleFilePath() {
		const scope = document.querySelector('input[name="scope"]:checked')?.value;
		const name = document.getElementById('name').value.trim();
		const pathEl = document.getElementById('ruleFilePath');
		if (!name) {
			pathEl.textContent = '（部署名を入力すると表示されます）';
			return;
		}
		const folder = scope === 'global' ? globalFolder : projectFolder;
		pathEl.textContent = folder + '/' + name + '.md';
	}

	function getFormData() {
		const thinkingOn = document.getElementById('thinkingEnabled').checked;
		return {
			name: document.getElementById('name').value.trim(),
			sessionId: sessionId,
			role: document.getElementById('role').value.trim(),
			model: document.querySelector('input[name="model"]:checked')?.value || 'opus',
			effort: document.querySelector('input[name="effort"]:checked')?.value || 'high',
			thinkingEnabled: thinkingOn,
			sessionMode: document.querySelector('input[name="sessionMode"]:checked')?.value || 'fixed',
			scope: document.querySelector('input[name="scope"]:checked')?.value || 'project',
			parentAgent: document.getElementById('parentAgent').value || undefined,
			workDir: document.getElementById('workDir').value.trim() || undefined,
			ruleFile: existingRuleFile || undefined,
			allowedTools: ${JSON.stringify(v.allowedTools || undefined)},
			status: ${JSON.stringify(v.status || 'idle')},
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

	// 拡張機能からのメッセージ受信
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'folderSelected') {
			document.getElementById('workDir').value = msg.path;
		}
	});

	// モデル変更時のグレーアウト連動
	function onModelChange(model) {
		const maxOption = document.getElementById('effort-option-max');
		const thinkingSwitch = document.getElementById('thinkingSwitch');
		const thinkingCheckbox = document.getElementById('thinkingEnabled');
		const thinkingLabel = document.getElementById('thinkingLabel');

		if (model === 'opus') {
			// Opus: 全4択有効、thinking有効
			maxOption.classList.remove('disabled');
			thinkingSwitch.classList.remove('disabled');
		} else if (model === 'sonnet') {
			// Sonnet: maxグレーアウト、thinking有効
			maxOption.classList.add('disabled');
			if (document.getElementById('effort-max').checked) {
				document.getElementById('effort-high').checked = true;
			}
			thinkingSwitch.classList.remove('disabled');
		} else if (model === 'haiku') {
			// Haiku: maxグレーアウト、thinking OFF固定
			maxOption.classList.add('disabled');
			if (document.getElementById('effort-max').checked) {
				document.getElementById('effort-high').checked = true;
			}
			thinkingSwitch.classList.add('disabled');
			thinkingCheckbox.checked = false;
			thinkingLabel.textContent = 'OFF';
		}
	}

	// Thinkingトグル変更時の連動
	document.getElementById('thinkingEnabled').addEventListener('change', function() {
		const label = document.getElementById('thinkingLabel');
		label.textContent = this.checked ? 'ON' : 'OFF';
	});

	// モデルラジオ変更イベント
	document.querySelectorAll('input[name="model"]').forEach(el => {
		el.addEventListener('change', function() {
			onModelChange(this.value);
		});
	});

	// 部署名・スコープ変更時にパスプレビューを更新
	document.getElementById('name').addEventListener('input', () => {
		document.getElementById('btnSave').disabled = !document.getElementById('name').value.trim();
		updateRuleFilePath();
	});
	document.querySelectorAll('input[name="scope"]').forEach(el => {
		el.addEventListener('change', updateRuleFilePath);
	});

	// 初期表示: モデルに応じたグレーアウト適用
	onModelChange(document.querySelector('input[name="model"]:checked')?.value || 'opus');
	updateRuleFilePath();

	// インラインonclickの代わりにaddEventListenerでイベントを登録（CSP対応）
	document.getElementById('btnBrowseFolder').addEventListener('click', browseFolder);
	document.getElementById('btnSave').addEventListener('click', save);
	document.getElementById('btnCancel').addEventListener('click', cancel);
</script>
</body>
</html>`;
}
