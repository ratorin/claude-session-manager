// agentTreeEnrichment.ts — v0.5.30 エージェント一覧の 2 段レンダリング用ユーティリティ
//
// **設計要約**:
// AgentTreeProvider.getChildren は初回表示前に await していた重い処理
// （特に `resolveExternalSessionTitles` = ~/.claude/projects/ 全走査 + 各 JSONL 先頭 256KB 読み）
// のせいで一覧表示が遅い。v0.5.30 で 2 段構えにする:
//   1. 高速パス: in-memory の titleMap（getSessionsFn 由来）+ 過去に解決済みの enrichmentMap のみで
//      AgentItem を即構築して返す。resolveExternalSessionTitles は呼ばない。
//   2. 遅延パス: getChildren から return した直後、未解決 sid だけを非同期解決し、
//      enrichmentMap に蓄積 → 変化があれば TreeDataProvider.refresh を 1 回だけ発火。
//
// 本ファイルは 2 段レンダリングのうち **純ロジック部分**（マージ / 未解決検出）を担う。
// vscode 非依存で単体テスト可能。

/** ミニマルなエージェント shape（sessionId のみ参照） */
export interface EnrichmentAgent {
	sessionId?: string;
}

/**
 * fast パスの titleMap（in-memory セッション由来）に enrichmentMap（過去に解決済みの外部タイトル）を
 * 合成する。fast が既に持つキーは fast を優先（in-memory が最新であるため）。
 * enrichmentMap の空文字値（＝「解決したが見つからなかった」マーカー）は無視する。
 */
export function mergeTitleMaps(
	fast: ReadonlyMap<string, string>,
	enrichment: ReadonlyMap<string, string>,
): Map<string, string> {
	const out = new Map(fast);
	for (const [sid, title] of enrichment) {
		if (out.has(sid)) { continue; }
		if (!title) { continue; } // 空文字は not-found マーカーなので追加しない
		out.set(sid, title);
	}
	return out;
}

/**
 * fast + enrichment のどちらにも載っていない sessionId を洗い出す。
 * 遅延解決の対象を決めるのに使う。
 *
 * enrichmentMap に空文字で入っている sid は「解決済み・見つからず」なので **再試行しない**
 * （無限リフレッシュ防止）。
 */
export function computeMissingSessionIds(
	agents: readonly EnrichmentAgent[],
	titleMap: ReadonlyMap<string, string>,
	enrichmentMap: ReadonlyMap<string, string>,
): string[] {
	const missing = new Set<string>();
	for (const a of agents) {
		const sid = a.sessionId;
		if (!sid) { continue; }
		if (titleMap.has(sid)) { continue; }
		if (enrichmentMap.has(sid)) { continue; } // 空文字含む「解決試行済み」もスキップ
		missing.add(sid);
	}
	return [...missing];
}

/**
 * 解決結果を既存 enrichmentMap にマージし、実際に値が変化したか判定する。
 * 変化があれば true（呼び出し側は refresh を発火）、無ければ false。
 *
 * 未解決だった sid は空文字で埋める（次回スキップさせる）。
 */
export function applyEnrichmentResult(
	enrichmentMap: Map<string, string>,
	requestedIds: readonly string[],
	resolved: ReadonlyMap<string, string>,
): boolean {
	let changed = false;
	for (const sid of requestedIds) {
		const newTitle = resolved.get(sid) ?? '';
		const prev = enrichmentMap.get(sid);
		if (prev === undefined) {
			// 新規記録: 値が空でも記録することで再試行を抑止
			enrichmentMap.set(sid, newTitle);
			if (newTitle) { changed = true; }
		} else if (prev !== newTitle) {
			enrichmentMap.set(sid, newTitle);
			changed = true;
		}
	}
	return changed;
}
