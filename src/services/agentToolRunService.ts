// agentToolRunService.ts — Agent ツール経由の「一時実行」を検出する
//
// 背景 (docs/agent-invocation-architecture.md G1/R3):
//   エージェントへの依頼には実体の異なる 2 経路がある。
//     経路A: Agent ツール（親セッション内のサブタスク）… 使い捨て・CSM から不可視だった
//     経路B: csm-ask-agent（別プロセスで claude --resume）… 永続セッションに蓄積される
//   経路 A で実行しても agentSessions の sessionId には一行も書かれないため、
//   ユーザーからは「依頼したはずの作業が履歴に無い」状態になり不信を招いた。
//
// 何を根拠に検出するか:
//   親セッションの JSONL に残る Agent/Task ツールの tool_use（subagent_type 付き）を読む。
//   一時実行のトランスクリプト実体は
//     <tmp>/claude/<slug>/<parentSessionId>/tasks/<agentId>.output
//   にも書かれるが、こちらは OS の一時領域なので短命（実測: 17 回の実行に対し
//   残っていたのは 1 件のみ）。したがって**恒久的な記録は親セッション JSONL 側**であり、
//   そちらを主、tasks/*.output を従（読めれば全文表示）として扱う。
//
// 性能:
//   セッション JSONL は数百 MB になる（実測最大 527MB）。毎回の全走査は現実的でないため
//   - 行バッファ上で "subagent_type" のバイト列を検索してから初めて UTF-8 デコード・JSON.parse
//   - 読み取り位置（byte offset）を覚えて追記分だけを読む増分スキャン
//   の 2 段構えにしている。JSONL は追記専用なのでこれが成立する。

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getSessionFileInfos } from '../utils/sessionLoader';

/** Agent ツール経由の 1 回の実行 */
export interface AgentToolRun {
	/** subagent_type（= エージェント名） */
	agentName: string;
	/** Agent ツールの description（無ければ prompt の先頭） */
	description: string;
	toolUseId: string;
	timestampMs: number;
	/** 呼び出し元セッション */
	parentSessionId: string;
	parentSessionPath: string;
}

/** 1 ファイル分の増分スキャン状態 */
export interface ScanState {
	/** 最後に読み終えた位置（完全な行の直後） */
	offset: number;
	/** 前回スキャン時のファイルサイズ。縮んでいたら作り直されたとみなし全走査する */
	size: number;
	runs: AgentToolRun[];
}

const NEEDLE = Buffer.from('"subagent_type"');
const NEWLINE = 0x0a;

/**
 * ファイルの start バイト目以降を行単位で読み、完全な行だけを onLine に渡す。
 * 戻り値は「最後の完全な行の直後」の byte offset。
 * 末尾の未完成行（書き込み途中）は消費せず、次回に持ち越す。
 */
function readLinesFrom(
	filePath: string,
	start: number,
	onLine: (line: Buffer) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let stream: fs.ReadStream;
		try {
			stream = fs.createReadStream(filePath, { start });
		} catch (e) {
			reject(e);
			return;
		}
		let pending: Buffer = Buffer.alloc(0);
		let completedBytes = 0;

		stream.on('data', (chunk: string | Buffer) => {
			const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
			let from = 0;
			let idx = pending.indexOf(NEWLINE, from);
			while (idx !== -1) {
				onLine(pending.subarray(from, idx));
				from = idx + 1;
				idx = pending.indexOf(NEWLINE, from);
			}
			// from はこの回で消費できた「完全な行」のバイト数
			completedBytes += from;
			pending = pending.subarray(from);
		});
		stream.on('error', reject);
		stream.on('end', () => resolve(start + completedBytes));
	});
}

/** tool_use ブロックから AgentToolRun を組み立てる */
function extractRuns(entry: unknown, sessionPath: string): AgentToolRun[] {
	const e = entry as {
		timestamp?: string;
		sessionId?: string;
		message?: { content?: unknown };
	};
	const content = e?.message?.content;
	if (!Array.isArray(content)) { return []; }

	const timestampMs = e.timestamp ? Date.parse(e.timestamp) : NaN;
	const out: AgentToolRun[] = [];
	for (const block of content) {
		const b = block as {
			type?: string;
			name?: string;
			id?: string;
			input?: { subagent_type?: string; description?: string; prompt?: string };
		};
		if (b?.type !== 'tool_use') { continue; }
		// ツール名は CC のバージョンで Task / Agent どちらもありうる
		if (b.name !== 'Task' && b.name !== 'Agent') { continue; }
		const agentName = b.input?.subagent_type;
		if (!agentName) { continue; }
		const description = (b.input?.description || b.input?.prompt || '').trim().slice(0, 120);
		out.push({
			agentName,
			description,
			toolUseId: b.id || '',
			timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0,
			parentSessionId: e.sessionId || '',
			parentSessionPath: sessionPath,
		});
	}
	return out;
}

/**
 * 1 セッション JSONL をスキャンする（増分）。
 * prev を渡すと追記分だけを読む。ファイルが縮んでいた場合は先頭から読み直す。
 */
export async function scanSessionForAgentToolRuns(
	sessionPath: string,
	prev?: ScanState,
): Promise<ScanState> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(sessionPath);
	} catch {
		return { offset: 0, size: 0, runs: prev?.runs ?? [] };
	}

	// ファイルが縮んでいる = 作り直された → 全走査
	const reusable = prev && prev.size <= stat.size && prev.offset <= stat.size;
	const start = reusable ? prev!.offset : 0;
	const runs: AgentToolRun[] = reusable ? [...prev!.runs] : [];

	if (start >= stat.size) {
		return { offset: start, size: stat.size, runs };
	}

	const nextOffset = await readLinesFrom(sessionPath, start, (lineBuf) => {
		// バイト列のまま絞り込む。大半の行はここで捨てられ UTF-8 デコードを避けられる。
		if (lineBuf.indexOf(NEEDLE) === -1) { return; }
		let entry: unknown;
		try {
			entry = JSON.parse(lineBuf.toString('utf-8'));
		} catch {
			return;
		}
		runs.push(...extractRuns(entry, sessionPath));
	});

	return { offset: nextOffset, size: stat.size, runs };
}

/**
 * 複数セッションをスキャンして、エージェント名ごとに一時実行をまとめる。
 * cache は呼び出し側が保持する（キーは sessionPath）。
 */
export async function collectAgentToolRuns(
	sessionPaths: readonly string[],
	cache: Map<string, ScanState>,
): Promise<Map<string, AgentToolRun[]>> {
	const byAgent = new Map<string, AgentToolRun[]>();
	for (const sessionPath of sessionPaths) {
		let state: ScanState;
		try {
			state = await scanSessionForAgentToolRuns(sessionPath, cache.get(sessionPath));
		} catch {
			continue; // 1 ファイルの失敗で全体を止めない
		}
		cache.set(sessionPath, state);
		for (const run of state.runs) {
			const arr = byAgent.get(run.agentName) || [];
			arr.push(run);
			byAgent.set(run.agentName, arr);
		}
	}
	for (const arr of byAgent.values()) {
		arr.sort((a, b) => b.timestampMs - a.timestampMs);
	}
	return byAgent;
}

// ---------------------------------------------------------------------------
// 一時トランスクリプト（tasks/*.output）の探索 — best effort
// ---------------------------------------------------------------------------

/** Claude Code が一時トランスクリプトを置くルート */
export function getEphemeralTranscriptRoot(): string {
	return path.join(os.tmpdir(), 'claude');
}

/**
 * 指定エージェントの一時トランスクリプトを探す。
 *
 * 判定は 1 行目の isSidechain/agentId（同じ tasks/ にはバックグラウンド Bash の
 * プレーンテキスト出力も混在するため、JSON として読めることを条件にする）。
 * エージェント名は各行の attributionAgent に入っている。
 *
 * OS の一時領域なので消えている方が普通。見つからなくても異常ではない。
 */
export async function findEphemeralTranscript(
	parentSessionId: string,
	agentName: string,
): Promise<string | undefined> {
	if (!parentSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(parentSessionId)) { return undefined; }
	const root = getEphemeralTranscriptRoot();
	let slugs: string[];
	try {
		slugs = await fs.promises.readdir(root);
	} catch {
		return undefined;
	}
	for (const slug of slugs) {
		const tasksDir = path.join(root, slug, parentSessionId, 'tasks');
		let files: string[];
		try {
			files = await fs.promises.readdir(tasksDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith('.output')) { continue; }
			const full = path.join(tasksDir, file);
			if (await transcriptBelongsTo(full, agentName)) { return full; }
		}
	}
	return undefined;
}

/** .output が指定エージェントの一時トランスクリプトかどうか */
async function transcriptBelongsTo(filePath: string, agentName: string): Promise<boolean> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(filePath, 'r');
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
		const head = buf.subarray(0, bytesRead).toString('utf-8');
		const firstLine = head.split('\n')[0];
		if (!firstLine.startsWith('{')) { return false; } // バックグラウンド Bash の出力
		const entry = JSON.parse(firstLine) as { isSidechain?: boolean; agentId?: string };
		if (!entry.isSidechain || !entry.agentId) { return false; }
	} catch {
		return false;
	} finally {
		await handle?.close().catch(() => undefined);
	}
	// attributionAgent でエージェント名を確認する
	try {
		const content = await fs.promises.readFile(filePath, 'utf-8');
		return content.includes(`"attributionAgent":${JSON.stringify(agentName)}`);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// 拡張本体から使うトラッカー
// ---------------------------------------------------------------------------


/**
 * 一時実行の集計とセッション容量を保持する。
 *
 * 走査コストが高いので UI スレッドの同期パスからは呼ばない。
 * refresh() を非同期で回し、結果はメモリに置いて TreeProvider から同期参照させる。
 */
export class AgentToolRunTracker {
	private scanCache = new Map<string, ScanState>();
	private byAgent = new Map<string, AgentToolRun[]>();
	private sessionBytes = new Map<string, number>();
	private scanning = false;

	/** エージェント名 → 一時実行（新しい順） */
	getRuns(agentName: string): AgentToolRun[] {
		return this.byAgent.get(agentName) ?? [];
	}

	/** R5(最小案): セッション JSONL のサイズ */
	getSessionBytes(sessionId: string): number | undefined {
		return this.sessionBytes.get(sessionId);
	}

	/** 総件数（ログ・通知用） */
	getTotalRunCount(): number {
		let total = 0;
		for (const runs of this.byAgent.values()) { total += runs.length; }
		return total;
	}

	/**
	 * 指定セッション群を走査して集計を更新する。
	 * 戻り値: 集計内容が前回から変わったか（true なら TreeView を refresh する）
	 */
	async refresh(sessionIds: readonly string[]): Promise<boolean> {
		if (this.scanning) { return false; } // 多重起動防止
		this.scanning = true;
		try {
			const pathById = await resolveSessionFilePaths(sessionIds);

			// R5: サイズも同じ機会に拾う（stat だけなので安い）
			const nextBytes = new Map<string, number>();
			await Promise.all([...pathById].map(async ([sid, filePath]) => {
				try {
					const stat = await fs.promises.stat(filePath);
					nextBytes.set(sid, stat.size);
				} catch {
					// 消えている（リンク切れ）→ サイズ不明のまま
				}
			}));
			this.sessionBytes = nextBytes;

			const before = summarize(this.byAgent);
			this.byAgent = await collectAgentToolRuns([...pathById.values()], this.scanCache);
			return summarize(this.byAgent) !== before;
		} finally {
			this.scanning = false;
		}
	}
}

/** 変化検出用の軽量な要約文字列 */
function summarize(byAgent: Map<string, AgentToolRun[]>): string {
	return [...byAgent.entries()]
		.map(([name, runs]) => `${name}:${runs.length}`)
		.sort()
		.join(',');
}

/** sessionId → JSONL の実パス を解決する */
export async function resolveSessionFilePaths(
	sessionIds: readonly string[],
): Promise<Map<string, string>> {
	const wanted = new Set(sessionIds.filter(Boolean));
	const out = new Map<string, string>();
	if (wanted.size === 0) { return out; }
	let infos: { filePath: string }[];
	try {
		infos = await getSessionFileInfos();
	} catch {
		return out;
	}
	for (const info of infos) {
		const sid = path.basename(info.filePath, '.jsonl');
		if (wanted.has(sid) && !out.has(sid)) {
			out.set(sid, info.filePath);
		}
	}
	return out;
}
