// agentCommands.ts — エージェント管理関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem } from '../providers/sessionTreeProvider';
import { AgentTreeProvider, AgentItem } from '../providers/agentTreeProvider';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { showAgentFormPanel } from '../panels/agentFormPanel';
import { showAgentPreview } from '../panels/agentPreviewPanel';
import { resolveRuleFilePath } from '../agents/agentManager';
import { normalizeModel, translateWorkDirPath } from '../utils/agentUtils';
import { isWorkDirCompatible } from '../utils/cliBuilder';
import { resolveOpenInClaudeTargetFolder, needsNewWindowForClaudeOpen } from '../utils/pathUtils';
import { syncParentRuleFile } from '../agents/parentChildSync';
import { AgentWatcher } from '../watchers/agentWatcher';
import {
	autoCreateSessionIfNeeded, createRenewSession,
	generateSimpleTestament, generateDetailedTestament,
	appendSessionHistoryToRuleFile, SessionServiceDeps,
} from '../services/sessionService';
import { prepareAgentRule } from '../services/agentService';
import { ensureSessionAgentInjectHook } from '../services/hookService';
import { addBookmark, removeBookmark } from '../services/bookmarkService';

export interface AgentCommandsDeps {
	sessionProvider: SessionTreeProvider;
	agentProvider: AgentTreeProvider;
	agentWatcher: AgentWatcher;
	sessionServiceDeps: SessionServiceDeps;
	refreshAll: () => void;
	getExtensionOutputChannel: () => vscode.OutputChannel;
	updateStatusBar: () => void;
	extensionOutputChannel: vscode.OutputChannel;
	// v0.5.17 §4-1: エージェント検索コマンドで reveal に使う
	claudeAgentsTreeView?: vscode.TreeView<unknown>;
}

// --resume コマンド引数を組み立てるヘルパー
// Phase 2-1: Claude Code v2.1.101+ の名前ベース resume を活用
// sessionId が既知なら sessionId を優先（信頼性が高い）
// sessionId がない場合は --resume <agentName> でフォールバック（v2.1.101+）
function buildResumeArgs(agent: AgentConfig): string[] | null {
	const args = ['claude', '--agent', agent.name];
	if (agent.sessionId) {
		// sessionId 既知: 正確なセッションを指定（推奨）
		args.push('--resume', agent.sessionId);
	} else if (agent.sessionMode !== 'disposable') {
		// sessionId 未設定: 名前ベース resume を試みる（Claude Code v2.1.101+）
		// CSM がセッションを追跡していない場合のフォールバック
		args.push('--resume', agent.name);
	} else {
		// disposable モードで sessionId なし: 開けない
		return null;
	}
	return args;
}

export function registerAgentCommands(
	context: vscode.ExtensionContext,
	deps: AgentCommandsDeps
): void {
	const {
		sessionProvider, agentProvider, agentWatcher,
		sessionServiceDeps, refreshAll, getExtensionOutputChannel,
		updateStatusBar, extensionOutputChannel,
		claudeAgentsTreeView,
	} = deps;

	// v0.5.17 §4-1: エージェント検索コマンド
	//   name / displayName / role / model / parentAgent をあいまい検索し、選択で previewAgentByName を実行 +
	//   TreeView.reveal で該当ノードにジャンプする（AgentTreeProvider.getParent 実装済み）。
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.searchAgents', async () => {
			const agents = await dataStore.getAgents();
			if (agents.length === 0) {
				vscode.window.showInformationMessage('登録されているエージェントがありません');
				return;
			}
			// QuickPickItem 型に整形（matchOnDescription / matchOnDetail であいまい検索を効かせる）
			interface AgentPickItem extends vscode.QuickPickItem {
				agentName: string;
			}
			const items: AgentPickItem[] = agents.map((a) => {
				const parts: string[] = [];
				if (a.displayName && a.displayName !== a.name) { parts.push(a.displayName); }
				if (a.model) { parts.push(a.model); }
				if (a.parentAgent) { parts.push(`親: ${a.parentAgent}`); }
				const description = parts.join(' ・ ');
				const detail = a.displayRole || a.role || a.displayDescription || '';
				return {
					label: `$(person) ${a.name}`,
					description,
					detail,
					agentName: a.name,
				};
			});
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'エージェント名 / 表示名 / 役割 / モデル / 親部署で検索',
				matchOnDescription: true,
				matchOnDetail: true,
			});
			if (!picked) { return; }

			// TreeView.reveal で該当ノードへジャンプ（getParent 経由でルートまで辿る）
			if (claudeAgentsTreeView) {
				const item = agentProvider.getAgentItemByName(picked.agentName);
				if (item) {
					try {
						await claudeAgentsTreeView.reveal(item, { select: true, focus: true, expand: 3 });
					} catch { /* reveal 失敗（親未展開等）は無視。preview は続行 */ }
				}
			}
			// previewAgentByName を実行してプレビューを開く
			await vscode.commands.executeCommand('claudeManager.previewAgentByName', picked.agentName);
		})
	);

	// v0.5.18 §4-8: エージェント表示グループを切替
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.groupAgents', async () => {
			const cfg = vscode.workspace.getConfiguration('claudeManager');
			const current = cfg.get<string>('agents.defaultGroupMode', 'org');
			interface ModePick extends vscode.QuickPickItem { value: 'org' | 'model' | 'status' | 'flat'; }
			const items: ModePick[] = [
				{ value: 'org',    label: '組織図', description: '親子関係で階層表示（既定）' },
				{ value: 'model',  label: 'モデル別', description: 'fable / opus / sonnet / haiku で集約' },
				{ value: 'status', label: '状態別', description: '稼働中 / 待機 / 未紐づけ で集約' },
				{ value: 'flat',   label: 'フラット', description: 'グルーピングなし・名前順' },
			];
			for (const it of items) { if (it.value === current) { it.label = `$(check) ${it.label}`; } }
			const picked = await vscode.window.showQuickPick(items, {
				placeHolder: 'エージェント一覧のグルーピング方式を選択',
				title: 'エージェント表示グループ',
			});
			if (!picked) { return; }
			await cfg.update('agents.defaultGroupMode', picked.value, vscode.ConfigurationTarget.Global);
			agentProvider.setGroupMode(picked.value);
		})
	);

	// v0.5.18 §4-4: 稼働中のみ表示を切替
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleAgentActiveOnly', async () => {
			const cfg = vscode.workspace.getConfiguration('claudeManager');
			const current = cfg.get<boolean>('agents.activeOnly', false);
			const next = !current;
			await cfg.update('agents.activeOnly', next, vscode.ConfigurationTarget.Global);
			agentProvider.setActiveOnly(next);
			vscode.window.showInformationMessage(
				next ? '稼働中のエージェントのみ表示中' : '全エージェントを表示中'
			);
		})
	);

	// v0.5.18 §4-7 walkthrough 用: エージェント監視を有効化
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.enableAgentMonitor', async () => {
			const cfg = vscode.workspace.getConfiguration('claudeManager');
			const already = cfg.get<boolean>('enableAgentMonitor', false);
			if (already) {
				vscode.window.showInformationMessage('エージェント監視は既に有効です。');
				return;
			}
			await cfg.update('enableAgentMonitor', true, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage('エージェント監視を有効にしました。');
		})
	);

	// v0.5.18 §4-7 walkthrough では既存の `claudeManager.installCsmAskAgent`（migrationCommands.ts:272 実装）
	// をそのまま呼ぶ。ここで再登録すると二重 registerCommand で activate() が失敗するため、
	// レビュー修正 (1) [CRITICAL] で本ラッパーは撤去済み。

// 初回エージェント登録時: 役割自動認識(SessionStart hook)の有効化を提案
const SESSION_INJECT_ASKED_KEY = 'csm.sessionAgentInject.asked';
async function promptSessionInjectIfFirstTime(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<boolean>(SESSION_INJECT_ASKED_KEY)) { return; }
	await context.globalState.update(SESSION_INJECT_ASKED_KEY, true);
	const choice = await vscode.window.showInformationMessage(
		'エージェントを作成しました。紐づけ後にClaudeが自動で役割を認識する機能を有効化しますか？\n（SessionStart hookを~/.claude/settings.jsonに登録します）',
		'有効化',
		'後で',
	);
	if (choice === '有効化') {
		await ensureSessionAgentInjectHook(context.extensionPath, extensionOutputChannel);
		vscode.window.showInformationMessage('役割自動認識を有効化しました。次回セッション開始時から動作します。');
	}
}

// エージェント保存共通ヘルパー（body生成 + 名前変更対応 + 親子同期）
async function saveAgentWithRule(
	config: AgentConfig,
	oldName: string | undefined,
	oldParent: string | undefined,
	isNewAgent: boolean = false,
	oldScope?: 'global' | 'project',
): Promise<void> {
	// スコープ変更時: ファイルを移動
	const effectiveName = oldName || config.name;
	if (oldScope && config.scope && oldScope !== config.scope) {
		await dataStore.moveAgentScope(effectiveName, config.scope);
	}
	// ルール本文を生成
	const [ruleConfig, ruleBody] = await prepareAgentRule(config, isNewAgent);
	// 名前変更時: 旧ファイルを削除
	if (oldName && ruleConfig.name !== oldName) {
		await dataStore.removeAgent(oldName);
	}
	// 保存（bodyをagents/<name>.mdの本文に書き込む）
	await dataStore.addAgent(ruleConfig, ruleBody);
	// 親子同期
	const ch = getExtensionOutputChannel();
	if (oldParent && oldParent !== ruleConfig.parentAgent) {
		await syncParentRuleFile(oldParent, ch);
	}
	await syncParentRuleFile(ruleConfig.parentAgent, ch);
	refreshAll();
}

// --- エージェント関連コマンド ---

// エージェントプレビュー（クリック時）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.previewAgent', (item: AgentItem) => {
		const agent = item.agent;
		const isLive = agent.sessionId ? sessionProvider.isLiveSession(agent.sessionId) : false;
		const sessions = sessionProvider.getSessions();
		const session = agent.sessionId ? sessions.find((s) => s.id === agent.sessionId) : undefined;
		const sessionTitle = session ? (session.customName || session.claudeTitle || session.firstMessage.substring(0, 40)) : undefined;

		showAgentPreview(agent, isLive, sessionTitle, {
			onEdit: (a) => {
				const oldName = a.name;
				const oldParent = a.parentAgent;
				const oldScope = a.scope;
				showAgentFormPanel(a, a.sessionId, async (config) => {
					await saveAgentWithRule(config, oldName, oldParent, false, oldScope);
					vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
				}, context);
			},
			onEditRuleFile: async (a) => {
				if (!a.ruleFile) { return; }
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.ruleFile));
				await vscode.window.showTextDocument(doc);
			},
			onOpenInClaude: (sessionId) => {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`);
				vscode.env.openExternal(uri);
			},
			onOpenInTerminal: (a) => {
				const args = buildResumeArgs(a);
				if (!args) { return; }
				if (a.permissionMode) { args.push('--permission-mode', a.permissionMode); }
				const terminal = vscode.window.createTerminal({ name: `🤖 ${a.displayName || a.name}`, cwd: a.workDir ? translateWorkDirPath(a.workDir) : undefined });
				terminal.show();
				terminal.sendText(args.join(' '));
			},
			onRenewSession: (a) => {
				vscode.commands.executeCommand('claudeManager.renewAgentSession', { agent: a });
			},
			onLinkSession: (a) => {
				vscode.commands.executeCommand('claudeManager.linkSession', { agent: a });
			},
			// v0.5.27: 基本情報のフォルダリンクから OS エクスプローラで開く
			onRevealFolder: (workDir) => {
				if (!workDir) { return; }
				const resolved = translateWorkDirPath(workDir);
				void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved));
			},
		});
	})
);

// TASK-5 Phase 2: エージェント名でプレビューを開く（LiveAgentItem クリック用）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.previewAgentByName', async (agentName: string) => {
		const agents = await dataStore.getAgents();
		const agent = agents.find(a => a.name === agentName);
		if (!agent) {
			vscode.window.showWarningMessage(`エージェント「${agentName}」が見つかりません`);
			return;
		}
		const isLive = agent.sessionId ? sessionProvider.isLiveSession(agent.sessionId) : false;
		const sessions = sessionProvider.getSessions();
		const session = agent.sessionId ? sessions.find((s) => s.id === agent.sessionId) : undefined;
		const sessionTitle = session ? (session.customName || session.claudeTitle || session.firstMessage.substring(0, 40)) : undefined;
		showAgentPreview(agent, isLive, sessionTitle, {
			onEdit: (a) => {
				vscode.commands.executeCommand('claudeManager.editAgent', { agent: a });
			},
			onEditRuleFile: async (a) => {
				if (!a.ruleFile) { return; }
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.ruleFile));
				await vscode.window.showTextDocument(doc);
			},
			onOpenInClaude: (sessionId) => {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`);
				vscode.env.openExternal(uri);
			},
			onOpenInTerminal: (a) => {
				const args = buildResumeArgs(a);
				if (!args) { return; }
				if (a.permissionMode) { args.push('--permission-mode', a.permissionMode); }
				const terminal = vscode.window.createTerminal({ name: `🤖 ${a.displayName || a.name}`, cwd: a.workDir ? translateWorkDirPath(a.workDir) : undefined });
				terminal.show();
				terminal.sendText(args.join(' '));
			},
			onRenewSession: (a) => {
				vscode.commands.executeCommand('claudeManager.renewAgentSession', { agent: a });
			},
			onLinkSession: (a) => {
				vscode.commands.executeCommand('claudeManager.linkSession', { agent: a });
			},
			// v0.5.27: 基本情報のフォルダリンクから OS エクスプローラで開く
			onRevealFolder: (workDir) => {
				if (!workDir) { return; }
				const resolved = translateWorkDirPath(workDir);
				void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolved));
			},
		});
	})
);

// エージェントに紐づいたセッションIDをクリップボードにコピー
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.copyAgentSessionId', async (item: AgentItem) => {
		const sid = item.agent.sessionId;
		if (!sid) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}
		await vscode.env.clipboard.writeText(sid);
		vscode.window.showInformationMessage(`セッションID をコピーしました: ${sid.substring(0, 8)}...`);
	})
);

// エージェントに紐づいたセッションの .jsonl ファイルパスをクリップボードにコピー
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.copyAgentSessionPath', async (item: AgentItem) => {
		const sid = item.agent.sessionId;
		if (!sid) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}
		// 全プロジェクト横断で実ファイルを検索
		const projectsDir = path.join(os.homedir(), '.claude', 'projects');
		let found: string | undefined;
		try {
			const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
			for (const e of entries) {
				if (!e.isDirectory()) { continue; }
				const candidate = path.join(projectsDir, e.name, `${sid}.jsonl`);
				try {
					await fs.promises.access(candidate);
					found = candidate;
					break;
				} catch { /* next */ }
			}
		} catch { /* noop */ }

		if (!found) {
			vscode.window.showWarningMessage(`セッションファイルが見つかりません: ${sid.substring(0, 8)}...`);
			return;
		}
		await vscode.env.clipboard.writeText(found);
		vscode.window.showInformationMessage(`セッションパス をコピーしました: ${path.basename(found)}`);
	})
);

// エージェントとして登録（新規 — Webviewフォーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.registerAgent', (item: SessionItem) => {
		showAgentFormPanel(undefined, item.session.id, async (config) => {
			await saveAgentWithRule(config, undefined, undefined, true);
			vscode.window.showInformationMessage(`「${config.name}」をエージェントとして登録しました`);
			await promptSessionInjectIfFirstTime(context);
		}, context);
	})
);

// エージェント追加（＋ボタン: 登録後は紐づけ画面へ誘導）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.addAgent', () => {
		showAgentFormPanel(undefined, '', async (config) => {
			if (!config.sessionId) { config.sessionId = ''; }
			// ルール生成 → ファイル書き込み（この時点ではセッション未紐づけ）
			const [ruleConfig, ruleBody] = await prepareAgentRule(config, true);
			await dataStore.addAgent(ruleConfig, ruleBody);

			// HISTORY.md / TODO.md 自動作成（有効かつファイル未存在の場合）
			if (ruleConfig.historyEnabled) {
				const agentDir = path.join(os.homedir(), '.claude', 'agents', ruleConfig.name);
				const historyPath = path.join(agentDir, 'HISTORY.md');
				try { await fs.promises.access(historyPath); } catch {
					await fs.promises.mkdir(agentDir, { recursive: true });
					await fs.promises.writeFile(
						historyPath,
						`# ${ruleConfig.displayName || ruleConfig.name} — 歴代セッション記録\n`,
						'utf-8'
					);
				}
			}
			if (ruleConfig.todoEnabled) {
				const agentDir = path.join(os.homedir(), '.claude', 'agents', ruleConfig.name);
				const todoPath = path.join(agentDir, 'TODO.md');
				try { await fs.promises.access(todoPath); } catch {
					await fs.promises.mkdir(agentDir, { recursive: true });
					await fs.promises.writeFile(
						todoPath,
						`# ${ruleConfig.displayName || ruleConfig.name} — TODO\n\n## 確認待ち\n\n## タスク\n`,
						'utf-8'
					);
				}
			}

			await syncParentRuleFile(ruleConfig.parentAgent, getExtensionOutputChannel());
			refreshAll();
			await promptSessionInjectIfFirstTime(context);

			// 使い捨て or 既にsessionIdが指定済みなら紐づけ誘導はスキップ
			if (ruleConfig.sessionMode === 'disposable' || ruleConfig.sessionId) {
				vscode.window.showInformationMessage(`「${ruleConfig.name}」をエージェントとして登録しました`);
				return;
			}

			// 既存セッション紐づけ画面を開く（末尾に「新規作成」オプションあり）
			vscode.window.showInformationMessage(
				`「${ruleConfig.name}」を登録しました。既存セッションを紐づけるか、新規セッションを作成してください。`
			);
			// AgentItem相当のダミーを作って linkSession を呼ぶ
			await vscode.commands.executeCommand('claudeManager.linkSession', { agent: ruleConfig });
		}, context);
	})
);

// エージェント設定を編集（Webviewフォーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editAgent', async (item: SessionItem | AgentItem) => {
		let existing: AgentConfig | undefined;
		let sessionId: string;
		if (item instanceof AgentItem) {
			existing = item.agent;
			sessionId = existing.sessionId;
		} else {
			existing = await dataStore.getAgentBySessionId(item.session.id);
			sessionId = item.session.id;
		}
		if (!existing) {
			vscode.window.showWarningMessage('エージェントが見つかりません');
			return;
		}

		const oldName = existing.name;
		const oldParent = existing.parentAgent;
		const oldScope = existing.scope;
		showAgentFormPanel(existing, sessionId, async (config) => {
			await saveAgentWithRule(config, oldName, oldParent, false, oldScope);
			vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
		}, context);
	})
);

// プレビューヘッダからの設定編集（セッションIDベース）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editAgentBySessionId', async (sessionId: string) => {
		const existing = await dataStore.getAgentBySessionId(sessionId);
		if (!existing) { return; }
		const oldName = existing.name;
		const oldParent = existing.parentAgent;
		const oldScope = existing.scope;
		showAgentFormPanel(existing, sessionId, async (config) => {
			await saveAgentWithRule(config, oldName, oldParent, false, oldScope);
			refreshAll();
			vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
		}, context);
	})
);

// プレビューヘッダからのルールファイル編集（セッションIDベース）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editRuleFileBySessionId', async (sessionId: string) => {
		const agent = await dataStore.getAgentBySessionId(sessionId);
		if (!agent || !agent.ruleFile) { return; }
		const resolved = await resolveRuleFilePath(agent.ruleFile);
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
		await vscode.window.showTextDocument(doc);
	})
);

// ルールファイルを編集
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editRuleFile', async (item: SessionItem | AgentItem) => {
		let agent: AgentConfig | undefined;
		if (item instanceof AgentItem) {
			agent = item.agent;
		} else {
			agent = await dataStore.getAgentBySessionId(item.session.id);
		}
		if (!agent || !agent.ruleFile) {
			vscode.window.showWarningMessage('ルールファイルが設定されていません');
			return;
		}
		const resolved = await resolveRuleFilePath(agent.ruleFile);
		const uri = vscode.Uri.file(resolved);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	})
);

// セッションを紐づけ（エージェントサイドバーから）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.linkSession', async (item: AgentItem) => {
		const sessions = sessionProvider.getSessions();
		const sessionItems: { label: string; description: string; sessionId: string; actualModel: string | undefined; alreadyLinked: boolean; linkedAgentName: string | undefined }[] = [];
		for (const s of sessions) {
			const existingAgent = await dataStore.getAgentBySessionId(s.id);
			const usedLabel = existingAgent ? ` [${existingAgent.name}に紐づけ済み]` : '';
			sessionItems.push({
				label: (s.customName || s.claudeTitle || s.firstMessage.substring(0, 50)) + usedLabel,
				description: `${s.project} — ${s.lastTimestamp.toLocaleString('ja-JP')}`,
				sessionId: s.id,
				actualModel: s.model,
				alreadyLinked: !!existingAgent,
				linkedAgentName: existingAgent?.name,
			});
		}

		// リスト末尾に「+ 新しいセッションを作成」オプションを追加
		const NEW_SESSION_ID = '__csm_new_session__';
		sessionItems.push({
			label: '$(add) 新しいセッションを作成してこのエージェントに紐づける',
			description: `claude --agent ${item.agent.name} で新規セッションを起動`,
			sessionId: NEW_SESSION_ID,
			actualModel: undefined,
			alreadyLinked: false,
			linkedAgentName: undefined,
		});

		const isAlreadyLinked = !!item.agent.sessionId;

		// 紐づけ済みの場合は確認を挟む
		if (isAlreadyLinked) {
			const confirm = await vscode.window.showWarningMessage(
				`「${item.agent.displayName || item.agent.name}」には既にセッションが紐づけされています。変更しますか？`,
				{ modal: true },
				'変更する'
			);
			if (confirm !== '変更する') { return; }
		}

		const picked = await vscode.window.showQuickPick(sessionItems, {
			placeHolder: '紐づけるセッションを選択（または末尾で新規作成）',
			title: `「${item.agent.displayName || item.agent.name}」に${isAlreadyLinked ? 'セッションを変更' : 'セッションを紐づけ'}`,
		});
		if (!picked) { return; }

		// 新規セッション作成パス
		if (picked.sessionId === NEW_SESSION_ID) {
			try {
				const newSessionId = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `「${item.agent.name}」の新規セッションを作成中...`,
						cancellable: false,
					},
					async () => {
						const { createSessionForAgent } = await import('../services/sessionService');
						return createSessionForAgent(item.agent, sessionServiceDeps);
					}
				);
				await dataStore.addAgent({ ...item.agent, sessionId: newSessionId });
				refreshAll();
				vscode.window.showInformationMessage(`新規セッションを作成して「${item.agent.name}」に紐づけました`);
			} catch (err) {
				vscode.window.showErrorMessage(`新規セッション作成に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
			}
			return;
		}

		// 他エージェントに紐づけ済みの場合は警告
		if (picked.alreadyLinked && picked.linkedAgentName !== item.agent.name) {
			const confirm = await vscode.window.showWarningMessage(
				`このセッションは「${picked.linkedAgentName}」に紐づけ済みです。上書きしますか？`,
				'上書き', 'キャンセル'
			);
			if (confirm !== '上書き') { return; }
			// 旧エージェントの紐づけを解除
			const oldAgent = await dataStore.getAgentBySessionId(picked.sessionId);
			if (oldAgent) {
				await dataStore.addAgent({ ...oldAgent, sessionId: '' });
			}
		}

		// モデル不一致チェック: 設定モデルと実際のモデルを比較
		let agentToSave = { ...item.agent, sessionId: picked.sessionId };
		if (picked.actualModel && item.agent.model) {
			const mismatch = !agentWatcher.modelsMatchPublic(item.agent.model, picked.actualModel);
			if (mismatch) {
				const answer = await vscode.window.showWarningMessage(
					`モデルが異なります。\n設定: ${item.agent.model}\n実際: ${picked.actualModel}\n設定を実際のモデルに合わせますか？`,
					{ modal: true },
					'合わせる', 'そのまま'
				);
				if (answer === '合わせる') {
					const newModel = picked.actualModel ? normalizeModel(picked.actualModel) : item.agent.model;
					agentToSave = { ...agentToSave, model: newModel };
				}
			}
		}

		await dataStore.addAgent(agentToSave);
		refreshAll();
		vscode.window.showInformationMessage(`「${item.agent.name}」にセッションを紐づけました`);
	})
);

// エージェントのセッションをClaudeで開く（URIスキーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openAgentInClaude', async (item: AgentItem) => {
		if (!item.agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}

		// v0.5.27: セッション作成時 cwd（存在すれば）または agent.workDir を対象フォルダとし、
		//   現ワークスペース群のいずれかに包含されていなければ「新しいウィンドウを開く」
		//   → その後にセッション復元 URI を投げる（ベストエフォート、下記 判断メモ 参照）。
		const sid = item.agent.sessionId;
		const projectsDir = path.join(os.homedir(), '.claude', 'projects');
		let sessionCwd: string | undefined;
		try {
			const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
			for (const e of entries) {
				if (!e.isDirectory()) { continue; }
				const jsonlPath = path.join(projectsDir, e.name, `${sid}.jsonl`);
				try {
					await fs.promises.access(jsonlPath);
					const handle = await fs.promises.open(jsonlPath, 'r');
					try {
						const buf = Buffer.alloc(16 * 1024);
						await handle.read(buf, 0, 16 * 1024, 0);
						const lines = buf.toString('utf-8').split('\n');
						for (const line of lines) {
							if (!line.trim()) { continue; }
							try {
								const entry = JSON.parse(line);
								if (entry.cwd) { sessionCwd = entry.cwd; break; }
							} catch { /* skip */ }
						}
					} finally { await handle.close(); }
					break;
				} catch { /* next */ }
			}
		} catch { /* projects dir なし */ }

		// 純関数で対象フォルダ・新ウィンドウ要否を判定
		const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
		const targetFolder = resolveOpenInClaudeTargetFolder(sessionCwd, item.agent.workDir);
		const allowNewWindow = vscode.workspace
			.getConfiguration('claudeManager')
			.get<boolean>('agent.openInNewWindowWhenFolderMismatch', true);
		const needsNew = needsNewWindowForClaudeOpen(targetFolder, wsFolders, allowNewWindow);

		const scheme = vscode.env.uriScheme;
		const uri = vscode.Uri.parse(
			`${scheme}://anthropic.claude-code/open?session=` +
			encodeURIComponent(item.agent.sessionId)
		);

		if (needsNew) {
			// 新ウィンドウで対象フォルダを開く → その後セッション URI をベストエフォートで送る
			const resolved = translateWorkDirPath(targetFolder);
			vscode.window.showInformationMessage(
				`「${targetFolder}」を新しいウィンドウで開きます。開いた先で自動的にセッションが復元されない場合は、` +
				`CSM のライブ状態から再度「Claude で開く」を押してください。`,
			);
			try {
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(resolved), { forceNewWindow: true });
			} catch (err) {
				// openFolder 失敗（パス不正等）→ URI のみ試みる（従来と同じ挙動にフォールバック）
				vscode.window.showWarningMessage(
					`新しいウィンドウを開けませんでした（${String(err)}）。URI ハンドラのみで開きます。`,
				);
			}
			// URI は新ウィンドウ側の CC 拡張が起動した後に届くのが理想。タイミング依存のため
			//   小さな遅延を入れてベストエフォートで送る。届かなくてもユーザーは案内メッセージにより
			//   再度「Claude で開く」を押せば復元できる。
			setTimeout(() => { void vscode.env.openExternal(uri); }, 1500);
		} else {
			// 既存動作: 現ワークスペースに包含されていれば URI ハンドラだけで OK
			// （openExternal を待つ必要はないので await しない）
			void vscode.env.openExternal(uri);
		}
	})
);

// エージェントのセッションをターミナルで開く（ルールファイル適用付き）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openAgentSession', async (item: AgentItem) => {
		if (!item.agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}
		// ルールファイルの存在チェック
		if (!item.agent.ruleFile) {
			vscode.window.showWarningMessage('ルールファイルが紐づいていません。エージェント設定から役割を設定してください');
		} else {
			try {
				await fs.promises.access(item.agent.ruleFile);
			} catch {
				vscode.window.showWarningMessage(`ルールファイルが見つかりません: ${item.agent.ruleFile}`);
			}
		}

		// workDirがVS Codeワークスペース外ならIDEパネルと連携しないため警告
		// Windows→Linux HGFSパス変換を適用してから比較・使用する
		// T3.20: isWorkDirCompatible() で isContainedIn ベースの双方向チェックに変更
		if (item.agent.workDir) {
			const resolvedWorkDir = translateWorkDirPath(item.agent.workDir);
			const { allowed: insideWorkspace } = isWorkDirCompatible(resolvedWorkDir);
			if (!insideWorkspace) {
				// 別フォルダは新しいウィンドウで開く (ダイアログ廃止)
				await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(resolvedWorkDir), { forceNewWindow: true });
				return;
			}
		}

		// ターミナルで --agent + --resume で起動（フロントマターからmodel/effort自動適用）
		// Phase 2-1: sessionId がない場合は --resume <agentName> による名前ベース再開（v2.1.101+）
		const args = buildResumeArgs(item.agent);
		if (!args) {
			vscode.window.showWarningMessage('セッションが紐づけられていません。エージェントを選択してセッションを紐づけてください。');
			return;
		}
		if (item.agent.permissionMode) {
			args.push('--permission-mode', item.agent.permissionMode);
		}

		const terminal = vscode.window.createTerminal({
			name: `🤖 ${item.agent.name}`,
			cwd: item.agent.workDir ? translateWorkDirPath(item.agent.workDir) : undefined,
		});
		terminal.show();
		terminal.sendText(args.join(' '));
	})
);

// セッションを新しくする（自動遺言生成して新セッション作成）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.renewAgentSession', async (item: AgentItem) => {
		const ch = getExtensionOutputChannel();
		const agent = item.agent;
		if (!agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}

		try {
			// セッションサイズチェック（巨大セッションではAI要約不可）
			let sessionSizeMB = 0;
			const oldSession2 = sessionProvider.getSessionById(agent.sessionId);
			if (oldSession2) {
				try {
					const stat = await fs.promises.stat(oldSession2.filePath);
					sessionSizeMB = stat.size / (1024 * 1024);
				} catch { /* stat失敗 */ }
			}
			const isTooLarge = sessionSizeMB > 30;

			// 遺言生成モードを選択
			const options: { label: string; description: string; value: 'simple' | 'detailed' | 'delegate' | 'manual' }[] = [
				{ label: '簡易（即時）', description: 'JSONL末尾から自動抽出。コストゼロ', value: 'simple' },
			];
			if (!isTooLarge) {
				options.push(
					{ label: '詳細（AI要約）', description: '本人のセッションで要約生成', value: 'detailed' as const },
					{ label: 'エージェントに委任する', description: '別エージェントに要約を依頼', value: 'delegate' as const },
				);
			} else {
				options.unshift(
					{ label: '📋 手動引き継ぎ手順を表示', description: `セッション${Math.round(sessionSizeMB)}MB — 手順に従って手動で引き継ぎ`, value: 'manual' as const },
				);
				options.push(
					{ label: 'エージェントに委任する', description: '別エージェントに要約を依頼', value: 'delegate' as const },
				);
			}
			const mode = await vscode.window.showQuickPick(options,
				{ placeHolder: isTooLarge ? `⚠ セッション${Math.round(sessionSizeMB)}MB — 手動引き継ぎ推奨` : '遺言の生成方法を選択してください' }
			);
			if (!mode) { return; }

			const oldSession = sessionProvider.getSessionById(agent.sessionId);
			const oldSessionId = agent.sessionId;
			let testament = `${agent.name}の前セッションから引き継ぎ。`;

			// 手動引き継ぎ手順を表示（巨大セッション用）
			if (mode.value === 'manual') {
				const crypto = require('crypto') as typeof import('crypto');
				const nonce = crypto.randomBytes(16).toString('hex');
				const historyPath = path.join(os.homedir(), '.claude', 'agents', agent.name, 'HISTORY.md').replace(/\\/g, '/');
				const manualPanel = vscode.window.createWebviewPanel(
					'claudeManualRenew',
					`📋 手動引き継ぎ手順 — ${agent.displayName || agent.name}`,
					vscode.ViewColumn.One,
					{ enableScripts: false }
				);
				manualPanel.webview.html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 24px; max-width: 700px; margin: 0 auto; }
h1 { font-size: 18px; margin-bottom: 16px; }
.warn { background: rgba(255,200,50,0.08); border: 1px solid rgba(255,200,50,0.3); border-radius: 4px; padding: 12px; margin-bottom: 16px; font-size: 13px; }
.step { margin-bottom: 20px; }
.step-num { font-size: 24px; font-weight: 700; color: #e27e4a; float: left; margin-right: 12px; }
.step-content { overflow: hidden; }
.step-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.step-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
code { background: var(--vscode-textBlockQuote-background); padding: 8px 12px; display: block; border-radius: 4px; font-size: 12px; white-space: pre-wrap; margin: 8px 0; line-height: 1.6; }
</style></head><body>
<h1>📋 手動引き継ぎ手順</h1>
<div class="warn">⚠ セッションが ${Math.round(sessionSizeMB)}MB と巨大なため、自動AI要約は使用できません。以下の手順で手動引き継ぎしてください。</div>

<div class="step">
<div class="step-num">1</div>
<div class="step-content">
<div class="step-title">このセッションで以下を実行</div>
<div class="step-desc">エージェントに直接入力してください：</div>
<code>セッションの要約を300文字以内で書いて。
何をしたか・何が達成されたか・何が未完了か。
結果を ${historyPath} に追記して。</code>
</div></div>

<div class="step">
<div class="step-num">2</div>
<div class="step-content">
<div class="step-title">引き継ぎボタンで「簡易（即時）」を選択</div>
<div class="step-desc">HISTORYに記録が残っているので、簡易モードで十分です。新セッションが自動作成されます。</div>
</div></div>

<div class="step">
<div class="step-num">3</div>
<div class="step-content">
<div class="step-title">新セッションで確認</div>
<div class="step-desc">新セッションが起動したら、HISTORY.mdを読んで前回の文脈を把握します。</div>
</div></div>
</body></html>`;
				return; // 手順表示のみで終了
			}

			// 遺言生成（エラー時はデフォルトメッセージで続行）
			try {
				if (mode.value === 'simple') {
					testament = await generateSimpleTestament(agent, oldSession);
				} else if (mode.value === 'delegate') {
					// エージェント委任モード: 他エージェントのセッションにresumeして要約生成
					const allAgents = await dataStore.getAgents();
					const availableAgents = allAgents.filter(a => a.name !== agent.name && a.sessionId);
					if (availableAgents.length === 0) {
						vscode.window.showWarningMessage('利用可能なエージェントがありません。簡易モードにフォールバックします。');
						testament = await generateSimpleTestament(agent, oldSession);
					} else {
						const agentPick = await vscode.window.showQuickPick(
							availableAgents.map(a => ({
								label: a.name,
								description: `${a.role || ''} [${a.model}]`,
								value: a,
							})),
							{ placeHolder: '要約を依頼するエージェントを選択', title: '委任先エージェント' }
						);
						if (!agentPick) { return; }
						testament = await generateDetailedTestament(agent, oldSession, agentPick.value.sessionId);
					}
				} else {
					// 詳細モード: エージェント設定のモデルでAI要約生成
					// 本人のセッションに直接要約を依頼
					testament = await generateDetailedTestament(agent, oldSession, agent.sessionId);
				}
			} catch (testamentErr) {
				ch.appendLine(`[${new Date().toISOString()}] 遺言生成エラー: ${testamentErr instanceof Error ? testamentErr.message : String(testamentErr)}`);
				vscode.window.showWarningMessage(`遺言生成に失敗しました。デフォルトメッセージで続行します。`);
				// testament はデフォルト値のまま続行
			}

			// 300文字上限
			testament = testament.substring(0, 300);

			// 確認ダイアログ（編集可能）
			const finalTestament = await vscode.window.showInputBox({
				prompt: '引き継ぎメッセージ（編集可能・最大300文字）',
				placeHolder: '次のセッションへの引き継ぎ事項...',
				value: testament,
			});
			if (finalTestament === undefined) { return; }
			const trimmedTestament = finalTestament.substring(0, 300);

			// 旧セッションのJSONLに引き継ぎメッセージを追記
			if (oldSession) {
				try {
					const entry = JSON.stringify({
						type: 'user',
						uuid: `testament-${Date.now()}`,
						parentUuid: null,
						timestamp: new Date().toISOString(),
						sessionId: oldSessionId,
						message: {
							role: 'user',
							content: `[セッション終了] ${trimmedTestament}`,
						},
					});
					await fs.promises.appendFile(oldSession.filePath, '\n' + entry);
				} catch (writeErr) {
					ch.appendLine(`[${new Date().toISOString()}] JSONL追記エラー: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
					// 書き込み失敗でもセッション更新は続行
				}
			}

			// ルールファイルのカスタム部分に歴代セッション記録を追記
			if (agent.ruleFile) {
				try {
					await appendSessionHistoryToRuleFile(agent.ruleFile, oldSessionId, trimmedTestament, extensionOutputChannel);
				} catch (historyErr) {
					ch.appendLine(`[${new Date().toISOString()}] 歴代セッション記録追記エラー: ${historyErr instanceof Error ? historyErr.message : String(historyErr)}`);
					// 追記失敗でもセッション更新は続行
				}
			}

			// previousSessionIds を更新（直近5件保持）
			const prevIds = [...(agent.previousSessionIds || [])];
			prevIds.push(oldSessionId);
			while (prevIds.length > 5) { prevIds.shift(); }

			// セッションID紐づけを一時解除
			const updatedAgent: AgentConfig = { ...agent, sessionId: '', previousSessionIds: prevIds };
			await dataStore.addAgent(updatedAgent);

			// 新セッション自動作成 + 紐づけ
			const createNew = await vscode.window.showInformationMessage(
				`「${agent.displayName || agent.name}」の旧セッションを解除しました。新しいセッションを自動作成しますか？`,
				'自動作成', '手動で紐づけ'
			);

			if (createNew === '自動作成') {
				try {
					ch.appendLine(`[${new Date().toISOString()}] 新セッション作成中: ${agent.name}`);
					const initPrompt = `セッション引き継ぎ完了。前回の要約: ${trimmedTestament}`;
					const newSessionId = await createRenewSession(agent.name, initPrompt, sessionServiceDeps);

					const finalAgent: AgentConfig = { ...updatedAgent, sessionId: newSessionId };
					await dataStore.addAgent(finalAgent);
					ch.appendLine(`[${new Date().toISOString()}] 新セッション紐づけ完了: ${newSessionId}`);
					refreshAll();
					vscode.window.showInformationMessage(
						`「${agent.displayName || agent.name}」の新セッションを作成・紐づけしました`
					);
				} catch (createErr) {
					ch.appendLine(`[${new Date().toISOString()}] 新セッション作成エラー: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
					refreshAll();
					vscode.window.showWarningMessage(
						`新セッションの自動作成に失敗しました。手動で紐づけてください。`
					);
				}
			} else {
				refreshAll();
				vscode.window.showInformationMessage(
					`「${agent.displayName || agent.name}」のセッション紐づけを解除しました。手動で紐づけてください。`
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ch.appendLine(`[${new Date().toISOString()}] renewAgentSession 致命的エラー (${agent.name}): ${msg}`);
			ch.show(true);
			vscode.window.showErrorMessage(`セッション更新に失敗しました: ${msg}`);
		}
	})
);

// エージェントを削除
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.deleteAgent', async (item: AgentItem) => {
		const confirm = await vscode.window.showWarningMessage(
			`エージェント「${item.agent.name}」を削除しますか？`,
			{ modal: true },
			'削除'
		);
		if (confirm !== '削除') { return; }

		const parentName = item.agent.parentAgent;
		await dataStore.removeAgent(item.agent.name);
		await syncParentRuleFile(parentName, getExtensionOutputChannel());
		refreshAll();
		vscode.window.showInformationMessage(`「${item.agent.name}」を削除しました`);
	})
);

// 確認待ち一覧
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.showPendingTasks', async () => {
		const crypto = require('crypto') as typeof import('crypto');
		// 全エージェントの TODO.md から「確認待ち」の未チェック項目を取得
		const agentsDir = path.join(os.homedir(), '.claude', 'agents');
		const agents = await dataStore.getAgents();
		const pendingByAgent: { name: string; displayName: string; items: string[] }[] = [];
		let totalCount = 0;

		for (const agent of agents) {
			const todoPath = path.join(agentsDir, agent.name, 'TODO.md');
			try {
				const content = await fs.promises.readFile(todoPath, 'utf-8');
				const items: string[] = [];
				let inPending = false;
				for (const line of content.split('\n')) {
					const stripped = line.trim();
					if (stripped.startsWith('## 確認待ち')) { inPending = true; continue; }
					if (inPending && stripped.startsWith('## ')) { break; }
					if (inPending && stripped.startsWith('- [ ]')) {
						items.push(stripped.substring(6).trim());
					}
				}
				if (items.length > 0) {
					pendingByAgent.push({
						name: agent.name,
						displayName: agent.displayName || agent.name,
						items,
					});
					totalCount += items.length;
				}
			} catch { /* TODO.mdがない場合はスキップ */ }
		}

		if (totalCount === 0) {
			vscode.window.showInformationMessage('確認待ちタスクはありません');
			return;
		}

		// Webviewパネルで表示
		const nonce = crypto.randomBytes(16).toString('hex');
		const sectionsHtml = pendingByAgent.map(a => {
			const itemsHtml = a.items.map((item, i) =>
				`<label class="pending-item"><input type="checkbox" data-agent="${a.name}" data-task="${item.replace(/"/g,'&quot;')}"> ${item.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</label>`
			).join('');
			return `<div class="agent-section">
				<div class="agent-name">🤖 ${a.displayName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}（${a.name}）</div>
				${itemsHtml}
			</div>`;
		}).join('');

		const panel = vscode.window.createWebviewPanel(
			'claudePendingTasks',
			`📋 確認待ち（${totalCount}件）`,
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		panel.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'togglePending') {
				const todoPath = path.join(os.homedir(), '.claude', 'agents', message.agent, 'TODO.md');
				try {
					const content = await fs.promises.readFile(todoPath, 'utf-8');
					const lines = content.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (message.checked && lines[i].trim() === `- [ ] ${message.task}`) {
							lines[i] = lines[i].replace('- [ ]', '- [x]');
							break;
						} else if (!message.checked && lines[i].trim() === `- [x] ${message.task}`) {
							lines[i] = lines[i].replace('- [x]', '- [ ]');
							break;
						}
					}
					await fs.promises.writeFile(todoPath, lines.join('\n'), 'utf-8');
				} catch { /* 失敗は無視 */ }
			}
		});

		panel.webview.html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 20px 24px; max-width: 720px; margin: 0 auto; }
h1 { font-size: 16px; margin-bottom: 16px; }
.agent-section { margin-bottom: 16px; border-left: 3px solid #e27e4a; padding-left: 12px; }
.agent-name { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #e27e4a; }
.pending-item { display: block; font-size: 12px; padding: 3px 0; cursor: pointer; }
.pending-item:hover { background: rgba(255,255,255,0.03); }
.pending-item input { margin-right: 6px; cursor: pointer; }
.pending-item.done { text-decoration: line-through; opacity: 0.4; }
.summary { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
</style></head><body>
<h1>📋 確認待ちタスク</h1>
<div class="summary">${pendingByAgent.length}エージェント・${totalCount}件</div>
${sectionsHtml}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('.pending-item input').forEach(cb => {
cb.addEventListener('change', (e) => {
	const input = e.target;
	const label = input.parentElement;
	if (input.checked) { label.classList.add('done'); } else { label.classList.remove('done'); }
	vscode.postMessage({
		type: 'togglePending',
		agent: input.dataset.agent,
		task: input.dataset.task,
		checked: input.checked
	});
});
});
</script>
</body></html>`;
	})
);

// ⭐ エージェントお気に入り追加
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.addAgentFavorite', (item: AgentItem) => {
		if (!item?.agent?.name) { return; }
		addBookmark(item.agent.name);
		agentProvider.refresh();
	})
);

// ⭐ エージェントお気に入り削除
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.removeAgentFavorite', (item: AgentItem) => {
		if (!item?.agent?.name) { return; }
		removeBookmark(item.agent.name);
		agentProvider.refresh();
	})
);

// エージェント管理を更新
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.refreshAgents', () => {
		agentProvider.refresh();
		updateStatusBar();
		vscode.window.showInformationMessage('エージェント管理を更新しました');
	})
);
}
