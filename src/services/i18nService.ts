/**
 * i18nService.ts — v0.5.0 T1.6
 * 辞書ロード + キャッシュ。翻訳APIは将来拡張用スタブ。
 *
 * ロード優先順:
 *   1. data/i18n/{locale}/*.json
 *   2. data/i18n/ja/*.json (フォールバック)
 * キャッシュはプロセス起動中は不変（ファイル変更は再起動で反映）。
 */

import * as fs from 'fs';
import * as path from 'path';

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

// -------------------------------------------------------------------
// モジュールスコープキャッシュ
// -------------------------------------------------------------------

let _cache: I18nNamespace | null = null;
let _locale: string = 'ja';

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
// 将来拡張: 翻訳API（スタブ）
// -------------------------------------------------------------------

/**
 * 翻訳APIを呼び出すスタブ。
 * 現在は辞書引きを行うのみ。将来的にはAPI呼び出しに置き換え可能。
 * @param text 翻訳元テキスト
 * @param _targetLocale 翻訳先ロケール（現在は未使用）
 */
export async function translateText(text: string, _targetLocale?: string): Promise<string> {
    // スタブ: 辞書にあればそれを返す、なければ原文を返す
    return text;
}
