// migrationCommands.ts — マイグレーション・インストール関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dataStore from '../models/dataStore';
import { AgentConfig } from '../models/types';
import { moveToTrash } from '../utils/agentUtils';
import {
	parseFrontmatter, generateFrontmatter, migrateAutoToYaml,
	isLegacyAutoFormat, hasFrontmatter,
} from '../utils/frontmatterUtils';
import { resolveRuleFilePath } from '../agents/agentManager';
import { syncParentRuleFile } from '../agents/parentChildSync';
import { ensureSubagentHooks, registerCsmAskAgentHook } from '../services/hookService';
import { autoGenerateRuleFile, ensureAgentFolderFiles, buildDescription } from '../services/agentService';

export interface MigrationCommandsDeps {
	refreshAll: () => void;
	getExtensionOutputChannel: () => vscode.OutputChannel;
	extensionOutputChannel: vscode.OutputChannel;
}

export function registerMigrationCommands(
	context: vscode.ExtensionContext,
	deps: MigrationCommandsDeps
): void {
	const { refreshAll, getExtensionOutputChannel, extensionOutputChannel } = deps;

	// --- フォルダ構造移行コマンド ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.migrateToFolderStructure', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'.agent-rules/ をフォルダ構造に移行します。旧ファイルは .trash/ に退避されます。',
				{ modal: true },
				'移行実行'
			);
			if (confirm !== '移行実行') { return; }
	
			const agents = await dataStore.getAgents();
			const migrated: string[] = [];
			const skipped: string[] = [];
	
			for (const agent of agents) {
				if (!agent.ruleFile) { skipped.push(agent.name); continue; }
				const resolved = await resolveRuleFilePath(agent.ruleFile);
				try {
					const stat = await fs.promises.stat(resolved);
					if (!stat.isFile()) { skipped.push(agent.name); continue; }
				} catch { skipped.push(agent.name); continue; }
	
				// 既にフォルダ構造なら skip
				const parentDir = path.dirname(resolved);
				const parentName = path.basename(parentDir);
				if (parentName === agent.name) { skipped.push(agent.name); continue; }
	
				// フォルダ構造に移行
				const ruleFolder = parentDir;
				const agentFolder = path.join(ruleFolder, agent.name);
				const newRuleFile = path.join(agentFolder, `${agent.name}.md`);
	
				try {
					await fs.promises.mkdir(agentFolder, { recursive: true });
	
					// ルールファイルをコピー
					const content = await fs.promises.readFile(resolved, 'utf-8');
	
					// HISTORY.md 分離: ルールファイル内の歴代セッション記録を抽出
					const HISTORY_HEADER = '## 歴代セッションの記録';
					const historyIdx = content.indexOf(HISTORY_HEADER);
					let ruleContent = content;
					let historyContent = `# ${agent.name} — 歴代セッション記録\n\n`;
					if (historyIdx >= 0) {
						const afterHeader = content.substring(historyIdx);
						const nextSectionMatch = afterHeader.match(/\n\n## [^#]/);
						const sectionEnd = nextSectionMatch
							? historyIdx + (nextSectionMatch.index ?? afterHeader.length)
							: content.length;
						const historySection = content.substring(historyIdx, sectionEnd).trim();
						historyContent += historySection.substring(HISTORY_HEADER.length).trim() + '\n';
						ruleContent = content.substring(0, historyIdx).trimEnd() + content.substring(sectionEnd);
					}
	
					await fs.promises.writeFile(newRuleFile, ruleContent, 'utf-8');
					await fs.promises.writeFile(path.join(agentFolder, 'HISTORY.md'), historyContent, 'utf-8');
	
					// TODO.md テンプレート作成
					await ensureAgentFolderFiles(agentFolder, agent.name);
	
					// 旧ファイルを .trash/ に移動
					await moveToTrash(resolved, path.join(ruleFolder, '.trash'));
	
					// session-manager.json の ruleFile パスを更新
					const updatedAgent: AgentConfig = { ...agent, ruleFile: newRuleFile };
					await dataStore.addAgent(updatedAgent);
					migrated.push(agent.name);
				} catch (err) {
					const ch = getExtensionOutputChannel();
					ch.appendLine(`[${new Date().toISOString()}] 移行エラー (${agent.name}): ${err instanceof Error ? err.message : String(err)}`);
					skipped.push(agent.name);
				}
			}
	
			refreshAll();
			vscode.window.showInformationMessage(
				`移行完了: ${migrated.length}件成功${skipped.length > 0 ? `、${skipped.length}件スキップ` : ''}`
			);
		})
	);
	
	// --- ルールファイル一括マイグレーション（バナーから呼ばれる） ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.migrateRuleFiles', async () => {
			const ch = getExtensionOutputChannel();
			const confirm = await vscode.window.showWarningMessage(
				'旧形式のルールファイルをYAMLフロントマター形式に変換し、フォルダ構造に移行します。旧ファイルは .trash/ に退避されます。',
				{ modal: true },
				'移行実行'
			);
			if (confirm !== '移行実行') { return; }
	
			const agents = await dataStore.getAgents();
			const migrated: string[] = [];
			const skipped: string[] = [];
			const errors: string[] = [];
	
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'ルールファイル移行中...', cancellable: false },
				async (progress) => {
					for (let i = 0; i < agents.length; i++) {
						const agent = agents[i];
						progress.report({ message: `${agent.name} (${i + 1}/${agents.length})`, increment: 100 / agents.length });
	
						if (!agent.ruleFile) { skipped.push(agent.name); continue; }
	
						try {
							const resolved = await resolveRuleFilePath(agent.ruleFile);
							if (!resolved) { skipped.push(agent.name); continue; }
	
							let stat: fs.Stats;
							try { stat = await fs.promises.stat(resolved); } catch { skipped.push(agent.name); continue; }
							if (!stat.isFile()) { skipped.push(agent.name); continue; }
	
							const parentDir = path.dirname(resolved);
							const parentName = path.basename(parentDir);
							const content = await fs.promises.readFile(resolved, 'utf-8');
							const hasLegacyMarker = isLegacyAutoFormat(content);
							const hasFm = hasFrontmatter(content);
							const isFlat = parentName !== agent.name;
	
							// 移行不要ならスキップ
							if (!isFlat && !hasLegacyMarker && hasFm) {
								skipped.push(agent.name);
								continue;
							}
	
							// --- Phase A: YAML フロントマター変換 ---
							let newContent = content;
							if (hasLegacyMarker) {
								// CSM:AUTO → YAML frontmatter
								newContent = migrateAutoToYaml(content, agent);
							} else if (!hasFm) {
								// フロントマターなし → 新規生成して本文を保持
								const description = buildDescription(agent);
								const fm = generateFrontmatter(agent, description);
								newContent = fm + '\n\n' + content;
							}
	
							// --- Phase B: フォルダ構造移行 ---
							if (isFlat) {
								// フラット → フォルダ構造
								const ruleFolder = parentDir;
								const agentFolder = path.join(ruleFolder, agent.name);
								const newRuleFile = path.join(agentFolder, `${agent.name}.md`);
	
								await fs.promises.mkdir(agentFolder, { recursive: true });
	
								// HISTORY.md 分離: ルールファイル内の歴代セッション記録を抽出
								const HISTORY_HEADER = '## 歴代セッションの記録';
								const historyIdx = newContent.indexOf(HISTORY_HEADER);
								let ruleContent = newContent;
								let historyContent = `# ${agent.name} — 歴代セッション記録\n\n`;
								if (historyIdx >= 0) {
									const afterHeader = newContent.substring(historyIdx);
									const nextSectionMatch = afterHeader.match(/\n\n## [^#]/);
									const sectionEnd = nextSectionMatch
										? historyIdx + (nextSectionMatch.index ?? afterHeader.length)
										: newContent.length;
									const historySection = newContent.substring(historyIdx, sectionEnd).trim();
									historyContent += historySection.substring(HISTORY_HEADER.length).trim() + '\n';
									ruleContent = newContent.substring(0, historyIdx).trimEnd() + newContent.substring(sectionEnd);
								}
	
								await fs.promises.writeFile(newRuleFile, ruleContent, 'utf-8');
								await fs.promises.writeFile(path.join(agentFolder, 'HISTORY.md'), historyContent, 'utf-8');
								await ensureAgentFolderFiles(agentFolder, agent.name);
	
								// 旧ファイルを .trash/ に移動
								await moveToTrash(resolved, path.join(ruleFolder, '.trash'));
	
								// session-manager.json のパス更新
								const updatedAgent: AgentConfig = { ...agent, ruleFile: newRuleFile };
								await dataStore.addAgent(updatedAgent);
							} else {
								// 既にフォルダ構造 → 内容だけ上書き
								await fs.promises.writeFile(resolved, newContent, 'utf-8');
							}
	
							migrated.push(agent.name);
							ch.appendLine(`[${new Date().toISOString()}] 移行成功: ${agent.name}`);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							ch.appendLine(`[${new Date().toISOString()}] 移行エラー (${agent.name}): ${msg}`);
							errors.push(agent.name);
						}
					}
				}
			);
	
			await ensureSubagentHooks(extensionOutputChannel);
			refreshAll();
			const parts: string[] = [`移行完了: ${migrated.length}件成功`];
			if (skipped.length > 0) { parts.push(`${skipped.length}件スキップ`); }
			if (errors.length > 0) { parts.push(`${errors.length}件エラー（OutputChannel参照）`); }
			vscode.window.showInformationMessage(parts.join('、'));
			if (errors.length > 0) { ch.show(true); }
		})
	);
	
	// 旧ask-agent → csm-ask-agent 移行
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.migrateAskAgent', async () => {
			const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!wsFolder) { return; }
	
			const renames = [
				{ old: 'commands/ask-agent.md', new: 'commands/csm-ask-agent.md' },
				{ old: 'hooks/check-ask-agent.sh', new: 'hooks/check-csm-ask-agent.sh' },
				{ old: 'scripts/ask-agent.py', new: 'scripts/csm-ask-agent.py' },
			];
	
			let count = 0;
			for (const r of renames) {
				const oldPath = path.join(wsFolder, '.claude', r.old);
				const newPath = path.join(wsFolder, '.claude', r.new);
				try {
					await fs.promises.access(oldPath);
					await fs.promises.rename(oldPath, newPath);
					count++;
				} catch { /* ファイルなし */ }
			}
	
			// settings.json のhookパスも更新
			const settingsPath = path.join(wsFolder, '.claude', 'settings.json');
			try {
				const raw = await fs.promises.readFile(settingsPath, 'utf-8');
				const updated = raw.replace(/check-ask-agent\.sh/g, 'check-csm-ask-agent.sh');
				if (updated !== raw) {
					await fs.promises.writeFile(settingsPath, updated, 'utf-8');
				}
			} catch { /* settings.jsonなし */ }
	
			refreshAll();
			vscode.window.showInformationMessage(`${count}件のファイルを csm-ask-agent にリネームしました`);
		})
	);
	
	// /csm-ask-agent グローバルインストール（バナーから起動）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.installCsmAskAgent', async () => {
			try {
				const extensionPath = context.extensionPath;
				const templatesDir = path.join(extensionPath, 'templates');
				const homeDir = os.homedir();
				const claudeDir = path.join(homeDir, '.claude');
				const targets = [
					{ src: 'csm-ask-agent.command.md', dest: path.join(claudeDir, 'commands', 'csm-ask-agent.md') },
					{ src: 'csm-ask-agent.py', dest: path.join(claudeDir, 'scripts', 'csm-ask-agent.py') },
					{ src: 'check-csm-ask-agent.sh', dest: path.join(claudeDir, 'hooks', 'check-csm-ask-agent.sh') },
				];
	
				let installed = 0;
				for (const t of targets) {
					try {
						await fs.promises.access(t.dest);
						continue; // 既存ファイルはスキップ
					} catch { /* インストール */ }
	
					await fs.promises.mkdir(path.dirname(t.dest), { recursive: true });
					const content = await fs.promises.readFile(path.join(templatesDir, t.src), 'utf-8');
					await fs.promises.writeFile(t.dest, content, 'utf-8');
					installed++;
				}
	
				// hookをsettings.jsonに登録
				await registerCsmAskAgentHook(claudeDir);
	
				const ch = getExtensionOutputChannel();
				ch.appendLine(`[${new Date().toISOString()}] /csm-ask-agent をインストールしました（${installed}ファイル）`);
				vscode.window.showInformationMessage(`/csm-ask-agent をインストールしました（${installed}ファイル）`);
				refreshAll();
			} catch (err) {
				vscode.window.showErrorMessage(`インストールエラー: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);
	
	// /csm-ask-agent hookインストール（プロジェクトローカル）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.installAskAgentHook', async () => {
			const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			if (!wsFolder) {
				vscode.window.showWarningMessage('ワークスペースが開かれていません');
				return;
			}
	
			const hookDir = path.join(wsFolder, '.claude', 'hooks');
			const hookFile = path.join(hookDir, 'check-csm-ask-agent.sh');
			const settingsFile = path.join(wsFolder, '.claude', 'settings.json');
	
			// hookスクリプトを作成
			await fs.promises.mkdir(hookDir, { recursive: true });
			const hookScript = `#!/bin/bash
	# PreToolUse(Bash) hook: claude -p が --agent/--resume なしで実行されたら警告
	INPUT_JSON=$(cat)
	RESULT=$(echo "$INPUT_JSON" | python -c "
	import sys, json, re
	try:
	    d = json.load(sys.stdin)
	    cmd = d.get('tool_input', {}).get('command', '')
	except:
	    print('pass'); sys.exit(0)
	if 'claude' not in cmd:
	    print('pass'); sys.exit(0)
	if re.search(r'claude\\\\s.*(-p|--print)', cmd):
	    if re.search(r'--agent|--resume', cmd):
	        print('pass')
	    else:
	        print('block')
	else:
	    print('pass')
	" 2>/dev/null)
	if [ "$RESULT" = "block" ]; then
	  cat <<'HOOKEOF'
	{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"block","permissionDecisionReason":"claude -p を --agent/--resume なしで実行しようとしています。/csm-ask-agent スキルを使ってください。"}}
	HOOKEOF
	else
	  echo '{}'
	fi
	exit 0
	`;
			await fs.promises.writeFile(hookFile, hookScript, 'utf-8');
	
			// settings.jsonにhookを追加
			let settings: Record<string, unknown> = {};
			try {
				const raw = await fs.promises.readFile(settingsFile, 'utf-8');
				settings = JSON.parse(raw);
			} catch { /* 新規作成 */ }
	
			if (!settings.hooks) { settings.hooks = {}; }
			const hooks = settings.hooks as Record<string, unknown[]>;
			if (!hooks.PreToolUse) { hooks.PreToolUse = []; }
	
			// 既に check-csm-ask-agent が含まれていなければ追加
			const preToolUse = hooks.PreToolUse as Array<Record<string, unknown>>;
			const alreadyExists = preToolUse.some(h =>
				JSON.stringify(h).includes('check-csm-ask-agent')
			);
			if (!alreadyExists) {
				preToolUse.push({
					matcher: 'Bash',
					hooks: [{
						type: 'command',
						command: `bash ${hookFile.replace(/\\/g, '/')}`,
					}],
				});
			}
	
			await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, '  '), 'utf-8');
	
			refreshAll();
			vscode.window.showInformationMessage('/csm-ask-agent hookをインストールしました。claude -p の安全ガードが有効になります。');
		})
	);
	
}
