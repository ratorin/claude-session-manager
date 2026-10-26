// liveStatusLabel.ts — ライブ状態の表示ラベル（純粋関数）
//
// v0.6.4: Claude Code の sessions/*.json に公式の `status`（'busy' | 'idle'）と
// `statusUpdatedAt` が入るようになった（CC 2.1.3xx で実測）。
// 従来は JSONL の mtime が 30 秒以内なら「対話中」とみなす推定だったが、
// 公式値があるときはそちらを使い、無いとき（古い CC）だけ推定に戻す。

export interface LiveStatusInput {
	isLive: boolean;
	/** sessions/*.json の公式 status。'busy'（応答中）| 'idle'（待機中）。無ければ推定にフォールバック */
	status?: string;
	/** status が変わった時刻（sessions/*.json の statusUpdatedAt、epoch ms） */
	statusUpdatedAt?: number;
	/** JSONL の mtime（公式 status が無いときの活動指標、epoch ms） */
	mtimeMs?: number;
	/** テスト用に固定できる現在時刻 */
	now?: number;
}

/** 経過時間を短い日本語にする: 30秒 / 5分 / 2時間 / 3日 */
export function formatLiveElapsed(ms: number): string {
	const sec = Math.floor(Math.max(0, ms) / 1000);
	if (sec < 60) { return `${sec}秒`; }
	const min = Math.floor(sec / 60);
	if (min < 60) { return `${min}分`; }
	const hr = Math.floor(min / 60);
	if (hr < 24) { return `${hr}時間`; }
	return `${Math.floor(hr / 24)}日`;
}

/**
 * 一覧の行頭に付けるプレフィックス。
 * - 公式 status あり: busy → '[応答中] '、idle → '[<待機してからの経過>] '
 * - 公式 status なし: mtime が 30 秒以内 → '[対話中] '、それ以外 → '[<経過>] '
 * - 停止中: ''
 */
export function formatLivePrefix(input: LiveStatusInput): string {
	if (!input.isLive) { return ''; }
	const now = input.now ?? Date.now();

	if (input.status === 'busy') { return '[応答中] '; }
	if (input.status === 'idle') {
		const since = input.statusUpdatedAt ?? input.mtimeMs;
		return since === undefined ? '[待機] ' : `[${formatLiveElapsed(now - since)}] `;
	}

	// 公式 status が無い（古い Claude Code）: 従来の推定
	if (input.mtimeMs !== undefined) {
		const elapsed = now - input.mtimeMs;
		return elapsed < 30_000 ? '[対話中] ' : `[${formatLiveElapsed(elapsed)}] `;
	}
	return '[実行中] ';
}

/** ツールチップ用の状態説明。公式 status があるときだけ返す */
export function describeLiveStatus(input: LiveStatusInput): string | undefined {
	if (!input.isLive) { return undefined; }
	if (input.status === 'busy') { return '応答中（Claude Code の公式 status）'; }
	if (input.status === 'idle') { return '待機中（Claude Code の公式 status）'; }
	return undefined;
}
