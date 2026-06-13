// migrationService.ts — CSMバージョンアップ時のマイグレーション統括
// v0.3.x → v0.4.x 移行処理をまとめて実行する

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MIGRATION_VERSION_KEY = 'csm.lastMigratedVersion';
const SESSION_MANAGER_FILE = path.join(os.homedir(), '.claude', 'session-manager.json');

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

	// v0.4.3未満からのアップグレードで実行（0.4.3で空sessionIdクリーンアップ追加）
	if (!versionLessThan(lastVersion, '0.4.3')) {
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

	// 2. 空sessionIdエントリのクリーンアップ（過去バグで空文字が保存された件への対処）
	const cleanedCount = await cleanupEmptySessionIds(outputChannel);
	if (cleanedCount > 0) {
		outputChannel.appendLine(`[Migration] 空sessionIdクリーンアップ: ${cleanedCount}件`);
		vscode.window.showInformationMessage(
			`CSMマイグレーション: ${cleanedCount}件のエージェントで空のセッション紐づけをクリーンアップしました。紐づけ直してください。`
		);
	}

	// 3. バージョンを記録
	await setLastMigratedVersion(ctx, currentVersion);
	outputChannel.appendLine(`[Migration] 完了 → v${currentVersion} を記録`);
}

// 空sessionIdまたは実ファイル不在のsessionIdをクリア（過去バグのクリーンアップ）
async function cleanupEmptySessionIds(outputChannel: vscode.OutputChannel): Promise<number> {
	try {
		await fs.promises.access(SESSION_MANAGER_FILE);
	} catch {
		return 0;
	}

	let content: string;
	try {
		content = await fs.promises.readFile(SESSION_MANAGER_FILE, 'utf-8');
	} catch {
		return 0;
	}

	let data: { agentSessions?: Record<string, { sessionId?: string; sessionMode?: string; previousSessionIds?: string[] }> };
	try {
		data = JSON.parse(content);
	} catch {
		return 0;
	}

	if (!data.agentSessions) { return 0; }

	const projectsDir = path.join(os.homedir(), '.claude', 'projects');
	let projectSubdirs: string[] = [];
	try {
		const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
		projectSubdirs = entries.filter(e => e.isDirectory()).map(e => path.join(projectsDir, e.name));
	} catch {
		// projects ディレクトリが無ければ空sessionIdのみクリーンアップ
	}

	let cleaned = 0;
	for (const [name, binding] of Object.entries(data.agentSessions)) {
		const sid = binding.sessionId;
		if (!sid) { continue; } // 既に空ならスキップ（明示的にクリアする必要なし）
		// ファイル実在チェック
		let exists = false;
		for (const pDir of projectSubdirs) {
			try {
				await fs.promises.access(path.join(pDir, `${sid}.jsonl`));
				exists = true;
				break;
			} catch { /* next */ }
		}
		if (!exists) {
			binding.sessionId = '';
			cleaned++;
			outputChannel.appendLine(`[Migration] ${name}: 不在sessionId ${sid.substring(0, 8)}... をクリア`);
		}
	}

	// 初期化バックアップ付き書き込み
	if (cleaned > 0) {
		const backup = SESSION_MANAGER_FILE + `.bak.${Date.now()}`;
		try {
			await fs.promises.copyFile(SESSION_MANAGER_FILE, backup);
			await fs.promises.writeFile(SESSION_MANAGER_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
		} catch (err) {
			outputChannel.appendLine(`[Migration] クリーンアップ書き込み失敗: ${err}`);
			return 0;
		}
	}
	return cleaned;
}

// -------------------------------------------------------------------
// v0.5.0 マイグレーション
// -------------------------------------------------------------------

/**
 * v0.5.0 マイグレーション統括。
 * - data/i18n パスの初期化確認
 * - csm-projects.json の初期スキーマ生成
 * - global-agents-i18n.json バックアップ（旧パスの保全）
 */
export async function runV05Migration(
	ctx: vscode.ExtensionContext,
	currentVersion: string,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	const lastVersion = getLastMigratedVersion(ctx);

	// v0.5.0未満からのアップグレードで実行
	if (!versionLessThan(lastVersion, '0.5.0')) {
		return;
	}

	outputChannel.appendLine(`[Migration v0.5] v${lastVersion} → v${currentVersion} マイグレーション開始`);

	// 1. csm-projects.json 初期スキーマ生成
	const projectsFile = path.join(os.homedir(), '.claude', 'csm-projects.json');
	if (!fs.existsSync(projectsFile)) {
		try {
			await fs.promises.writeFile(projectsFile, JSON.stringify({ projects: [] }, null, '\t'), 'utf-8');
			outputChannel.appendLine('[Migration v0.5] csm-projects.json を初期化しました');
		} catch (err) {
			outputChannel.appendLine(`[Migration v0.5] csm-projects.json 初期化失敗: ${err}`);
		}
	}

	// 2. data/i18n/ja/ ディレクトリの存在確認（パッケージに含まれるはずだがログ）
	const dataDir = path.join(path.dirname(path.dirname(__dirname)), 'data');
	const i18nDir = path.join(dataDir, 'i18n', 'ja');
	if (!fs.existsSync(i18nDir)) {
		outputChannel.appendLine('[Migration v0.5] 警告: data/i18n/ja/ が存在しません。再インストールをお試しください。');
	} else {
		outputChannel.appendLine('[Migration v0.5] data/i18n/ja/ 確認OK');
	}

	// 3. バージョンを記録
	await setLastMigratedVersion(ctx, currentVersion);
	outputChannel.appendLine(`[Migration v0.5] 完了 → v${currentVersion} を記録`);
}

// usage.showRemaining を既定 ON にする一度きりのマイグレーション（v0.5.10）
// - 未設定ユーザー: 新しい default(true) が自動適用されるため何もしない
// - 明示的に false にしているユーザー: 一度だけ true へ flip（更新者も ON にする要望）
// - 一度実行したらフラグを立て、以降は再強制しない（ユーザーが後で OFF にしても尊重）
const SHOW_REMAINING_ON_KEY = 'csm.migration.usageShowRemainingDefaultOn.v1';

export async function runUsageShowRemainingMigration(
	ctx: vscode.ExtensionContext,
	outputChannel: vscode.OutputChannel,
): Promise<void> {
	if (ctx.globalState.get<boolean>(SHOW_REMAINING_ON_KEY, false)) { return; }
	try {
		const cfg = vscode.workspace.getConfiguration('claudeManager');
		const inspected = cfg.inspect<boolean>('usage.showRemaining');
		if (inspected?.globalValue === false) {
			await cfg.update('usage.showRemaining', true, vscode.ConfigurationTarget.Global);
			outputChannel.appendLine('[Migration] usage.showRemaining: 明示 OFF を既定 ON へ更新しました');
		}
		// globalValue が undefined（未設定）の場合は default(true) が効くため何もしない
	} catch (err) {
		outputChannel.appendLine(`[Migration] usage.showRemaining 更新失敗: ${err}`);
	}
	await ctx.globalState.update(SHOW_REMAINING_ON_KEY, true);
}
