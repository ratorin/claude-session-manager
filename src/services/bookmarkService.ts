/**
 * bookmarkService.ts — v0.5.0 T2.10
 * エージェントブックマーク管理 + 最終使用日記録（T2.11統合）
 *
 * 永続化先: ~/.claude/csm-agent-meta.json
 * {
 *   bookmarks: string[],         // bookmarked agent names
 *   lastUsed: Record<string, number>  // agent name → Unix ms
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// -------------------------------------------------------------------
// 定数 / 型
// -------------------------------------------------------------------

const META_FILE = path.join(os.homedir(), '.claude', 'csm-agent-meta.json');

interface AgentMetaFile {
	bookmarks: string[];
	lastUsed: Record<string, number>;
}

// -------------------------------------------------------------------
// ファイル I/O
// -------------------------------------------------------------------

function load(): AgentMetaFile {
	try {
		const raw = fs.readFileSync(META_FILE, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === 'object' && 'bookmarks' in parsed) {
			const p = parsed as Record<string, unknown>;
			return {
				bookmarks: Array.isArray(p.bookmarks) ? (p.bookmarks as string[]) : [],
				lastUsed: (p.lastUsed && typeof p.lastUsed === 'object')
					? (p.lastUsed as Record<string, number>)
					: {},
			};
		}
	} catch { /* ファイルなし or パースエラー */ }
	return { bookmarks: [], lastUsed: {} };
}

function save(data: AgentMetaFile): void {
	try {
		fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
		fs.writeFileSync(META_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
	} catch { /* 書き込み失敗は無視 */ }
}

// -------------------------------------------------------------------
// ブックマーク API
// -------------------------------------------------------------------

/** エージェントがブックマーク済みか */
export function isBookmarked(agentName: string): boolean {
	return load().bookmarks.includes(agentName);
}

/** ブックマーク済みエージェント一覧 */
export function getBookmarks(): string[] {
	return load().bookmarks;
}

/** ブックマーク追加（冪等） */
export function addBookmark(agentName: string): void {
	const data = load();
	if (!data.bookmarks.includes(agentName)) {
		const updated: AgentMetaFile = {
			...data,
			bookmarks: [...data.bookmarks, agentName],
		};
		save(updated);
	}
}

/** ブックマーク削除 */
export function removeBookmark(agentName: string): void {
	const data = load();
	if (data.bookmarks.includes(agentName)) {
		const updated: AgentMetaFile = {
			...data,
			bookmarks: data.bookmarks.filter(n => n !== agentName),
		};
		save(updated);
	}
}

/** ブックマークトグル。新しい状態を返す */
export function toggleBookmark(agentName: string): boolean {
	if (isBookmarked(agentName)) {
		removeBookmark(agentName);
		return false;
	} else {
		addBookmark(agentName);
		return true;
	}
}

// -------------------------------------------------------------------
// 最終使用日 API (T2.11 統合)
// -------------------------------------------------------------------

/** エージェントの最終使用日時を記録する（セッション開始時に呼び出す） */
export function recordLastUsed(agentName: string, at?: number): void {
	const data = load();
	const updated: AgentMetaFile = {
		...data,
		lastUsed: {
			...data.lastUsed,
			[agentName]: at ?? Date.now(),
		},
	};
	save(updated);
}

/** エージェントの最終使用日時を取得する（Unix ms / なければ 0） */
export function getLastUsed(agentName: string): number {
	return load().lastUsed[agentName] ?? 0;
}

/** 全エージェントの最終使用日時 Map を取得する */
export function getAllLastUsed(): Record<string, number> {
	return load().lastUsed;
}

/**
 * 最終使用日順 Top N エージェント名を返す。
 * @param n 件数（デフォルト 5）
 */
export function getRecentlyUsed(n = 5): string[] {
	const lastUsed = load().lastUsed;
	return Object.entries(lastUsed)
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([name]) => name);
}

/**
 * 最終使用日時を相対表記に変換する。
 * 例: "3時間前" / "2日前" / "1分前" / "たった今"
 */
export function relativeTime(ms: number): string {
	if (!ms) { return '未使用'; }
	const diff = Date.now() - ms;
	const sec = Math.floor(diff / 1000);
	if (sec < 60)    { return 'たった今'; }
	const min = Math.floor(sec / 60);
	if (min < 60)    { return `${min}分前`; }
	const hour = Math.floor(min / 60);
	if (hour < 24)   { return `${hour}時間前`; }
	const day = Math.floor(hour / 24);
	if (day < 30)    { return `${day}日前`; }
	const month = Math.floor(day / 30);
	if (month < 12)  { return `${month}ヶ月前`; }
	return `${Math.floor(month / 12)}年前`;
}

// -------------------------------------------------------------------
// 初期化（マイグレーション用）
// -------------------------------------------------------------------

/** csm-agent-meta.json が存在しない場合に空ファイルを作成 */
export function initAgentMetaFile(): void {
	if (!fs.existsSync(META_FILE)) {
		save({ bookmarks: [], lastUsed: {} });
	}
}
