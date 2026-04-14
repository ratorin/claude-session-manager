// config.ts — VS Code設定値取得ヘルパー

import * as vscode from 'vscode';

export function getConfig<T>(key: string, defaultValue: T): T {
	return vscode.workspace.getConfiguration('claudeManager').get<T>(key, defaultValue);
}
