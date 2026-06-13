/**
 * orgChartPanel.ts — v0.5.0 Sprint 2 T2.18〜T2.21
 * エージェント組織図 — Cytoscape.js + ELK レイアウト刷新
 *
 * T2.18: Cytoscape描画基盤（ELK layeredデフォルト）
 * T2.19: モード切替（ツリー/関係/グループ）
 * T2.20: フィルタ + PNG/SVGエクスポート
 * T2.21: プロジェクト詳細用ミニ組織図はsendMiniOrgChart()で外部公開
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentInfo, getAgents, enrichAgentsWithSessions } from '../agents/agentManager';
import { ParsedSession } from '../models/types';
import { shouldShowInOrgChart } from '../utils/agentUtils';

// -------------------------------------------------------------------
// 状態管理
// -------------------------------------------------------------------

let orgPanel: vscode.WebviewPanel | undefined;

let onOpenSession: ((sessionId: string) => void) | undefined;
let onOpenInClaude: ((sessionId: string) => void) | undefined;

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/** フル組織図パネルを開く（T2.18〜T2.20） */
export async function showOrgChart(
	getSessions: () => ParsedSession[],
	isLive: (id: string) => boolean,
	openSession?: (sessionId: string) => void,
	openInClaude?: (sessionId: string) => void,
	extensionUri?: vscode.Uri
): Promise<void> {
	onOpenSession = openSession;
	onOpenInClaude = openInClaude;

	const agents = await getAgents();
	const sessions = getSessions();
	const titleMap = new Map<string, string>();
	for (const s of sessions) {
		titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
	}
	const enriched = enrichAgentsWithSessions(agents, titleMap);

	const liveIds = new Set<string>();
	for (const a of enriched) {
		if (a.sessionId && isLive(a.sessionId)) {
			liveIds.add(a.sessionId);
		}
	}

	const nonce = crypto.randomBytes(16).toString('hex');
	const title = 'エージェント組織図';

	// パネルを先に生成/取得してから HTML を組む
	// (HTML 生成は webview.asWebviewUri を使うため、パネルが存在している必要がある。
	//  以前は buildOrgChartHtml を生成前に呼んでいたため、初回のみ Cytoscape URI が空になり
	//  一覧フォールバックに落ちるバグがあった)
	if (!orgPanel) {
		orgPanel = vscode.window.createWebviewPanel(
			'claudeOrgChart',
			title,
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: extensionUri ? [extensionUri] : [],
			}
		);
		orgPanel.onDidDispose(() => { orgPanel = undefined; });

		orgPanel.webview.onDidReceiveMessage((message) => {
			handleOrgChartMessage(message);
		});
	}

	const html = buildOrgChartHtml(enriched, liveIds, nonce, extensionUri);
	orgPanel.webview.html = html;
	orgPanel.reveal(vscode.ViewColumn.One);
}

/** ミニ組織図データを WebviewView へ送る（T2.21 用） */
export async function buildMiniOrgChartData(
	projectAgentNames: string[]
): Promise<MiniOrgChartNode[]> {
	const agents = await getAgents();
	return agents
		.filter(a => projectAgentNames.includes(a.name) && shouldShowInOrgChart(a))
		.map(a => ({
			id: a.name,
			label: a.displayName || a.name,
			parent: a.parentAgent || null,
			model: a.model,
			role: a.role,
		}));
}

export interface MiniOrgChartNode {
	id: string;
	label: string;
	parent: string | null;
	model: string;
	role: string;
}

// -------------------------------------------------------------------
// メッセージハンドラ
// -------------------------------------------------------------------

function handleOrgChartMessage(message: Record<string, unknown>): void {
	if (message.type === 'copyId') {
		vscode.env.clipboard.writeText(String(message.id)).then(() => {
			vscode.window.showInformationMessage(`コピー: ${message.id}`);
		});
	} else if (message.type === 'openSession' && onOpenSession) {
		onOpenSession(String(message.sessionId));
	} else if (message.type === 'openInClaude' && onOpenInClaude) {
		onOpenInClaude(String(message.sessionId));
	}
}

// -------------------------------------------------------------------
// HTML生成 — Cytoscape.js + ELK
// -------------------------------------------------------------------

function buildOrgChartHtml(
	agents: AgentInfo[],
	liveIds: Set<string>,
	nonce: string,
	extensionUri?: vscode.Uri
): string {
	// エレメント JSON 生成
	const elements = buildCytoscapeElements(agents, liveIds);
	const elementsJson = JSON.stringify(elements);

	// 利用可能なモデル/プロジェクト/役割リスト（T2.20 フィルタ用）
	const models  = [...new Set(agents.map(a => a.model))].sort();
	const parents = [...new Set(agents.filter(a => a.parentAgent).map(a => a.parentAgent || ''))].sort();

	// Cytoscape スクリプトURI
	let cytoscapeUri = '';
	let elkBundledUri = '';
	let cytoscapeElkUri = '';
	let cspScript = `'nonce-${nonce}'`;

	if (extensionUri && orgPanel) {
		const webview = orgPanel.webview;
		cytoscapeUri  = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'resources', 'cytoscape.min.js')
		).toString();
		elkBundledUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'resources', 'elk.bundled.js')
		).toString();
		cytoscapeElkUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'resources', 'cytoscape-elk.js')
		).toString();
		cspScript = `'nonce-${nonce}'`;
	}

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'nonce-${nonce}'; script-src ${cspScript}${cytoscapeUri ? ' ' + new URL(cytoscapeUri).origin : ''};">
<style nonce="${nonce}">
:root {
	--bg: var(--vscode-editor-background);
	--surface: var(--vscode-textBlockQuote-background);
	--border: var(--vscode-panel-border);
	--text: var(--vscode-foreground);
	--text-dim: var(--vscode-descriptionForeground);
	--accent: #e27e4a;
	--live: #4ec94e;
	--opus: #b388ff;
	--sonnet: #64b5f6;
	--haiku: #81c784;
}
* { margin:0; padding:0; box-sizing:border-box; }
html, body { height:100%; overflow:hidden; }
body {
	font-family: var(--vscode-font-family);
	background: var(--bg);
	color: var(--text);
	display: flex;
	flex-direction: column;
}

/* ---- ツールバー ---- */
#toolbar {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 10px;
	background: var(--vscode-sideBar-background);
	border-bottom: 1px solid var(--border);
	flex-shrink: 0;
	flex-wrap: wrap;
}
#toolbar h1 {
	font-size: 13px;
	font-weight: 600;
	color: var(--accent);
	margin-right: 8px;
}
.toolbar-group {
	display: flex;
	gap: 4px;
	align-items: center;
}
.toolbar-label {
	font-size: 11px;
	color: var(--text-dim);
}
.mode-btn {
	padding: 3px 8px;
	font-size: 11px;
	background: transparent;
	border: 1px solid var(--border);
	border-radius: 3px;
	color: var(--text);
	cursor: pointer;
	font-family: inherit;
}
.mode-btn:hover { background: var(--vscode-list-hoverBackground); }
.mode-btn.active {
	background: var(--accent);
	color: #fff;
	border-color: transparent;
}
.filter-select {
	padding: 3px 6px;
	font-size: 11px;
	background: var(--vscode-dropdown-background, var(--surface));
	border: 1px solid var(--border);
	border-radius: 3px;
	color: var(--text);
	font-family: inherit;
	max-width: 120px;
}
.export-btn {
	padding: 3px 8px;
	font-size: 11px;
	background: var(--vscode-button-secondaryBackground, transparent);
	border: 1px solid var(--border);
	border-radius: 3px;
	color: var(--vscode-button-secondaryForeground, var(--text));
	cursor: pointer;
	font-family: inherit;
}
.export-btn:hover { background: var(--vscode-list-hoverBackground); }

/* ---- Cytoscape コンテナ ---- */
#cy-container {
	flex: 1;
	position: relative;
	overflow: hidden;
}
#cy {
	width: 100%;
	height: 100%;
}

/* ---- ローディング ---- */
#loading {
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -50%);
	font-size: 13px;
	color: var(--text-dim);
	text-align: center;
}

/* ---- ツールチップ ---- */
#tooltip {
	position: absolute;
	background: var(--surface);
	border: 1px solid var(--border);
	border-radius: 4px;
	padding: 6px 10px;
	font-size: 11px;
	pointer-events: none;
	opacity: 0;
	transition: opacity 0.15s;
	max-width: 220px;
	z-index: 100;
}
#tooltip.visible { opacity: 1; }
.tooltip-name { font-weight: 600; margin-bottom: 2px; }
.tooltip-role { color: var(--text-dim); }
.tooltip-session { font-size: 10px; color: var(--text-dim); margin-top: 4px; font-family: monospace; }

/* ---- フォールバック（Cytoscapeロード失敗時） ---- */
#fallback {
	display: none;
	padding: 16px;
	overflow: auto;
	flex: 1;
}
</style>
</head>
<body>

<!-- ツールバー -->
<div id="toolbar">
	<h1>組織図</h1>

	<!-- T2.19: モード切替 -->
	<div class="toolbar-group">
		<span class="toolbar-label">レイアウト:</span>
		<button class="mode-btn active" data-mode="tree" title="ツリー (ELK layered)">ツリー</button>
		<button class="mode-btn" data-mode="force" title="関係 (force-directed)">関係</button>
		<button class="mode-btn" data-mode="group" title="グループ (ELK box)">グループ</button>
	</div>

	<!-- T2.20: フィルタ -->
	<div class="toolbar-group">
		<span class="toolbar-label">モデル:</span>
		<select class="filter-select" id="filter-model" aria-label="モデルフィルタ">
			<option value="">すべて</option>
			${models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')}
		</select>
	</div>
	<div class="toolbar-group">
		<span class="toolbar-label">親:</span>
		<select class="filter-select" id="filter-parent" aria-label="親エージェントフィルタ">
			<option value="">すべて</option>
			${parents.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
		</select>
	</div>

	<!-- T2.20: エクスポート -->
	<div class="toolbar-group" style="margin-left:auto;">
		<button class="export-btn" id="btn-export-png" title="PNG として保存">PNG</button>
		<button class="export-btn" id="btn-export-svg" title="SVG として保存">SVG</button>
	</div>
</div>

<!-- Cytoscapeコンテナ -->
<div id="cy-container">
	<div id="cy" role="img" aria-label="エージェント組織図"></div>
	<div id="loading">組織図を読み込み中...</div>
	<div id="tooltip" role="tooltip"></div>
</div>

<!-- フォールバック（Cytoscapeロード失敗時用） -->
<div id="fallback"></div>

${cytoscapeUri
	? `<script nonce="${nonce}" src="${cytoscapeUri}"></script>
<script nonce="${nonce}" src="${elkBundledUri}"></script>
<script nonce="${nonce}" src="${cytoscapeElkUri}"></script>`
	: ''}

<script nonce="${nonce}">
// ================================================================
// データ
// ================================================================
const vscode = acquireVsCodeApi();

const ELEMENTS = ${elementsJson};

const LAYOUT_CONFIGS = {
	tree: {
		name: 'elk',
		elk: {
			algorithm: 'layered',
			'elk.direction': 'DOWN',
			'elk.layered.spacing.nodeNodeBetweenLayers': 40,
			'elk.spacing.nodeNode': 20,
		},
	},
	force: {
		name: 'cose',
		animate: true,
		animationDuration: 500,
		idealEdgeLength: 120,
		nodeOverlap: 20,
		refresh: 20,
		fit: true,
		padding: 30,
		randomize: false,
		componentSpacing: 100,
		nodeRepulsion: 400000,
		edgeElasticity: 100,
		nestingFactor: 5,
		gravity: 80,
		numIter: 1000,
		coolingFactor: 0.99,
		minTemp: 1.0,
	},
	group: {
		name: 'elk',
		elk: {
			algorithm: 'box',
			'elk.spacing.nodeNode': 15,
		},
	},
};

// ================================================================
// Cytoscape 初期化
// ================================================================
let cy = null;
let currentMode = 'tree';
let activeFilters = { model: '', parent: '' };

function modelColor(model) {
	switch (model) {
		case 'opus':
		case 'opus-1m': return '#b388ff';
		case 'haiku':   return '#81c784';
		default:        return '#64b5f6';
	}
}

function initCytoscape(elements) {
	if (typeof cytoscape === 'undefined') {
		showFallback(elements);
		return;
	}

	document.getElementById('loading').style.display = 'block';

	// ELK拡張を登録（利用可能な場合）
	if (typeof cytoscapeElk !== 'undefined') {
		cytoscape.use(cytoscapeElk);
	}

	cy = cytoscape({
		container: document.getElementById('cy'),
		elements,
		style: buildStyle(),
		minZoom: 0.1,
		maxZoom: 3,
		wheelSensitivity: 0.3,
	});

	applyLayout(currentMode, () => {
		document.getElementById('loading').style.display = 'none';
	});

	// ツールチップ
	const tooltip = document.getElementById('tooltip');
	cy.on('mouseover', 'node', (evt) => {
		const node = evt.target;
		const data = node.data();
		if (!data || data.isCompound) return;
		const pos = evt.renderedPosition;
		tooltip.innerHTML =
			'<div class="tooltip-name">' + escHtml(data.label || data.id) + '</div>' +
			(data.role ? '<div class="tooltip-role">' + escHtml(data.role) + '</div>' : '') +
			(data.sessionId
				? '<div class="tooltip-session">' + data.sessionId.substring(0, 20) + '...</div>'
				: '');
		tooltip.style.left = (pos.x + 12) + 'px';
		tooltip.style.top  = (pos.y + 12) + 'px';
		tooltip.classList.add('visible');
	});
	cy.on('mouseout', 'node', () => {
		tooltip.classList.remove('visible');
	});

	// クリック — セッション操作
	cy.on('tap', 'node', (evt) => {
		const data = evt.target.data();
		if (data && data.sessionId) {
			vscode.postMessage({ type: 'openSession', sessionId: data.sessionId });
		}
	});
}

function buildStyle() {
	return [
		{
			selector: 'node',
			style: {
				'background-color': (ele) => modelColor(ele.data('model')),
				'background-opacity': 0.15,
				'border-color': (ele) => modelColor(ele.data('model')),
				'border-width': (ele) => ele.data('isLive') ? 2.5 : 1.5,
				'border-style': (ele) => ele.data('isDirector') ? 'solid' : 'solid',
				'border-opacity': 1,
				'label': 'data(label)',
				'text-valign': 'center',
				'text-halign': 'center',
				'color': 'var(--vscode-foreground, #cccccc)',
				'font-family': 'var(--vscode-font-family, monospace)',
				'font-size': '11px',
				'text-wrap': 'wrap',
				'text-max-width': '120px',
				'width': 130,
				'height': 36,
				'shape': 'roundrectangle',
				'padding': '6px',
			},
		},
		{
			selector: 'node[isDirector]',
			style: {
				'background-color': '#e27e4a',
				'background-opacity': 0.2,
				'border-color': '#e27e4a',
				'border-width': 2.5,
				'font-weight': 'bold',
				'font-size': '13px',
				'width': 160,
				'height': 44,
			},
		},
		{
			selector: 'node[isLive]',
			style: {
				'border-width': 2.5,
				'box-shadow': '0 0 6px 2px var(--live, #4ec94e)',
			},
		},
		{
			selector: 'edge',
			style: {
				'width': 1.5,
				'line-color': 'var(--vscode-editorIndentGuide-background, #555)',
				'target-arrow-color': 'var(--vscode-editorIndentGuide-background, #555)',
				'target-arrow-shape': 'triangle',
				'curve-style': 'bezier',
				'arrow-scale': 0.8,
			},
		},
		{
			selector: '.faded',
			style: {
				'opacity': 0.25,
			},
		},
	];
}

function applyLayout(mode, callback) {
	if (!cy) return;
	const config = LAYOUT_CONFIGS[mode] || LAYOUT_CONFIGS.tree;
	const layout = cy.layout(config);
	if (callback) {
		layout.on('layoutstop', callback);
	}
	layout.run();
}

function applyFilters() {
	if (!cy) return;
	const { model: mf, parent: pf } = activeFilters;

	cy.elements().removeClass('faded');

	if (!mf && !pf) return;

	cy.nodes().forEach(node => {
		const data = node.data();
		let keep = true;
		if (mf && data.model !== mf) keep = false;
		if (pf && data.parent !== pf && data.id !== pf) keep = false;
		if (!keep) node.addClass('faded');
	});

	cy.edges().forEach(edge => {
		const src = edge.source();
		const tgt = edge.target();
		if (src.hasClass('faded') || tgt.hasClass('faded')) {
			edge.addClass('faded');
		}
	});
}

// ================================================================
// フォールバック（Cytoscapeなし）
// ================================================================
function showFallback(elements) {
	document.getElementById('cy-container').style.display = 'none';
	const fb = document.getElementById('fallback');
	fb.style.display = 'block';

	const nodes = elements.filter(e => !e.data.source);
	let html = '<h2 style="font-size:13px; margin-bottom:8px;">エージェント一覧（Cytoscapeロード失敗）</h2>';
	html += nodes.map(n =>
		'<div style="padding:4px 0; border-bottom:1px solid var(--border);">' +
		'<strong>' + escHtml(n.data.label || n.data.id) + '</strong>' +
		(n.data.role ? ' <span style="color:var(--text-dim); font-size:10px;">— ' + escHtml(n.data.role) + '</span>' : '') +
		'</div>'
	).join('');
	fb.innerHTML = html;
}

// ================================================================
// UI イベント
// ================================================================

// T2.19: モード切替
document.querySelectorAll('.mode-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		const mode = btn.dataset.mode;
		currentMode = mode;
		document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
		btn.classList.add('active');
		document.getElementById('loading').style.display = 'block';
		applyLayout(mode, () => {
			document.getElementById('loading').style.display = 'none';
		});
	});
});

// T2.20: フィルタ
document.getElementById('filter-model').addEventListener('change', (e) => {
	activeFilters.model = e.target.value;
	applyFilters();
});
document.getElementById('filter-parent').addEventListener('change', (e) => {
	activeFilters.parent = e.target.value;
	applyFilters();
});

// T2.20: PNG エクスポート
document.getElementById('btn-export-png').addEventListener('click', () => {
	if (!cy) return;
	const png64 = cy.png({ scale: 2, full: true, bg: 'transparent' });
	const link = document.createElement('a');
	link.href = png64;
	link.download = 'org-chart.png';
	link.click();
});

// T2.20: SVG エクスポート（cytoscape-svg がなければ canvas→SVG変換）
document.getElementById('btn-export-svg').addEventListener('click', () => {
	if (!cy) return;
	// Cytoscapeには cy.svg() が標準では無いため PNG を SVG foreignObject でラップ
	const png64 = cy.png({ scale: 2, full: true, bg: 'transparent' });
	const bbox = cy.elements().boundingBox();
	const w = Math.ceil(bbox.w * 2) || 800;
	const h = Math.ceil(bbox.h * 2) || 600;
	const svgStr = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"',
		'     width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">',
		'  <image href="' + png64 + '" x="0" y="0" width="' + w + '" height="' + h + '"/>',
		'</svg>',
	].join('\\n');
	const blob = new Blob([svgStr], { type: 'image/svg+xml' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'org-chart.svg';
	link.click();
	URL.revokeObjectURL(url);
});

// ================================================================
// ユーティリティ
// ================================================================
function escHtml(str) {
	if (!str) return '';
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ================================================================
// 初期化
// ================================================================
initCytoscape(ELEMENTS);

</script>
</body>
</html>`;
}

// -------------------------------------------------------------------
// Cytoscape エレメント生成
// -------------------------------------------------------------------

function buildCytoscapeElements(
	agents: AgentInfo[],
	liveIds: Set<string>
): CytoscapeElement[] {
	const elements: CytoscapeElement[] = [];
	const validAgents = agents.filter(a => shouldShowInOrgChart(a));
	const agentNames = new Set(validAgents.map(a => a.name));

	for (const a of validAgents) {
		const isLive = a.sessionId ? liveIds.has(a.sessionId) : false;
		const isDirector = a.name === 'director';

		elements.push({
			data: {
				id: a.name,
				label: a.displayName || a.name,
				model: a.model,
				role: a.role || '',
				sessionId: a.sessionId || '',
				parent: (a.parentAgent && agentNames.has(a.parentAgent)) ? a.parentAgent : undefined,
				isLive: isLive || undefined,
				isDirector: isDirector || undefined,
			},
		});
	}

	// エッジ: parentAgent → 子
	for (const a of validAgents) {
		if (a.parentAgent && agentNames.has(a.parentAgent)) {
			elements.push({
				data: {
					id: `${a.parentAgent}-->${a.name}`,
					source: a.parentAgent,
					target: a.name,
				},
			});
		}
	}

	return elements;
}

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

interface CytoscapeElement {
	data: {
		id: string;
		label?: string;
		model?: string;
		role?: string;
		sessionId?: string;
		parent?: string;
		isLive?: true;
		isDirector?: true;
		source?: string;
		target?: string;
	};
}

// -------------------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------------------

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
