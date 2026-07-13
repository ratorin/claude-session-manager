// collabLog.ts — v0.5.23 /csm-ask-agent 送信履歴の集計
//
// データ源: `~/.claude/csm-collab-log.jsonl`
//   各行: `{"ts": epoch_ms, "from": "director", "to": "csm-impl"}`
//
// v0.5.23 では組織図の連携レイヤー（金色点線）で利用する。
// テスト容易性のため、ファイル IO と集計ロジックを分離してある。
// - `aggregateCollabLog()`: 純ロジック（配列 in、Map out）
// - `readCollabLog()`: ファイル読み込み（存在しない/エラー時は空配列を返す）

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** JSONL 1 行分（読み取り後） */
export interface CollabLogEntry {
	ts: number;
	from: string;
	to: string;
}

/** 集計エッジ 1 件 */
export interface CollabEdge {
	from: string;
	to: string;
	/** 期間内の送信回数 */
	count: number;
	/** 期間内で最も新しい送信の epoch_ms */
	latestTs: number;
}

/** csm-collab-log.jsonl のパス */
export function getCollabLogPath(): string {
	return path.join(os.homedir(), '.claude', 'csm-collab-log.jsonl');
}

/**
 * 集計ロジック — 純関数。
 * @param entries 読み取り済みログ配列
 * @param nowMs   基準時刻（Date.now()）
 * @param windowDays 集計窓の日数（既定 7 日）
 * @returns 集計エッジ配列（count 降順）
 */
export function aggregateCollabLog(
	entries: CollabLogEntry[],
	nowMs: number,
	windowDays: number = 7,
): CollabEdge[] {
	const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
	const map = new Map<string, CollabEdge>();
	for (const e of entries) {
		if (!e || typeof e.ts !== 'number' || typeof e.from !== 'string' || typeof e.to !== 'string') { continue; }
		if (e.ts < cutoff) { continue; }
		if (!e.from || !e.to) { continue; }
		if (e.from === e.to) { continue; } // 自己送信は集計対象外
		// v0.5.23 レビュー修正 (LOW): 区切り 1 文字だけだと `a b`+`c` と `a`+`b c` が衝突する余地があるため、
		// JSON.stringify([from, to]) を使って区切りを曖昧さゼロで確定させる。
		const key = JSON.stringify([e.from, e.to]);
		const cur = map.get(key);
		if (cur) {
			cur.count++;
			if (e.ts > cur.latestTs) { cur.latestTs = e.ts; }
		} else {
			map.set(key, { from: e.from, to: e.to, count: 1, latestTs: e.ts });
		}
	}
	return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * ファイル読み込み — 存在しない/破損時は空配列を返す（呼び出し元は成功時と同じ扱いにできる）。
 * `filePath` を上書き可能にしてテスト時は tmpdir 内の合成ファイルを指定できる。
 */
export async function readCollabLog(filePath?: string): Promise<CollabLogEntry[]> {
	const fp = filePath ?? getCollabLogPath();
	let text: string;
	try {
		text = await fs.promises.readFile(fp, 'utf-8');
	} catch {
		return []; // 存在しない/権限エラー等はサイレントに空扱い
	}
	const entries: CollabLogEntry[] = [];
	for (const line of text.split('\n')) {
		const s = line.trim();
		if (!s) { continue; }
		try {
			const parsed = JSON.parse(s);
			if (
				parsed
				&& typeof parsed.ts === 'number'
				&& typeof parsed.from === 'string'
				&& typeof parsed.to === 'string'
			) {
				entries.push({ ts: parsed.ts, from: parsed.from, to: parsed.to });
			}
		} catch { /* 不正行はスキップ */ }
	}
	return entries;
}
