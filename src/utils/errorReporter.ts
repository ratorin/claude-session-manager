// errorReporter.ts — エラーをローカルファイルに蓄積し、GitHub Issue作成を支援する
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOG_FILE = path.join(os.homedir(), '.claude', 'csm-errors.log');
const MAX_LOG_SIZE = 512 * 1024; // 512KB でローテート

export interface ErrorEntry {
	timestamp: string;
	level: 'error' | 'warn';
	source: string;
	message: string;
	stack?: string;
}

let _version = 'unknown';

export function initErrorReporter(version: string): void {
	_version = version;
}

// エラーをログファイルに追記（非同期・失敗しても無視）
export async function logError(level: 'error' | 'warn', source: string, err: unknown): Promise<void> {
	const entry: ErrorEntry = {
		timestamp: new Date().toISOString(),
		level,
		source,
		message: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	};
	const line = JSON.stringify(entry) + '\n';
	try {
		// サイズ超過時はローテート
		try {
			const stat = await fs.promises.stat(LOG_FILE);
			if (stat.size > MAX_LOG_SIZE) {
				await fs.promises.rename(LOG_FILE, LOG_FILE + '.old');
			}
		} catch { /* ファイル未作成なら無視 */ }

		await fs.promises.mkdir(path.dirname(LOG_FILE), { recursive: true });
		await fs.promises.appendFile(LOG_FILE, line, 'utf-8');
	} catch {
		// ログ失敗は無視（無限ループ防止）
	}
}

// 直近N件のエラーを読み出し（Issue本文用）
export async function readRecentErrors(limit: number = 20): Promise<ErrorEntry[]> {
	try {
		const content = await fs.promises.readFile(LOG_FILE, 'utf-8');
		const lines = content.split('\n').filter(l => l.trim());
		const recent = lines.slice(-limit);
		const entries: ErrorEntry[] = [];
		for (const line of recent) {
			try { entries.push(JSON.parse(line)); } catch { /* skip */ }
		}
		return entries;
	} catch {
		return [];
	}
}

// GitHub Issue 作成URLを生成してブラウザで開く
export async function reportIssue(): Promise<void> {
	const recent = await readRecentErrors(20);
	const header = [
		'## 環境',
		`- CSM バージョン: ${_version}`,
		`- VS Code: ${vscode.version}`,
		`- OS: ${process.platform} ${os.release()}`,
		`- Node: ${process.version}`,
		'',
		'## 症状・再現手順',
		'（ここに何が起きたか書いてください）',
		'',
		'',
		'## 直近のエラーログ',
		'```',
	];
	const body = [
		...header,
		...recent.map(e => `[${e.timestamp}] ${e.level.toUpperCase()} ${e.source}: ${e.message}`),
		'```',
		'',
		'## 送信情報について',
		'上記ログは `~/.claude/csm-errors.log` から自動抽出されています。',
		'個人情報が含まれる場合は送信前に編集してください。',
	].join('\n');

	const title = encodeURIComponent('[BUG] ');
	const bodyEncoded = encodeURIComponent(body);
	const url = `https://github.com/ratorin/claude-session-manager/issues/new?title=${title}&body=${bodyEncoded}`;

	// URLが長すぎる場合（GitHub制限: 約8000文字）はログファイルを開いて手動貼付を案内
	if (url.length > 7500) {
		const open = await vscode.window.showInformationMessage(
			'エラーログが大きすぎてURLに埋め込めません。ログファイルを開きますか？',
			'ログを開く', 'キャンセル'
		);
		if (open === 'ログを開く') {
			const doc = await vscode.workspace.openTextDocument(LOG_FILE);
			await vscode.window.showTextDocument(doc);
		}
		return;
	}

	await vscode.env.openExternal(vscode.Uri.parse(url));
}

export function getLogFilePath(): string {
	return LOG_FILE;
}
