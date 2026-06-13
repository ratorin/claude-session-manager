// csmHookCleanup.ts — CSM hook のクリーンアップ共通ロジック
//
// 重要: このモジュールは vscode に依存しない（fs/path のみ）。
// vscode:uninstall で実行される out/uninstall.js は VS Code API を使えないため、
// アンインストール処理（A案）とコマンド（B案）の両方からこの純粋ロジックを共有する。

import * as fs from 'fs';
import * as path from 'path';

/**
 * CSM が settings.json に登録する hook を識別するマーカー一覧。
 * command 文字列 / args 配列のいずれかにこの文字列を含めば「CSM の hook」と判定する。
 * （exec-form / shell-form / Windows パス / Linux パスのいずれでもマッチする）
 */
export const CSM_HOOK_MARKERS: readonly string[] = [
	'csm-precompact',          // csm-precompact.js / csm-precompact-summary.js 両方にマッチ
	'csm-recap-capture',
	'csm-session-stop',
	'csm-session-agent-inject',
	'csm-governance-capture',
	'csm-check-ask-agent',
	'csm-injection-detect',
	'check-csm-ask-agent',     // 旧 bash 版マーカー（check-csm-ask-agent.sh）
	'csm/subagent-signal',     // CSM が登録した SubagentStart/Stop（スクリプト本体は ECC 所有）
];

function hookIsCsm(hh: unknown): boolean {
	if (!hh || typeof hh !== 'object') { return false; }
	const h = hh as Record<string, unknown>;
	if (typeof h.command === 'string' && CSM_HOOK_MARKERS.some((m) => (h.command as string).includes(m))) {
		return true;
	}
	if (Array.isArray(h.args) && (h.args as unknown[]).some(
		(a) => typeof a === 'string' && CSM_HOOK_MARKERS.some((m) => a.includes(m))
	)) {
		return true;
	}
	return false;
}

export interface RemovalCount { removed: number; }

/**
 * settings オブジェクトから CSM hook を除去する（in-place 変更）。
 * - matcher グループ内の CSM hook を除去
 * - グループが空になればグループごと削除
 * - イベントキーが空配列になればキーごと削除
 *
 * @returns 1 件でも除去したら true
 */
export function filterCsmHooks(
	settings: Record<string, unknown>,
	count: RemovalCount = { removed: 0 }
): boolean {
	const hooksObj = settings.hooks as Record<string, unknown> | undefined;
	if (!hooksObj || typeof hooksObj !== 'object' || Array.isArray(hooksObj)) { return false; }

	let changed = false;
	for (const eventKey of Object.keys(hooksObj)) {
		const entries = hooksObj[eventKey];
		if (!Array.isArray(entries)) { continue; }

		const newEntries: unknown[] = [];
		for (const entry of entries as Array<Record<string, unknown>>) {
			const innerHooks = entry && (entry.hooks as unknown[] | undefined);
			if (!Array.isArray(innerHooks)) { newEntries.push(entry); continue; }

			const kept = innerHooks.filter((hh) => {
				if (hookIsCsm(hh)) { count.removed++; changed = true; return false; }
				return true;
			});

			if (kept.length === 0) {
				changed = true; // この matcher グループは空 → 丸ごと捨てる
			} else if (kept.length !== innerHooks.length) {
				newEntries.push({ ...entry, hooks: kept });
			} else {
				newEntries.push(entry);
			}
		}

		if (newEntries.length === 0) {
			delete hooksObj[eventKey]; // イベントが空 → キーごと削除
			changed = true;
		} else {
			hooksObj[eventKey] = newEntries;
		}
	}
	return changed;
}

export interface SettingsRemovalResult { changed: boolean; removed: number; backupPath?: string; }

/**
 * settings.json を読み込み、CSM hook を除去して書き戻す（standalone・vscode 非依存）。
 * 書き込み前にバックアップを取り、書き込み内容の JSON 妥当性を検証する。
 * vscode:uninstall（out/uninstall.js）から使う。
 */
export function removeCsmHooksFromSettings(settingsPath: string): SettingsRemovalResult {
	let raw: string;
	try { raw = fs.readFileSync(settingsPath, 'utf-8'); } catch { return { changed: false, removed: 0 }; }

	let settings: Record<string, unknown>;
	try { settings = JSON.parse(raw); } catch { return { changed: false, removed: 0 }; }

	const count: RemovalCount = { removed: 0 };
	const changed = filterCsmHooks(settings, count);
	if (!changed) { return { changed: false, removed: 0 }; }

	const serialized = JSON.stringify(settings, null, '\t');
	try { JSON.parse(serialized); } catch { return { changed: false, removed: 0 }; } // 念のため検証

	const backupPath = `${settingsPath}.bak.${Date.now()}`;
	try { fs.copyFileSync(settingsPath, backupPath); } catch { /* バックアップ失敗は続行 */ }
	fs.writeFileSync(settingsPath, serialized, 'utf-8');
	pruneOldSettingsBackups(settingsPath);
	return { changed: true, removed: count.removed, backupPath };
}

/**
 * `<settings.json>.bak.*` バックアップを新しい順に keep 件だけ残し、古いものを削除する。
 * （ensure 系 / クリーンアップで毎回バックアップを作るため、無制限な蓄積を防ぐ）
 * vscode 非依存。失敗しても無視。
 */
export function pruneOldSettingsBackups(settingsPath: string, keep = 5): void {
	try {
		const dir = path.dirname(settingsPath);
		const prefix = `${path.basename(settingsPath)}.bak.`;
		const backups = fs.readdirSync(dir)
			.filter((f) => f.startsWith(prefix))
			.map((f) => {
				const full = path.join(dir, f);
				let mtime = 0;
				try { mtime = fs.statSync(full).mtimeMs; } catch { /* */ }
				return { full, mtime };
			})
			.sort((a, b) => b.mtime - a.mtime); // 新しい順
		for (const { full } of backups.slice(Math.max(0, keep))) {
			try { fs.unlinkSync(full); } catch { /* 個別削除失敗は無視 */ }
		}
	} catch { /* readdir 失敗等は無視 */ }
}

export interface ScriptTrashResult { moved: number; }

/**
 * ~/.claude/hooks/csm-*.js を .trash/ へ退避する。
 * ECC 所有の ~/.claude/scripts/csm/（subagent-signal.js 等）には触れない。
 */
export function trashCsmHookScripts(homeDir: string): ScriptTrashResult {
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	let files: string[];
	try { files = fs.readdirSync(hooksDir); } catch { return { moved: 0 }; }

	const trashDir = path.join(hooksDir, '.trash');
	let moved = 0;
	for (const f of files) {
		if (!/^csm-.*\.js$/.test(f)) { continue; }
		try {
			fs.mkdirSync(trashDir, { recursive: true });
			fs.renameSync(path.join(hooksDir, f), path.join(trashDir, `${f}.${Date.now()}`));
			moved++;
		} catch { /* 個別の移動失敗は無視 */ }
	}
	return { moved };
}

export interface CleanupResult { settings: SettingsRemovalResult; scripts: ScriptTrashResult; }

/**
 * CSM hook の全クリーンアップ（settings.json 除去 + スクリプト退避）。standalone・vscode 非依存。
 */
export function cleanupAllCsm(homeDir: string): CleanupResult {
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	return {
		settings: removeCsmHooksFromSettings(settingsPath),
		scripts: trashCsmHookScripts(homeDir),
	};
}
