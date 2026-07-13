// orgChartEngine.ts — v0.5.23 組織図の**純ロジック層**
//
// 描画（Canvas）に依存しない計算だけをここに置く（vscode 依存なし）。
// - 力学シミュレーションの 1 ステップ計算（reduce-friendly な純関数群）
// - 隣接集合の計算
// - グルーピング関数（部署 / モデル / 状態）
// - Radius 計算
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
