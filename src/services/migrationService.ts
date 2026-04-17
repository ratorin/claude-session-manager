// migrationService.ts — CSMバージョンアップ時のマイグレーション統括
// v0.3.x → v0.4.x 移行処理をまとめて実行する

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MIGRATION_VERSION_KEY = 'csm.lastMigratedVersion';

// 前回マイグレーション実行時のバージョンを取得
export function getLastMigratedVersion(ctx: vscode.ExtensionContext): string {
	return ctx.globalState.get<string>(MIGRATION_VERSION_KEY, '0.0.0');
}

// マイグレーション完了バージョンを記録
export async function setLastMigratedVersion(ctx: vscode.ExtensionContext, version: string): Promise<void> {
	await ctx.globalState.update(MIGRATION_VERSION_KEY, version);
}

// セマンティックバージョン比較（a < b なら true）
function versionLessThan(a: string, b: string): boolean {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const na = pa[i] ?? 0;
		const nb = pb[i] ?? 0;
		if (na < nb) { return true; }
		if (na > nb) { return false; }
	}
	return false;
}

// YAMLフロントマターのバックスラッシュ増殖を正規化（agents/*.md対象）
async function fixBackslashInAgentsDir(dir: string, outputChannel: vscode.OutputChannel): Promise<number> {
	let fixed = 0;
	try {
		await fs.promises.access(dir);
	} catch {
		return 0; // ディレクトリなし
	}

	const entries = await fs.promises.readdir(dir);
	for (const entry of entries) {
		if (!entry.endsWith('.md')) { continue; }
		const filePath = path.join(dir, entry);
		let content: string;
		try {
			content = await fs.promises.readFile(filePath, 'utf-8');
		} catch {
			continue;
		}

		const lines = content.split('\n');
		let inFrontmatter = false;
		let changed = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === '---') {
				if (!inFrontmatter) { inFrontmatter = true; continue; }
				else { break; }
			}
			if (!inFrontmatter) { continue; }

			// key: "value" でバックスラッシュ4個以上を含む行を検出
			const m = line.match(/^([a-zA-Z_]\w*):\s*"(.*)"$/);
			if (!m || !m[2].includes('\\\\\\\\')) { continue; }

			// \\\\ → \\ → \ と半分ずつデコード
			let value = m[2];
			while (value.includes('\\\\\\\\')) {
				value = value.replace(/\\\\\\\\/g, '\\\\');
			}
			lines[i] = `${m[1]}: "${value}"`;
			changed = true;
		}

		if (changed) {
			// バックアップ
			const backupPath = filePath + `.bak.${Date.now()}`;
			await fs.promises.copyFile(filePath, backupPath);
			await fs.promises.writeFile(filePath, lines.join('\n'), 'utf-8');
			fixed++;
			outputChannel.appendLine(`[Migration] バックスラッシュ修正: ${entry}`);
		}
	}
	return fixed;
}

// v0.4.x マイグレーション統括
export async function runV04Migration(
	ctx: vscode.ExtensionContext,
	currentVersion: string,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const lastVersion = getLastMigratedVersion(ctx);

	// v0.4.0未満からのアップグレードのみ実行
	if (!versionLessThan(lastVersion, '0.4.0')) {
		return;
	}

	outputChannel.appendLine(`[Migration] v${lastVersion} → v${currentVersion} マイグレーション開始`);
	let totalFixed = 0;

	// 1. バックスラッシュ正規化（全agentsディレクトリ対象）
	const scanDirs = [
		path.join(os.homedir(), '.claude', 'agents'),
	];
	// VS Codeの全ワークスペースフォルダも対象
	for (const folder of vscode.workspace.workspaceFolders || []) {
		scanDirs.push(path.join(folder.uri.fsPath, '.claude', 'agents'));
	}
	// 設定の追加ディレクトリ
	const additionalDirs: string[] = vscode.workspace.getConfiguration('claudeManager').get<string[]>('additionalAgentDirs', []);
	for (const base of additionalDirs) {
		if (base) { scanDirs.push(path.join(base, '.claude', 'agents')); }
	}

	for (const dir of scanDirs) {
		const count = await fixBackslashInAgentsDir(dir, outputChannel);
		totalFixed += count;
	}

	if (totalFixed > 0) {
		outputChannel.appendLine(`[Migration] バックスラッシュ修正完了: ${totalFixed}件`);
		vscode.window.showInformationMessage(`CSMマイグレーション: ${totalFixed}件のエージェント設定ファイルを自動修正しました。`);
	}

	// 2. バージョンを記録
	await setLastMigratedVersion(ctx, currentVersion);
	outputChannel.appendLine(`[Migration] 完了 → v${currentVersion} を記録`);
}
