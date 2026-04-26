// config.ts — VS Code設定値取得ヘルパー

import * as vscode from 'vscode';

export function getConfig<T>(key: string, defaultValue: T): T {
	return vscode.workspace.getConfiguration('claudeManager').get<T>(key, defaultValue);
}

/**
 * claudeManager.locale: UIの表示言語を取得する。
 * デフォルト: 'ja'
 */
export function getLocaleConfig(): string {
	return getConfig<string>('locale', 'ja');
}

/**
 * claudeManager.locale.autoTranslate: 自動翻訳フラグを取得する。
 * true の場合、未翻訳テキストを Anthropic API で自動翻訳する（APIキー必要）。
 * デフォルト: false
 */
export function getAutoTranslateConfig(): boolean {
	return getConfig<boolean>('locale.autoTranslate', false);
}
