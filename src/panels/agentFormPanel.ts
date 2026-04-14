import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { getDescendants } from '../agents/parentChildSync';
import { shouldShowInOrgChart } from '../utils/agentUtils';

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
		} else if (message.type === 'loadFromSession') {
			// セッションJSONLから実際のモデルとcwdを読み取る
			const sessionId = message.sessionId;
			if (!sessionId) { return; }
			try {
				const { loadSessionFull } = await import('../utils/sessionLoader');
				const { buildProjectPathMap, getSessionFileInfos } = await import('../utils/sessionLoader');
				const fileInfos = await getSessionFileInfos();
				const info = fileInfos.find(f => f.filePath.includes(sessionId));
				if (info) {
					const session = await loadSessionFull(info.filePath);
					if (session) {
						// モデルを内部名に変換（日付付きモデルID対応: includes で部分一致）
						function resolveModelName(rawModel: string): string {
							if (rawModel.includes('[1m]')) {
								if (rawModel.includes('sonnet')) { return 'sonnet-1m'; }
								return 'opus'; // opus[1m]
							}
							if (rawModel.includes('opus')) { return 'opus'; }
							if (rawModel.includes('sonnet')) { return 'sonnet'; }
							if (rawModel.includes('haiku')) { return 'haiku'; }
							return rawModel;
						}
						const model = session.model ? resolveModelName(session.model) : undefined;
						formPanel?.webview.postMessage({
							type: 'sessionDataLoaded',
							model,
							cwd: session.project,
							rawModel: session.model,
						});
					}
				}
			} catch { /* 読み取り失敗は無視 */ }
		} else if (message.type === 'translate') {
			// Google Translate 無料API経由で翻訳
			const results = await translateFieldsToJapanese(
				message.name || '',
				message.role || '',
				message.description || ''
			);
			formPanel?.webview.postMessage({ type: 'translateResult', ...results });
		}
	});
}

// Google Translate 無料エンドポイント経由で英→日翻訳
async function translateText(text: string): Promise<string> {
	if (!text.trim()) { return ''; }
	try {
		const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=${encodeURIComponent(text)}`;
		const response = await fetch(url);
		if (!response.ok) { return ''; }
		const data = await response.json() as unknown[][];
		// Google Translate APIのレスポンス形式: [[["翻訳文","原文",null,null,10]],null,"en",...]
		const sentences = data[0] as unknown[][];
		return sentences.map((s: unknown[]) => String(s[0])).join('');
	} catch {
		return '';
	}
}

async function translateFieldsToJapanese(
	name: string,
	role: string,
	description: string
): Promise<{ displayName: string; displayRole: string; displayDescription: string }> {
	const [displayName, displayRole, displayDescription] = await Promise.all([
		translateText(name),
		translateText(role),
		translateText(description),
	]);
	return { displayName, displayRole, displayDescription };
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

	// 親エージェント候補（自身 + 全子孫を除外 → 循環参照防止）
	const agents = await dataStore.getAgents();
	const excludeNames = existing?.name
		? new Set([existing.name, ...getDescendants(existing.name, agents)])
		: new Set<string>();
	const parentOptions = agents
		.filter((a) => !excludeNames.has(a.name))
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

	/* セクション区切り */
	.section-header {
		font-size: 14px;
		font-weight: 600;
		color: var(--accent);
		margin: 24px 0 12px;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}

	/* テキストエリア */
	textarea {
		width: 100%;
		padding: 6px 10px;
		border: 1px solid var(--input-border);
		background: var(--input-bg);
		color: var(--input-fg);
		border-radius: 4px;
		font-size: 13px;
		font-family: var(--vscode-font-family);
		resize: vertical;
		min-height: 60px;
	}
	textarea:focus {
		outline: none;
		border-color: var(--focus);
	}

	/* 日本語フィールド（常に表示） */
	.jp-field-always {
		margin-top: 6px;
		padding: 6px 8px;
		border-left: 2px solid var(--vscode-textLink-foreground);
		background: rgba(0,120,212,0.04);
	}
	.jp-field-always input, .jp-field-always textarea {
		margin-top: 2px;
	}
	/* 日本語フィールド（トグル表示） */
	.jp-field {
		margin-top: 6px;
		padding: 6px 8px;
		border-left: 2px solid var(--vscode-textLink-foreground);
		background: rgba(0,120,212,0.04);
	}
	.form-label-sub {
		font-size: 11px;
		opacity: 0.7;
		margin-bottom: 2px;
	}
	.jp-field input, .jp-field textarea {
		margin-top: 2px;
	}
	/* 翻訳ボタン */
	.btn-translate {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 6px 14px;
		background: transparent;
		color: var(--accent);
		border: 1px solid var(--accent);
		border-radius: 4px;
		cursor: pointer;
		font-size: 12px;
		margin-top: 8px;
	}
	.btn-translate:hover { background: rgba(226, 126, 74, 0.08); }
	.btn-translate:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-translate .spinner {
		display: inline-block;
		width: 12px;
		height: 12px;
		border: 2px solid var(--accent);
		border-top-color: transparent;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* チェックボックス行 */
	.checkbox-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.checkbox-row input[type="checkbox"] {
		width: 16px;
		height: 16px;
		accent-color: var(--accent);
		cursor: pointer;
	}
	.checkbox-label {
		font-size: 13px;
		cursor: pointer;
	}

	/* バリデーションエラー */
	input.invalid {
		border-color: #f44336;
	}
	.error-text {
		font-size: 11px;
		color: #f44336;
		margin-top: 4px;
		display: none;
	}
	.error-text.visible {
		display: block;
	}
</style>
</head>
<body>
<h1>🤖 ${existing ? 'エージェント設定を編集' : 'エージェント登録'}</h1>

<div class="form-group">
	<label class="form-label">部署名<span class="required">*</span></label>
	<div class="form-desc">エージェントの識別名（英数字・ハイフン・アンダースコアのみ）</div>
	<input type="text" id="name" value="${escapeHtml(v.name || '')}" placeholder="code-reviewer">
	<div class="error-text" id="nameError">英数字、ハイフン（-）、アンダースコア（_）のみ使用できます</div>
	<div class="jp-field-always">
		<label class="form-label-sub">表示名（日本語）</label>
		<input type="text" id="displayName" value="${escapeHtml(v.displayName || '')}" placeholder="例: CSM開発部">
	</div>
</div>

<div class="form-group">
	<label class="form-label">役割の説明</label>
	<div class="form-desc">このエージェントが担当する業務内容</div>
	<textarea id="role" rows="2" placeholder="日本語でもOK（例: コードレビュー・品質管理）">${escapeHtml(v.role || '')}</textarea>
</div>

<div class="form-group">
	<label class="form-label">説明（description）</label>
	<div class="form-desc">CLIが使用するエージェントの説明文</div>
	<textarea id="description" rows="2" placeholder="Handles code review and quality assurance">${escapeHtml(v.displayDescription || v.role || '')}</textarea>
</div>

<div class="form-group">
	<button class="btn-translate" id="btnTranslate" style="${v.role && v.displayName ? 'display:none' : ''}">
		<span id="translateIcon">🔄</span>
		<span id="translateText">英語 → 日本語に翻訳（名前・役割）</span>
	</button>
	${sessionId ? `<button class="btn-translate" id="btnLoadSession" style="margin-left:8px">
		<span>📥</span>
		<span id="loadSessionText">セッションから読み込む</span>
	</button>` : ''}
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
			<input type="radio" name="model" id="model-sonnet-1m" value="sonnet-1m" ${v.model === 'sonnet-1m' ? 'checked' : ''}>
			<label for="model-sonnet-1m">Sonnet 1M<div class="radio-sub">長文コンテキスト（5倍）・定型作業</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="model" id="model-haiku" value="haiku" ${v.model === 'haiku' ? 'checked' : ''}>
			<label for="model-haiku">Haiku<div class="radio-sub">軽量タスク・高速応答</div></label>
		</div>
	</div>
</div>

<div style="margin: 12px 0 8px; padding: 10px 12px; border: 1px solid rgba(255,200,50,0.4); border-radius: 4px; background: rgba(255,200,50,0.06); font-size: 0.85em;">
	<strong>💡 起動時パラメータ</strong><br>
	以下の設定はセッション内には保存されません。<code>/ask-agent</code> や「ターミナルで開く」で起動する際のCLIオプションとして使用されます。
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
	<label class="form-label">権限モード（Permission Mode）</label>
	<div class="form-desc">/ask-agent で呼び出す時の権限レベル。-p モードでは acceptEdits か auto を推奨</div>
	<select id="permissionMode">
		<option value="acceptEdits" ${(v as any).permissionMode === 'acceptEdits' || !(v as any).permissionMode ? 'selected' : ''}>acceptEdits（編集自動許可・推奨）</option>
		<option value="auto" ${(v as any).permissionMode === 'auto' ? 'selected' : ''}>auto（ほぼ全自動）</option>
		<option value="plan" ${(v as any).permissionMode === 'plan' ? 'selected' : ''}>plan（計画のみ・対話用）</option>
		<option value="default" ${(v as any).permissionMode === 'default' ? 'selected' : ''}>default（毎回確認・対話用）</option>
		<option value="bypassPermissions" ${(v as any).permissionMode === 'bypassPermissions' ? 'selected' : ''}>bypassPermissions（全自動・危険）</option>
	</select>
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
		<option value="" ${!existing?.parentAgent && !existing?.showInOrgChart ? 'selected' : ''}>グローバル</option>
		<option value="__org_top__" ${!existing?.parentAgent && existing?.showInOrgChart ? 'selected' : ''}>組織図トップ</option>
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
		return {
			name: document.getElementById('name').value.trim(),
			displayName: document.getElementById('displayName').value.trim() || undefined,
			sessionId: sessionId,
			role: document.getElementById('role').value.trim(),
			model: document.querySelector('input[name="model"]:checked')?.value || 'opus',
			effort: document.querySelector('input[name="effort"]:checked')?.value || 'high',
			permissionMode: document.getElementById('permissionMode').value || 'acceptEdits',
			sessionMode: document.querySelector('input[name="sessionMode"]:checked')?.value || 'fixed',
			scope: document.querySelector('input[name="scope"]:checked')?.value || 'project',
			parentAgent: (() => {
				const val = document.getElementById('parentAgent').value;
				if (val === '__org_top__' || val === '') { return undefined; }
				return val;
			})(),
			showInOrgChart: (() => {
				const val = document.getElementById('parentAgent').value;
				if (val === '__org_top__') { return true; }
				if (val === '') { return false; }
				return true; // 親エージェントがある = 組織図に表示
			})(),
			workDir: document.getElementById('workDir').value.trim() || undefined,
			ruleFile: existingRuleFile || undefined,
			allowedTools: ${JSON.stringify(v.allowedTools || undefined)},
			status: ${JSON.stringify(v.status || 'idle')},
		};
	}

	// 部署名バリデーション: 英数字・ハイフン・アンダースコアのみ
	function isValidName(name) {
		return /^[a-zA-Z0-9_-]+$/.test(name);
	}

	function validateName() {
		const nameInput = document.getElementById('name');
		const nameError = document.getElementById('nameError');
		const val = nameInput.value.trim();
		const valid = val === '' || isValidName(val);
		nameInput.classList.toggle('invalid', !valid);
		nameError.classList.toggle('visible', !valid);
		return valid;
	}

	function save() {
		const data = getFormData();
		if (!data.name) {
			document.getElementById('name').focus();
			return;
		}
		if (!isValidName(data.name)) {
			document.getElementById('name').focus();
			validateName();
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


	// 翻訳実行（name → displayName, description → role）
	function requestTranslate() {
		const btn = document.getElementById('btnTranslate');
		const icon = document.getElementById('translateIcon');
		const text = document.getElementById('translateText');
		btn.disabled = true;
		icon.innerHTML = '<span class="spinner"></span>';
		text.textContent = '翻訳中...';
		vscode.postMessage({
			type: 'translate',
			name: document.getElementById('name').value.trim(),
			role: document.getElementById('description')?.value.trim() || document.getElementById('role').value.trim(),
			description: document.getElementById('description')?.value.trim() || '',
		});
	}

	// 拡張機能からのメッセージ受信
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'folderSelected') {
			document.getElementById('workDir').value = msg.path;
		} else if (msg.type === 'translateResult') {
			// 翻訳結果: displayName → 表示名, displayRole → 役割
			if (msg.displayName) { document.getElementById('displayName').value = msg.displayName; }
			if (msg.displayRole) { document.getElementById('role').value = msg.displayRole; }
			const btn = document.getElementById('btnTranslate');
			const icon = document.getElementById('translateIcon');
			const text = document.getElementById('translateText');
			btn.disabled = false;
			icon.textContent = '🔄';
			text.textContent = '英語 → 日本語に翻訳（名前・役割）';
			btn.style.display = 'none';
		} else if (msg.type === 'sessionDataLoaded') {
			// セッションから読み込んだデータをフォームに反映
			if (msg.model) {
				const radio = document.getElementById('model-' + msg.model);
				if (radio) { radio.checked = true; onModelChange(msg.model); }
			}
			if (msg.cwd) {
				document.getElementById('workDir').value = msg.cwd;
				updateRuleFilePath();
			}
			// ボタンを戻す
			const loadBtn = document.getElementById('btnLoadSession');
			if (loadBtn) {
				loadBtn.disabled = false;
				document.getElementById('loadSessionText').textContent =
					'読み込み完了' + (msg.rawModel ? '（' + msg.rawModel + '）' : '');
			}
		}
	});

	// モデル変更時のグレーアウト連動
	function onModelChange(model) {
		const maxOption = document.getElementById('effort-option-max');
		if (model === 'opus') {
			maxOption.classList.remove('disabled');
		} else {
			maxOption.classList.add('disabled');
			if (document.getElementById('effort-max').checked) {
				document.getElementById('effort-high').checked = true;
			}
		}
	}

	// モデルラジオ変更イベント
	document.querySelectorAll('input[name="model"]').forEach(el => {
		el.addEventListener('change', function() {
			onModelChange(this.value);
		});
	});

	// 部署名・スコープ変更時にパスプレビューを更新 + バリデーション
	document.getElementById('name').addEventListener('input', () => {
		const nameVal = document.getElementById('name').value.trim();
		const valid = nameVal === '' || isValidName(nameVal);
		document.getElementById('btnSave').disabled = !nameVal || !valid;
		validateName();
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
	document.getElementById('btnTranslate')?.addEventListener('click', requestTranslate);
	const btnLoadSession = document.getElementById('btnLoadSession');
	if (btnLoadSession) {
		btnLoadSession.addEventListener('click', () => {
			document.getElementById('loadSessionText').textContent = '読み込み中...';
			btnLoadSession.disabled = true;
			vscode.postMessage({ type: 'loadFromSession', sessionId: sessionId });
		});
	}
	document.getElementById('btnSave').addEventListener('click', save);
	document.getElementById('btnCancel').addEventListener('click', cancel);
</script>
</body>
</html>`;
}
