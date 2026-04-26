/**
 * snippetLibrary.ts — v0.5.0 T3.1
 * エージェントロール「機能追加」スニペット管理サービス (F11)
 *
 * スニペット読み込み元（優先順）:
 *   1. ~/.claude/csm-snippets/*.json  (ユーザー定義)
 *   2. data/snippets/core.json         (同梱標準)
 *
 * 各スニペットは agentFormPanel の役割本文に挿入されるテキストブロック。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export type SnippetCategory = 'workflow' | 'constraint' | 'communication' | 'tool-note' | 'custom';

export interface Snippet {
    /** 一意ID (例: "core-tdd-workflow") */
    id: string;
    /** 表示名（日本語可） */
    title: string;
    /** カテゴリ */
    category: SnippetCategory;
    /** 説明（UIに表示） */
    description: string;
    /** 挿入本文テキスト */
    body: string;
    /** ソースファイル（読み込み元） */
    source: 'core' | 'user';
    /** タグ（フィルタ用） */
    tags?: string[];
}

export interface SnippetFile {
    version: number;
    snippets: Snippet[];
}

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

const USER_SNIPPETS_DIR = path.join(os.homedir(), '.claude', 'csm-snippets');

// -------------------------------------------------------------------
// 内部ヘルパー
// -------------------------------------------------------------------

function resolveCoreFile(): string {
    // __dirname = out/services/ → up 2 levels → project root → data/snippets/
    return path.join(path.dirname(path.dirname(__dirname)), 'data', 'snippets', 'core.json');
}

function loadFile(filePath: string, source: 'core' | 'user'): Snippet[] {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SnippetFile;
        if (!Array.isArray(parsed.snippets)) { return []; }
        return parsed.snippets.map(s => ({ ...s, source }));
    } catch {
        return [];
    }
}

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/**
 * 全スニペットをロードする。
 * ユーザー定義が同一IDを持つ場合、コアを上書き。
 */
export function loadAll(): Snippet[] {
    const coreSnippets = loadFile(resolveCoreFile(), 'core');

    // ユーザー定義スニペット
    const userSnippets: Snippet[] = [];
    if (fs.existsSync(USER_SNIPPETS_DIR)) {
        try {
            const files = fs.readdirSync(USER_SNIPPETS_DIR).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(USER_SNIPPETS_DIR, file);
                const loaded = loadFile(filePath, 'user');
                userSnippets.push(...loaded);
            }
        } catch { /* 読み込みエラーは無視 */ }
    }

    // マージ：ユーザー定義が同ID のコアスニペットを上書き
    const merged = new Map<string, Snippet>();
    for (const s of coreSnippets) { merged.set(s.id, s); }
    for (const s of userSnippets) { merged.set(s.id, s); }
    return Array.from(merged.values());
}

/**
 * カテゴリでフィルタリング
 */
export function filterByCategory(snippets: Snippet[], category: SnippetCategory): Snippet[] {
    return snippets.filter(s => s.category === category);
}

/**
 * キーワード検索（title / description / tags）
 */
export function search(snippets: Snippet[], query: string): Snippet[] {
    if (!query.trim()) { return snippets; }
    const lower = query.toLowerCase();
    return snippets.filter(s =>
        s.title.toLowerCase().includes(lower) ||
        s.description.toLowerCase().includes(lower) ||
        (s.tags ?? []).some(t => t.toLowerCase().includes(lower))
    );
}

/**
 * IDでスニペットを取得
 */
export function getById(id: string): Snippet | undefined {
    return loadAll().find(s => s.id === id);
}

/**
 * ユーザー定義スニペットを保存する
 */
export function saveUserSnippet(snippet: Omit<Snippet, 'source'>): void {
    fs.mkdirSync(USER_SNIPPETS_DIR, { recursive: true });
    const filePath = path.join(USER_SNIPPETS_DIR, 'custom.json');

    let existing: SnippetFile = { version: 1, snippets: [] };
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SnippetFile;
        if (Array.isArray(parsed.snippets)) { existing = parsed; }
    } catch { /* ファイル未存在 or パースエラー */ }

    // 同一IDを更新 or 追加
    const idx = existing.snippets.findIndex(s => s.id === snippet.id);
    const fullSnippet: Snippet = { ...snippet, source: 'user' };
    if (idx >= 0) {
        existing.snippets[idx] = fullSnippet;
    } else {
        existing.snippets.push(fullSnippet);
    }

    fs.writeFileSync(filePath, JSON.stringify(existing, null, '\t'), 'utf-8');
}

/**
 * ユーザー定義スニペットを削除する
 */
export function deleteUserSnippet(id: string): void {
    const filePath = path.join(USER_SNIPPETS_DIR, 'custom.json');
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as SnippetFile;
        if (!Array.isArray(parsed.snippets)) { return; }
        parsed.snippets = parsed.snippets.filter(s => s.id !== id);
        fs.writeFileSync(filePath, JSON.stringify(parsed, null, '\t'), 'utf-8');
    } catch { /* ファイル未存在は無視 */ }
}

/**
 * スニペット本文をエージェントロール本文に挿入する位置を決定して返す。
 * - `### 利用可能スキル` 節が存在する → その節の末尾に追加
 * - `### 利用ツール` 節が存在する → その節の末尾に追加
 * - それ以外 → 末尾に追加
 *
 * @param currentBody 現在の役割本文
 * @param snippet     挿入するスニペット
 * @returns 挿入後の本文
 */
export function insertIntoBody(currentBody: string, snippet: Snippet): string {
    const sep = '\n\n';
    const trimmed = currentBody.trimEnd();

    // 専用セクションに追記するパターン
    if (snippet.category === 'tool-note') {
        const sectionHeader = '### 利用ツール';
        const idx = trimmed.indexOf(sectionHeader);
        if (idx >= 0) {
            // セクション末尾を見つけて挿入
            const after = trimmed.indexOf('\n###', idx + sectionHeader.length);
            if (after >= 0) {
                return trimmed.slice(0, after) + '\n' + snippet.body + trimmed.slice(after) + '\n';
            }
            return trimmed + '\n' + snippet.body + '\n';
        }
        return trimmed + sep + sectionHeader + '\n' + snippet.body + '\n';
    }

    if (snippet.category === 'workflow') {
        const sectionHeader = '### 利用可能スキル';
        const idx = trimmed.indexOf(sectionHeader);
        if (idx >= 0) {
            const after = trimmed.indexOf('\n###', idx + sectionHeader.length);
            if (after >= 0) {
                return trimmed.slice(0, after) + '\n' + snippet.body + trimmed.slice(after) + '\n';
            }
            return trimmed + '\n' + snippet.body + '\n';
        }
    }

    // デフォルト: 末尾に追加
    return trimmed + sep + snippet.body + '\n';
}
