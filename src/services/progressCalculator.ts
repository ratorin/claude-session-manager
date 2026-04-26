/**
 * progressCalculator.ts — v0.5.0 T2.6
 * ProjectProgress 計算ロジック + キャッシュ（5秒TTL）
 *
 * ProjectProgress:
 *   - todos: 各エージェントの TODO 残件数 / 完了件数
 *   - history: 各エージェントの最終 HISTORY.md エントリ
 *   - pendingTasks: 確認待ちタスク（"確認待ち" / "保留" セクション）
 *   - activeSubagents: 稼働中サブエージェント数（session-manager.json から）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectDef } from './projectService';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export interface ProjectProgress {
	projectId: string;
	todos: TodoProgress[];
	history: HistoryEntry[];
	pendingTasks: PendingTask[];
	activeSubagents: number;
	computedAt: number;  // Unix ms
}

export interface TodoProgress {
	agent: string;
	total: number;
	done: number;
	pending: number;
}

export interface HistoryEntry {
	agent: string;
	lastEntry: string;  // 直近エントリの先頭50文字
	lastAt: number;     // ファイル更新時刻 Unix ms
}

export interface PendingTask {
	agent: string;
	count: number;
}

// -------------------------------------------------------------------
// キャッシュ（5秒TTL）
// -------------------------------------------------------------------

const CACHE_TTL_MS = 5000;
const _cache = new Map<string, ProjectProgress>();
const _cacheTime = new Map<string, number>();

// -------------------------------------------------------------------
// TODO.md パーサー
// -------------------------------------------------------------------

const TODO_HEADING_DONE    = /^##\s*(完了|done)/i;
const TODO_HEADING_PENDING = /^##\s*(保留|確認待ち|pending)/i;
const TODO_HEADING_UNDONE  = /^##\s*(未完了|todo)/i;
const TODO_ITEM            = /^[-*]\s+\[[ x?]\]/i;
const TODO_ITEM_DONE       = /^[-*]\s+\[x\]/i;

interface ParsedTodo {
	undone: number;
	done: number;
	pending: number;
}

function parseTodoFile(content: string): ParsedTodo {
	const result: ParsedTodo = { undone: 0, done: 0, pending: 0 };
	let section: 'undone' | 'done' | 'pending' | 'other' = 'other';

	for (const line of content.split('\n')) {
		if (TODO_HEADING_DONE.test(line))    { section = 'done';    continue; }
		if (TODO_HEADING_PENDING.test(line)) { section = 'pending'; continue; }
		if (TODO_HEADING_UNDONE.test(line))  { section = 'undone';  continue; }
		if (/^##/.test(line))               { section = 'other';   continue; }

		if (TODO_ITEM.test(line)) {
			if (section === 'done' || TODO_ITEM_DONE.test(line)) {
				result.done++;
			} else if (section === 'pending') {
				result.pending++;
			} else {
				result.undone++;
			}
		}
	}
	return result;
}

// -------------------------------------------------------------------
// HISTORY.md パーサー（直近エントリ抽出）
// -------------------------------------------------------------------

function parseHistoryLastEntry(content: string): string {
	// "## " で始まる見出しを探して最後の ## セクションの冒頭を返す
	const lines = content.split('\n');
	let lastSection = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith('## ')) {
			lastSection = i;
			break;
		}
	}
	if (lastSection === -1) { return ''; }

	// セクション見出し行以降の最初の非空行を返す
	for (let i = lastSection + 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed) {
			return trimmed.substring(0, 80);
		}
	}
	return lines[lastSection].replace(/^##\s*/, '').trim();
}

// -------------------------------------------------------------------
// エージェントディレクトリのスキャン
// -------------------------------------------------------------------

/** プロジェクトに関連するエージェントディレクトリを返す */
function getAgentDirs(project: ProjectDef): string[] {
	const dirs: string[] = [];

	// グローバル ~/.claude/agents/
	const globalDir = path.join(os.homedir(), '.claude', 'agents');
	if (fs.existsSync(globalDir)) { dirs.push(globalDir); }

	// プロジェクトローカル .claude/agents/
	const localDir = path.join(project.path, '.claude', 'agents');
	if (fs.existsSync(localDir)) { dirs.push(localDir); }

	return dirs;
}

/** 指定エージェント名のサブディレクトリから TODO / HISTORY を読む */
function readAgentFiles(agentDir: string, agentName: string): {
	todo: ParsedTodo | null;
	historyEntry: string;
	historyMtime: number;
} {
	const subDir = path.join(agentDir, agentName);
	const todoPath    = path.join(subDir, 'TODO.md');
	const historyPath = path.join(subDir, 'HISTORY.md');

	let todo: ParsedTodo | null = null;
	let historyEntry = '';
	let historyMtime = 0;

	try {
		if (fs.existsSync(todoPath)) {
			const content = fs.readFileSync(todoPath, 'utf-8');
			todo = parseTodoFile(content);
		}
	} catch { /* 読み取り失敗は無視 */ }

	try {
		if (fs.existsSync(historyPath)) {
			const content = fs.readFileSync(historyPath, 'utf-8');
			historyEntry = parseHistoryLastEntry(content);
			historyMtime = fs.statSync(historyPath).mtimeMs;
		}
	} catch { /* 読み取り失敗は無視 */ }

	return { todo, historyEntry, historyMtime };
}

// -------------------------------------------------------------------
// session-manager.json から稼働中エージェント数を取得
// -------------------------------------------------------------------

function getActiveSubagentCount(project: ProjectDef): number {
	const smFile = path.join(os.homedir(), '.claude', 'session-manager.json');
	try {
		if (!fs.existsSync(smFile)) { return 0; }
		const raw = fs.readFileSync(smFile, 'utf-8');
		const data = JSON.parse(raw) as Record<string, unknown>;
		const agentSessions = data.agentSessions as Record<string, { sessionId?: string }> | undefined;
		if (!agentSessions) { return 0; }

		// sessionId が空でないエージェントを「稼働中」とみなす
		// より正確には running PID チェックが必要だが、軽量な近似値として使用
		return Object.values(agentSessions).filter(s => s.sessionId && s.sessionId.length > 0).length;
	} catch {
		return 0;
	}
}

// -------------------------------------------------------------------
// メイン計算関数
// -------------------------------------------------------------------

/**
 * ProjectProgress を計算して返す。
 * キャッシュが有効な場合（5秒以内）はキャッシュを返す。
 */
export function computeProgress(project: ProjectDef): ProjectProgress {
	const now = Date.now();
	const cached = _cache.get(project.id);
	const cacheTime = _cacheTime.get(project.id) ?? 0;

	if (cached && (now - cacheTime) < CACHE_TTL_MS) {
		return cached;
	}

	const todos: TodoProgress[]  = [];
	const history: HistoryEntry[] = [];
	const pendingTasks: PendingTask[] = [];

	const agentDirs = getAgentDirs(project);

	for (const agentDir of agentDirs) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(agentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const agentName = entry.name;
			const { todo, historyEntry, historyMtime } = readAgentFiles(agentDir, agentName);

			if (todo) {
				todos.push({
					agent: agentName,
					total: todo.undone + todo.done,
					done: todo.done,
					pending: todo.undone,
				});
				if (todo.pending > 0) {
					pendingTasks.push({ agent: agentName, count: todo.pending });
				}
			}

			if (historyEntry) {
				history.push({
					agent: agentName,
					lastEntry: historyEntry,
					lastAt: historyMtime,
				});
			}
		}
	}

	// HISTORY は更新日時降順でソート
	history.sort((a, b) => b.lastAt - a.lastAt);

	const result: ProjectProgress = {
		projectId: project.id,
		todos,
		history: history.slice(0, 10),   // 最新10件
		pendingTasks,
		activeSubagents: getActiveSubagentCount(project),
		computedAt: now,
	};

	_cache.set(project.id, result);
	_cacheTime.set(project.id, now);

	return result;
}

/**
 * 指定プロジェクトのキャッシュを無効化する。
 * ファイル変更検知時に呼び出す。
 */
export function invalidateCache(projectId: string): void {
	_cache.delete(projectId);
	_cacheTime.delete(projectId);
}

/**
 * 全キャッシュを無効化する。
 */
export function clearAllCache(): void {
	_cache.clear();
	_cacheTime.clear();
}

// -------------------------------------------------------------------
// ユーティリティ: サマリー文字列
// -------------------------------------------------------------------

/** プロジェクト進捗のサマリー文字列を生成する（UI表示用） */
export function summarizeProgress(p: ProjectProgress): string {
	const totalPending = p.todos.reduce((s, t) => s + t.pending, 0);
	const waitingCount = p.pendingTasks.reduce((s, t) => s + t.count, 0);
	const parts: string[] = [];
	if (totalPending > 0)  { parts.push(`TODO残 ${totalPending}件`); }
	if (waitingCount > 0)  { parts.push(`確認待ち ${waitingCount}件`); }
	if (p.activeSubagents > 0) { parts.push(`稼働中 ${p.activeSubagents}体`); }
	if (parts.length === 0) { return '進捗なし'; }
	return parts.join(' / ');
}
