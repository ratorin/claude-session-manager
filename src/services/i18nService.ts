/**
 * i18nService.ts — v0.5.0 T1.6 / T3.8
 * 辞書ロード + キャッシュ。翻訳APIはAnthropicAPIで自動翻訳（T3.8実装）。
 *
 * ロード優先順:
 *   1. data/i18n/{locale}/*.json
 *   2. data/i18n/ja/*.json (フォールバック)
 * キャッシュはプロセス起動中は不変（ファイル変更は再起動で反映）。
 *
 * 自動翻訳:
 *   - claudeManager.locale.autoTranslate: true の場合のみ API 呼び出し
 *   - Claude Haiku 4.5 使用（コスト優先）
 *   - 結果は data/i18n/ja/cache.json にキャッシュ
 *   - キャッシュキー: SHA-256(text) の16進数
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export type I18nDict = Record<string, unknown>;

export interface I18nNamespace {
    agents: Record<string, { displayName?: string; displayDescription?: string; displayRole?: string }>;
    skills: Record<string, { displayName?: string; displayDescription?: string }>;
    tools:  Record<string, { displayName?: string; displayDescription?: string }>;
    ui:     Record<string, unknown>;
}

interface TranslationCacheEntry {
    translatedText: string;
    confidence_score: number;
    createdAt: string;
}

type TranslationCache = Record<string, TranslationCacheEntry>;

interface AnthropicMessageResponse {
    content: Array<{ type: string; text: string }>;
}

// -------------------------------------------------------------------
// モジュールスコープキャッシュ
// -------------------------------------------------------------------

let _cache: I18nNamespace | null = null;
let _locale: string = 'ja';
let _translationCache: TranslationCache | null = null;
let _autoTranslate: boolean = false;

// -------------------------------------------------------------------
// 内部ヘルパー
// -------------------------------------------------------------------

function loadJson(filePath: string): Record<string, unknown> {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return {};
    }
}

function resolveDataDir(): string {
    // __dirname = out/services/ → up 2 levels → project root → data/
    return path.join(path.dirname(path.dirname(__dirname)), 'data');
}

function loadNamespace(dataDir: string, locale: string, filename: string): Record<string, unknown> {
    const localePath = path.join(dataDir, 'i18n', locale, filename);
    if (locale !== 'ja' && !fs.existsSync(localePath)) {
        // フォールバック: ja
        const fallback = path.join(dataDir, 'i18n', 'ja', filename);
        return loadJson(fallback);
    }
    return loadJson(localePath);
}

function buildCacheKey(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function loadTranslationCache(): TranslationCache {
    if (_translationCache !== null) {
        return _translationCache;
    }
    const dataDir = resolveDataDir();
    const cachePath = path.join(dataDir, 'i18n', 'ja', 'cache.json');
    try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        _translationCache = JSON.parse(raw) as TranslationCache;
    } catch {
        _translationCache = {};
    }
    return _translationCache;
}

function saveTranslationCache(cache: TranslationCache): void {
    const dataDir = resolveDataDir();
    const cachePath = path.join(dataDir, 'i18n', 'ja', 'cache.json');
    try {
        fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8');
    } catch {
        // キャッシュ保存失敗は無視（次回の翻訳で再試行）
    }
}

async function callAnthropicTranslateApi(text: string): Promise<string> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
        return text;
    }

    const prompt = `次の英語テキストを簡潔な日本語に翻訳してください（30文字以内）: ${text}`;

    const body = JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
        },
        body,
    });

    if (!response.ok) {
        return text;
    }

    const data = await response.json() as AnthropicMessageResponse;
    const translated = data.content?.[0]?.text?.trim();
    return translated ?? text;
}

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/**
 * ロケールを設定する（拡張機能設定変更時に呼び出す）。
 * キャッシュをクリアし、次回 get() で再ロードされる。
 */
export function setLocale(locale: string): void {
    if (_locale !== locale) {
        _locale = locale;
        _cache = null;
    }
}

/** 現在のロケールを返す */
export function getLocale(): string {
    return _locale;
}

/**
 * 自動翻訳フラグを設定する（claudeManager.locale.autoTranslate 設定値）。
 */
export function setAutoTranslate(enabled: boolean): void {
    _autoTranslate = enabled;
}

/** 自動翻訳フラグを返す */
export function getAutoTranslate(): boolean {
    return _autoTranslate;
}

/** 辞書を取得する（必要に応じてロード） */
export function getI18n(): I18nNamespace {
    if (_cache !== null) {
        return _cache;
    }
    const dataDir = resolveDataDir();
    _cache = {
        agents: loadNamespace(dataDir, _locale, 'agents.json') as I18nNamespace['agents'],
        skills: loadNamespace(dataDir, _locale, 'skills.json') as I18nNamespace['skills'],
        tools:  loadNamespace(dataDir, _locale, 'tools.json')  as I18nNamespace['tools'],
        ui:     loadNamespace(dataDir, _locale, 'ui.json'),
    };
    return _cache;
}

/**
 * UIテキストをドット区切りキーで取得する。
 * 例: t('sessions.newSession') → "新規セッション"
 * キーが見つからなければ key をそのまま返す。
 */
export function t(key: string): string {
    const ui = getI18n().ui;
    const parts = key.split('.');
    let node: unknown = ui;
    for (const part of parts) {
        if (node === null || typeof node !== 'object') {
            return key;
        }
        node = (node as Record<string, unknown>)[part];
    }
    return typeof node === 'string' ? node : key;
}

/**
 * エージェント表示名を取得する。
 * 見つからない場合は undefined を返す（呼び出し元で生データを使用）。
 */
export function agentDisplayName(agentName: string): string | undefined {
    return getI18n().agents[agentName]?.displayName;
}

/**
 * エージェント表示説明を取得する。
 */
export function agentDisplayDescription(agentName: string): string | undefined {
    return getI18n().agents[agentName]?.displayDescription;
}

/**
 * スキル表示名を取得する。
 */
export function skillDisplayName(skillName: string): string | undefined {
    return getI18n().skills[skillName]?.displayName;
}

/**
 * ツール表示名を取得する。
 */
export function toolDisplayName(toolName: string): string | undefined {
    return getI18n().tools[toolName]?.displayName;
}

// -------------------------------------------------------------------
// T3.8: 翻訳API実装（stub解除）
// -------------------------------------------------------------------

/**
 * テキストを自動翻訳する。
 *
 * 動作フロー:
 *   1. autoTranslate が false → 原文をそのまま返す
 *   2. キャッシュに存在 → キャッシュ値を返す（API呼び出しスキップ）
 *   3. ANTHROPIC_API_KEY 未設定 → 原文を返す
 *   4. API呼び出し → 成功時はキャッシュに保存して翻訳文を返す
 *   5. API失敗 → 原文をフォールバックとして返す
 *
 * @param text 翻訳元テキスト（英語想定）
 * @param _targetLocale 翻訳先ロケール（現在は 'ja' 固定）
 */
export async function translateText(text: string, _targetLocale?: string): Promise<string> {
    if (!text || !text.trim()) {
        return text;
    }

    // autoTranslate フラグが false の場合はスキップ
    if (!_autoTranslate) {
        return text;
    }

    const cacheKey = buildCacheKey(text);
    const cache = loadTranslationCache();

    // キャッシュヒット
    const cached = cache[cacheKey];
    if (cached !== undefined) {
        return cached.translatedText;
    }

    // API呼び出し
    try {
        const translated = await callAnthropicTranslateApi(text);

        // 翻訳結果をキャッシュに保存（不変オブジェクトとして新しいエントリを作成）
        const newEntry: TranslationCacheEntry = {
            translatedText: translated,
            confidence_score: 0.9,
            createdAt: new Date().toISOString(),
        };
        const updatedCache: TranslationCache = { ...cache, [cacheKey]: newEntry };
        _translationCache = updatedCache;
        saveTranslationCache(updatedCache);

        return translated;
    } catch {
        // 失敗時は原文フォールバック
        return text;
    }
}
