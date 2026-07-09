/**
 * projectDetailPanel.ts — v0.5.0 プロジェクト詳細 WebView Editor
 *
 * agentPreviewPanel.ts と同じパターンで実装。
 * - singleton WebviewPanel (同一パネルを再利用・更新)
 * - 詳細ペインのHTML/CSSを mainTabPanel.ts から独立させ、エディタ幅全体で表示
 * - クイックアクション: VS Code (新ウィンドウ) / ターミナル / 📂 エクスプローラで開く
 */

import * as vscode from 'vscode';
import { generateModelCss } from '../models/modelCatalog';

// -----------------------------------------------------------------------
// 型定義
// -----------------------------------------------------------------------

export interface ProjectMeta {
	id: string;
	name: string;
	path: string;
	source: string;
	addedAt?: string;
	isCurrent?: boolean;
}

export interface ProjectDetailData {
	project: ProjectMeta;
	progress?: {
		todos: Array<{ pending: number; done: number }>;
		pendingTasks: Array<{ count: number }>;
		history: Array<{ agent: string; lastEntry: string }>;
	};
	allAgents: Array<{ name: string; displayName?: string; role?: string; model?: string }>;
	assignedAgentNames: string[];
	miniOrgNodes?: Array<{ id: string; label?: string; parent?: string; model?: string; role?: string }>;
	memoryGroups?: Array<{ project: string; files: Array<{ name: string; description?: string; type?: string }> }>;
	globalMemoryFiles?: Array<{ name: string; description?: string; type?: string }>;
}

export interface ProjectDetailCallbacks {
	onOpenInVSCode: (projectPath: string) => Promise<void>;
	onOpenInTerminal: (projectPath: string) => void;
	onOpenInExplorer: (projectPath: string) => void;
	onAssignAgent: (projectId: string, agentName: string) => Promise<void>;
	onUnassignAgent: (projectId: string, agentName: string) => Promise<void>;
}

// -----------------------------------------------------------------------
// singleton 参照
// -----------------------------------------------------------------------

let _panel: vscode.WebviewPanel | undefined;
let _disposable: vscode.Disposable | undefined;

// -----------------------------------------------------------------------
// 公開 API
// -----------------------------------------------------------------------

export function showProjectDetail(
	data: ProjectDetailData,
	callbacks: ProjectDetailCallbacks
): void {
	const title = `📁 ${data.project.name}`;
	const html = buildHtml(data);

	if (_panel) {
		_panel.reveal(vscode.ViewColumn.One);
		_panel.title = title;
		_panel.webview.html = html;
		_rebind(_panel, data, callbacks);
		return;
	}

	_panel = vscode.window.createWebviewPanel(
		'claudeProjectDetail',
		title,
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true }
	);

	_panel.webview.html = html;
	_panel.onDidDispose(() => {
		_panel = undefined;
		_disposable?.dispose();
		_disposable = undefined;
	});
	_rebind(_panel, data, callbacks);
}

// -----------------------------------------------------------------------
// メッセージバインド
// -----------------------------------------------------------------------

function _rebind(
	panel: vscode.WebviewPanel,
	data: ProjectDetailData,
	cb: ProjectDetailCallbacks
): void {
	_disposable?.dispose();
	_disposable = panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: Record<string, unknown> }) => {
		const { path: projectPath, id: projectId } = data.project;
		switch (msg.type) {
			case 'open-vscode':
				await cb.onOpenInVSCode(projectPath);
				break;
			case 'open-terminal':
				cb.onOpenInTerminal(projectPath);
				break;
			case 'open-explorer':
				cb.onOpenInExplorer(projectPath);
				break;
			case 'assign-agent':
				if (msg.payload?.agentName) {
					await cb.onAssignAgent(projectId, String(msg.payload.agentName));
				}
				break;
			case 'unassign-agent':
				if (msg.payload?.agentName) {
					await cb.onUnassignAgent(projectId, String(msg.payload.agentName));
				}
				break;
		}
	});
}

// -----------------------------------------------------------------------
// HTML生成
// -----------------------------------------------------------------------

function esc(s: unknown): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function buildHtml(data: ProjectDetailData): string {
	const { project, progress, allAgents, assignedAgentNames, miniOrgNodes, memoryGroups, globalMemoryFiles } = data;

	// シリアライズして JS 側に注入
	const dataJson = JSON.stringify({
		project,
		allAgents: allAgents ?? [],
		assignedAgentNames: assignedAgentNames ?? [],
		miniOrgNodes: miniOrgNodes ?? [],
		memoryGroups: memoryGroups ?? [],
		globalMemoryFiles: globalMemoryFiles ?? [],
		progress: progress ?? null,
	});

	const sourceLabel = project.source === 'workspace' ? 'ワークスペース'
		: project.source === 'manual' ? '手動登録'
		: 'Claudeプロジェクト';

	const addedAtLabel = project.addedAt
		? new Date(project.addedAt).toLocaleDateString('ja-JP')
		: '—';  // addedAt is ISO string

	return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>📁 ${esc(project.name)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-editor-background);
	padding: 16px 20px 32px;
	max-width: 800px;
}

/* ---- タイトル ---- */
.project-title {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 18px;
	font-weight: 700;
	margin-bottom: 4px;
}
.project-path {
	font-size: 11px;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 16px;
	word-break: break-all;
}
.badge-current {
	font-size: 10px;
	padding: 2px 7px;
	border-radius: 10px;
	background: var(--vscode-statusBarItem-remoteBackground, #007acc);
	color: var(--vscode-statusBarItem-remoteForeground, #fff);
}

/* ---- クイックアクション ---- */
.quick-actions {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	margin-bottom: 20px;
}
.qa-btn {
	padding: 5px 12px;
	font-size: 12px;
	font-family: inherit;
	background: var(--vscode-button-secondaryBackground, transparent);
	color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
	border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
	border-radius: 3px;
	cursor: pointer;
	display: flex;
	align-items: center;
	gap: 5px;
}
.qa-btn:hover {
	background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
}

/* ---- セクション ---- */
.section {
	margin-bottom: 20px;
}
.section-title {
	font-size: 11px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--vscode-descriptionForeground);
	margin-bottom: 8px;
	padding-bottom: 4px;
	border-bottom: 1px solid var(--vscode-panel-border);
}

/* ---- メタ情報 ---- */
.meta-row {
	display: flex;
	gap: 8px;
	font-size: 12px;
	margin-bottom: 4px;
	align-items: flex-start;
}
.meta-label {
	color: var(--vscode-descriptionForeground);
	min-width: 70px;
	flex-shrink: 0;
	font-size: 11px;
}
.meta-value {
	color: var(--vscode-foreground);
	word-break: break-all;
}

/* ---- 進捗 ---- */
.progress-bar-wrap {
	background: rgba(255,255,255,0.1);
	border-radius: 3px;
	height: 6px;
	margin: 6px 0;
	overflow: hidden;
}
.progress-bar-fill {
	height: 100%;
	background: var(--vscode-focusBorder, #007acc);
	transition: width 0.3s;
}
.progress-stats {
	display: flex;
	gap: 12px;
	font-size: 12px;
	flex-wrap: wrap;
	margin-bottom: 6px;
}
.stat-item {
	display: flex;
	align-items: center;
	gap: 5px;
}
.stat-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex-shrink: 0;
}
.dot-todo    { background: var(--vscode-charts-yellow, #e9c46a); }
.dot-done    { background: var(--vscode-charts-green, #4caf50); }
.dot-pending { background: var(--vscode-charts-orange, #f4a261); }
.history-item {
	font-size: 11px;
	padding: 3px 0;
	border-bottom: 1px solid var(--vscode-panel-border);
	display: flex;
	gap: 6px;
}
.history-item:last-child { border-bottom: none; }
.history-agent { color: var(--vscode-descriptionForeground); min-width: 60px; flex-shrink: 0; }
.history-text { color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- エージェント ---- */
.agent-chips {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-bottom: 8px;
}
.agent-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 11px;
	padding: 3px 8px;
	border-radius: 12px;
	background: var(--vscode-badge-background);
	color: var(--vscode-badge-foreground);
	cursor: pointer;
}
.agent-chip:hover { opacity: 0.8; }
.chip-remove { font-size: 10px; opacity: 0.7; }
.candidate-list {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-top: 4px;
}
.candidate-btn {
	font-size: 11px;
	padding: 3px 8px;
	border: 1px solid var(--vscode-panel-border);
	border-radius: 3px;
	background: transparent;
	color: var(--vscode-foreground);
	font-family: inherit;
	cursor: pointer;
}
.candidate-btn:hover { background: var(--vscode-list-hoverBackground); }
.subsection-title {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	margin: 8px 0 4px;
}
.info-text {
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
}

/* ---- メモリ ---- */
.memory-item {
	display: flex;
	align-items: baseline;
	gap: 6px;
	padding: 4px 0;
	border-bottom: 1px solid var(--vscode-panel-border);
	font-size: 11px;
}
.memory-item:last-child { border-bottom: none; }
.memory-type-badge {
	font-size: 9px;
	padding: 1px 5px;
	border-radius: 3px;
	flex-shrink: 0;
}
/* v0.5.18 §4-10: メモリタイプ色を charts.* テーマ変数へ */
.memory-type-user     { background: rgba(100,181,246,0.15); color: var(--vscode-charts-blue, #64b5f6); }
.memory-type-feedback { background: rgba(255,183,77,0.15);  color: var(--vscode-charts-orange, #ffb74d); }
.memory-type-project  { background: rgba(129,199,132,0.15); color: var(--vscode-charts-green, #81c784); }
.memory-type-reference{ background: rgba(206,147,216,0.15); color: var(--vscode-charts-purple, #ce93d8); }
.memory-name { font-weight: 500; color: var(--vscode-foreground); }
.memory-desc { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; }
.memory-group-header {
	font-size: 11px;
	font-weight: 600;
	color: var(--vscode-descriptionForeground);
	margin: 8px 0 3px;
}

/* ---- ミニ組織図 ---- */
.mini-org-tree { display: flex; flex-direction: column; gap: 3px; }
.mini-org-node {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 3px 6px;
	border-radius: 3px;
	font-size: 11px;
	border: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background, var(--vscode-editor-background));
}
.mini-org-node.indent-1 { margin-left: 20px; }
.mini-org-node.indent-2 { margin-left: 40px; }
.mini-org-indent { color: var(--vscode-descriptionForeground); font-size: 10px; }
.mini-org-name { font-weight: 500; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.model-badge { font-size: 9px; padding: 1px 4px; border-radius: 3px; font-weight: 600; flex-shrink: 0; }
/* v0.5.14 レビュー修正 (8): modelCatalog.generateModelCss() から一括生成（[1m] 分も含む） */
${generateModelCss('model')}
</style>
</head>
<body>

<div class="project-title">
	<span aria-hidden="true">📁</span>
	<span>${esc(project.name)}</span>
	${project.isCurrent ? '<span class="badge-current">現在</span>' : ''}
</div>
<div class="project-path">${esc(project.path)}</div>

<!-- クイックアクション -->
<div class="quick-actions">
	<button class="qa-btn" id="btn-vscode" aria-label="VS Codeで開く（新ウィンドウ）">
		<span aria-hidden="true">🖥</span> VS Codeで開く
	</button>
	<button class="qa-btn" id="btn-terminal" aria-label="ターミナルで開く">
		<span aria-hidden="true">⌨</span> ターミナル
	</button>
	<button class="qa-btn" id="btn-explorer" aria-label="エクスプローラで開く">
		<span aria-hidden="true">📂</span> エクスプローラで開く
	</button>
</div>

<!-- 概要 -->
<div class="section">
	<div class="section-title">概要</div>
	<div class="meta-row"><span class="meta-label">パス</span><span class="meta-value">${esc(project.path)}</span></div>
	<div class="meta-row"><span class="meta-label">ソース</span><span class="meta-value">${esc(sourceLabel)}</span></div>
	<div class="meta-row"><span class="meta-label">登録日</span><span class="meta-value">${esc(addedAtLabel)}</span></div>
</div>

<!-- 割当エージェント -->
<div class="section">
	<div class="section-title">割当エージェント</div>
	<div id="assigned-agents"></div>
	<div class="subsection-title">エージェントを追加</div>
	<div id="candidate-agents"></div>
</div>

<!-- 進捗ダッシュボード -->
<div class="section">
	<div class="section-title">進捗ダッシュボード</div>
	<div id="progress-section"></div>
</div>

<!-- ミニ組織図 -->
<div class="section">
	<div class="section-title">ミニ組織図</div>
	<div id="mini-org"></div>
</div>

<!-- メモリファイル -->
<div class="section">
	<div class="section-title">メモリファイル</div>
	<div id="memory-section"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
const DATA = ${dataJson};

// ---- ユーティリティ ----
function esc(s) {
	if (!s) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ---- クイックアクション ----
document.getElementById('btn-vscode').addEventListener('click', () => {
	vscode.postMessage({ type: 'open-vscode' });
});
document.getElementById('btn-terminal').addEventListener('click', () => {
	vscode.postMessage({ type: 'open-terminal' });
});
document.getElementById('btn-explorer').addEventListener('click', () => {
	vscode.postMessage({ type: 'open-explorer' });
});

// ---- 割当エージェント ----
function renderAssignedAgents() {
	const el = document.getElementById('assigned-agents');
	if (DATA.assignedAgentNames.length === 0) {
		el.innerHTML = '<div class="info-text">割当なし</div>';
		return;
	}
	const wrap = document.createElement('div');
	wrap.className = 'agent-chips';
	DATA.assignedAgentNames.forEach(name => {
		const chip = document.createElement('span');
		chip.className = 'agent-chip';
		chip.innerHTML = esc(name) + ' <span class="chip-remove" aria-hidden="true">✕</span>';
		chip.title = name + ' — クリックで解除';
		chip.setAttribute('role', 'button');
		chip.setAttribute('aria-label', name + 'を解除');
		chip.addEventListener('click', () => {
			vscode.postMessage({ type: 'unassign-agent', payload: { agentName: name } });
		});
		wrap.appendChild(chip);
	});
	el.appendChild(wrap);
}

function renderCandidateAgents() {
	const el = document.getElementById('candidate-agents');
	const unassigned = DATA.allAgents.filter(a => !DATA.assignedAgentNames.includes(a.name));
	if (unassigned.length === 0) {
		el.innerHTML = '<div class="info-text">すべて割当済み</div>';
		return;
	}
	const wrap = document.createElement('div');
	wrap.className = 'candidate-list';
	unassigned.slice(0, 15).forEach(a => {
		const btn = document.createElement('button');
		btn.className = 'candidate-btn';
		btn.textContent = '＋ ' + (a.displayName || a.name);
		btn.title = a.role || a.name;
		btn.setAttribute('aria-label', (a.displayName || a.name) + 'を割当');
		btn.addEventListener('click', () => {
			vscode.postMessage({ type: 'assign-agent', payload: { agentName: a.name } });
		});
		wrap.appendChild(btn);
	});
	el.appendChild(wrap);
}

// ---- 進捗 ----
function renderProgress() {
	const el = document.getElementById('progress-section');
	const p = DATA.progress;
	if (!p) { el.innerHTML = '<div class="info-text">データなし</div>'; return; }

	const totalPending = p.todos.reduce((s, t) => s + t.pending, 0);
	const totalDone    = p.todos.reduce((s, t) => s + t.done,    0);
	const totalAll     = totalPending + totalDone;
	const pct = totalAll > 0 ? Math.round(totalDone / totalAll * 100) : 0;
	const pendingTasks = p.pendingTasks.reduce((s, t) => s + t.count, 0);

	let html = '<div class="progress-stats">' +
		'<span class="stat-item"><span class="stat-dot dot-todo"></span>TODO残 ' + totalPending + '件</span>' +
		'<span class="stat-item"><span class="stat-dot dot-done"></span>完了 ' + totalDone + '件</span>' +
		'<span class="stat-item"><span class="stat-dot dot-pending"></span>確認待ち ' + pendingTasks + '件</span>' +
	'</div>';

	if (totalAll > 0) {
		html += '<div class="progress-bar-wrap" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
			'<div class="progress-bar-fill" style="width:' + pct + '%;"></div></div>' +
			'<div style="font-size:11px;color:var(--vscode-descriptionForeground);text-align:right;margin-bottom:6px;">' + pct + '% 完了</div>';
	}

	if (p.history && p.history.length > 0) {
		html += '<div style="font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:4px;">直近履歴</div>';
		html += p.history.slice(0, 5).map(h =>
			'<div class="history-item">' +
				'<span class="history-agent">' + esc(h.agent) + '</span>' +
				'<span class="history-text">' + esc(h.lastEntry) + '</span>' +
			'</div>'
		).join('');
	}
	el.innerHTML = html;
}

// ---- ミニ組織図 ----
function renderMiniOrg() {
	const el = document.getElementById('mini-org');
	const nodes = DATA.miniOrgNodes;
	if (!nodes || nodes.length === 0) {
		el.innerHTML = '<div class="info-text">割当エージェントなし</div>';
		return;
	}

	const roots   = nodes.filter(n => !n.parent);
	const children = nodes.filter(n => n.parent);

	// v0.5.14: Fable 5 対応
	function modelClass(model) {
		if (model === 'fable' || model === 'fable-1m') return 'model-fable';
		if (model === 'opus' || model === 'opus-1m')  return 'model-opus';
		if (model === 'haiku') return 'model-haiku';
		return 'model-sonnet';
	}
	function nodeHtml(n, indent) {
		const indentClass = indent === 1 ? 'indent-1' : indent === 2 ? 'indent-2' : '';
		const prefix = indent > 0 ? '<span class="mini-org-indent">└─</span>' : '';
		return '<div class="mini-org-node ' + indentClass + '">' +
			prefix +
			'<span class="model-badge ' + modelClass(n.model) + '">' + esc(n.model) + '</span>' +
			'<span class="mini-org-name" title="' + esc(n.role || n.id) + '">' + esc(n.label || n.id) + '</span>' +
		'</div>';
	}

	let html = '<div class="mini-org-tree">';
	const rootIds = new Set(roots.map(r => r.id));
	for (const root of roots) {
		html += nodeHtml(root, 0);
		const level1 = children.filter(c => c.parent === root.id);
		for (const c1 of level1) {
			html += nodeHtml(c1, 1);
			children.filter(c => c.parent === c1.id).forEach(c2 => { html += nodeHtml(c2, 2); });
		}
	}
	// 孤立ノード
	children.filter(c => !rootIds.has(c.parent)).forEach(o => { html += nodeHtml(o, 0); });
	html += '</div>';
	el.innerHTML = html;
}

// ---- メモリ ----
function renderMemory() {
	const el = document.getElementById('memory-section');
	let html = '';

	function memItem(f) {
		const tc = 'memory-type-' + (f.type || 'project');
		return '<div class="memory-item">' +
			'<span class="memory-type-badge ' + tc + '">' + esc(f.type || 'project') + '</span>' +
			'<span class="memory-name">' + esc(f.name) + '</span>' +
			(f.description ? '<span class="memory-desc">— ' + esc(f.description) + '</span>' : '') +
		'</div>';
	}

	if (DATA.globalMemoryFiles && DATA.globalMemoryFiles.length > 0) {
		html += '<div class="memory-group-header">🌐 グローバル</div>';
		html += DATA.globalMemoryFiles.map(f => memItem(f)).join('');
	}
	if (DATA.memoryGroups && DATA.memoryGroups.length > 0) {
		DATA.memoryGroups.forEach(g => {
			if (g.files && g.files.length > 0) {
				html += '<div class="memory-group-header">📁 ' + esc(g.project) + '</div>';
				html += g.files.map(f => memItem(f)).join('');
			}
		});
	}
	if (!html) { html = '<div class="info-text">メモリファイルなし</div>'; }
	el.innerHTML = html;
}

// ---- 初期レンダリング ----
renderAssignedAgents();
renderCandidateAgents();
renderProgress();
renderMiniOrg();
renderMemory();
</script>
</body>
</html>`;
}
