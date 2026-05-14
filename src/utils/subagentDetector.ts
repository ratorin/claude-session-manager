// JSONL解析ベースのサブエージェント検出モジュール
// 既存 agentMonitor.ts のロジックを発展させ、SubagentInfo 型を返すように拡張
// v0.3.0 perf: 全sync I/O排除
import * as fs from 'fs';
import { SubagentInfo } from '../models/types';

// ファイルキャッシュ: mtime+sizeが変わらなければ再解析しない
interface FileCache {
	mtimeMs: number;
	size: number;
	activeSubagents: SubagentInfo[];
}

// 末尾から読むバイト数（巨大JSONLでもこれだけ読めば十分）
const TAIL_BYTES = 64 * 1024; // 64KB

const fileCacheMap = new Map<string, FileCache>();

// ファイル末尾だけ読み取る（巨大ファイル対策・非同期・fdリーク対策済み）
async function readFileTail(filePath: string, bytes: number): Promise<string> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const stat = await handle.stat();
		if (stat.size === 0) { return ''; }
		const readSize = Math.min(bytes, stat.size);
		const startPos = Math.max(0, stat.size - readSize);
		const buffer = Buffer.alloc(readSize);
		await handle.read(buffer, 0, readSize, startPos);
		return buffer.toString('utf-8');
	} finally {
		await handle.close();
	}
}

// JSONL末尾を解析して稼働中のサブエージェントを検出
// tool_use(name==="Task"||"Agent") → tool_result ペアを追跡し、
// tool_result が来ていないものを「稼働中」として返す
function parseTailForSubagents(tail: string): SubagentInfo[] {
	const lines = tail.split('\n');
	// 先頭行は途中で切れている可能性があるのでスキップ
	if (lines.length > 1) { lines.shift(); }

	// tool_use ID → SubagentInfo のマップ（出現順を保持）
	const running = new Map<string, SubagentInfo>();

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		try {
			const entry = JSON.parse(trimmed);
			const content = entry?.message?.content;
			if (!Array.isArray(content)) { continue; }

			// エントリのタイムスタンプを取得（なければ0）
			const timestamp = entry.timestamp
				? new Date(entry.timestamp).getTime()
				: 0;

			for (const block of content) {
				// tool_use で name === "Task" or "Agent" → サブエージェント開始
				if (
					block.type === 'tool_use' &&
					block.id &&
					(block.name === 'Task' || block.name === 'Agent')
				) {
					// input.description があればサブエージェントの説明として記録
					const description = typeof block.input?.description === 'string'
						? block.input.description
						: typeof block.input?.prompt === 'string'
							? block.input.prompt.slice(0, 120) // prompt先頭120文字をフォールバック
							: undefined;

					running.set(block.id, {
						toolUseId: block.id,
						name: block.name,
						description,
						startedAt: timestamp,
					});
				}
				// tool_result → 対応するtool_useの完了
				if (block.type === 'tool_result' && block.tool_use_id) {
					running.delete(block.tool_use_id);
				}
			}
		} catch { /* パース失敗行はスキップ */ }
	}

	return [...running.values()];
}

// セッションJSONLファイルを解析し、稼働中のサブエージェント一覧を返す（非同期）
export async function detectSubagents(filePath: string): Promise<SubagentInfo[]> {
	try {
		const stat = await fs.promises.stat(filePath);

		// キャッシュチェック: mtime+sizeが同じなら再解析不要
		const cached = fileCacheMap.get(filePath);
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			return cached.activeSubagents;
		}

		// ファイルが変更されたので再解析
		const tail = await readFileTail(filePath, TAIL_BYTES);
		const activeSubagents = parseTailForSubagents(tail);

		// キャッシュサイズ制限（最大100エントリ）
		// Map は挿入順を保持するため、先頭エントリが最も古い
		if (fileCacheMap.size >= 100) {
			const firstKey = fileCacheMap.keys().next().value;
			if (firstKey) { fileCacheMap.delete(firstKey); }
		}

		// キャッシュ更新
		fileCacheMap.set(filePath, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			activeSubagents,
		});

		return activeSubagents;
	} catch {
		return [];
	}
}

// 全キャッシュをクリア
export function clearCache(): void {
	fileCacheMap.clear();
}

// 特定ファイルのキャッシュのみ削除
export function invalidateCache(filePath: string): void {
	fileCacheMap.delete(filePath);
}
