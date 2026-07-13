// orgChartEngine.ts — v0.5.23〜 組織図の**純ロジック層**
//
// 描画（Canvas）に依存しない計算だけをここに置く（vscode 依存なし）。
// - 力学シミュレーションの 1 ステップ計算（reduce-friendly な純関数群）
// - 隣接集合の計算
// - グルーピング関数（部署 / モデル / 状態）
// - Radius 計算
// - v0.5.25: ビューポート（zoom / pan）変換とフィット計算
//
// これにより Node.js 単体テスト（node --test）で挙動を担保できる。

/** シミュレーション対象のノード（可変） */
export interface SimNode {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	r: number;
	// 表示用メタ（力計算では使わないが同じオブジェクトに載せると便利）
	model?: string;
	live?: boolean;
	parent?: string | null;
	label?: string;
}

/** エッジ（親子 = 'cmd' / 連携 = 'collab'） */
export interface SimEdge {
	sId: string;
	tId: string;
	kind: 'cmd' | 'collab';
	/** 連携エッジの重み（回数） */
	w?: number;
}

/**
 * 半径計算: 基礎 + 部下数 + ライブボーナス + director ボーナス。
 * モックの `7 + 部下数 * 2.2 + live?2 + director?4` を実装。
 */
export function computeNodeRadius(
	id: string,
	childCount: number,
	isLive: boolean,
	isDirector: boolean,
): number {
	return 7 + childCount * 2.2 + (isLive ? 2 : 0) + (isDirector ? 4 : 0);
}

/**
 * 力学シミュレーションの 1 ステップを計算する（純関数）。
 * `nodes` は in-place で速度と位置を更新する。テスト時は snapshot を取って値を検証する。
 *
 * @param nodes  ノード配列（in-place 更新）
 * @param edges  エッジ配列（親子/連携両方）
 * @param W      ステージ幅
 * @param H      ステージ高
 * @param alpha  減衰係数（0-1、1 が最大）
 * @param dragId ドラッグ中のノード ID（あれば速度を 0 に固定）
 */
export function simulateStep(
	nodes: SimNode[],
	edges: SimEdge[],
	W: number,
	H: number,
	alpha: number,
	dragId?: string,
): void {
	// 斥力（O(n^2)、規模数十まで想定）
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			const a = nodes[i];
			const b = nodes[j];
			let dx = b.x - a.x;
			let dy = b.y - a.y;
			const d2 = dx * dx + dy * dy || 1;
			const d = Math.sqrt(d2);
			const f = Math.min(2200 / d2, 4);
			dx /= d;
			dy /= d;
			a.vx -= dx * f; a.vy -= dy * f;
			b.vx += dx * f; b.vy += dy * f;
		}
	}
	// エッジの吸引（親子 110px / 連携 150px の理想距離）
	const byId = new Map<string, SimNode>(nodes.map((n) => [n.id, n]));
	for (const e of edges) {
		const s = byId.get(e.sId);
		const t = byId.get(e.tId);
		if (!s || !t) { continue; }
		const dx = t.x - s.x;
		const dy = t.y - s.y;
		const d = Math.sqrt(dx * dx + dy * dy) || 1;
		const ideal = e.kind === 'cmd' ? 110 : 150;
		const f = (d - ideal) * 0.004;
		s.vx += (dx / d) * f; s.vy += (dy / d) * f;
		t.vx -= (dx / d) * f; t.vy -= (dy / d) * f;
	}
	// 中心へのわずかな引力 + 減衰 + 位置更新
	for (const n of nodes) {
		n.vx += (W / 2 - n.x) * 0.0012;
		n.vy += (H / 2 - n.y) * 0.0012;
		if (dragId && n.id === dragId) {
			n.vx = 0; n.vy = 0;
			continue;
		}
		n.vx *= 0.86; n.vy *= 0.86;
		n.x += n.vx * alpha * 2;
		n.y += n.vy * alpha * 2;
		n.x = Math.max(30, Math.min(W - 30, n.x));
		n.y = Math.max(30, Math.min(H - 30, n.y));
	}
}

/**
 * 隣接集合の計算（無向: cmd/collab 両方）。
 * ホバー時の減光判定に使う。返り値は必ずノード自身の id を含む。
 */
export function computeNeighbors(nodeId: string, edges: SimEdge[]): Set<string> {
	const s = new Set<string>([nodeId]);
	for (const e of edges) {
		if (e.sId === nodeId) { s.add(e.tId); }
		if (e.tId === nodeId) { s.add(e.sId); }
	}
	return s;
}

// ─────────────────────────────────────────────────────────────
// グルーピング（グループモード）
// ─────────────────────────────────────────────────────────────

/** グルーピングの軸 */
export type GroupAxis = 'dept' | 'model' | 'status';

/** グルーピング対象のミニマル型（agentConfig からの投影） */
export interface GroupTargetAgent {
	name: string;
	displayName?: string;
	model?: string;
	parentAgent?: string;
	isLive?: boolean;
}

/** グループ 1 件（クラスタ表示用） */
export interface GroupCluster {
	key: string;    // グループの識別子（"opus" / "csm-dev 系" 等）
	label: string;  // 表示ラベル
	members: GroupTargetAgent[];
}

/**
 * 部署別グルーピング — 最上位（parentAgent === undefined / null / 自分含む祖先が居ない）で分類。
 * 各エージェントは「最上位まで parentAgent を辿った先の名前」でグループ化される。
 * 循環参照は byName ルックアップの `visited` チェックで防止。
 */
export function groupByDept(agents: GroupTargetAgent[]): GroupCluster[] {
	const byName = new Map<string, GroupTargetAgent>(agents.map((a) => [a.name, a]));
	const clusters = new Map<string, GroupCluster>();
	for (const a of agents) {
		let root = a.name;
		const visited = new Set<string>([a.name]);
		let cur: GroupTargetAgent | undefined = a;
		while (cur?.parentAgent && byName.has(cur.parentAgent) && !visited.has(cur.parentAgent)) {
			root = cur.parentAgent;
			visited.add(cur.parentAgent);
			cur = byName.get(cur.parentAgent);
		}
		const rootAgent = byName.get(root);
		const key = root;
		const label = rootAgent?.displayName || root;
		if (!clusters.has(key)) {
			clusters.set(key, { key, label, members: [] });
		}
		clusters.get(key)!.members.push(a);
	}
	// 部下数の多い順
	return [...clusters.values()].sort((a, b) => b.members.length - a.members.length);
}

/** モデル別グルーピング — `MODEL_CATALOG` の順序に近い並び */
export function groupByModel(agents: GroupTargetAgent[]): GroupCluster[] {
	const map = new Map<string, GroupTargetAgent[]>();
	for (const a of agents) {
		const k = a.model || 'unknown';
		if (!map.has(k)) { map.set(k, []); }
		map.get(k)!.push(a);
	}
	const preferredOrder = ['fable', 'fable-1m', 'opus', 'opus-1m', 'sonnet', 'sonnet-1m', 'haiku', 'unknown'];
	const keys = [...map.keys()].sort((a, b) => {
		const ai = preferredOrder.indexOf(a); const bi = preferredOrder.indexOf(b);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
	});
	return keys.map((k) => ({
		key: k,
		label: k,
		members: map.get(k)!.slice().sort((a, b) => a.name.localeCompare(b.name)),
	}));
}

// ─────────────────────────────────────────────────────────────
// v0.5.25: ビューポート（zoom / pan）変換
// ─────────────────────────────────────────────────────────────

/**
 * ビューポート状態。
 *
 * ワールド座標 → スクリーン座標:
 *   screenX = worldX * zoom + panX
 *   screenY = worldY * zoom + panY
 */
export interface Viewport {
	zoom: number;
	panX: number;
	panY: number;
}

/** ズーム倍率の下限・上限（UI と一致させる） */
export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4.0;

/** 数値クランプ */
function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

/** スクリーン → ワールド */
export function screenToWorld(
	viewport: Viewport,
	screenX: number,
	screenY: number,
): { x: number; y: number } {
	return {
		x: (screenX - viewport.panX) / viewport.zoom,
		y: (screenY - viewport.panY) / viewport.zoom,
	};
}

/** ワールド → スクリーン */
export function worldToScreen(
	viewport: Viewport,
	worldX: number,
	worldY: number,
): { x: number; y: number } {
	return {
		x: worldX * viewport.zoom + viewport.panX,
		y: worldY * viewport.zoom + viewport.panY,
	};
}

/**
 * カーソル位置を中心にズームした新しいビューポートを返す（純関数）。
 * カーソル下のワールド点はズーム前後で同じスクリーン座標に留まる（自然なズーム）。
 *
 * @param viewport   現在のビューポート
 * @param anchorSx   ズーム基点のスクリーン x
 * @param anchorSy   ズーム基点のスクリーン y
 * @param factor     倍率係数（例: 1.1 で 10% ズームイン、0.9 でズームアウト）
 * @param min        ズーム下限（省略時 ZOOM_MIN）
 * @param max        ズーム上限（省略時 ZOOM_MAX）
 */
export function zoomAt(
	viewport: Viewport,
	anchorSx: number,
	anchorSy: number,
	factor: number,
	min: number = ZOOM_MIN,
	max: number = ZOOM_MAX,
): Viewport {
	const newZoom = clamp(viewport.zoom * factor, min, max);
	if (newZoom === viewport.zoom) { return viewport; }
	// アンカー下のワールド点を計算
	const w = screenToWorld(viewport, anchorSx, anchorSy);
	// ズーム変更後もアンカーの世界点がアンカーのスクリーン座標に来るように pan を調整
	return {
		zoom: newZoom,
		panX: anchorSx - w.x * newZoom,
		panY: anchorSy - w.y * newZoom,
	};
}

/**
 * 指定ワールド点をスクリーン中心に置くビューポートを返す（zoom はそのまま or 指定）。
 * 検索ヒット時のセンタリングに使用。
 */
export function centerViewportOn(
	viewport: Viewport,
	worldX: number,
	worldY: number,
	stageW: number,
	stageH: number,
	newZoom?: number,
): Viewport {
	const zoom = newZoom !== undefined ? clamp(newZoom, ZOOM_MIN, ZOOM_MAX) : viewport.zoom;
	return {
		zoom,
		panX: stageW / 2 - worldX * zoom,
		panY: stageH / 2 - worldY * zoom,
	};
}

/**
 * 与えられたポイント群（ノード中心 + 半径）を包む最小フィット viewport を返す。
 * padding は左右合計・上下合計それぞれ pxで確保する余白（既定 40）。
 * 空の場合はデフォルト（zoom=1, ステージ中央 pan）を返す。
 */
export function fitToView(
	points: readonly { x: number; y: number; r?: number }[],
	stageW: number,
	stageH: number,
	padding: number = 40,
): Viewport {
	if (!points || points.length === 0 || stageW <= 0 || stageH <= 0) {
		return { zoom: 1, panX: stageW / 2, panY: stageH / 2 };
	}
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) {
		const r = p.r ?? 0;
		if (p.x - r < minX) { minX = p.x - r; }
		if (p.y - r < minY) { minY = p.y - r; }
		if (p.x + r > maxX) { maxX = p.x + r; }
		if (p.y + r > maxY) { maxY = p.y + r; }
	}
	const bboxW = Math.max(1, maxX - minX);
	const bboxH = Math.max(1, maxY - minY);
	const availW = Math.max(1, stageW - padding * 2);
	const availH = Math.max(1, stageH - padding * 2);
	const zoom = clamp(Math.min(availW / bboxW, availH / bboxH), ZOOM_MIN, ZOOM_MAX);
	// bbox 中心をステージ中心に
	const cx = (minX + maxX) / 2;
	const cy = (minY + maxY) / 2;
	return {
		zoom,
		panX: stageW / 2 - cx * zoom,
		panY: stageH / 2 - cy * zoom,
	};
}

// ─────────────────────────────────────────────────────────────
// v0.5.26: 組織図フィルタ（グローバル除外 / ルート絞り込み / 折りたたみ）
// ─────────────────────────────────────────────────────────────

/** 組織図フィルタ対象のミニマル型 */
export interface OrgFilterAgent {
	name: string;
	parentAgent?: string;
	showInOrgChart?: boolean;
}

/**
 * shouldShowInOrgChart と同じ判定（純粋版）。
 * agentUtils.shouldShowInOrgChart を engine 側で再実装しているのは、
 * agentUtils が vscode 未依存とはいえ他モジュールを引き込む可能性があるためテストの独立性を優先。
 *
 * 判定ルール（agentUtils と一致させる）:
 *   1. showInOrgChart が明示的に設定されていれば → その値
 *   2. parentAgent が設定されていれば → true（部門エージェント）
 *   3. それ以外 → false（グローバルエージェント）
 */
export function isOrgChartMember(a: OrgFilterAgent): boolean {
	if (a.showInOrgChart !== undefined) { return a.showInOrgChart; }
	return !!a.parentAgent;
}

/**
 * ルート集合を計算する。
 * ルート = `showInOrgChart` フィルタを通した後、parentAgent が空 or 未知（他ルートに繋がらない）なエージェント。
 * 循環参照は visited セットで防御。
 */
export function computeRoots<T extends OrgFilterAgent>(agents: readonly T[]): T[] {
	const known = new Set(agents.map((a) => a.name));
	const roots: T[] = [];
	for (const a of agents) {
		// parentAgent が無い or 既知集合に無い → ルート
		if (!a.parentAgent || !known.has(a.parentAgent)) {
			roots.push(a);
		}
	}
	return roots;
}

/**
 * 指定ルートから到達可能な部分グラフを抽出する（ルート自身も含む）。
 * parentAgent 関係を辿って `rootName` 配下の子孫を BFS で収集。循環参照は visited セットで防御。
 * `rootName` が空文字列 or 存在しない場合は全件を返す。
 */
export function extractSubtree<T extends OrgFilterAgent>(agents: readonly T[], rootName: string): T[] {
	if (!rootName) { return [...agents]; }
	const byName = new Map<string, T>(agents.map((a) => [a.name, a]));
	if (!byName.has(rootName)) { return [...agents]; }
	// 親→子の隣接リストを構築
	const childrenOf = new Map<string, T[]>();
	for (const a of agents) {
		if (a.parentAgent && byName.has(a.parentAgent)) {
			const list = childrenOf.get(a.parentAgent) ?? [];
			list.push(a);
			childrenOf.set(a.parentAgent, list);
		}
	}
	// BFS
	const collected: T[] = [];
	const visited = new Set<string>();
	const queue: string[] = [rootName];
	while (queue.length > 0) {
		const nm = queue.shift()!;
		if (visited.has(nm)) { continue; }
		visited.add(nm);
		const a = byName.get(nm);
		if (a) { collected.push(a); }
		for (const child of childrenOf.get(nm) ?? []) {
			if (!visited.has(child.name)) { queue.push(child.name); }
		}
	}
	return collected;
}

/**
 * 組織図表示対象を計算する（グローバル除外 + ルート絞り込み）。
 *
 * 順序が重要:
 *   1) まず**元の親子関係**で `rootName` 配下の部分グラフを BFS で得る（`extractSubtree`）。
 *      ここでフィルタしていないのは、`rootName` に指定されたエージェント自身がグローバルで
 *      あっても、その配下の部門エージェントを引き出せるようにするため。
 *   2) その後 `showGlobal=false` ならグローバルエージェントを除外。ルート自身がグローバルなら
 *      ここで除外される（結果には配下の部門エージェントだけが残る）。
 *
 * @param agents      全エージェント
 * @param showGlobal  true なら shouldShowInOrgChart のフィルタを外し全エージェントを対象にする
 * @param rootName    '' なら全ルート、それ以外はその配下（BFS）に限定
 */
export function filterOrgChartAgents<T extends OrgFilterAgent>(
	agents: readonly T[],
	showGlobal: boolean,
	rootName: string,
): T[] {
	const subtree = extractSubtree(agents, rootName);
	if (showGlobal) { return subtree; }
	return subtree.filter(isOrgChartMember);
}

/** 稼働状態別グルーピング（稼働中 / 待機 / 未紐づけ） */
export function groupByStatus(
	agents: GroupTargetAgent[],
	isLinked: (a: GroupTargetAgent) => boolean,
): GroupCluster[] {
	const active: GroupTargetAgent[] = [];
	const idle: GroupTargetAgent[] = [];
	const unlinked: GroupTargetAgent[] = [];
	for (const a of agents) {
		if (a.isLive) { active.push(a); }
		else if (isLinked(a)) { idle.push(a); }
		else { unlinked.push(a); }
	}
	const byName = (a: GroupTargetAgent, b: GroupTargetAgent) => a.name.localeCompare(b.name);
	return [
		{ key: 'active',   label: '🟢 稼働中',  members: active.sort(byName) },
		{ key: 'idle',     label: '⚪ 待機',    members: idle.sort(byName) },
		{ key: 'unlinked', label: '🔗 未紐づけ', members: unlinked.sort(byName) },
	].filter((g) => g.members.length > 0);
}
