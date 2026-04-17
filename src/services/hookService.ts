// hookService.ts — hook管理・組織情報メモリ書き込みロジック
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentConfig } from '../models/types';
import { addToIndex } from '../utils/memoryManager';

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
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return;
		}

		const hooksObj = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
			? settings.hooks as Record<string, unknown>
			: {};
		if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
			settings.hooks = hooksObj;
		}
		const CSM_SIGNAL_MARKER = 'csm/subagent-signal.js';

		const hasSignalHook = (eventKey: string, action: string): boolean => {
			const entries = hooksObj[eventKey];
			if (!Array.isArray(entries)) { return false; }
			return entries.some((entry: Record<string, unknown>) => {
				const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(innerHooks)) { return false; }
				return innerHooks.some((hh: Record<string, unknown>) =>
					typeof hh.command === 'string' && hh.command.includes(CSM_SIGNAL_MARKER) && hh.command.includes(action)
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
					typeof hh.command === 'string' && hh.command.includes(CSM_SIGNAL_MARKER)
				);
			});
			if (filtered.length !== originalLen) {
				hooksObj[eventKey] = filtered;
				return true;
			}
			return false;
		};

		const removedFromStop = removeStaleSignalHooks('Stop');
		const removedFromSessionStart = removeStaleSignalHooks('SessionStart');

		const hasStart = hasSignalHook('SubagentStart', 'start');
		const hasStop = hasSignalHook('SubagentStop', 'stop');

		let changed = removedFromStop || removedFromSessionStart;

		const addSignalHook = (eventKey: string, action: string): void => {
			if (!Array.isArray(hooksObj[eventKey])) {
				hooksObj[eventKey] = [];
			}
			const entries = hooksObj[eventKey] as Array<Record<string, unknown>>;
			const hook = {
				type: 'command',
				command: `node "${signalScript.replace(/\\/g, '/')}" ${action}`,
				timeout: 10,
				async: true,
			};
			const existing = entries.find((e: Record<string, unknown>) => e.matcher === '*');
			if (existing && Array.isArray(existing.hooks)) {
				(existing.hooks as Array<Record<string, unknown>>).push(hook);
			} else {
				entries.push({ matcher: '*', hooks: [hook] });
			}
		};

		if (!hasStart) {
			addSignalHook('SubagentStart', 'start');
			changed = true;
		}

		if (!hasStop) {
			addSignalHook('SubagentStop', 'stop');
			changed = true;
		}

		if (changed) {
			const backupPath = settingsPath + `.bak.${Date.now()}`;
			try {
				await fs.promises.copyFile(settingsPath, backupPath);
			} catch { /* バックアップ失敗は無視 */ }
			await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] SubagentStart/Stop フックを settings.json に登録しました`);
		}
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] フック登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// SessionStart hookでエージェント役割自動注入（デプロイ+settings.json登録）
export async function ensureSessionAgentInjectHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-session-agent-inject.sh');
	const CSM_MARKER = 'csm-session-agent-inject';

	// 1. テンプレートからスクリプトをデプロイ（存在しなければ）
	try {
		await fs.promises.access(hookScript);
	} catch {
		const templatePath = path.join(extensionPath, 'templates', 'csm-session-agent-inject.sh');
		try {
			const content = await fs.promises.readFile(templatePath, 'utf-8');
			await fs.promises.mkdir(hooksDir, { recursive: true });
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-session-agent-inject.sh をデプロイしました`);
		} catch {
			return;
		}
	}

	// 2. settings.json にSessionStart hookを登録
	try {
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return;
		}

		if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
			settings.hooks = {};
		}
		const hooksObj = settings.hooks as Record<string, unknown>;

		// 既に登録済みか確認
		const sessionStart = hooksObj['SessionStart'];
		if (Array.isArray(sessionStart)) {
			const alreadyInstalled = sessionStart.some((entry: Record<string, unknown>) => {
				const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(innerHooks)) { return false; }
				return innerHooks.some((hh: Record<string, unknown>) =>
					typeof hh.command === 'string' && hh.command.includes(CSM_MARKER)
				);
			});
			if (alreadyInstalled) { return; }
		}

		if (!Array.isArray(hooksObj['SessionStart'])) {
			hooksObj['SessionStart'] = [];
		}
		const arr = hooksObj['SessionStart'] as Array<Record<string, unknown>>;
		arr.push({
			matcher: '*',
			hooks: [{
				type: 'command',
				command: `bash "${hookScript.replace(/\\/g, '/')}"`,
				timeout: 10,
			}]
		});

		const backupPath = settingsPath + `.bak.${Date.now()}`;
		try { await fs.promises.copyFile(settingsPath, backupPath); } catch { /* */ }
		await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
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
		const raw = await fs.promises.readFile(settingsPath, 'utf-8');
		const settings: Record<string, unknown> = JSON.parse(raw);
		const hooksObj = settings.hooks as Record<string, unknown> | undefined;
		if (!hooksObj) { return; }
		const sessionStart = hooksObj['SessionStart'];
		if (!Array.isArray(sessionStart)) { return; }

		const filtered = sessionStart.filter((entry: Record<string, unknown>) => {
			const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
			if (!Array.isArray(innerHooks)) { return true; }
			return !innerHooks.some((hh: Record<string, unknown>) =>
				typeof hh.command === 'string' && hh.command.includes(CSM_MARKER)
			);
		});

		if (filtered.length === sessionStart.length) { return; } // 変更なし
		hooksObj['SessionStart'] = filtered;

		await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart エージェント注入hookを削除しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] SessionStart hook削除エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// PreCompact hook を settings.json に登録（テンプレートからスクリプトもデプロイ）
export async function ensurePreCompactHook(extensionPath: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const homeDir = os.homedir();
	const settingsPath = path.join(homeDir, '.claude', 'settings.json');
	const hooksDir = path.join(homeDir, '.claude', 'hooks');
	const hookScript = path.join(hooksDir, 'csm-precompact.sh');
	const CSM_MARKER = 'csm-precompact';

	// 1. テンプレートからスクリプトをデプロイ（存在しなければ）
	try {
		await fs.promises.access(hookScript);
	} catch {
		const templatePath = path.join(extensionPath, 'templates', 'csm-precompact.sh');
		try {
			const content = await fs.promises.readFile(templatePath, 'utf-8');
			await fs.promises.mkdir(hooksDir, { recursive: true });
			await fs.promises.writeFile(hookScript, content, 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] csm-precompact.sh をデプロイしました`);
		} catch {
			// テンプレートが見つからない場合はスキップ
			return;
		}
	}

	// 2. settings.json にPreCompact hookを登録
	try {
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return;
		}

		if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
			settings.hooks = {};
		}
		const hooksObj = settings.hooks as Record<string, unknown>;

		// 既に登録済みか確認
		const preCompact = hooksObj['PreCompact'];
		if (Array.isArray(preCompact)) {
			const alreadyInstalled = preCompact.some((entry: Record<string, unknown>) => {
				const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
				if (!Array.isArray(innerHooks)) { return false; }
				return innerHooks.some((hh: Record<string, unknown>) =>
					typeof hh.command === 'string' && hh.command.includes(CSM_MARKER)
				);
			});
			if (alreadyInstalled) { return; }
		}

		if (!Array.isArray(hooksObj['PreCompact'])) {
			hooksObj['PreCompact'] = [];
		}
		const preCompactArr = hooksObj['PreCompact'] as Array<Record<string, unknown>>;

		preCompactArr.push({
			matcher: '*',
			hooks: [{
				type: 'command',
				command: `bash "${hookScript.replace(/\\/g, '/')}"`,
				timeout: 15,
			}]
		});

		const backupPath = settingsPath + `.bak.${Date.now()}`;
		try { await fs.promises.copyFile(settingsPath, backupPath); } catch { /* */ }
		await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact hookを settings.json に登録しました`);
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] PreCompact hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
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
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return;
		}

		if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
			settings.hooks = {};
		}
		const hooksObj = settings.hooks as Record<string, unknown>;
		const scriptCmd = `node "${hookScript.replace(/\\/g, '/')}"`;
		let changed = false;

		for (const eventKey of ['PreToolUse', 'PostToolUse']) {
			const entries = hooksObj[eventKey];
			// 既に登録済みか確認
			if (Array.isArray(entries)) {
				const alreadyInstalled = entries.some((entry: Record<string, unknown>) => {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { return false; }
					return innerHooks.some((hh: Record<string, unknown>) =>
						typeof hh.command === 'string' && hh.command.includes(CSM_MARKER)
					);
				});
				if (alreadyInstalled) { continue; }
			}

			if (!Array.isArray(hooksObj[eventKey])) {
				hooksObj[eventKey] = [];
			}
			const arr = hooksObj[eventKey] as Array<Record<string, unknown>>;
			arr.push({
				matcher: 'Bash|Write|Edit|MultiEdit',
				hooks: [{
					type: 'command',
					command: scriptCmd,
					timeout: 10,
				}]
			});
			changed = true;
		}

		if (changed) {
			const backupPath = settingsPath + `.bak.${Date.now()}`;
			try { await fs.promises.copyFile(settingsPath, backupPath); } catch { /* */ }
			await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
			outputChannel.appendLine(`[${new Date().toISOString()}] CSM Governance hookを settings.json に登録しました`);
		}
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] Governance hook登録エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// settings.json に check-csm-ask-agent hook を登録
export async function registerCsmAskAgentHook(claudeDir: string): Promise<void> {
	const settingsPath = path.join(claudeDir, 'settings.json');
	const hookScriptPath = path.join(claudeDir, 'hooks', 'check-csm-ask-agent.sh').replace(/\\/g, '/');

	let settings: Record<string, unknown> = {};
	try {
		const raw = await fs.promises.readFile(settingsPath, 'utf-8');
		settings = JSON.parse(raw);
	} catch {
		return;
	}

	const hooksObj = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
		? settings.hooks as Record<string, unknown>
		: {};
	const preToolUse = hooksObj['PreToolUse'];
	if (Array.isArray(preToolUse)) {
		const alreadyInstalled = preToolUse.some((entry: Record<string, unknown>) => {
			const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
			if (!Array.isArray(innerHooks)) { return false; }
			return innerHooks.some((hh: Record<string, unknown>) =>
				typeof hh.command === 'string' && hh.command.includes('check-csm-ask-agent')
			);
		});
		if (alreadyInstalled) { return; }
	}

	if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
		settings.hooks = {};
	}
	const hooks = settings.hooks as Record<string, unknown>;
	if (!Array.isArray(hooks['PreToolUse'])) {
		hooks['PreToolUse'] = [];
	}
	const preToolUseArr = hooks['PreToolUse'] as Array<Record<string, unknown>>;

	preToolUseArr.push({
		matcher: 'Bash',
		hooks: [{
			type: 'command',
			command: `bash "${hookScriptPath}"`,
			timeout: 5,
		}]
	});

	const backupPath = settingsPath + `.bak.${Date.now()}`;
	try { await fs.promises.copyFile(settingsPath, backupPath); } catch { /* */ }
	await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
}

// MEMORY.mdに組織情報を書き込む（メモリファイル＋ポインタ方式）
export async function writeOrgInfoToMemory(config: AgentConfig): Promise<void> {
	try {
		const homeDir = os.homedir();
		const projectsDir = path.join(homeDir, '.claude', 'projects');
		try { await fs.promises.access(projectsDir); } catch { return; }
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
		if (!cwd) { return; }
		const dirs = await fs.promises.readdir(projectsDir);
		for (const dir of dirs) {
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
