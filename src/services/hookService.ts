// hookService.ts — hook管理・組織情報メモリ書き込みロジック
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { AgentConfig } from '../models/types';
import { addToIndex } from '../utils/memoryManager';

// ─── settings.json 排他書き込みキュー ────────────────────────────────────────
// 複数の ensure*Hook が並行起動しても、read→modify→write が直列に実行されるよう
// dataStore.writeQueue と同じ Promise チェーンパターンで保護する（C-3 対策）。
let settingsWriteQueue: Promise<void> = Promise.resolve();

/**
 * settings.json を安全に read→modify→write する共通ヘルパー。
 *
 * @param settingsPath  settings.json の絶対パス
 * @param modifier      settings オブジェクトを受け取り、変更した場合は true を返す純粋関数
 * @param log           任意のロガー（省略可）
 */
async function modifySettingsJson(
	settingsPath: string,
	modifier: (settings: Record<string, unknown>) => boolean,
	log: (msg: string) => void = () => { /* noop */ }
): Promise<void> {
	// Promise チェーンに連結して直列化
	settingsWriteQueue = settingsWriteQueue.then(async () => {
		// 1. 読み込み
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return; // ファイルが存在しない or パース失敗 → スキップ
		}

		// 2. 変更適用（no-op なら早期 return）
		const changed = modifier(settings);
		if (!changed) { return; }

		// 3. バックアップ（書き込み前）
		const backupPath = `${settingsPath}.bak.${Date.now()}`;
		try { await fs.promises.copyFile(settingsPath, backupPath); } catch { /* */ }

		// 4. 書き込み
		const serialized = JSON.stringify(settings, null, '\t');
		await fs.promises.writeFile(settingsPath, serialized, 'utf-8');

		// 5. JSON 検証 — 失敗したらバックアップから復元して例外
		try {
			JSON.parse(serialized);
		} catch {
			// 書き込み内容が不正 → バックアップから復元
			try { await fs.promises.copyFile(backupPath, settingsPath); } catch { /* */ }
			log(`[CSM] settings.json 書き込み後の検証に失敗しました。バックアップを復元しました: ${backupPath}`);
			throw new Error('settings.json JSON validation failed after write');
		}
	}).catch(() => { /* キュー内の例外を握りつぶしてチェーンを維持 */ });

	return settingsWriteQueue;
}

// ─── exec-form サポート (Claude Code 2.1.139+) ────────────────────────────────
// args: string[] 形式はシェル経由しない直接 spawn のためクォート問題が消える。

let _execFormSupported: boolean | null = null;

/** Claude Code バージョンを取得し exec-form (args[]) が使えるか判定（初回のみ実行） */
function supportsExecForm(): boolean {
	if (_execFormSupported !== null) { return _execFormSupported; }
	try {
		const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 3000 });
		const output = (result.stdout || '').trim();
		const m = output.match(/(\d+)\.(\d+)\.(\d+)/);
		if (!m) { _execFormSupported = false; return false; }
		const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
		_execFormSupported = (
			major > 2 ||
			(major === 2 && minor > 1) ||
			(major === 2 && minor === 1 && patch >= 139)
		);
	} catch {
		_execFormSupported = false;
	}
	return _execFormSupported;
}

/**
 * CSM hook オブジェクトを構築（exec-form / shell-form を自動選択）
 * @param scriptPath  フックスクリプトの絶対パス
 * @param timeout     タイムアウト秒数
 * @param extraArgs   スクリプトに渡す追加引数（例: ["start"]）
 * @param extra       追加フィールド（例: { async: true }）
 */
function buildHookDef(
	scriptPath: string,
	timeout: number,
	extraArgs: string[] = [],
	extra: Record<string, unknown> = {}
): Record<string, unknown> {
	const normalizedPath = scriptPath.replace(/\\/g, '/');
	if (supportsExecForm()) {
		return { type: 'command', command: 'node', args: [normalizedPath, ...extraArgs], timeout, ...extra };
	}
	const suffix = extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : '';
	return { type: 'command', command: `node "${normalizedPath}"${suffix}`, timeout, ...extra };
}

/**
 * hook オブジェクトが指定マーカー（スクリプトパスの一部）を含むか判定
 * shell-form: command に含む / exec-form: args に含む
 */
function hookMatchesMarker(hh: Record<string, unknown>, marker: string): boolean {
	if (typeof hh.command === 'string' && hh.command.includes(marker)) { return true; }
	if (Array.isArray(hh.args) && (hh.args as string[]).some((a) => a.includes(marker))) { return true; }
	return false;
}

/**
 * signal hook がマーカーと action 両方に一致するか判定（shell/exec 両形式対応）
 */
function signalHookMatches(hh: Record<string, unknown>, marker: string, action: string): boolean {
	// shell-form: "node \"...signal.js\" start"
	if (typeof hh.command === 'string' && hh.command.includes(marker) && hh.command.includes(action)) { return true; }
	// exec-form: { command: 'node', args: ['...signal.js', 'start'] }
	if (hh.command === 'node' && Array.isArray(hh.args)) {
		const args = hh.args as string[];
		return args.some((a) => a.includes(marker)) && args.includes(action);
	}
	return false;
}

/**
 * shell-form の CSM hook を exec-form に in-place 変換する。
 * 変換した場合は true を返す。
 */
function migrateHookToExecForm(hh: Record<string, unknown>): boolean {
	if (!supportsExecForm()) { return false; }
	if (typeof hh.command !== 'string') { return false; }
	if (hh.command === 'node' && Array.isArray(hh.args)) { return false; } // 既に exec-form
	// shell-form: node "/path/script.js" [arg1 arg2 ...]
	const m = (hh.command as string).match(/^node\s+"([^"]+)"(.*)$/);
	if (!m) { return false; }
	const scriptPath = m[1];
	const rest = m[2].trim();
	hh.command = 'node';
	hh.args = rest ? [scriptPath, ...rest.split(/\s+/)] : [scriptPath];
	return true;
}

// SubagentStart/Stop フックを settings.json に登録する
export async function ensureSubagentHooks(outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const signalScript = path.join(homeDir, '.claude', 'scripts', 'csm', 'subagent-signal.js');

	// シグナルスクリプトが存在しなければスキップ
	try {
		await fs.promises.access(signalScript);
	} catch {
		return;
	}

	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			const CSM_SIGNAL_MARKER = 'csm/subagent-signal.js';

			const hasSignalHook = (eventKey: string, action: string): boolean => {
				const entries = hooksObj[eventKey];
				if (!Array.isArray(entries)) { return false; }
				return entries.some((entry: Record<string, unknown>) => {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { return false; }
					return innerHooks.some((hh: Record<string, unknown>) =>
						signalHookMatches(hh, CSM_SIGNAL_MARKER, action)
					);
				});
			};

			const removeStaleSignalHooks = (eventKey: string): boolean => {
				const entries = hooksObj[eventKey];
				if (!Array.isArray(entries)) { return false; }
				const originalLen = entries.length;
				const filtered = entries.filter((entry: Record<string, unknown>) => {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { return true; }
					return !innerHooks.some((hh: Record<string, unknown>) =>
						hookMatchesMarker(hh, CSM_SIGNAL_MARKER)
					);
				});
				if (filtered.length !== originalLen) {
					hooksObj[eventKey] = filtered;
					return true;
				}
				return false;
			};

			const addSignalHook = (eventKey: string, action: string): void => {
				if (!Array.isArray(hooksObj[eventKey])) {
					hooksObj[eventKey] = [];
				}
				const entries = hooksObj[eventKey] as Array<Record<string, unknown>>;
				const hook = buildHookDef(signalScript, 10, [action], { async: true });
				const existing = entries.find((e: Record<string, unknown>) => e.matcher === '*');
				if (existing && Array.isArray(existing.hooks)) {
					(existing.hooks as Array<Record<string, unknown>>).push(hook);
				} else {
					entries.push({ matcher: '*', hooks: [hook] });
				}
			};

			const removedFromStop = removeStaleSignalHooks('Stop');
			const removedFromSessionStart = removeStaleSignalHooks('SessionStart');
			const hasStart = hasSignalHook('SubagentStart', 'start');
			const hasStop = hasSignalHook('SubagentStop', 'stop');

			let changed = removedFromStop || removedFromSessionStart;
			if (!hasStart) { addSignalHook('SubagentStart', 'start'); changed = true; }
			if (!hasStop) { addSignalHook('SubagentStop', 'stop'); changed = true; }
			return changed;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] SubagentStart/Stop フックを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] フック登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// SessionStart hookでエージェント役割自動注入（デプロイ+settings.json登録）
export async function ensureSessionAgentInjectHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	// Node.js版スクリプト（bash+python非依存、Windows対応）
	const hookScript = path.join(hooksDir, 'csm-session-agent-inject.js');
	const CSM_MARKER = 'csm-session-agent-inject';

	// 1. テンプレートからスクリプトをデプロイ（存在しなければ、または古いsh版なら置き換え）
	const oldShScript = path.join(hooksDir, 'csm-session-agent-inject.sh');
	try {
		await fs.promises.access(hookScript);
	} catch {
		const templatePath = path.join(extensionPath, 'templates', 'csm-session-agent-inject.js');
		try {
			const content = await fs.promises.readFile(templatePath, 'utf-8');
			await fs.promises.mkdir(hooksDir, { recursive: true });
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			// 古いsh版は.trashに退避
			try {
				await fs.promises.access(oldShScript);
				const trashDir = path.join(hooksDir, '.trash');
				await fs.promises.mkdir(trashDir, { recursive: true });
				await fs.promises.rename(oldShScript, path.join(trashDir, `csm-session-agent-inject.sh.${Date.now()}`));
			} catch { /* shファイルが存在しない場合は無視 */ }
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-session-agent-inject.js をデプロイしました`);
		} catch {
			return;
		}
	}

	// 2. settings.json にSessionStart hookを登録
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;

			// 既に登録済みか確認（旧bash版をNode.js版に自動マイグレーション）
			const sessionStart = hooksObj['SessionStart'];
			if (Array.isArray(sessionStart)) {
				let needsMigration = false;
				let alreadyNodeInstalled = false;

				for (const entry of sessionStart as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
						// shell-form .sh → 要マイグレーション
						if (typeof hh.command === 'string' && hh.command.includes('.sh')) {
							needsMigration = true;
						} else {
							// .js shell-form または exec-form → インストール済み
							alreadyNodeInstalled = true;
							// exec-form へのマイグレーション試行
							migrateHookToExecForm(hh);
						}
					}
				}

				if (alreadyNodeInstalled && !needsMigration) { return false; } // 既に最新版

				if (needsMigration) {
					hooksObj['SessionStart'] = (sessionStart as Array<Record<string, unknown>>).map((entry) => {
						const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
						if (!Array.isArray(innerHooks)) { return entry; }
						const hasOldHook = innerHooks.some((hh) =>
							typeof hh.command === 'string' && hh.command.includes(CSM_MARKER) && hh.command.includes('.sh')
						);
						if (!hasOldHook) { return entry; }
						const filtered = innerHooks.filter((hh) =>
							!(typeof hh.command === 'string' && hh.command.includes(CSM_MARKER))
						);
						return filtered.length === 0 ? null : { ...entry, hooks: filtered };
					}).filter(Boolean);
					outputChannel.appendLine(`[${new Date().toISOString()}] csm-session-agent-inject: bash版→Node.js版へ自動マイグレーション`);
				}
			}

			if (!Array.isArray(hooksObj['SessionStart'])) {
				hooksObj['SessionStart'] = [];
			}
			(hooksObj['SessionStart'] as Array<Record<string, unknown>>).push({
				matcher: '*',
				hooks: [buildHookDef(hookScript, 10)]
			});
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart エージェント注入hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// SessionStart hookをsettings.jsonから削除
export async function removeSessionAgentInjectHook(outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const CSM_MARKER = 'csm-session-agent-inject';

	try {
		await modifySettingsJson(settingsPath, (settings) => {
			const hooksObj = settings.hooks as Record<string, unknown> | undefined;
			if (!hooksObj) { return false; }
			const sessionStart = hooksObj['SessionStart'];
			if (!Array.isArray(sessionStart)) { return false; }

			const filtered = sessionStart.filter((entry: Record<string, unknown>) => {
				const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(innerHooks)) { return true; }
				return !innerHooks.some((hh: Record<string, unknown>) =>
					typeof hh.command === 'string' && hh.command.includes(CSM_MARKER)
				);
			});

			if (filtered.length === sessionStart.length) { return false; } // 変更なし
			hooksObj['SessionStart'] = filtered;
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart エージェント注入hookを削除しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart hook削除エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// PreCompact hook を settings.json に登録（テンプレートからスクリプトもデプロイ）
// v0.4.6: bash/python 依存を排除するため csm-precompact.js (Node.js) に移行
export async function ensurePreCompactHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-precompact.js');
	const oldShScript = path.join(hooksDir, 'csm-precompact.sh');
	const CSM_MARKER = 'csm-precompact';

	await fs.promises.mkdir(hooksDir, { recursive: true });

	// 1. 旧 .sh が存在する場合は .trash/ に退避（Windows 素環境での silent fail を防止）
	try {
		await fs.promises.access(oldShScript);
		const trashDir = path.join(hooksDir, '.trash');
		await fs.promises.mkdir(trashDir, { recursive: true });
		await fs.promises.rename(oldShScript, path.join(trashDir, `csm-precompact.sh.${Date.now()}`));
		outputChannel.appendLine(`[${new Date().toISOString()}] csm-precompact.sh を .trash/ に退避しました`);
	} catch { /* .sh が存在しない場合は無視 */ }

	// 2. csm-precompact.js をデプロイ（常に最新に上書き）
	const templatePath = path.join(extensionPath, 'templates', 'csm-precompact.js');
	try {
		const content = await fs.promises.readFile(templatePath, 'utf-8');
		let needsWrite = true;
		try {
			const existing = await fs.promises.readFile(hookScript, 'utf-8');
			if (existing === content) { needsWrite = false; }
		} catch { /* not exists */ }
		if (needsWrite) {
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-precompact.js をデプロイしました`);
		}
	} catch {
		// テンプレートが見つからない場合はスキップ
		return;
	}

	// 3. settings.json にPreCompact hookを登録（既存の .sh エントリを .js に差し替え）
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			const preCompact = hooksObj['PreCompact'];
			let updatedOldEntry = false;

			if (Array.isArray(preCompact)) {
				for (const entry of preCompact as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
						if (typeof hh.command === 'string' && hh.command.startsWith('bash ')) {
							// 旧 bash → node exec-form に更新
							Object.assign(hh, buildHookDef(hookScript, 15));
							updatedOldEntry = true;
						} else {
							// 既に node 形式 → exec-form へマイグレーション試行して終了
							return migrateHookToExecForm(hh);
						}
					}
				}
			}

			if (!updatedOldEntry) {
				if (!Array.isArray(hooksObj['PreCompact'])) {
					hooksObj['PreCompact'] = [];
				}
				(hooksObj['PreCompact'] as Array<Record<string, unknown>>).push({
					matcher: '*',
					hooks: [buildHookDef(hookScript, 15)]
				});
			}
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// CSM PreCompact Summary hook — コンパクション前にCSM_SUMMARY生成・保存（全セッション対象）
// v0.4.7: csm-precompact-summary.js をデプロイし、文脈保持を強化
export async function ensurePreCompactSummaryHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-precompact-summary.js');
	const CSM_MARKER = 'csm-precompact-summary';

	await fs.promises.mkdir(hooksDir, { recursive: true });

	// 1. テンプレートからスクリプトをデプロイ（常に最新に上書き）
	const templatePath = path.join(extensionPath, 'templates', 'csm-precompact-summary.js');
	try {
		const content = await fs.promises.readFile(templatePath, 'utf-8');
		let needsWrite = true;
		try {
			const existing = await fs.promises.readFile(hookScript, 'utf-8');
			if (existing === content) { needsWrite = false; }
		} catch { /* not exists */ }
		if (needsWrite) {
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-precompact-summary.js をデプロイしました`);
		}
	} catch {
		// テンプレートが見つからない場合はスキップ
		return;
	}

	// 2. settings.json に PreCompact hook を登録
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			const preCompact = hooksObj['PreCompact'];
			if (Array.isArray(preCompact)) {
				let changed = false;
				for (const entry of preCompact as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
						// 既にインストール済み → exec-form マイグレーション試行
						if (migrateHookToExecForm(hh)) { changed = true; }
					}
				}
				// インストール済みならマイグレーション結果のみ返す
				if ((preCompact as Array<Record<string, unknown>>).some((entry) => {
					const ih = entry.hooks as Array<Record<string, unknown>> | undefined;
					return Array.isArray(ih) && ih.some((hh) => hookMatchesMarker(hh, CSM_MARKER));
				})) { return changed; }
			}
			if (!Array.isArray(hooksObj['PreCompact'])) {
				hooksObj['PreCompact'] = [];
			}
			(hooksObj['PreCompact'] as Array<Record<string, unknown>>).push({
				matcher: '*',
				hooks: [buildHookDef(hookScript, 15)]
			});
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact Summary hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact Summary hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// CSM Stop hook — セッション終了時にHISTORY.mdへ要約追記（historyEnabled:trueのみ）
export async function ensureSessionStopHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-session-stop.js');
	const CSM_MARKER = 'csm-session-stop';

	// 1. テンプレートからスクリプトをデプロイ（常に最新に上書き）
	const templatePath = path.join(extensionPath, 'templates', 'csm-session-stop.js');
	try {
		const content = await fs.promises.readFile(templatePath, 'utf-8');
		await fs.promises.mkdir(hooksDir, { recursive: true });
		let needsWrite = true;
		try {
			const existing = await fs.promises.readFile(hookScript, 'utf-8');
			if (existing === content) { needsWrite = false; }
		} catch { /* not exists */ }
		if (needsWrite) {
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-session-stop.js をデプロイしました`);
		}
	} catch {
		return;
	}

	// 2. settings.json にStop hookを登録
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			const stopArr = hooksObj['Stop'];
			if (Array.isArray(stopArr)) {
				let changed = false;
				for (const entry of stopArr as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
						if (migrateHookToExecForm(hh)) { changed = true; }
					}
				}
				if ((stopArr as Array<Record<string, unknown>>).some((entry) => {
					const ih = entry.hooks as Array<Record<string, unknown>> | undefined;
					return Array.isArray(ih) && ih.some((hh) => hookMatchesMarker(hh, CSM_MARKER));
				})) { return changed; }
			}
			if (!Array.isArray(hooksObj['Stop'])) {
				hooksObj['Stop'] = [];
			}
			(hooksObj['Stop'] as Array<Record<string, unknown>>).push({
				matcher: '*',
				hooks: [buildHookDef(hookScript, 10)]
			});
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] Stop hook (HISTORY記録) を settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] Stop hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ─── MessageDisplay hook (Claude Code 2.1.152+) ──────────────────────────────
//
// MessageDisplay hook はモデル応答をユーザーに表示する前に発火する。
// stdout の JSON で表示内容を上書き・フィルタリングできる（将来のユーザー拡張用）。
//
// 設定キー: claudeManager.hooks.messageDisplay.enabled (boolean, default: false)
//
// 実装テンプレートは将来のユーザー拡張向けに予約。現時点では settings への自動登録は行わない。
// 有効化した場合、settings.json の MessageDisplay セクションにユーザーが手動で hook を追加する。
//
// 参考 input 形式 (CC 2.1.152+):
//   { session_id, hook_event_name: "MessageDisplay", message: { role, content }, cwd }
// 参考 output 形式:
//   {} (通過) | { hookSpecificOutput: { replacementText: "..." } } (内容差し替え)

/**
 * MessageDisplay hook の設定キーが有効か確認する（将来の自動登録用スタブ）
 * @returns true if the user has opted in via settings
 */
export function isMessageDisplayHookEnabled(): boolean {
	const config = vscode.workspace.getConfiguration('claudeManager');
	return config.get<boolean>('hooks.messageDisplay.enabled', false);
}

// CSM Governance Capture hookを settings.json に登録（PreToolUse/PostToolUse）
export async function ensureGovernanceHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-governance-capture.js');
	const CSM_MARKER = 'csm-governance-capture';

	// 1. テンプレートからスクリプトをデプロイ
	try {
		await fs.promises.access(hookScript);
	} catch {
		const templatePath = path.join(extensionPath, 'templates', 'csm-governance-capture.js');
		try {
			const content = await fs.promises.readFile(templatePath, 'utf-8');
			await fs.promises.mkdir(hooksDir, { recursive: true });
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-governance-capture.js をデプロイしました`);
		} catch {
			return;
		}
	}

	// 2. settings.json にPreToolUse/PostToolUse hookを登録
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			let changed = false;

			for (const eventKey of ['PreToolUse', 'PostToolUse']) {
				const entries = hooksObj[eventKey];
				if (Array.isArray(entries)) {
					let alreadyInstalled = false;
					for (const entry of entries as Array<Record<string, unknown>>) {
						const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
						if (!Array.isArray(innerHooks)) { continue; }
						for (const hh of innerHooks) {
							if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
							alreadyInstalled = true;
							if (migrateHookToExecForm(hh)) { changed = true; }
						}
					}
					if (alreadyInstalled) { continue; }
				}
				if (!Array.isArray(hooksObj[eventKey])) {
					hooksObj[eventKey] = [];
				}
				(hooksObj[eventKey] as Array<Record<string, unknown>>).push({
					matcher: 'Bash|Write|Edit|MultiEdit',
					hooks: [buildHookDef(hookScript, 10)]
				});
				changed = true;
			}
			return changed;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] CSM Governance hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] Governance hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// settings.json に csm-check-ask-agent hook を登録
// v0.4.7: bash+python → Node.js (csm-check-ask-agent.js) に移行。Windows 素環境対応。
export async function registerCsmAskAgentHook(claudeDir: string): Promise<void> {
	const settingsPath = path.join(claudeDir, 'settings.json');
	const jsHookPath = path.join(claudeDir, 'hooks', 'csm-check-ask-agent.js').replace(/\\/g, '/');
	const CSM_MARKER = 'csm-check-ask-agent';
	const OLD_MARKER = 'check-csm-ask-agent'; // 旧マーカー: 後方互換チェック用

	await modifySettingsJson(settingsPath, (settings) => {
		if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
			settings.hooks = {};
		}
		const hooksObj = settings.hooks as Record<string, unknown>;
		const preToolUse = hooksObj['PreToolUse'];

		if (Array.isArray(preToolUse)) {
			let hasOldBash = false;
			let hasNewNode = false;
			let changed = false;
			for (const entry of preToolUse as Array<Record<string, unknown>>) {
				const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(innerHooks)) { continue; }
				for (const hh of innerHooks) {
					if (typeof hh.command === 'string' && hh.command.includes(OLD_MARKER) && hh.command.startsWith('bash ')) {
						hasOldBash = true;
					} else if (hookMatchesMarker(hh, CSM_MARKER)) {
						hasNewNode = true;
						if (migrateHookToExecForm(hh)) { changed = true; }
					}
				}
			}
			if (hasNewNode && !hasOldBash) { return changed; } // 最新版インストール済み（マイグレーション結果のみ返す）

			if (hasOldBash) {
				hooksObj['PreToolUse'] = (preToolUse as Array<Record<string, unknown>>).map((entry) => {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { return entry; }
					const filtered = innerHooks.filter((hh) =>
						!(typeof hh.command === 'string' && hh.command.includes(OLD_MARKER) && hh.command.startsWith('bash '))
					);
					return filtered.length === 0 ? null : { ...entry, hooks: filtered };
				}).filter(Boolean);
			}
		}

		if (!Array.isArray(hooksObj['PreToolUse'])) {
			hooksObj['PreToolUse'] = [];
		}
		(hooksObj['PreToolUse'] as Array<Record<string, unknown>>).push({
			matcher: 'Bash',
			hooks: [buildHookDef(jsHookPath, 5)]
		});
		return true;
	});
}

// CSM Recap Capture hook — /recap 結果を HISTORY.md へ自動追記（historyEnabled:trueのみ）
export async function ensureRecapCaptureHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-recap-capture.js');
	const CSM_MARKER = 'csm-recap-capture';

	// 1. テンプレートからスクリプトをデプロイ（常に最新に上書き）
	const templatePath = path.join(extensionPath, 'templates', 'csm-recap-capture.js');
	try {
		const content = await fs.promises.readFile(templatePath, 'utf-8');
		await fs.promises.mkdir(hooksDir, { recursive: true });
		let needsWrite = true;
		try {
			const existing = await fs.promises.readFile(hookScript, 'utf-8');
			if (existing === content) { needsWrite = false; }
		} catch { /* not exists */ }
		if (needsWrite) {
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-recap-capture.js をデプロイしました`);
		}
	} catch {
		return;
	}

	// 2. settings.json に Stop hook を登録
	try {
		await modifySettingsJson(settingsPath, (settings) => {
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = {};
			}
			const hooksObj = settings.hooks as Record<string, unknown>;
			const stopArr = hooksObj['Stop'];
			if (Array.isArray(stopArr)) {
				let changed = false;
				for (const entry of stopArr as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (!hookMatchesMarker(hh, CSM_MARKER)) { continue; }
						if (migrateHookToExecForm(hh)) { changed = true; }
					}
				}
				if ((stopArr as Array<Record<string, unknown>>).some((entry) => {
					const ih = entry.hooks as Array<Record<string, unknown>> | undefined;
					return Array.isArray(ih) && ih.some((hh) => hookMatchesMarker(hh, CSM_MARKER));
				})) { return changed; }
			}
			if (!Array.isArray(hooksObj['Stop'])) {
				hooksObj['Stop'] = [];
			}
			(hooksObj['Stop'] as Array<Record<string, unknown>>).push({
				matcher: '*',
				hooks: [buildHookDef(hookScript, 15)]
			});
			return true;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] Recap Capture hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] Recap Capture hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ─── 既存 hook の exec-form 一括マイグレーション ────────────────────────────────
/**
 * settings.json 内に残っている CSM の旧 shell-form hook を exec-form に一括変換する。
 * Claude Code 2.1.139+ の場合のみ動作。拡張機能起動時に 1 回呼び出す。
 */
export async function migrateHooksToExecForm(outputChannel: vscode.OutputChannel): Promise<void> {
	if (!supportsExecForm()) { return; }
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const CSM_SCRIPT_MARKERS = [
		'csm-precompact',
		'csm-recap-capture',
		'csm-session-stop',
		'csm-check-ask-agent',
		'csm-precompact-summary',
		'csm-session-agent-inject',
		'csm-governance-capture',
		'csm/subagent-signal',
	];

	try {
		await modifySettingsJson(settingsPath, (settings) => {
			const hooksObj = settings.hooks as Record<string, unknown> | undefined;
			if (!hooksObj || typeof hooksObj !== 'object') { return false; }
			let changed = false;
			for (const eventHooks of Object.values(hooksObj)) {
				if (!Array.isArray(eventHooks)) { continue; }
				for (const entry of eventHooks as Array<Record<string, unknown>>) {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { continue; }
					for (const hh of innerHooks) {
						if (typeof hh.command !== 'string') { continue; }
						const cmd = hh.command as string;
						if (!CSM_SCRIPT_MARKERS.some((marker) => cmd.includes(marker))) { continue; }
						if (migrateHookToExecForm(hh)) { changed = true; }
					}
				}
			}
			return changed;
		}, (msg) => outputChannel.appendLine(msg));

		outputChannel.appendLine(`[${new Date().toISOString()}] CSM hook exec-form マイグレーション完了 (Claude Code 2.1.139+)`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] CSM hook マイグレーションエラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// cwd を Claude Code のプロジェクトフォルダ名形式にエンコード
// 例: C:\My Project → c--my-project
function encodeCwdToProjectDir(cwd: string): string {
	return cwd
		.toLowerCase()
		.replace(/\\/g, '/')
		.replace(/^([a-z]):/, '$1-')
		.replace(/[\s/]/g, '-');
}

// MEMORY.mdに組織情報を書き込む（メモリファイル＋ポインタ方式）
export async function writeOrgInfoToMemory(config: AgentConfig): Promise<void> {
	try {
		const homeDir = os.homedir();
		const projectsDir = path.join(homeDir, '.claude', 'projects');
		try { await fs.promises.access(projectsDir); } catch { return; }
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		if (!cwd) { return; }
		// 現在の cwd に対応するプロジェクトフォルダ名を算出
		const expectedDir = encodeCwdToProjectDir(cwd);
		const dirs = await fs.promises.readdir(projectsDir);
		for (const dir of dirs) {
			// cwd と一致するプロジェクトフォルダのみ処理する（別プロジェクト汚染防止）
			if (dir !== expectedDir) { continue; }
			const memoryDir = path.join(projectsDir, dir, 'memory');
			const memoryFile = path.join(memoryDir, 'MEMORY.md');
			let content: string;
			try {
				content = await fs.promises.readFile(memoryFile, 'utf-8');
			} catch { continue; }

			// 1. project_agent_architecture.md を作成（なければ）
			const archFile = path.join(memoryDir, 'project_agent_architecture.md');
			try {
				await fs.promises.access(archFile);
			} catch {
				const archContent = [
					`---`,
					`name: マルチエージェント運用体制`,
					`description: 取締役＋子エージェント構成・部署一覧・運用ルール`,
					`type: project`,
					`---`,
					``,
					`セッション管理: Claude Session Manager（VS Code拡張）で運用`,
					`エージェント一覧: \`~/.claude/session-manager.json\` の \`agents[]\` が唯一の情報源`,
					``,
					`**Why:** session-manager.json をマスターデータとすることで、MEMORY.md との二重管理を防止する`,
					`**How to apply:** エージェント情報が必要な場合は session-manager.json を直接読むこと`,
				].join('\n') + '\n';
				await fs.promises.writeFile(archFile, archContent, 'utf-8');
			}

			// 2. project_director_rules.md を作成（なければ）
			const directorFile = path.join(memoryDir, 'project_director_rules.md');
			try {
				await fs.promises.access(directorFile);
			} catch {
				const directorContent = [
					`---`,
					`name: 取締役の行動規範`,
					`description: 取締役エージェントの役割・行動ルール・禁止事項`,
					`type: project`,
					`---`,
					``,
					`取締役名: ${config.name}`,
					`役割: ${config.role || '全体統括・タスク分割・承認判断'}`,
					``,
					`**Why:** 取締役は実装を行わず、方針決定と委任に専念する`,
					`**How to apply:** session-manager.json からエージェント情報を読み、子エージェントに作業を委任する`,
				].join('\n') + '\n';
				await fs.promises.writeFile(directorFile, directorContent, 'utf-8');
			}

			// 3. MEMORY.mdにセクションポインタを追記（なければ）
			let appendText = '';
			if (!content.includes('## マルチエージェント運用')) {
				appendText += [
					``,
					`## マルチエージェント運用`,
					`- [マルチエージェント運用体制](project_agent_architecture.md) — 取締役＋子エージェント構成・部署一覧・運用ルール`,
				].join('\n') + '\n';
			}
			if (!content.includes('## 取締役セッション')) {
				appendText += [
					``,
					`## 取締役セッション（※子エージェントはこのセクションを無視すること）`,
					`- [取締役の行動規範](project_director_rules.md) — 役割・行動ルール`,
				].join('\n') + '\n';
			}
			if (appendText) {
				await fs.promises.appendFile(memoryFile, appendText, 'utf-8');
			}

			// 4. MEMORY.mdインデックスにファイルポインタを追加（なければ）
			const updatedContent = await fs.promises.readFile(memoryFile, 'utf-8');
			if (!updatedContent.includes('project_agent_architecture.md')) {
				await addToIndex(memoryDir, 'project_agent_architecture.md', 'マルチエージェント運用体制', '取締役＋子エージェント構成・部署一覧・運用ルール');
			}
			if (!updatedContent.includes('project_director_rules.md')) {
				await addToIndex(memoryDir, 'project_director_rules.md', '取締役の行動規範', '取締役エージェントの役割・行動ルール・禁止事項');
			}
			return;
		}
	} catch {
		// MEMORY.md書き込み失敗は無視
	}
}
