import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { getDescendants } from '../agents/parentChildSync';
import { shouldShowInOrgChart } from '../utils/agentUtils';
import { showSnippetPicker } from './snippetPickerPanel';
import { MODEL_CATALOG, CSM_MODELS, type CsmModel } from '../models/modelCatalog';

// フォームパネルの参照
let formPanel: vscode.WebviewPanel | undefined;
// 最新のコールバックを保持（パネル再利用時に古いコールバックが残るバグ対策）
let currentOnSave: ((config: AgentConfig) => void | Promise<void>) | undefined;
// ExtensionContext 参照（スニペットピッカー起動に必要）
let _extensionContext: vscode.ExtensionContext | undefined;

// エージェント設定フォームをWebviewで表示
export function showAgentFormPanel(
	existing: AgentConfig | undefined,
	sessionId: string,
	onSave: (config: AgentConfig) => void | Promise<void>,
	context?: vscode.ExtensionContext
): void {
	if (context) { _extensionContext = context; }
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
			try {
				await currentOnSave?.(message.config as AgentConfig);
			} catch (err) {
				vscode.window.showErrorMessage(`エージェント保存エラー: ${err instanceof Error ? err.message : String(err)}`);
			}
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
						// v0.5.14: modelCatalog.normalizeModel に集約（fable 判定を [1m] より前へ）
						const { normalizeModel } = await import('../models/modelCatalog');
						const model = session.model ? normalizeModel(session.model) : undefined;
						formPanel?.webview.postMessage({
							type: 'sessionDataLoaded',
							// v0.5.32: 作業フォルダには生の cwd を優先。
							//   session.project は translateWorkDirPath / decodeProjectName 済みの
							//   「表示用パス」で、cwd 欠落時は推測パス、dev-lamp では Linux 変換後パスになり
							//   Windows の workDir 欄に誤った値が入っていた。生 cwd を優先し無い時のみ project。
							cwd: session.cwd || session.project,
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
		} else if (message.type === 'openSnippetPicker') {
			// T3.4: スニペットピッカーを開いてbodyテキストを取得
			if (!_extensionContext) {
				vscode.window.showErrorMessage('スニペットピッカーを開けませんでした（コンテキスト未設定）');
				return;
			}
			try {
				const snippetText = await showSnippetPicker(_extensionContext);
				if (snippetText !== undefined) {
					// T3.7: 差分プレビュー → modal で確認
					const answer = await vscode.window.showInformationMessage(
						'次のテキストを役割本文に挿入しますか？',
						{ modal: true, detail: snippetText.length > 300 ? snippetText.slice(0, 300) + '...' : snippetText },
						'挿入する',
						'キャンセル'
					);
					if (answer === '挿入する') {
						formPanel?.webview.postMessage({ type: 'snippetInsert', text: snippetText });
					}
				}
			} catch (err) {
				vscode.window.showErrorMessage(
					`スニペット挿入エラー: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		} else if (message.type === 'offerDisplayName') {
			// T3.9: displayName が空の場合、日本語名自動生成をオファー
			await offerGenerateDisplayName(message.name || '', message.role || '');
		} else if (message.type === 'formError') {
			// v0.5.32: フォーム側のバリデーション不備を明確に通知（無言中断の防止）
			vscode.window.showWarningMessage(String(message.message || '入力内容に不備があります'));
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

/**
 * T3.9: displayName が空の場合、日本語名の自動生成をオファーする。
 * Yes → translateText で displayName を生成してフォームに設定。
 * No  → そのまま保存を続行。
 */
async function offerGenerateDisplayName(name: string, role: string): Promise<void> {
	if (!name) { return; }
	const answer = await vscode.window.showInformationMessage(
		`「${name}」の日本語名を自動生成しますか？`,
		{ modal: true, detail: '表示名（displayName）が未入力です。役割の説明をもとに自動生成します。' },
		'はい',
		'いいえ（そのまま保存）'
	);
	if (answer === 'はい') {
		// 翻訳を試みる（name + role を素材に）
		const source = role ? `${name} — ${role}` : name;
		const translated = await translateText(source);
		const displayName = translated || name;
		formPanel?.webview.postMessage({ type: 'setDisplayName', displayName });
	} else if (answer === 'いいえ（そのまま保存）') {
		// そのまま保存を進める
		formPanel?.webview.postMessage({ type: 'proceedSave' });
	}
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

	// v0.5.32: 「プロジェクト」保存先の実体を明示するための情報。
	//   プロジェクトスコープ = 今開いている VS Code ワークスペース（第1フォルダ）の .claude/agents。
	//   フォルダ未オープンだと保存が失敗するため、その場合はプロジェクトを選べないようにする。
	const wsFolders = vscode.workspace.workspaceFolders || [];
	const hasWorkspace = wsFolders.length > 0;
	const workspacePath = hasWorkspace ? wsFolders[0].uri.fsPath : '';
	// このエージェントの作業フォルダが現ワークスペースに含まれるか（含まれない=プロジェクト保存しても別ワークスペースに入る旨を注意喚起）
	const normWorkDir = (existing?.workDir || '').replace(/\\/g, '/').toLowerCase();
	const workDirInWorkspace = hasWorkspace && normWorkDir
		? wsFolders.some((f) => {
			const w = f.uri.fsPath.replace(/\\/g, '/').toLowerCase();
			return normWorkDir === w || normWorkDir.startsWith(w + '/') || w.startsWith(normWorkDir + '/');
		})
		: false;

	// HISTORY / TODO デフォルト値: 編集時は既存値、新規時は設定値を使用
	const agentCfg = vscode.workspace.getConfiguration('claudeManager.agent');
	const historyChecked = existing
		? (existing.historyEnabled === true)
		: agentCfg.get<boolean>('defaultHistoryEnabled', false);
	const todoChecked = existing
		? (existing.todoEnabled === true)
		: agentCfg.get<boolean>('defaultTodoEnabled', false);

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
	<div style="position:relative;">
		<textarea id="role" rows="2" placeholder="日本語でもOK（例: コードレビュー・品質管理）">${escapeHtml(v.role || '')}</textarea>
	</div>
	<button class="btn-browse" id="btnAddSnippet" style="margin-top:6px;display:inline-flex;align-items:center;gap:4px;" aria-label="スニペットを追加">
		+ 機能追加
	</button>
</div>

<div class="form-group">
	<label class="form-label">説明（description）</label>
	<div class="form-desc">CLIが使用するエージェントの英語説明文。Claude Code の自動委譲（sub-agent 選択）判定で参照される。空にすると保存時に消去。</div>
	${/* v0.5.14 レビュー修正 (2): displayDescription/role へのフォールバックを廃止。
		toAgentConfig で def.description が渡るようになったため、既存 description をそのまま復元する。
		旧フォールバックは「翻訳ボタンで英語descriptionが日本語roleに置換される」HIGH-1の根本原因だった。 */''}
	<textarea id="description" rows="2" placeholder="Handles code review and quality assurance">${escapeHtml(v.description ?? '')}</textarea>
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
	<div class="form-desc">使用するClaudeモデル（v0.5.14 で Fable 5 を追加）</div>
	${/* v0.5.14 レビュー修正 (8): モデル一覧を MODEL_CATALOG から動的生成。
	   旧: 7 モデル分の HTML をハードコード（追加時にラベル・description の重複更新が必要）
	   新: MODEL_CATALOG に追記するだけで自動反映。default 判定（!v.model → opus）は互換維持。 */''}
	<div class="radio-group">
		${CSM_MODELS.map(function(m){
			const def = MODEL_CATALOG[m];
			const checked = (v.model === m || (!v.model && m === 'opus')) ? 'checked' : '';
			return '<div class="radio-option">'
				+ '<input type="radio" name="model" id="model-' + m + '" value="' + m + '" ' + checked + '>'
				+ '<label for="model-' + m + '">' + def.label + '<div class="radio-sub">' + def.description + '</div></label>'
				+ '</div>';
		}).join('')}
	</div>
</div>

<div style="margin: 12px 0 8px; padding: 10px 12px; border: 1px solid rgba(255,200,50,0.4); border-radius: 4px; background: rgba(255,200,50,0.06); font-size: 0.85em;">
	<strong>💡 起動時パラメータ</strong><br>
	以下の設定はセッション内には保存されません。<code>/ask-agent</code> や「ターミナルで開く」で起動する際のCLIオプションとして使用されます。
</div>

${/* v0.5.16 M-10: effort に「未設定（継承）」を追加。
   旧: v.effort が空でも high が自動 checked → 保存で effort:high が黙って書き込まれた
   新: 既存値が空なら inherit を選択状態にし、getFormData で inherit → undefined（frontmatter に書かない） */''}
<div class="form-group">
	<label class="form-label">推論努力レベル（Effort）</label>
	<div class="form-desc">モデルの推論にどれだけ努力させるか</div>
	<div class="radio-group" id="effortGroup">
		<div class="radio-option" id="effort-option-inherit">
			<input type="radio" name="effort" id="effort-inherit" value="__inherit__" ${!v.effort ? 'checked' : ''}>
			<label for="effort-inherit">未設定（継承）<div class="radio-sub">frontmatter に書かず CC 側の既定/呼出コンテキストを継承</div></label>
		</div>
		<div class="radio-option" id="effort-option-low">
			<input type="radio" name="effort" id="effort-low" value="low" ${v.effort === 'low' ? 'checked' : ''}>
			<label for="effort-low">Low<div class="radio-sub">最小限の推論</div></label>
		</div>
		<div class="radio-option" id="effort-option-medium">
			<input type="radio" name="effort" id="effort-medium" value="medium" ${v.effort === 'medium' ? 'checked' : ''}>
			<label for="effort-medium">Medium<div class="radio-sub">標準的な推論</div></label>
		</div>
		<div class="radio-option" id="effort-option-high">
			<input type="radio" name="effort" id="effort-high" value="high" ${v.effort === 'high' ? 'checked' : ''}>
			<label for="effort-high">High<div class="radio-sub">深い推論（Opus 4.8 デフォルト・推奨）</div></label>
		</div>
		<div class="radio-option" id="effort-option-xhigh">
			<input type="radio" name="effort" id="effort-xhigh" value="xhigh" ${v.effort === 'xhigh' ? 'checked' : ''}>
			<label for="effort-xhigh">XHigh<div class="radio-sub">超高深度（最難タスク向け）</div></label>
		</div>
		<div class="radio-option" id="effort-option-max">
			<input type="radio" name="effort" id="effort-max" value="max" ${v.effort === 'max' ? 'checked' : ''}>
			<label for="effort-max">Max<div class="radio-sub">最大（コスト大 — 上位モデル推奨）</div></label>
		</div>
	</div>
</div>


<div class="form-group">
	<label class="form-label">許可ツール（allowedTools）</label>
	<div class="form-desc">チェックしたツールのみ許可。全部オフ = 全ツール継承（無制限）</div>
	<div style="display:flex;flex-wrap:wrap;">
		${(() => {
			// v0.5.14 HIGH-2 fix: 固定 12 種 → AskUserQuestion 追加 + 既存 frontmatter の未掲載ツールを動的追加
			//   旧: フォームに無いツール（例: AskUserQuestion）が保存で消去されていた
			// レビュー修正 (4)(5): extraTools を [...new Set(current)] で重複除去 + value/label 双方を escapeHtml
			const KNOWN_TOOLS = ['Read','Write','Edit','MultiEdit','Bash','Grep','Glob','Agent','WebFetch','WebSearch','Skill','TodoWrite','AskUserQuestion'];
			const current = v.allowedTools || [];
			// 既存の allowedTools のうち KNOWN_TOOLS に無いものを追加（順番は既知→未知、重複は除去）
			const extraTools = [...new Set(current)].filter(t => !KNOWN_TOOLS.includes(t));
			const allTools = KNOWN_TOOLS.concat(extraTools);
			return allTools.map(function(t){
				const checked = current.indexOf(t) >= 0 ? 'checked' : '';
				const isExtra = extraTools.includes(t);
				const safe = escapeHtml(t);
				const badge = isExtra ? '<span style="font-size:10px;opacity:.6;margin-left:2px;" title="frontmatter に既存のツール（フォーム標準リスト外）">＋</span>' : '';
				return '<label style="display:inline-flex;align-items:center;gap:5px;margin:3px 14px 3px 0;font-size:13px;"><input type="checkbox" name="tool" value="' + safe + '" ' + checked + '>' + safe + badge + '</label>';
			}).join('');
		})()}
	</div>
</div>

<div class="form-group">
	<label class="form-label">実行オプション（Claude Code 2.1.15x+）</label>
	<div class="form-desc">並列・バックグラウンド運用向け。サブエージェント定義の frontmatter に書き出されます。</div>
	<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-size:13px;"><input type="checkbox" id="isolation" ${v.isolation === 'worktree' ? 'checked' : ''}>worktree 隔離（isolation: worktree — 専用ワークツリーで実行）</label>
	<label style="display:flex;align-items:center;gap:6px;margin:4px 0;font-size:13px;"><input type="checkbox" id="background" ${v.background ? 'checked' : ''}>バックグラウンド実行（background: true）</label>
	<label style="display:flex;align-items:center;gap:8px;margin:6px 0;font-size:13px;">最大ターン数（maxTurns）<input type="number" id="maxTurns" min="1" step="1" placeholder="無制限" value="${v.maxTurns && v.maxTurns > 0 ? v.maxTurns : ''}" style="width:90px;"><span class="form-desc" style="margin:0;">暴走/コスト制御。空=無制限</span></label>
</div>

<div class="form-group">
	<label class="form-label">権限モード（Permission Mode）</label>
	<div class="form-desc">/ask-agent で呼び出す時の権限レベル。-p モードでは acceptEdits か auto を推奨</div>
	${/* v0.5.16 M-10: permissionMode に「未設定（継承）」を追加。
	   旧: 既定が acceptEdits で自動 selected → CSM 経由起動が「毎回確認」→「編集自動許可」に権限拡大
	   新: 既存値が空なら inherit を選択状態にし、getFormData で inherit → undefined（frontmatter に書かない） */''}
	<select id="permissionMode">
		<option value="__inherit__" ${!(v as any).permissionMode ? 'selected' : ''}>未設定（継承） — CC 側/呼出コンテキストに委ねる</option>
		<option value="acceptEdits" ${(v as any).permissionMode === 'acceptEdits' ? 'selected' : ''}>acceptEdits（編集自動許可・推奨）</option>
		<option value="auto" ${(v as any).permissionMode === 'auto' ? 'selected' : ''}>auto（ほぼ全自動）</option>
		<option value="plan" ${(v as any).permissionMode === 'plan' ? 'selected' : ''}>plan（計画のみ・対話用）</option>
		<option value="default" ${(v as any).permissionMode === 'default' ? 'selected' : ''}>default（毎回確認・対話用）</option>
		<option value="bypassPermissions" ${(v as any).permissionMode === 'bypassPermissions' ? 'selected' : ''}>bypassPermissions（全自動・危険）</option>
	</select>
</div>

<div class="form-group">
	<label class="form-label">HISTORY 有効化</label>
	<div class="form-desc">セッション履歴を HISTORY.md に自動記録します。ON で保存すると HISTORY.md を作成します。</div>
	<div class="toggle-row">
		<label class="toggle-switch">
			<input type="checkbox" id="historyEnabled" ${historyChecked ? 'checked' : ''}>
			<span class="toggle-slider"></span>
		</label>
		<span class="toggle-label" id="historyEnabledLabel">${historyChecked ? 'ON' : 'OFF'}</span>
	</div>
</div>

<div class="form-group" id="historyScopeGroup" style="${historyChecked ? '' : 'display:none'}">
	<label class="form-label">HISTORY.md 保存先</label>
	<div class="form-desc">HISTORY.md を保存する場所。デフォルトは定義ファイル（.md）と同じスコープ。</div>
	<select id="historyScope">
		<option value="" ${!v.historyScope ? 'selected' : ''}>自動（.mdと同じスコープ）</option>
		<option value="global" ${v.historyScope === 'global' ? 'selected' : ''}>グローバル（~/.claude/agents/&lt;name&gt;/HISTORY.md に集約）</option>
		<option value="project" ${v.historyScope === 'project' ? 'selected' : ''}>プロジェクト（&lt;workspace&gt;/.claude/agents/&lt;name&gt;/HISTORY.md）</option>
	</select>
</div>

<div class="form-group">
	<label class="form-label">TODO 有効化</label>
	<div class="form-desc">タスク管理用の TODO.md を使用します。ON で保存すると TODO.md を作成します。</div>
	<div class="toggle-row">
		<label class="toggle-switch">
			<input type="checkbox" id="todoEnabled" ${todoChecked ? 'checked' : ''}>
			<span class="toggle-slider"></span>
		</label>
		<span class="toggle-label" id="todoEnabledLabel">${todoChecked ? 'ON' : 'OFF'}</span>
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
	<label class="form-label">ルールファイルの保存先<span class="required">*</span></label>
	<div class="form-desc">どこに <code>&lt;name&gt;.md</code> を保存するか。保存時に自動生成されます。</div>
	<div class="radio-group">
		<div class="radio-option">
			<input type="radio" name="scope" id="scope-global" value="global" ${(v.scope === 'global' || !hasWorkspace) ? 'checked' : ''}>
			<label for="scope-global">グローバル（全プロジェクト共通）<div class="radio-sub">${escapeHtml(globalFolder)}</div></label>
		</div>
		<div class="radio-option">
			<input type="radio" name="scope" id="scope-project" value="project" ${(v.scope !== 'global' && hasWorkspace) ? 'checked' : ''} ${hasWorkspace ? '' : 'disabled'}>
			<label for="scope-project">プロジェクト（このワークスペースのみ）<div class="radio-sub">${hasWorkspace ? escapeHtml(projectFolder) : '⚠ フォルダ未オープンのため選択できません'}</div></label>
		</div>
	</div>
	${hasWorkspace
		? `<div class="form-desc" style="margin-top: 6px; opacity: 0.75;">「プロジェクト」= 今開いているワークスペース <code>${escapeHtml(workspacePath)}</code> の <code>.claude/agents</code> です。</div>`
		: `<div class="form-desc" style="margin-top: 6px; color: #fbbf24;">⚠ フォルダを開いていないため「プロジェクト」に保存できません。グローバルで保存するか、対象フォルダを開いてください。</div>`}
	${(hasWorkspace && normWorkDir && !workDirInWorkspace)
		? `<div class="form-desc" style="margin-top: 4px; color: #fbbf24;">⚠ このエージェントの作業フォルダは現在のワークスペース外です。作業フォルダ側に保存したい場合は、そのフォルダを VS Code で開いてから「プロジェクト」を選んでください。</div>`
		: ''}
	<div class="form-desc" style="margin-top: 6px; opacity: 0.7;">保存されるファイル: <span id="ruleFilePath">—</span></div>
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
		// v0.5.14 HIGH-1 fix: description を送信する（旧: 未送信で role 値が description に代入されるバグ）
		const descriptionEl = document.getElementById('description');
		const descriptionVal = descriptionEl ? descriptionEl.value.trim() : '';
		// v0.5.16 M-10: effort / permissionMode は「未設定（継承）」を明示送信できるように。
		//   '__inherit__' → undefined（frontmatter に書き出さない）
		const effortRaw = document.querySelector('input[name="effort"]:checked')?.value;
		const effortVal = (!effortRaw || effortRaw === '__inherit__') ? undefined : effortRaw;
		const pmRaw = document.getElementById('permissionMode').value;
		const permissionModeVal = (!pmRaw || pmRaw === '__inherit__') ? undefined : pmRaw;
		return {
			name: document.getElementById('name').value.trim(),
			displayName: document.getElementById('displayName').value.trim() || undefined,
			sessionId: sessionId,
			role: document.getElementById('role').value.trim(),
			description: descriptionVal,
			model: document.querySelector('input[name="model"]:checked')?.value || 'opus',
			effort: effortVal,
			permissionMode: permissionModeVal,
			historyEnabled: document.getElementById('historyEnabled').checked,
			historyScope: (() => {
				const val = document.getElementById('historyScope').value;
				return (val === 'global' || val === 'project') ? val : undefined;
			})(),
			todoEnabled: document.getElementById('todoEnabled').checked,
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
			allowedTools: Array.from(document.querySelectorAll('input[name="tool"]:checked')).map(el => el.value),
			isolation: document.getElementById('isolation').checked ? 'worktree' : '',
			background: document.getElementById('background').checked,
			maxTurns: (() => { const n = parseInt(document.getElementById('maxTurns').value, 10); return Number.isFinite(n) && n > 0 ? n : 0; })(),
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
		// v0.5.32: 名前の不備は「無言で中断」せず、必ず理由を通知する（旧: focus のみで気づけなかった）
		if (!data.name) {
			document.getElementById('name').focus();
			validateName();
			vscode.postMessage({ type: 'formError', message: '名前（識別名）を入力してください。英数字・ハイフン・アンダースコアのみ使用できます（日本語は「表示名」欄へ）。' });
			return;
		}
		if (!isValidName(data.name)) {
			document.getElementById('name').focus();
			validateName();
			vscode.postMessage({ type: 'formError', message: '名前「' + data.name + '」は使用できません。名前（識別名）は英数字・ハイフン（-）・アンダースコア（_）のみです。日本語やスペースは「表示名」欄に入力してください。' });
			return;
		}
		// T3.9: displayName が空の場合、日本語名生成オファーを拡張機能側に委譲
		const displayName = document.getElementById('displayName').value.trim();
		if (!displayName) {
			vscode.postMessage({ type: 'offerDisplayName', name: data.name, role: data.role });
			return; // 保存はオファー後に proceedSave メッセージで再開
		}
		vscode.postMessage({ type: 'save', config: data });
	}

	function saveDirectly() {
		const data = getFormData();
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
		} else if (msg.type === 'snippetInsert') {
			// T3.4: スニペットテキストをロールテキストエリアに挿入
			const roleArea = document.getElementById('role');
			if (roleArea) {
				const current = roleArea.value;
				const sep = current.trimEnd().length > 0 ? '\\n\\n' : '';
				roleArea.value = current.trimEnd() + sep + msg.text;
				roleArea.focus();
				// テキストエリアを末尾にスクロール
				roleArea.scrollTop = roleArea.scrollHeight;
			}
		} else if (msg.type === 'setDisplayName') {
			// T3.9: 日本語名自動生成結果を displayName フィールドに設定
			const dnInput = document.getElementById('displayName');
			if (dnInput) { dnInput.value = msg.displayName || ''; }
			// displayName が埋まったので保存を再実行
			saveDirectly();
		} else if (msg.type === 'proceedSave') {
			// T3.9: "いいえ" 選択時 → displayName なしでそのまま保存
			saveDirectly();
		}
	});

	// モデル変更時のグレーアウト連動
	// v0.5.14: Fable 5 も Max effort を許可（Opus と同格の最上位モデル）
	// v0.5.14 レビュー修正 (8): allowsMax 判定を MODEL_CATALOG から生成。
	//   旧: "model === opus" 等のリテラル羅列（新モデル追加時に忘れやすい）
	//   新: MODEL_CATALOG[m].allowsMaxEffort=true のモデル集合を webview に埋め込む
	const ALLOWS_MAX_MODELS = ${JSON.stringify(CSM_MODELS.filter(function(m){ return MODEL_CATALOG[m].allowsMaxEffort; }))};
	function onModelChange(model) {
		const maxOption = document.getElementById('effort-option-max');
		const allowsMax = ALLOWS_MAX_MODELS.indexOf(model) >= 0;
		if (allowsMax) {
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

	// HISTORY / TODO トグル: ラベル更新 + historyScope の表示切替
	function onHistoryToggle(checked) {
		document.getElementById('historyEnabledLabel').textContent = checked ? 'ON' : 'OFF';
		const scopeGroup = document.getElementById('historyScopeGroup');
		if (scopeGroup) { scopeGroup.style.display = checked ? '' : 'none'; }
	}
	function onTodoToggle(checked) {
		document.getElementById('todoEnabledLabel').textContent = checked ? 'ON' : 'OFF';
	}
	document.getElementById('historyEnabled').addEventListener('change', function() {
		onHistoryToggle(this.checked);
	});
	document.getElementById('todoEnabled').addEventListener('change', function() {
		onTodoToggle(this.checked);
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
	document.getElementById('btnAddSnippet').addEventListener('click', () => {
		vscode.postMessage({ type: 'openSnippetPicker' });
	});
</script>
</body>
</html>`;
}
