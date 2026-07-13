/**
 * orgChartPanel.ts — v0.5.23 組織図リデザイン
 *
 * 全面刷新（オーナー承認モック `docs/mockups/orgchart-redesign-mock.html` の makeSim を移植・発展）:
 * - **メイン**: Obsidian 風力学グラフ（自前 Canvas 力学エンジン）— ダーク固定
 * - **サブ**: 階層 / グループ（カードベース、VS Code テーマ追従）
 * - Cytoscape / ELK 依存を全撤去。関係/グループの「真っ暗バグ」も実装ごと消滅。
 *
 * 責務分離:
 * - 力計算・隣接・グルーピングの純ロジック → `utils/orgChartEngine.ts`
 * - /csm-ask-agent の連携ログ集計 → `utils/collabLog.ts`
 * - 本ファイルは "vscode WebView への配線と HTML/JS 生成" のみ。
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AgentInfo, getAgents, enrichAgentsWithSessions } from '../agents/agentManager';
import { ParsedSession } from '../models/types';
import { shouldShowInOrgChart } from '../utils/agentUtils';
import { isContainedIn } from '../utils/pathUtils';
import { readCollabLog, aggregateCollabLog, CollabEdge } from '../utils/collabLog';
import { MODEL_CATALOG, CsmModel } from '../models/modelCatalog';

// -------------------------------------------------------------------
// 状態管理
// -------------------------------------------------------------------

let orgPanel: vscode.WebviewPanel | undefined;

let onOpenSession: ((sessionId: string) => void) | undefined;
let onOpenInClaude: ((sessionId: string) => void) | undefined;

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/** 組織図パネルを開く（v0.5.23 Canvas 版） */
export async function showOrgChart(
	getSessions: () => ParsedSession[],
	isLive: (id: string) => boolean,
	openSession?: (sessionId: string) => void,
	openInClaude?: (sessionId: string) => void,
	_extensionUri?: vscode.Uri, // v0.5.23: 未使用（Cytoscape 撤去のため）
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

	if (!orgPanel) {
		orgPanel = vscode.window.createWebviewPanel(
			'claudeOrgChart',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		orgPanel.onDidDispose(() => { orgPanel = undefined; });
		orgPanel.webview.onDidReceiveMessage((message) => {
			void handleOrgChartMessage(message);
		});
	}

	// 連携ログ集計（初期表示分。オンデマンドで再取得もできる）
	const collabEdges = aggregateCollabLog(await readCollabLog(), Date.now());

	// ワークスペース群
	const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

	// 設定
	const cfg = vscode.workspace.getConfiguration('claudeManager');
	const defaultMode = cfg.get<'graph' | 'tree' | 'group'>('orgChart.defaultMode', 'graph');
	const hideOtherProjects = cfg.get<boolean>('orgChart.hideOtherProjects', false);

	const html = buildOrgChartHtml({
		agents: enriched,
		liveIds,
		wsFolders,
		collabEdges,
		nonce,
		defaultMode,
		hideOtherProjects,
	});
	orgPanel.webview.html = html;
	orgPanel.reveal(vscode.ViewColumn.One);
}

/** ミニ組織図データ（プロジェクト詳細用）— 従来 API 温存 */
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

async function handleOrgChartMessage(message: Record<string, unknown>): Promise<void> {
	const type = message.type;
	if (type === 'copyId') {
		await vscode.env.clipboard.writeText(String(message.id));
		vscode.window.showInformationMessage(`コピー: ${message.id}`);
	} else if (type === 'openSession' && onOpenSession) {
		onOpenSession(String(message.sessionId));
	} else if (type === 'openInClaude' && onOpenInClaude) {
		onOpenInClaude(String(message.sessionId));
	} else if (type === 'refreshCollab' && orgPanel) {
		// 連携トグル ON 時のオンデマンド再集計
		const edges = aggregateCollabLog(await readCollabLog(), Date.now());
		orgPanel.webview.postMessage({ type: 'collabData', edges });
	} else if (type === 'setHideOtherProjects') {
		// v0.5.23 レビュー修正: 「他プロジェクトを隠す」トグルを Global 設定に永続化。
		// ドキュメント（CHANGELOG/README/step5）が「設定 orgChart.hideOtherProjects で永続化」と明記しているため、
		// UI 操作を必ず vscode 設定に反映して整合を取る。
		try {
			await vscode.workspace
				.getConfiguration('claudeManager')
				.update('orgChart.hideOtherProjects', Boolean(message.value), vscode.ConfigurationTarget.Global);
		} catch { /* 書き込み失敗はサイレント（次回起動時に既定に戻るのみ） */ }
	} else if (type === 'setDefaultMode') {
		// v0.5.23 レビュー修正: モードセグメントの選択を既定モード設定に永続化。
		// これにより次回パネル起動時にユーザーが最後に選んだモードで開ける。
		const v = String(message.value);
		if (v === 'graph' || v === 'tree' || v === 'group') {
			try {
				await vscode.workspace
					.getConfiguration('claudeManager')
					.update('orgChart.defaultMode', v, vscode.ConfigurationTarget.Global);
			} catch { /* 書き込み失敗はサイレント */ }
		}
	}
}

// -------------------------------------------------------------------
// HTML 生成
// -------------------------------------------------------------------

interface BuildArgs {
	agents: AgentInfo[];
	liveIds: Set<string>;
	wsFolders: string[];
	collabEdges: CollabEdge[];
	nonce: string;
	defaultMode: 'graph' | 'tree' | 'group';
	hideOtherProjects: boolean;
}

interface OrgNodeData {
	id: string;
	label: string;
	model: string;
	live: boolean;
	parent: string | null;
	sessionId: string;
	role: string;
	workDir: string;
	inWorkspace: boolean;
	color: string;
}

/** エージェント → クライアント側描画用データに変換 */
function toOrgNodeData(agents: AgentInfo[], liveIds: Set<string>, wsFolders: string[]): OrgNodeData[] {
	const knownNames = new Set(agents.map((a) => a.name));
	return agents.map((a) => {
		const live = !!(a.sessionId && liveIds.has(a.sessionId));
		// workDir 未設定 → 全プロジェクト共通とみなし常に inWorkspace=true
		const inWorkspace = a.workDir
			? wsFolders.some((ws) => isContainedIn(a.workDir!, ws) || isContainedIn(ws, a.workDir!))
			: true;
		const mdef = MODEL_CATALOG[a.model as CsmModel];
		return {
			id: a.name,
			label: a.displayName || a.name,
			model: a.model,
			live,
			// 親不明な参照は null に落として orphan として扱う（力計算が破綻しないよう）
			parent: a.parentAgent && knownNames.has(a.parentAgent) ? a.parentAgent : null,
			sessionId: a.sessionId || '',
			role: a.displayRole || a.role || '',
			workDir: a.workDir || '',
			inWorkspace,
			color: mdef?.colorHex || '#9aa0b2',
		};
	});
}

function buildOrgChartHtml(args: BuildArgs): string {
	const { agents, liveIds, wsFolders, collabEdges, nonce, defaultMode, hideOtherProjects } = args;
	const nodes = toOrgNodeData(agents, liveIds, wsFolders);
	const nodesJson = JSON.stringify(nodes);
	const collabJson = JSON.stringify(collabEdges);
	const modelColorsJson = JSON.stringify(
		Object.fromEntries(Object.entries(MODEL_CATALOG).map(([k, v]) => [k, v.colorHex]))
	);

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:; font-src data:;">
<style nonce="${nonce}">
:root {
	--bg: var(--vscode-editor-background);
	--panel: var(--vscode-sideBar-background);
	--surface: var(--vscode-textBlockQuote-background);
	--border: var(--vscode-panel-border);
	--text: var(--vscode-foreground);
	--text-dim: var(--vscode-descriptionForeground);
	--accent: var(--vscode-charts-orange, #e27e4a);
	--accent-fg: var(--vscode-button-foreground, #fff);
	--live: var(--vscode-charts-green, #4ec94e);
	--fable: #e8b84b;
	--opus: #b388ff;
	--sonnet: #64b5f6;
	--haiku: #81c784;
	--collab: #e8b84b;
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
	background: var(--panel);
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
.toolbar-label { font-size: 11px; color: var(--text-dim); }
.mode-seg {
	display: inline-flex;
	border: 1px solid var(--border);
	border-radius: 4px;
	overflow: hidden;
}
.mode-seg button {
	padding: 3px 12px; font-size: 11px; background: transparent; border: none;
	color: var(--text); cursor: pointer; font-family: inherit; border-right: 1px solid var(--border);
}
.mode-seg button:last-child { border-right: none; }
.mode-seg button.active { background: var(--accent); color: var(--accent-fg); }
.mtool {
	padding: 3px 10px; font-size: 11px; background: transparent;
	border: 1px solid var(--border); border-radius: 3px; color: var(--text);
	cursor: pointer; font-family: inherit;
}
.mtool:hover { background: var(--vscode-list-hoverBackground); }
.mtool.active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
input.search-box {
	background: var(--vscode-input-background); color: var(--vscode-input-foreground);
	border: 1px solid var(--border); border-radius: 3px; padding: 3px 8px; font-size: 11px;
	max-width: 180px; font-family: inherit;
}
input.search-box:focus { outline: none; border-color: var(--vscode-focusBorder); }

/* 凡例チップ */
.legend {
	display: flex; gap: 6px; flex-wrap: wrap;
}
.legend-chip {
	display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; font-size: 10.5px;
	background: transparent; border: 1px solid var(--border); border-radius: 10px;
	color: var(--text); cursor: pointer; font-family: inherit;
}
.legend-chip:hover { background: var(--vscode-list-hoverBackground); }
.legend-chip.active {
	border-color: var(--accent); background: var(--vscode-list-activeSelectionBackground);
}
.legend-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* ---- ステージ共通 ---- */
#stage-wrap { flex: 1; overflow: hidden; position: relative; }
.pane { display: none; height: 100%; overflow: hidden; }
.pane.on { display: block; }

/* ---- グラフ（ダーク固定） ---- */
#pane-graph {
	background: #17181d;
}
canvas.graph { display: block; width: 100%; height: 100%; cursor: grab; }
canvas.graph.drag { cursor: grabbing; }
.hint-overlay {
	position: absolute; top: 12px; right: 12px; padding: 6px 10px; font-size: 11px;
	background: rgba(24,25,32,.85); border: 1px solid #383c4a; color: #c9cdd9;
	border-radius: 6px; z-index: 3; max-width: 260px; pointer-events: none;
}
/* v0.5.25: ズーム倍率バッジ（右下） */
.zoom-badge {
	position: absolute; right: 12px; bottom: 12px; padding: 3px 8px; font-size: 11px;
	background: rgba(24,25,32,.7); border: 1px solid #383c4a; color: #c9cdd9;
	border-radius: 10px; z-index: 3; pointer-events: none; font-family: ui-monospace, Consolas, monospace;
}
canvas.graph.pan { cursor: move; }

/* ---- 階層（カード階層、テーマ追従） ---- */
#pane-tree { overflow: auto; background: var(--bg); padding: 20px; }
.tree { min-width: min-content; }
.tier { display: flex; justify-content: center; gap: 14px; flex-wrap: nowrap; }
.tcol { display: flex; flex-direction: column; align-items: center; gap: 0; }
.card {
	background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
	padding: 8px 12px; min-width: 150px; position: relative; cursor: pointer;
	transition: transform .12s, border-color .12s;
}
.card:hover { transform: translateY(-2px); border-color: var(--accent); }
.card.dimmed { opacity: 0.35; }
.card.hidden { display: none; }
.card .nm { font-weight: 600; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.card .rl { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
.card .foot { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
.mchip { font-size: 10px; font-weight: 700; border-radius: 4px; padding: 1px 6px; letter-spacing: .05em; }
.m-fable  { background: rgba(232,184,75,.16);  color: var(--fable);  border: 1px solid rgba(232,184,75,.35); }
.m-opus   { background: rgba(179,136,255,.14); color: var(--opus);   border: 1px solid rgba(179,136,255,.32); }
.m-sonnet { background: rgba(100,181,246,.14); color: var(--sonnet); border: 1px solid rgba(100,181,246,.32); }
.m-haiku  { background: rgba(129,199,132,.14); color: var(--haiku);  border: 1px solid rgba(129,199,132,.32); }
.pulse {
	width: 8px; height: 8px; border-radius: 50%; background: var(--live);
	box-shadow: 0 0 0 0 rgba(63,174,106,.55); animation: pw 1.8s infinite;
}
.idle-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); opacity: 0.5; }
.ecount { font-size: 10px; color: var(--text-dim); margin-left: auto; font-family: ui-monospace, Consolas, monospace; }
.vline { width: 1px; height: 20px; background: var(--border); }
.subtree { display: flex; gap: 10px; margin-top: 20px; flex-wrap: nowrap; }
@keyframes pw {
	0% { box-shadow: 0 0 0 0 rgba(63,174,106,.5); }
	70% { box-shadow: 0 0 0 9px rgba(63,174,106,0); }
	100% { box-shadow: 0 0 0 0 rgba(63,174,106,0); }
}
@media (prefers-reduced-motion: reduce) {
	.pulse { animation: none; }
	.card { transition: none; }
}

/* ---- グループ（軸切替、テーマ追従） ---- */
#pane-group { overflow: auto; background: var(--bg); padding: 12px; }
.gaxis { display: flex; gap: 6px; margin-bottom: 10px; }
.gclusters { display: flex; flex-wrap: wrap; gap: 12px; }
.gc {
	background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
	padding: 10px 14px; min-width: 200px; flex: 1;
}
.gc h4 {
	margin: 0 0 8px; font-size: 12px; letter-spacing: .06em; font-weight: 700;
	color: var(--text-dim); display: flex; gap: 6px; align-items: center;
}
.gc h4 .cnt { margin-left: auto; font-family: ui-monospace, Consolas, monospace; opacity: 0.7; font-weight: 400; }
.gmember {
	display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px;
	font-size: 12px; cursor: pointer;
}
.gmember:hover { background: var(--vscode-list-hoverBackground); }
.gmember.dimmed { opacity: 0.35; }
.gmember.hidden { display: none; }
.gm-ch { font-size: 10px; font-weight: 700; width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; }

/* 空状態 */
.empty-hint {
	padding: 40px 20px; text-align: center; color: var(--text-dim); font-size: 13px;
}
</style>
</head>
<body>
<div id="toolbar">
	<h1>組織図</h1>
	<div class="mode-seg" role="tablist">
		<button data-mode="graph" class="${defaultMode === 'graph' ? 'active' : ''}">グラフ</button>
		<button data-mode="tree"  class="${defaultMode === 'tree'  ? 'active' : ''}">階層</button>
		<button data-mode="group" class="${defaultMode === 'group' ? 'active' : ''}">グループ</button>
	</div>

	<div class="toolbar-group">
		<input type="search" id="org-search" class="search-box" placeholder="🔎 名前・役割で検索" aria-label="組織図ノード検索">
	</div>

	<div class="toolbar-group" id="legend-chips" role="group" aria-label="凡例フィルタ">
		<button class="legend-chip" data-chip-type="model" data-chip-value="fable" title="Fable モデルのみハイライト">
			<span class="legend-dot" style="background:var(--fable);"></span>Fable
		</button>
		<button class="legend-chip" data-chip-type="model" data-chip-value="opus" title="Opus モデルのみハイライト">
			<span class="legend-dot" style="background:var(--opus);"></span>Opus
		</button>
		<button class="legend-chip" data-chip-type="model" data-chip-value="sonnet" title="Sonnet モデルのみハイライト">
			<span class="legend-dot" style="background:var(--sonnet);"></span>Sonnet
		</button>
		<button class="legend-chip" data-chip-type="model" data-chip-value="haiku" title="Haiku モデルのみハイライト">
			<span class="legend-dot" style="background:var(--haiku);"></span>Haiku
		</button>
		<button class="legend-chip" data-chip-type="status" data-chip-value="live" title="稼働中のみハイライト">
			<span class="legend-dot" style="background:var(--live);"></span>稼働中
		</button>
	</div>

	<div class="toolbar-group" style="margin-left:auto;">
		<button class="mtool" id="btn-collab" title="/csm-ask-agent の直近 7 日の送信を金色点線で重ね描き">連携</button>
		<button class="mtool ${hideOtherProjects ? 'active' : ''}" id="btn-hide-other" title="現ワークスペース外のエージェントを非表示">他プロジェクトを隠す</button>
	</div>

	<!-- v0.5.25: グラフモード専用のズームコントロール（他モードでは無効） -->
	<div class="toolbar-group" id="zoom-controls" title="ズーム / パン（グラフモードのみ）">
		<button class="mtool" id="btn-zoom-out" title="縮小">−</button>
		<button class="mtool" id="btn-zoom-in"  title="拡大">＋</button>
		<button class="mtool" id="btn-zoom-fit" title="全体をフィット表示（ダブルクリックでも可）">⤢</button>
	</div>
</div>

<div id="stage-wrap">
	<!-- グラフモード -->
	<div class="pane ${defaultMode === 'graph' ? 'on' : ''}" id="pane-graph" role="tabpanel">
		<div class="hint-overlay" id="collab-hint" style="display:none;"></div>
		<div class="zoom-badge" id="zoom-badge">100%</div>
		<canvas id="graph-cv" class="graph"></canvas>
	</div>

	<!-- 階層モード -->
	<div class="pane ${defaultMode === 'tree' ? 'on' : ''}" id="pane-tree" role="tabpanel">
		<div class="tree" id="tree-root"></div>
	</div>

	<!-- グループモード -->
	<div class="pane ${defaultMode === 'group' ? 'on' : ''}" id="pane-group" role="tabpanel">
		<div class="gaxis">
			<button class="mtool active" data-ax="dept">部署別</button>
			<button class="mtool" data-ax="model">モデル別</button>
			<button class="mtool" data-ax="status">稼働状態別</button>
		</div>
		<div class="gclusters" id="gclusters"></div>
	</div>
</div>

<script nonce="${nonce}">
"use strict";
const vscode = acquireVsCodeApi();
const NODES = ${nodesJson};
const MODEL_COLORS = ${modelColorsJson};
let COLLAB = ${collabJson}; // [{ from, to, count, latestTs }]

// ────────────────────────── ユーティリティ ──────────────────────────
const byId = Object.fromEntries(NODES.map(n => [n.id, n]));
const CHILD_COUNT = {};
NODES.forEach(n => { if (n.parent && byId[n.parent]) { CHILD_COUNT[n.parent] = (CHILD_COUNT[n.parent] || 0) + 1; } });

function modelClass(m) {
	if (m === 'fable' || m === 'fable-1m') return 'm-fable';
	if (m === 'opus'  || m === 'opus-1m')  return 'm-opus';
	if (m === 'haiku') return 'm-haiku';
	return 'm-sonnet';
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// hideOtherProjects の反映
let HIDE_OTHER = ${hideOtherProjects};
function isVisible(node) {
	if (HIDE_OTHER && !node.inWorkspace) return false;
	return true;
}

// 検索 / 凡例フィルタの状態
let searchQ = '';
let chipFilter = null; // { type: 'model'|'status', value: string } | null
let collabOn = false;

// マッチ判定
function matchesSearch(n) {
	if (!searchQ) return true;
	const q = searchQ.toLowerCase();
	return String(n.label || '').toLowerCase().includes(q)
		|| String(n.id || '').toLowerCase().includes(q)
		|| String(n.role || '').toLowerCase().includes(q);
}
function matchesChip(n) {
	if (!chipFilter) return true;
	if (chipFilter.type === 'model') return String(n.model || '').toLowerCase().includes(chipFilter.value);
	if (chipFilter.type === 'status') return chipFilter.value === 'live' ? !!n.live : true;
	return true;
}

// ────────────────────────── 力学グラフ ──────────────────────────
// 実装はモック makeSim を移植。純ロジックは utils/orgChartEngine と等価。
const cv = document.getElementById('graph-cv');
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, hover = null, drag = null, alpha = 1, raf = null, seeded = false;
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ────────────────────────── v0.5.25: ビューポート（zoom/pan） ──────────────────────────
// 実装は utils/orgChartEngine の zoomAt / screenToWorld / fitToView と等価。
// マウス座標は全て screenToWorld で必ずワールド座標へ変換してからノード判定に使う。
const ZOOM_MIN = 0.2, ZOOM_MAX = 4.0;
let viewport = { zoom: 1, panX: 0, panY: 0 };
let panDrag = null; // 背景パン中の状態: { startSx, startSy, startPanX, startPanY }
function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }
function screenToWorld(sx, sy) {
	return { x: (sx - viewport.panX) / viewport.zoom, y: (sy - viewport.panY) / viewport.zoom };
}
function zoomAtScreen(sx, sy, factor) {
	const nz = clampZoom(viewport.zoom * factor);
	if (nz === viewport.zoom) return;
	const w = screenToWorld(sx, sy);
	viewport = { zoom: nz, panX: sx - w.x * nz, panY: sy - w.y * nz };
	updateZoomBadge();
}
function updateZoomBadge() {
	const b = document.getElementById('zoom-badge');
	if (b) b.textContent = Math.round(viewport.zoom * 100) + '%';
}
function fitToView(padding) {
	padding = padding || 40;
	const visible = gnodes.filter(isVisible);
	if (visible.length === 0 || W <= 0 || H <= 0) {
		viewport = { zoom: 1, panX: 0, panY: 0 };
		updateZoomBadge();
		return;
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const n of visible) {
		if (n.x - n.r < minX) minX = n.x - n.r;
		if (n.y - n.r < minY) minY = n.y - n.r;
		if (n.x + n.r > maxX) maxX = n.x + n.r;
		if (n.y + n.r > maxY) maxY = n.y + n.r;
	}
	const bboxW = Math.max(1, maxX - minX);
	const bboxH = Math.max(1, maxY - minY);
	const availW = Math.max(1, W - padding * 2);
	const availH = Math.max(1, H - padding * 2);
	const z = clampZoom(Math.min(availW / bboxW, availH / bboxH));
	const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
	viewport = { zoom: z, panX: W / 2 - cx * z, panY: H / 2 - cy * z };
	updateZoomBadge();
}

// 描画ノード群（力学は同じ配列を in-place で更新）
const gnodes = NODES.map(n => ({
	...n,
	x: 0, y: 0, vx: 0, vy: 0,
	r: 7 + (CHILD_COUNT[n.id] || 0) * 2.2 + (n.live ? 2 : 0) + (n.id === 'director' ? 4 : 0),
}));
const gById = Object.fromEntries(gnodes.map(n => [n.id, n]));
// エッジ: 親子のみ（連携は collabOn で動的追加）
const baseEdges = gnodes.filter(n => n.parent && gById[n.parent])
	.map(n => ({ s: gById[n.parent], t: n, kind: 'cmd', w: 1 }));

function resizeCanvas() {
	const rect = cv.getBoundingClientRect();
	DPR = window.devicePixelRatio || 1;
	W = rect.width; H = rect.height;
	cv.width = W * DPR; cv.height = H * DPR;
	// v0.5.25: base transform は draw() 内で毎フレーム viewport を反映して再設定する。
	ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
function seedPositions() {
	gnodes.forEach((n, i) => {
		const ang = i / gnodes.length * Math.PI * 2;
		const rad = n.parent === null ? 0 : (n.parent === 'director' ? 120 : 210);
		n.x = W / 2 + Math.cos(ang) * rad + (Math.random() - 0.5) * 30;
		n.y = H / 2 + Math.sin(ang) * rad + (Math.random() - 0.5) * 30;
	});
	seeded = true;
}

function currentEdges() {
	// 連携 ON なら base + collab を返す
	if (!collabOn) return baseEdges;
	const extra = [];
	for (const e of COLLAB) {
		const s = gById[e.from];
		const t = gById[e.to];
		if (!s || !t) continue;
		extra.push({ s, t, kind: 'collab', w: e.count });
	}
	return baseEdges.concat(extra);
}

function step(edges) {
	if (REDUCED && seeded) { alpha = 0; return; } // reduced-motion: 位置固定
	for (let i = 0; i < gnodes.length; i++) {
		for (let j = i + 1; j < gnodes.length; j++) {
			const a = gnodes[i], b = gnodes[j];
			let dx = b.x - a.x, dy = b.y - a.y;
			const d2 = dx * dx + dy * dy || 1; const d = Math.sqrt(d2);
			const f = Math.min(2200 / d2, 4);
			dx /= d; dy /= d;
			a.vx -= dx * f; a.vy -= dy * f;
			b.vx += dx * f; b.vy += dy * f;
		}
	}
	for (const e of edges) {
		const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
		const d = Math.sqrt(dx * dx + dy * dy) || 1;
		const ideal = e.kind === 'cmd' ? 110 : 150;
		const f = (d - ideal) * 0.004;
		e.s.vx += dx / d * f; e.s.vy += dy / d * f;
		e.t.vx -= dx / d * f; e.t.vy -= dy / d * f;
	}
	for (const n of gnodes) {
		n.vx += (W / 2 - n.x) * 0.0012; n.vy += (H / 2 - n.y) * 0.0012;
		if (drag === n) { n.vx = 0; n.vy = 0; continue; }
		n.vx *= 0.86; n.vy *= 0.86;
		n.x += n.vx * alpha * 2; n.y += n.vy * alpha * 2;
		n.x = Math.max(30, Math.min(W - 30, n.x));
		n.y = Math.max(30, Math.min(H - 30, n.y));
	}
	alpha = Math.max(alpha * 0.995, 0.25);
}

function neighborsOf(n, edges) {
	const s = new Set([n.id]);
	for (const e of edges) {
		if (e.s.id === n.id) s.add(e.t.id);
		if (e.t.id === n.id) s.add(e.s.id);
	}
	return s;
}

function draw(ts, edges) {
	// v0.5.25: 背景はスクリーン座標で（zoom の影響を受けない宇宙感）→ その後ワールド座標系へ切替
	ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
	ctx.clearRect(0, 0, W, H);
	const g = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, Math.max(W, H) / 1.2);
	g.addColorStop(0, '#191b24'); g.addColorStop(1, '#111218');
	ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

	// v0.5.25: ワールド座標系（zoom * pan 適用）に切替 — 以降のノード/エッジ/ラベルはワールド座標のまま描画
	ctx.setTransform(DPR * viewport.zoom, 0, 0, DPR * viewport.zoom, DPR * viewport.panX, DPR * viewport.panY);

	const hi = hover ? neighborsOf(hover, edges) : null;

	// エッジ
	for (const e of edges) {
		if (!isVisible(e.s) || !isVisible(e.t)) continue;
		const dim = hi && !(hi.has(e.s.id) && hi.has(e.t.id));
		ctx.globalAlpha = dim ? 0.06 : (e.kind === 'cmd' ? 0.35 : 0.8);
		ctx.beginPath();
		ctx.moveTo(e.s.x, e.s.y); ctx.lineTo(e.t.x, e.t.y);
		if (e.kind === 'collab') {
			ctx.setLineDash([5, 4]);
			ctx.strokeStyle = 'var(--collab)';
			ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--collab') || '#e8b84b';
			ctx.lineWidth = Math.min(1 + (e.w || 1) * 0.7, 5);
		} else {
			ctx.setLineDash([]);
			ctx.strokeStyle = '#6b7185';
			ctx.lineWidth = 1.1;
		}
		ctx.stroke(); ctx.setLineDash([]);
	}

	// ノード
	for (const n of gnodes) {
		if (!isVisible(n)) continue;
		// ワークスペース外は既定で減光
		const outOfWs = !n.inWorkspace;
		// マッチ/隣接に基づく減光
		const dimByHover = hi && !hi.has(n.id);
		const dimByFilter = (searchQ && !matchesSearch(n)) || (chipFilter && !matchesChip(n));
		const dim = dimByHover || dimByFilter || outOfWs;
		ctx.globalAlpha = dim ? (outOfWs ? 0.25 : 0.12) : 1;
		const col = n.color;
		if (n.live && !dim) {
			const p = (Math.sin(ts / 600 + n.x) + 1) / 2;
			ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 5 + p * 4, 0, Math.PI * 2);
			ctx.fillStyle = col + '22'; ctx.fill();
		}
		ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
		ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = dim ? 0 : 12;
		ctx.fill(); ctx.shadowBlur = 0;
		if (n.live) {
			ctx.beginPath(); ctx.arc(n.x + n.r * 0.72, n.y - n.r * 0.72, 3, 0, Math.PI * 2);
			ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--live') || '#3fae6a';
			ctx.fill();
		}
		ctx.globalAlpha = dim ? 0.1 : 0.92;
		ctx.fillStyle = '#dfe3ee';
		// v0.5.25: ラベルの実サイズがズーム倍率に反比例して過大/過小にならないよう補正
		//   9〜18px の範囲で見た目のフォント高を安定させる。
		const targetPx = Math.max(9, Math.min(18, 11.5));
		const fontPx = targetPx / viewport.zoom;
		ctx.font = fontPx + 'px "Hiragino Kaku Gothic ProN","Yu Gothic UI",sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText(n.label, n.x, n.y + n.r + 15 / viewport.zoom);
	}
	ctx.globalAlpha = 1;
}

function loop(ts) {
	const edges = currentEdges();
	step(edges); draw(ts, edges);
	raf = requestAnimationFrame(loop);
}

// v0.5.25: 命中判定はワールド座標で行う（マウスは screenToWorld で必ず変換してから使う）。
function pickNode(worldX, worldY) {
	return gnodes.find(n => {
		if (!isVisible(n)) return false;
		const dx = n.x - worldX, dy = n.y - worldY;
		// クリック許容半径もワールド単位（6px 相当を zoom で補正）
		const tol = 6 / viewport.zoom;
		return dx * dx + dy * dy < (n.r + tol) * (n.r + tol);
	});
}

function kickGraph() {
	resizeCanvas();
	if (!seeded) {
		seedPositions();
		// v0.5.25: 初期表示は全体フィット（多数エージェント時のカオス対策）
		// simulateStep で位置が安定する前にフィットすると崩れるので、後続の loop で 1 度だけフィット呼び直し。
		requestAnimationFrame(() => { fitToView(); });
	}
	alpha = 1;
	if (!raf) requestAnimationFrame(loop);
}
function stopGraph() {
	if (raf) { cancelAnimationFrame(raf); raf = null; }
}

// マウスイベント: 全て screenToWorld で世界座標へ変換してから使用（ズーム時のずれ防止）
cv.addEventListener('mousemove', (ev) => {
	const r = cv.getBoundingClientRect();
	const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
	// 背景パン中: pan を更新（マウス移動量 / zoom を pan に加算 … と考えがちだが
	//   スクリーン移動量 = pan の増分そのものなので / zoom 不要）
	if (panDrag) {
		viewport = {
			zoom: viewport.zoom,
			panX: panDrag.startPanX + (sx - panDrag.startSx),
			panY: panDrag.startPanY + (sy - panDrag.startSy),
		};
		return;
	}
	const w = screenToWorld(sx, sy);
	if (drag) { drag.x = w.x; drag.y = w.y; alpha = Math.max(alpha, 0.6); return; }
	hover = pickNode(w.x, w.y);
	cv.style.cursor = hover ? 'pointer' : 'grab';
});
cv.addEventListener('mousedown', (ev) => {
	if (ev.button !== 0) { return; } // 左クリックのみ
	const r = cv.getBoundingClientRect();
	const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
	const w = screenToWorld(sx, sy);
	const hit = pickNode(w.x, w.y);
	if (hit) {
		// ノード命中 → ノードドラッグ
		drag = hit;
		cv.classList.add('drag');
	} else {
		// 背景ヒット → パン開始
		panDrag = { startSx: sx, startSy: sy, startPanX: viewport.panX, startPanY: viewport.panY };
		cv.classList.add('pan');
	}
});
window.addEventListener('mouseup', () => {
	drag = null; panDrag = null;
	cv.classList.remove('drag'); cv.classList.remove('pan');
});
cv.addEventListener('mouseleave', () => { hover = null; });
cv.addEventListener('click', (ev) => {
	if (drag || panDrag) return; // ドラッグ/パン中はクリックしない
	const r = cv.getBoundingClientRect();
	const w = screenToWorld(ev.clientX - r.left, ev.clientY - r.top);
	const n = pickNode(w.x, w.y);
	if (n) handleNodeClick(n);
});
// v0.5.25: ダブルクリックで全体フィット（判断: 一般的なグラフエディタ慣習に合わせる）
cv.addEventListener('dblclick', (ev) => {
	ev.preventDefault();
	fitToView();
});
// v0.5.25: ホイールでカーソル位置ズーム（判断: Miro / tldraw / Excalidraw の慣習に寄せる）
//   ctrlKey/metaKey は不要 — グラフモードは全画面 Canvas でスクロール概念が無く、ホイール=ズームが直感的。
//   トラックパッドのピンチは ctrlKey=true が付くが同じくズームになるので問題なし。
cv.addEventListener('wheel', (ev) => {
	ev.preventDefault();
	const r = cv.getBoundingClientRect();
	const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
	// deltaY 正 = 下スクロール = ズームアウト（自然な向き）
	const factor = ev.deltaY < 0 ? 1.1 : (1 / 1.1);
	zoomAtScreen(sx, sy, factor);
}, { passive: false });
window.addEventListener('resize', () => { resizeCanvas(); });

// ────────────────────────── 検索 → センタリング ──────────────────────────
// v0.5.25: ノード位置を動かすのではなく viewport を pan して該当ノードを中央に来るよう調整。
//   ついでに軽くズームイン（現在の zoom が 1 未満なら 1 に、それ以外は現状維持）。
function centerOn(id) {
	const n = gById[id]; if (!n) return;
	const targetZoom = Math.max(viewport.zoom, 1.0);
	viewport = {
		zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom)),
		panX: W / 2 - n.x * targetZoom,
		panY: H / 2 - n.y * targetZoom,
	};
	updateZoomBadge();
	alpha = 1;
}

// ────────────────────────── 階層モード（カード） ──────────────────────────
function renderTree() {
	const root = document.getElementById('tree-root');
	root.innerHTML = '';
	// ルート = parent === null
	const roots = NODES.filter(n => n.parent === null);
	if (roots.length === 0) {
		root.innerHTML = '<div class="empty-hint">エージェントが登録されていません</div>';
		return;
	}
	// 全階層を再帰的にレンダリング
	const tier = document.createElement('div'); tier.className = 'tier';
	root.appendChild(tier);
	for (const r of roots) tier.appendChild(renderCardCol(r));
	applyTreeFilter();
}

function renderCardCol(node) {
	const col = document.createElement('div'); col.className = 'tcol';
	col.appendChild(renderCard(node));
	const children = NODES.filter(n => n.parent === node.id);
	if (children.length > 0) {
		const vline = document.createElement('div'); vline.className = 'vline'; col.appendChild(vline);
		const sub = document.createElement('div'); sub.className = 'subtree';
		for (const c of children) sub.appendChild(renderCardCol(c));
		col.appendChild(sub);
	}
	return col;
}
function renderCard(node) {
	const card = document.createElement('div'); card.className = 'card';
	card.dataset.nodeId = node.id;
	const cc = CHILD_COUNT[node.id] || 0;
	const dot = node.live ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>';
	const chip = modelClass(node.model);
	card.innerHTML =
		'<div class="nm">' + dot + esc(node.label) + '</div>' +
		(node.role ? '<div class="rl">' + esc(node.role) + '</div>' : '') +
		'<div class="foot">' +
			'<span class="mchip ' + chip + '">' + esc(String(node.model || '').toUpperCase()) + '</span>' +
			(cc > 0 ? '<span class="ecount">部下 ' + cc + '</span>' : '') +
		'</div>';
	card.addEventListener('click', () => handleNodeClick(node));
	return card;
}
function applyTreeFilter() {
	document.querySelectorAll('#tree-root .card').forEach((el) => {
		const id = el.dataset.nodeId;
		const n = byId[id]; if (!n) return;
		const visible = isVisible(n) && matchesSearch(n) && matchesChip(n);
		el.classList.toggle('hidden', HIDE_OTHER && !n.inWorkspace);
		el.classList.toggle('dimmed', !visible && !(HIDE_OTHER && !n.inWorkspace));
	});
}

// ────────────────────────── グループモード ──────────────────────────
let groupAxis = 'dept';
function renderGroup() {
	const box = document.getElementById('gclusters');
	box.innerHTML = '';
	let clusters;
	if (groupAxis === 'dept') clusters = clustersByDept();
	else if (groupAxis === 'model') clusters = clustersByModel();
	else clusters = clustersByStatus();
	if (clusters.length === 0) {
		box.innerHTML = '<div class="empty-hint">エージェントが登録されていません</div>';
		return;
	}
	for (const c of clusters) {
		const gc = document.createElement('div'); gc.className = 'gc';
		const h = document.createElement('h4');
		h.innerHTML = esc(c.label) + '<span class="cnt">' + c.members.length + '</span>';
		gc.appendChild(h);
		for (const m of c.members) {
			const row = document.createElement('div'); row.className = 'gmember';
			row.dataset.nodeId = m.id;
			const dot = m.live ? '<span class="pulse"></span>' : '<span class="idle-dot"></span>';
			const chip = modelClass(m.model);
			row.innerHTML = dot + '<span>' + esc(m.label) + '</span>' +
				'<span class="gm-ch mchip ' + chip + '">' + esc((m.model || '').substring(0, 1).toUpperCase()) + '</span>';
			row.addEventListener('click', () => handleNodeClick(m));
			gc.appendChild(row);
		}
		box.appendChild(gc);
	}
	applyGroupFilter();
}
function clustersByDept() {
	// 最上位まで parent を辿ってグルーピング
	const map = new Map();
	for (const a of NODES) {
		let root = a.id;
		const seen = new Set([a.id]);
		let cur = a;
		while (cur && cur.parent && byId[cur.parent] && !seen.has(cur.parent)) {
			root = cur.parent; seen.add(cur.parent); cur = byId[cur.parent];
		}
		const key = root; const label = (byId[root] && byId[root].label) || root;
		if (!map.has(key)) map.set(key, { key, label, members: [] });
		map.get(key).members.push(a);
	}
	return [...map.values()].sort((a, b) => b.members.length - a.members.length);
}
function clustersByModel() {
	const map = new Map();
	for (const a of NODES) {
		const k = a.model || 'unknown';
		if (!map.has(k)) map.set(k, { key: k, label: k, members: [] });
		map.get(k).members.push(a);
	}
	const order = ['fable', 'fable-1m', 'opus', 'opus-1m', 'sonnet', 'sonnet-1m', 'haiku', 'unknown'];
	return [...map.keys()].sort((a, b) => {
		const ai = order.indexOf(a); const bi = order.indexOf(b);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	}).map(k => map.get(k));
}
function clustersByStatus() {
	const active = [], idle = [], unlinked = [];
	for (const a of NODES) {
		if (a.live) active.push(a);
		else if (a.sessionId) idle.push(a);
		else unlinked.push(a);
	}
	return [
		{ key: 'active',   label: '🟢 稼働中',  members: active },
		{ key: 'idle',     label: '⚪ 待機',    members: idle },
		{ key: 'unlinked', label: '🔗 未紐づけ', members: unlinked },
	].filter(g => g.members.length > 0);
}
function applyGroupFilter() {
	document.querySelectorAll('#gclusters .gmember').forEach((el) => {
		const id = el.dataset.nodeId;
		const n = byId[id]; if (!n) return;
		el.classList.toggle('hidden', HIDE_OTHER && !n.inWorkspace);
		const visible = isVisible(n) && matchesSearch(n) && matchesChip(n);
		el.classList.toggle('dimmed', !visible && !(HIDE_OTHER && !n.inWorkspace));
	});
}

// ────────────────────────── ノードクリック（既存動作維持） ──────────────────────────
function handleNodeClick(n) {
	if (n.sessionId) {
		vscode.postMessage({ type: 'openSession', sessionId: n.sessionId });
	}
}

// ────────────────────────── モード切替 ──────────────────────────
let currentMode = ${JSON.stringify(defaultMode)};
function setMode(m) {
	currentMode = m;
	document.querySelectorAll('.mode-seg button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
	document.querySelectorAll('.pane').forEach(p => p.classList.remove('on'));
	document.getElementById('pane-' + m).classList.add('on');
	if (m === 'graph') { kickGraph(); }
	else { stopGraph(); }
	if (m === 'tree') renderTree();
	if (m === 'group') renderGroup();
	// v0.5.25: グラフモード以外ではズームコントロール/バッジを隠す
	updateZoomControlsVisibility();
}
document.querySelectorAll('.mode-seg button').forEach(b => {
	b.addEventListener('click', () => {
		setMode(b.dataset.mode);
		// v0.5.23 レビュー修正: 選択モードを orgChart.defaultMode 設定に永続化
		vscode.postMessage({ type: 'setDefaultMode', value: b.dataset.mode });
	});
});

// ────────────────────────── 検索 ──────────────────────────
let searchTimer;
document.getElementById('org-search').addEventListener('input', (e) => {
	if (searchTimer) clearTimeout(searchTimer);
	searchQ = (e.target.value || '').trim();
	searchTimer = setTimeout(() => {
		// マッチした 1 件目をセンタリング（グラフモード時のみ）
		if (currentMode === 'graph' && searchQ) {
			const matched = NODES.find(matchesSearch);
			if (matched) centerOn(matched.id);
		}
		if (currentMode === 'tree') applyTreeFilter();
		if (currentMode === 'group') applyGroupFilter();
	}, 200);
});

// ────────────────────────── 凡例チップ ──────────────────────────
document.querySelectorAll('.legend-chip').forEach((chip) => {
	chip.addEventListener('click', () => {
		const active = chip.classList.contains('active');
		document.querySelectorAll('.legend-chip').forEach(c => c.classList.remove('active'));
		if (active) { chipFilter = null; return; }
		chip.classList.add('active');
		chipFilter = { type: chip.dataset.chipType, value: chip.dataset.chipValue };
		if (currentMode === 'tree') applyTreeFilter();
		if (currentMode === 'group') applyGroupFilter();
	});
});

// ────────────────────────── 連携トグル ──────────────────────────
document.getElementById('btn-collab').addEventListener('click', () => {
	collabOn = !collabOn;
	document.getElementById('btn-collab').classList.toggle('active', collabOn);
	// 連携 ON 時にログが空なら「連携ログはまだありません」を表示
	const hint = document.getElementById('collab-hint');
	if (collabOn && COLLAB.length === 0) {
		hint.textContent = '連携ログはまだありません（/csm-ask-agent の利用で蓄積されます）';
		hint.style.display = 'block';
	} else if (collabOn) {
		hint.textContent = '直近 7 日の連携（' + COLLAB.length + '本、金色点線）を重ね描き中';
		hint.style.display = 'block';
	} else {
		hint.style.display = 'none';
	}
	// 集計を再取得（拡張側から postMessage で最新を返してくる）
	if (collabOn) vscode.postMessage({ type: 'refreshCollab' });
	alpha = 1;
});

// ────────────────────────── 他プロジェクトを隠す ──────────────────────────
document.getElementById('btn-hide-other').addEventListener('click', () => {
	HIDE_OTHER = !HIDE_OTHER;
	document.getElementById('btn-hide-other').classList.toggle('active', HIDE_OTHER);
	if (currentMode === 'tree') applyTreeFilter();
	if (currentMode === 'group') applyGroupFilter();
	alpha = 1;
	// v0.5.23 レビュー修正: 設定 orgChart.hideOtherProjects に永続化（拡張側で書き込み）
	vscode.postMessage({ type: 'setHideOtherProjects', value: HIDE_OTHER });
});

// ────────────────────────── v0.5.25: ズームコントロール ──────────────────────────
document.getElementById('btn-zoom-in').addEventListener('click', () => {
	if (currentMode !== 'graph') return;
	// 画面中央を基点にズームイン
	zoomAtScreen(W / 2, H / 2, 1.2);
	alpha = Math.max(alpha, 0.4);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
	if (currentMode !== 'graph') return;
	zoomAtScreen(W / 2, H / 2, 1 / 1.2);
	alpha = Math.max(alpha, 0.4);
});
document.getElementById('btn-zoom-fit').addEventListener('click', () => {
	if (currentMode !== 'graph') return;
	fitToView();
	alpha = Math.max(alpha, 0.4);
});
// グラフモード以外ではズームコントロールを隠す（UI 混乱防止）
function updateZoomControlsVisibility() {
	const zc = document.getElementById('zoom-controls');
	if (zc) zc.style.display = currentMode === 'graph' ? '' : 'none';
	const zb = document.getElementById('zoom-badge');
	if (zb) zb.style.display = currentMode === 'graph' ? '' : 'none';
}

// ────────────────────────── グループ軸切替 ──────────────────────────
document.querySelectorAll('.gaxis .mtool').forEach(b => {
	b.addEventListener('click', () => {
		document.querySelectorAll('.gaxis .mtool').forEach(x => x.classList.remove('active'));
		b.classList.add('active');
		groupAxis = b.dataset.ax;
		renderGroup();
	});
});

// ────────────────────────── 拡張から postMessage 受信 ──────────────────────────
window.addEventListener('message', (ev) => {
	const m = ev.data;
	if (!m) return;
	if (m.type === 'collabData') {
		COLLAB = m.edges || [];
		const hint = document.getElementById('collab-hint');
		if (collabOn) {
			hint.textContent = COLLAB.length === 0
				? '連携ログはまだありません（/csm-ask-agent の利用で蓄積されます）'
				: '直近 7 日の連携（' + COLLAB.length + '本、金色点線）を重ね描き中';
			hint.style.display = 'block';
		}
	}
});

// ────────────────────────── 初期化 ──────────────────────────
if (currentMode === 'graph') kickGraph();
if (currentMode === 'tree') renderTree();
if (currentMode === 'group') renderGroup();
// v0.5.25: 起動時にズームコントロール表示/バッジを反映
updateZoomControlsVisibility();
updateZoomBadge();
</script>
</body>
</html>`;
}
