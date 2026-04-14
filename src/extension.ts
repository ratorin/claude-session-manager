import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem, SessionDecorationProvider } from './providers/sessionTreeProvider';
import { BookmarkTreeProvider } from './providers/bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from './providers/tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem, MemoryGroupItem } from './providers/memoryTreeProvider';
import { AgentTreeProvider, AgentItem, MigrationBannerItem } from './providers/agentTreeProvider';
import { showSessionPreview, showMemoryPreview, updatePreviewTitle } from './panels/webviewPanel';
import { showAgentFormPanel } from './panels/agentFormPanel';
import { showAgentPreview } from './panels/agentPreviewPanel';
import { showOrgChart } from './panels/orgChartPanel';
import { shouldShowInOrgChart, moveToTrash } from './utils/agentUtils';
import { AgentWatcher } from './watchers/agentWatcher';
// detectionComparePanel は Phase 4 で削除済み
import { modelCliMap } from './utils/cliBuilder';
import { TaskTracker } from './watchers/taskTracker';
import { UsageMonitor } from './utils/usageMonitor';
import * as dataStore from './models/dataStore';
import { AgentConfig } from './models/types';
import { loadMemoryFiles, deleteMemoryFile, mergeMemoryFiles, extractFromMemory, addToIndex } from './utils/memoryManager';
import { resolveRuleFilePath } from './agents/agentManager';
import { syncParentRuleFile, syncAllParentRuleFiles, hasCircularRef } from './agents/parentChildSync';
import {
	createSessionForAgent, autoCreateSessionIfNeeded,
	readFileTail, generateSimpleTestament, generateDetailedTestament,
	appendSessionHistoryToRuleFile, SessionServiceDeps,
} from './services/sessionService';
import {
	buildDescription, updateRuleFrontmatter, autoGenerateRuleFile,
	ensureAgentFolderFiles, addAffinitySettings,
	generateDirectorRuleFile, buildDirectorDescription,
} from './services/agentService';
import {
	ensureSubagentHooks, registerCsmAskAgentHook, writeOrgInfoToMemory,
} from './services/hookService';
import {
	parseFrontmatter, generateFrontmatter, updateFrontmatterInContent,
	migrateAutoToYaml, isLegacyAutoFormat, hasFrontmatter, sanitizeForYaml,
} from './utils/frontmatterUtils';

// VS Code設定から値を取得するヘルパー
function getConfig<T>(key: string, defaultValue: T): T {
	return vscode.workspace.getConfiguration('claudeManager').get<T>(key, defaultValue);
}

// 出力先ファイルパスの安全性検証（H-2: パストラバーサル対策）
function validateOutputFile(filePath: string): boolean {
	try {
		const resolved = path.resolve(filePath);
		// ワークスペースフォルダ配下を許可
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders) {
			for (const folder of workspaceFolders) {
				if (resolved.startsWith(folder.uri.fsPath)) { return true; }
			}
		}
		// tmpフォルダ配下を許可
		const tmpDir = os.tmpdir();
		if (resolved.startsWith(tmpDir)) { return true; }
		// ホームディレクトリ配下の .claude を許可
		const claudeDir = path.join(os.homedir(), '.claude');
		if (resolved.startsWith(claudeDir)) { return true; }
		return false;
	} catch {
		return false;
	}
}

export function activate(context: vscode.ExtensionContext) {
	// session-manager.json マイグレーション: agents[] → agentSessions（一度だけ実行）
	dataStore.migrateAgentsToAgentSessions().catch(() => {
		// マイグレーション失敗は致命的ではないため、エラーを無視
	});

	// check-dispatch フックのマイグレーション（初回のみユーザー確認付き）
	// /csm-ask-agent のインストール状態はエージェントツリーのバナーで表示（ensureCsmAskAgent は廃止）

	// TreeViewプロバイダーを作成
	const sessionProvider = new SessionTreeProvider();
	const bookmarkProvider = new BookmarkTreeProvider(() => sessionProvider.getAllParentSessions(), sessionProvider);
	const tagProvider = new TagTreeProvider(() => sessionProvider.getSessions());
	const memoryProvider = new MemoryTreeProvider();
	const sessionDecoProvider = new SessionDecorationProvider();
	// AgentWatcher: PIDベース監視 + サブエージェント検出を統合
	const agentWatcher = new AgentWatcher();
	context.subscriptions.push(agentWatcher);

	const agentProvider = new AgentTreeProvider(
		() => sessionProvider.getSessions(),
		(id) => agentWatcher.isLive(id),
		() => agentWatcher.getActiveAgentNames()
	);

	// TreeDataProviderのEventEmitter解放を追跡
	context.subscriptions.push(sessionProvider, bookmarkProvider, tagProvider, memoryProvider, agentProvider);

	// デコレーションプロバイダーを登録
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionDecoProvider));

	// セッションロード完了時にブックマーク・タグを自動リフレッシュ
	sessionProvider.onDidRefresh(() => {
		bookmarkProvider.refresh();
		tagProvider.refresh();
	});

	// ステータスバーにエージェント稼働状況表示
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	statusBarItem.command = 'claudeManager.openOrgChart';
	statusBarItem.tooltip = '組織図を開く';
	context.subscriptions.push(statusBarItem);

	// AgentWatcher の状態変更時にステータスバー＋ツリーを更新
	function updateStatusBar(): void {
		dataStore.getAgents().then((agents) => {
			try {
				// 組織図エージェントのみカウント（showInOrgChart: true）
				const orgAgents = agents.filter((a) => shouldShowInOrgChart(a));
				const orgCount = orgAgents.length;

				if (!agentWatcher.isEnabled()) {
					// 監視無効時は静的表示のみ
					statusBarItem.text = `👥 ${orgCount}`;
					statusBarItem.tooltip = 'エージェント監視: OFF（設定で有効化できます）';
					statusBarItem.backgroundColor = undefined;
					statusBarItem.show();
					return;
				}

				const activeNames = agentWatcher.getActiveAgentNames();
				// 組織図エージェントの中でアクティブなもののみカウント
				const orgAgentNames = new Set(orgAgents.map((a) => a.name));
				const activeOrgNames = [...activeNames].filter((n) => orgAgentNames.has(n));
				const activeCount = activeOrgNames.length;

				if (activeCount === 0) {
					statusBarItem.text = `👥 ${orgCount}`;
					statusBarItem.tooltip = `動作中のエージェントなし（組織図: ${orgCount}件）`;
					statusBarItem.backgroundColor = undefined;
				} else {
					statusBarItem.text = `🟢 ${activeCount} 👥 ${orgCount}`;
					statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
					// 和名があれば「和名（英語名）」形式で表示
					const displayNameMap = new Map(orgAgents.map((a) => [a.name, a.displayName]));
					const nameList = activeOrgNames.map((n) => {
						const dn = displayNameMap.get(n);
						return dn ? `▶ ${dn}（${n}）` : `▶ ${n}`;
					}).join('\n');
					statusBarItem.tooltip = `動作中: ${activeCount}件 / 組織図: ${orgCount}件\n${nameList}`;
				}
				statusBarItem.show();
			} catch {
				statusBarItem.text = `👥 ?`;
				statusBarItem.backgroundColor = undefined;
				statusBarItem.show();
			}
		}).catch(() => {
			statusBarItem.text = `👥 ?`;
			statusBarItem.show();
		});
	}

	// TaskTracker: AgentWatcher に便乗してタスク状態を評価
	const taskTracker = new TaskTracker(agentWatcher);
	context.subscriptions.push(taskTracker);

	// TaskTracker → AgentTreeProvider 連携
	agentProvider.setTaskProvider((agentName) => taskTracker.getVisibleTasksForAgent(agentName));

	// AgentWatcher のイベントでステータスバー＋ツリーをリフレッシュ
	agentWatcher.onDidChange(() => {
		updateStatusBar();
		// モデル不一致情報をagentProviderに連携してからリフレッシュ
		agentProvider.setWatcherStates(agentWatcher.getStates());
		agentProvider.refresh();
		// ライブセッション情報をsessionTreeProviderに連携（H-3: 二重ポーリング統合）
		sessionProvider.setLiveSessionIds(agentWatcher.getLiveSessionIds());
		// タスク状態を評価（通知含む）
		taskTracker.evaluate().then(() => {
			dataStore.getTaskLogs().then(logs => taskTracker.notify(logs)).catch(() => {/* ignore */});
		}).catch(() => {/* ignore */});
	});

	// TaskTracker の状態変更時にツリーをリフレッシュ
	taskTracker.onDidChange(() => {
		agentProvider.refresh();
	});

	// 設定からデフォルトのソート/グループモードを適用
	const initialSortMode = getConfig<string>('defaultSortMode', 'updated-desc');
	const initialGroupMode = getConfig<string>('defaultGroupMode', 'date');
	sessionProvider.setSortMode(initialSortMode as 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model');
	sessionProvider.setGroupMode(initialGroupMode as 'date' | 'tag' | 'agent' | 'flat');

	// AgentWatcher を起動
	agentWatcher.start();

	// --- 利用率モニター ---
	const usageMonitor = new UsageMonitor();
	context.subscriptions.push(usageMonitor);

	// 利用率モニターの起動（設定に応じて）
	function startUsageMonitorIfEnabled(): void {
		const enabled = getConfig<boolean>('enableUsageMonitor', false);
		if (enabled) {
			const interval = getConfig<number>('usageMonitorInterval', 300);
			usageMonitor.start(interval);
		} else {
			usageMonitor.stop();
		}
	}
	startUsageMonitorIfEnabled();

	// 利用率手動更新コマンド
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshUsage', async () => {
			const enabled = getConfig<boolean>('enableUsageMonitor', false);
			if (!enabled) {
				vscode.window.showWarningMessage('利用制限モニターが無効です。設定から claudeManager.enableUsageMonitor を有効にしてください');
				return;
			}
			await usageMonitor.refresh();
			vscode.window.showInformationMessage('利用制限を更新しました');
		})
	);

	// 設定変更時に AgentWatcher / UsageMonitor を再起動
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (
			e.affectsConfiguration('claudeManager.enableAgentMonitor') ||
			e.affectsConfiguration('claudeManager.agentMonitorInterval') ||
			e.affectsConfiguration('claudeManager.detectionMode') ||
			e.affectsConfiguration('claudeSessionManager.detectionMode')
		) {
			const wasEnabled = agentWatcher.isEnabled();
			agentWatcher.restart();
			sessionProvider.restartPolling();
			updateStatusBar();
			// H-4: 監視ONからOFF切替時にrunning/stalledをpendingにリセット
			if (wasEnabled && !agentWatcher.isEnabled()) {
				taskTracker.resetOnMonitorDisabled();
			}
		}
		if (e.affectsConfiguration('claudeManager.enableUsageMonitor') || e.affectsConfiguration('claudeManager.usageMonitorInterval')) {
			startUsageMonitorIfEnabled();
		}
	}));

	// ウェルカム画面の表示制御用コンテキストキーを更新
	function updateHasAgentsContext(): void {
		dataStore.getAgents().then(agents => {
			vscode.commands.executeCommand('setContext', 'claudeManager.hasAgents', agents.length > 0);
		}).catch(() => {/* ignore */});
	}


	// ファイル末尾だけ読み取る（巨大JSONL対策・非同期・fdリーク対策済み）
	// OutputChannel（エラーログ出力用）— 起動時に即作成
	const extensionOutputChannel = vscode.window.createOutputChannel('CSM Session Manager');
	context.subscriptions.push(extensionOutputChannel);
	function getExtensionOutputChannel(): vscode.OutputChannel {
		return extensionOutputChannel;
	}

	// SessionService 依存オブジェクト（activate内クロージャ変数を注入）
	const sessionServiceDeps: SessionServiceDeps = {
		outputChannel: extensionOutputChannel,
		agentWatcher,
	};

	// 全ビューをリフレッシュするヘルパー
	function refreshAll(): void {
		sessionProvider.refresh();
		bookmarkProvider.refresh();
		tagProvider.refresh();
		agentProvider.refresh();
		sessionDecoProvider.refresh();
		// agentWatcher.scheduleUpdate() → onDidChange → updateStatusBar() の順で実行
		// updateStatusBar()を直接呼ぶとstates再構築前の古いデータを表示するため、
		// onDidChangeイベント経由に統一する
		agentWatcher.scheduleUpdate();
		// 監視無効時はonDidChangeが発火しないため直接更新
		if (!agentWatcher.isEnabled()) {
			updateStatusBar();
		}
		updateHasAgentsContext();
	}

	// TreeViewを登録（Disposableをsubscriptionsに追跡）
	context.subscriptions.push(
		vscode.window.createTreeView('claudeSessions', { treeDataProvider: sessionProvider }),
		vscode.window.createTreeView('claudeBookmarks', { treeDataProvider: bookmarkProvider }),
		vscode.window.createTreeView('claudeTags', { treeDataProvider: tagProvider }),
		vscode.window.createTreeView('claudeMemory', { treeDataProvider: memoryProvider }),
		vscode.window.createTreeView('claudeAgents', { treeDataProvider: agentProvider }),
	);

	// --- 会話関連コマンド ---

	// 会話一覧を更新
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshSessions', () => {
			refreshAll();
			vscode.window.showInformationMessage('会話一覧を更新しました');
		})
	);

	// 会話をプレビュー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewSession', (item: SessionItem | TagSessionItem) => {
			const session = item.session;
			if (session) {
				sessionProvider.setActiveSession(session.id);
				bookmarkProvider.refresh();
				tagProvider.refresh();
				showSessionPreview(session, context, getConfig<boolean>('preview.showThinkingBlocks', false));
			}
		})
	);

	// ブックマークに追加
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.bookmarkSession', (item: SessionItem) => {
			dataStore.addBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage(`「${item.session.customName || item.session.firstMessage.substring(0, 30)}」をブックマークしました`);
		})
	);

	// ブックマークから削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.unbookmarkSession', (item: SessionItem) => {
			dataStore.removeBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage('ブックマークを解除しました');
		})
	);

	// タグを追加
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.tagSession', async (item: SessionItem) => {
			const existingTags = Object.keys(dataStore.getAllTags());
			let tagName: string | undefined;

			if (existingTags.length > 0) {
				const NEW_TAG = '+ 新しいタグを作成...';
				const picked = await vscode.window.showQuickPick([...existingTags, NEW_TAG], {
					placeHolder: 'タグを選択',
				});
				if (!picked) { return; }
				if (picked === NEW_TAG) {
					tagName = await vscode.window.showInputBox({ prompt: '新しいタグ名を入力' });
				} else {
					tagName = picked;
				}
			} else {
				tagName = await vscode.window.showInputBox({ prompt: 'タグ名を入力' });
			}

			if (tagName) {
				dataStore.addTag(tagName, item.session.id);
				sessionProvider.refresh();
				tagProvider.refresh();
				vscode.window.showInformationMessage(`タグ「${tagName}」を追加しました`);
			}
		})
	);

	// タグを削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.removeTag', (item: TagSessionItem) => {
			dataStore.removeTagFromSession(item.tagName, item.session.id);
			tagProvider.refresh();
			sessionProvider.refresh();
		})
	);

	// 会話をリネーム
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.renameSession', async (item: SessionItem) => {
			const currentName = item.session.customName || item.session.firstMessage.substring(0, 50);
			const newName = await vscode.window.showInputBox({
				prompt: '新しい名前を入力',
				value: currentName,
			});
			if (newName) {
				dataStore.setCustomName(item.session.id, newName);
				try {
					const titleEntry = JSON.stringify({
						type: 'custom-title',
						customTitle: newName,
						sessionId: item.session.id,
					});
					await fs.promises.appendFile(item.session.filePath, '\n' + titleEntry);
				} catch {
					// 書き込み失敗は無視
				}
				if (sessionProvider.getActiveSessionId() === item.session.id) {
					updatePreviewTitle(newName);
				}
				sessionProvider.refresh();
				bookmarkProvider.refresh();
				tagProvider.refresh();
			}
		})
	);

	// 会話を検索
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.searchSessions', async () => {
			const keyword = await vscode.window.showInputBox({
				prompt: '検索キーワード（空で全件表示）',
				placeHolder: 'SSH, ALOrderForge, etc...',
			});
			if (keyword !== undefined) {
				sessionProvider.setFilter(keyword);
			}
		})
	);

	// --- メモリ関連コマンド ---

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshMemory', () => {
			memoryProvider.refresh();
			vscode.window.showInformationMessage('メモリを更新しました');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewMemory', (item: MemoryFileItem) => {
			showMemoryPreview(item.memoryFile);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editMemory', async (item: MemoryFileItem) => {
			const doc = await vscode.workspace.openTextDocument(item.memoryFile.filePath);
			await vscode.window.showTextDocument(doc);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteMemory', async (item: MemoryFileItem) => {
			const confirm = await vscode.window.showWarningMessage(
				`メモリ「${item.memoryFile.name}」を削除しますか？`,
				{ modal: true },
				'削除'
			);
			if (confirm === '削除') {
				await deleteMemoryFile(item.memoryFile.filePath);
				memoryProvider.refresh();
				vscode.window.showInformationMessage('メモリを削除しました');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.mergeMemories', async (item: MemoryFileItem) => {
			const groups = await loadMemoryFiles();
			const memoryDir = path.dirname(item.memoryFile.filePath);
			const group = groups.find((g) => g.dir === memoryDir);
			if (!group) { return; }

			const otherFiles = group.files.filter((f) => f.filePath !== item.memoryFile.filePath);
			if (otherFiles.length === 0) {
				vscode.window.showInformationMessage('統合先のメモリファイルがありません');
				return;
			}

			const picked = await vscode.window.showQuickPick(
				otherFiles.map((f) => ({ label: f.name, description: `[${f.type}] ${f.description}`, file: f })),
				{ placeHolder: '統合するメモリを選択' }
			);
			if (!picked) { return; }

			const newName = await vscode.window.showInputBox({ prompt: '統合後のメモリ名', value: item.memoryFile.name });
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({ prompt: '統合後の説明', value: item.memoryFile.description });
			if (!newDescription) { return; }

			const mergedContent = mergeMemoryFiles(item.memoryFile, picked.file, newName, newDescription);
			await fs.promises.writeFile(item.memoryFile.filePath, mergedContent, 'utf-8');
			await deleteMemoryFile(picked.file.filePath);
			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${item.memoryFile.name}」と「${picked.file.name}」を統合しました`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.extractMemory', async (item: MemoryFileItem) => {
			const doc = await vscode.workspace.openTextDocument(item.memoryFile.filePath);
			await vscode.window.showTextDocument(doc);

			const extractContent = await vscode.window.showInputBox({ prompt: '抽出する内容を入力', placeHolder: '抽出する内容...' });
			if (!extractContent) { return; }

			const newFileName = await vscode.window.showInputBox({ prompt: '新しいファイル名（.md不要）' });
			if (!newFileName) { return; }

			const newName = await vscode.window.showInputBox({ prompt: '新しいメモリ名' });
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({ prompt: '説明' });
			if (!newDescription) { return; }

			const typeOptions = ['user', 'feedback', 'project', 'reference'];
			const newType = await vscode.window.showQuickPick(typeOptions, { placeHolder: 'メモリタイプを選択' });
			if (!newType) { return; }

			const newContent = extractFromMemory(item.memoryFile, extractContent, newFileName, newName, newDescription, newType);
			const memoryDir = path.dirname(item.memoryFile.filePath);
			const newFilePath = path.join(memoryDir, `${newFileName}.md`);
			await fs.promises.writeFile(newFilePath, newContent, 'utf-8');
			await addToIndex(memoryDir, `${newFileName}.md`, newName, newDescription);
			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${newName}」を抽出しました`);
		})
	);

	// セッションIDをクリップボードにコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copySessionId', async (item: SessionItem) => {
			await vscode.env.clipboard.writeText(item.session.id);
			vscode.window.showInformationMessage(`セッションID をコピーしました: ${item.session.id}`);
		})
	);

	// Claude Codeで開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openInClaude', (item: SessionItem) => {
			const scheme = vscode.env.uriScheme;
			const uri = vscode.Uri.parse(
				`${scheme}://anthropic.claude-code/open?session=` +
				encodeURIComponent(item.session.id)
			);
			vscode.env.openExternal(uri);
		})
	);

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
					showAgentFormPanel(a, a.sessionId, async (config) => {
						if (config.name !== oldName) { await dataStore.removeAgent(oldName); }
						await dataStore.addAgent(config);
						const ch = getExtensionOutputChannel();
						if (oldParent && oldParent !== config.parentAgent) {
							await syncParentRuleFile(oldParent, ch);
						}
						await syncParentRuleFile(config.parentAgent, ch);
						refreshAll();
						vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
					});
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
					if (!a.sessionId) { return; }
					const args = ['claude', '--resume', a.sessionId];
					if (a.ruleFile) { args.push('--append-system-prompt-file', a.ruleFile); }
					args.push('--model', modelCliMap[a.model] || a.model);
					if (a.effort) { args.push('--effort', a.effort); }
					if (a.permissionMode) { args.push('--permission-mode', a.permissionMode); }
					const terminal = vscode.window.createTerminal({ name: `🤖 ${a.displayName || a.name}`, cwd: a.workDir || undefined });
					terminal.show();
					terminal.sendText(args.join(' '));
				},
				onRenewSession: (a) => {
					vscode.commands.executeCommand('claudeManager.renewAgentSession', { agent: a });
				},
				onLinkSession: (a) => {
					vscode.commands.executeCommand('claudeManager.linkSession', { agent: a });
				},
			});
		})
	);

	// エージェントとして登録（新規 — Webviewフォーム）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.registerAgent', (item: SessionItem) => {
			showAgentFormPanel(undefined, item.session.id, async (config) => {
				const finalConfig = await autoGenerateRuleFile(config);
				await dataStore.addAgent(finalConfig);
				await syncParentRuleFile(finalConfig.parentAgent, getExtensionOutputChannel());
				refreshAll();
				vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
			});
		})
	);

	// エージェント追加（＋ボタン: セッション未紐づけで新規作成）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.addAgent', () => {
			showAgentFormPanel(undefined, '', async (config) => {
				// sessionIdが空文字の場合は空文字のまま保持（undefinedにしない）
				if (!config.sessionId) { config.sessionId = ''; }
				const ruleConfig = await autoGenerateRuleFile(config);
				// 固定セッションかつsessionId未設定なら自動作成
				const finalConfig = await autoCreateSessionIfNeeded(ruleConfig, sessionServiceDeps);
				await dataStore.addAgent(finalConfig);
				await syncParentRuleFile(finalConfig.parentAgent, getExtensionOutputChannel());
				refreshAll();
				vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
			});
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
			showAgentFormPanel(existing, sessionId, async (config) => {
				if (config.name !== oldName) {
					await dataStore.removeAgent(oldName);
				}
				await dataStore.addAgent(config);
				// 親子同期: 旧親≠新親なら両方、同じなら1回
				const ch = getExtensionOutputChannel();
				if (oldParent && oldParent !== config.parentAgent) {
					await syncParentRuleFile(oldParent, ch);
				}
				await syncParentRuleFile(config.parentAgent, ch);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
			});
		})
	);

	// プレビューヘッダからの設定編集（セッションIDベース）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editAgentBySessionId', async (sessionId: string) => {
			const existing = await dataStore.getAgentBySessionId(sessionId);
			if (!existing) { return; }
			const oldName = existing.name;
			const oldParent = existing.parentAgent;
			showAgentFormPanel(existing, sessionId, async (config) => {
				if (config.name !== oldName) { await dataStore.removeAgent(oldName); }
				await dataStore.addAgent(config);
				const ch = getExtensionOutputChannel();
				if (oldParent && oldParent !== config.parentAgent) {
					await syncParentRuleFile(oldParent, ch);
				}
				await syncParentRuleFile(config.parentAgent, ch);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
			});
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

			if (sessionItems.length === 0) {
				vscode.window.showInformationMessage('紐づけ可能なセッションがありません');
				return;
			}

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
				placeHolder: '紐づけるセッションを選択',
				title: `「${item.agent.displayName || item.agent.name}」に${isAlreadyLinked ? 'セッションを変更' : 'セッションを紐づけ'}`,
			});
			if (!picked) { return; }

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
						// 実際のモデルから内部モデル名に変換（日付付きID対応）
						function resolveModel(raw: string): string {
							if (raw.includes('[1m]')) {
								return raw.includes('sonnet') ? 'sonnet-1m' : 'opus';
							}
							if (raw.includes('opus')) { return 'opus'; }
							if (raw.includes('sonnet')) { return 'sonnet'; }
							if (raw.includes('haiku')) { return 'haiku'; }
							return raw;
						}
						const newModel = picked.actualModel ? resolveModel(picked.actualModel) : picked.actualModel;
						agentToSave = { ...agentToSave, model: newModel as typeof item.agent.model };
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
			const scheme = vscode.env.uriScheme;
			const uri = vscode.Uri.parse(
				`${scheme}://anthropic.claude-code/open?session=` +
				encodeURIComponent(item.agent.sessionId)
			);
			vscode.env.openExternal(uri);
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

			// ターミナルでclaude --resume + 全設定付きで起動
			const args = ['claude', '--resume', item.agent.sessionId];
			if (item.agent.ruleFile) {
				args.push('--append-system-prompt-file', item.agent.ruleFile);
			}
			const modelId = modelCliMap[item.agent.model] || item.agent.model;
			args.push('--model', modelId);
			if (item.agent.effort) {
				args.push('--effort', item.agent.effort);
			}
			if (item.agent.permissionMode) {
				args.push('--permission-mode', item.agent.permissionMode);
			}

			const terminal = vscode.window.createTerminal({
				name: `🤖 ${item.agent.name}`,
				cwd: item.agent.workDir || undefined,
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
						const { spawn } = require('child_process') as typeof import('child_process');
						const initPrompt = `セッション引き継ぎ完了。前回の要約: ${trimmedTestament}`;

						const newSessionId = await new Promise<string>((resolve, reject) => {
							const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
							const args = [
								'--agent', agent.name,
								'-p', initPrompt,
								'--permission-mode', 'acceptEdits',
								'--output-format', 'stream-json',
								'--max-turns', '1',
							];

							// ネストセッション検出を回避
							const env = { ...process.env };
							delete env.CLAUDE_CODE;
							delete env.CLAUDECODE;

							const child = spawn(claudeCmd, args, {
								env,
								cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
								stdio: ['ignore', 'pipe', 'pipe'],
								shell: false,
								windowsHide: true,
							});

							let output = '';
							let sessionId = '';
							const timeout = setTimeout(() => {
								child.kill('SIGTERM');
								reject(new Error('新セッション作成がタイムアウトしました（120秒）'));
							}, 120000);

							child.stdout?.on('data', (data: Buffer) => {
								output += data.toString('utf-8');
								// stream-json形式: 各行が独立したJSON
								const lines = output.split('\n');
								for (const line of lines) {
									if (!line.trim()) { continue; }
									try {
										const parsed = JSON.parse(line);
										if (parsed.session_id) {
											sessionId = parsed.session_id;
										}
									} catch {
										// 不完全な行は次回に持ち越し
									}
								}
							});

							child.stderr?.on('data', (data: Buffer) => {
								ch.appendLine(`[renew stderr] ${data.toString('utf-8').trim()}`);
							});

							child.on('close', (code: number | null) => {
								clearTimeout(timeout);
								agentWatcher.scheduleUpdate();
								if (sessionId) {
									resolve(sessionId);
								} else if (code === 0) {
									// stream-jsonでID取得失敗時: 出力から正規表現フォールバック
									const match = output.match(/"session_id"\s*:\s*"([a-f0-9-]{36})"/);
									if (match) {
										resolve(match[1]);
									} else {
										reject(new Error('セッションIDを取得できませんでした'));
									}
								} else {
									reject(new Error(`claude CLI がエラーコード ${code} で終了しました`));
								}
							});

							child.on('error', (err: Error) => {
								clearTimeout(timeout);
								reject(err);
							});
						});

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

	// エージェント管理を更新
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshAgents', () => {
			agentProvider.refresh();
			updateStatusBar();
			vscode.window.showInformationMessage('エージェント管理を更新しました');
		})
	);

	// 全親ルールファイルの配下エージェントセクションを一括再生成
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.syncAllParentRules', async () => {
			await syncAllParentRuleFiles(getExtensionOutputChannel());
			vscode.window.showInformationMessage('全ての親ルールファイルの配下エージェントセクションを再生成しました');
		})
	);

	// エージェント組織図を表示
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openOrgChart', () => {
			showOrgChart(
				() => sessionProvider.getSessions(),
				(id) => sessionProvider.isLiveSession(id),
				// 履歴プレビュー
				(sessionId) => {
					const session = sessionProvider.getSessionById(sessionId);
					if (session) {
						sessionProvider.setActiveSession(session.id);
						bookmarkProvider.refresh();
						tagProvider.refresh();
						showSessionPreview(session, context, getConfig<boolean>('preview.showThinkingBlocks', false));
					}
				},
				// Claude Codeで開く
				(sessionId) => {
					const scheme = vscode.env.uriScheme;
					const uri = vscode.Uri.parse(
						`${scheme}://anthropic.claude-code/open?session=` +
						encodeURIComponent(sessionId)
					);
					vscode.env.openExternal(uri);
				}
			);
		})
	);

	// 組織図表示設定を確認
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.checkOrgChartSettings', async () => {
			const agents = await dataStore.getAgents();

			// 組織図に表示/非表示を分類（B案: parentAgent 自動判定）
			const visible = agents.filter((a) => shouldShowInOrgChart(a));
			const hidden = agents.filter((a) => !shouldShowInOrgChart(a));

			// グループ化（親ごと）
			const visibleByParent = new Map<string | undefined, typeof visible>();
			for (const a of visible) {
				const parent = a.parentAgent || '(親なし)';
				if (!visibleByParent.has(parent)) {
					visibleByParent.set(parent, []);
				}
				visibleByParent.get(parent)!.push(a);
			}

			// メッセージ構築
			let message = `📊 **組織図表示設定**\n\n`;
			message += `**表示対象: ${visible.length}件**\n`;
			for (const [parent, list] of visibleByParent.entries()) {
				message += `\n${parent}\n`;
				for (const a of list) {
					const displayName = a.displayName || a.name;
					message += `  • ${displayName}\n`;
				}
			}

			if (hidden.length > 0) {
				message += `\n**非表示: ${hidden.length}件**\n`;
				for (const a of hidden) {
					const displayName = a.displayName || a.name;
					message += `  • ${displayName}\n`;
				}
			}

			const ch = getExtensionOutputChannel();
			ch.clear();
			ch.appendLine(message);
			ch.show();

			vscode.window.showInformationMessage(`組織図設定: 表示${visible.length}件 / 非表示${hidden.length}件`);
		})
	);

	// タスクログ手動記録コマンドは削除済み（v0.3.0: TODO.md自動管理に移行）
	// 自動検知（taskTracker.ts）は引き続き動作

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

	// 使い方ガイドを開く（Webviewパネル）
	let guidePanel: vscode.WebviewPanel | undefined;
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openGuide', async () => {
			const guidePath = path.join(context.extensionPath, 'guide.html');
			try {
				await fs.promises.access(guidePath);
			} catch {
				vscode.window.showErrorMessage('guide.html が見つかりません');
				return;
			}

			if (guidePanel) {
				guidePanel.reveal(vscode.ViewColumn.One);
				return;
			}

			guidePanel = vscode.window.createWebviewPanel(
				'claudeGuide',
				'📖 使い方ガイド',
				vscode.ViewColumn.One,
				{
					enableScripts: false,
					localResourceRoots: [vscode.Uri.file(context.extensionPath)],
				}
			);

			// HTMLを読み込み、画像パスをWebview URIに変換
			let html = await fs.promises.readFile(guidePath, 'utf-8');
			const imagesUri = guidePanel.webview.asWebviewUri(
				vscode.Uri.file(path.join(context.extensionPath, 'images'))
			);
			html = html.replace(/images\//g, `${imagesUri}/`);
			guidePanel.webview.html = html;
			guidePanel.onDidDispose(() => { guidePanel = undefined; });
		})
	);

	// セッションパスをコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copySessionPath', async (item: SessionItem) => {
			await vscode.env.clipboard.writeText(item.session.filePath);
			vscode.window.showInformationMessage(`セッションパスをコピーしました`);
		})
	);

	// メモリパスをコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copyMemoryPath', async (item: MemoryFileItem) => {
			await vscode.env.clipboard.writeText(item.memoryFile.filePath);
			vscode.window.showInformationMessage(`メモリパスをコピーしました`);
		})
	);

	// 設定ファイルをエディタで開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openSettingsFile', async (filePath: string) => {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(doc);
		})
	);

	// プロジェクトフォルダをVS Codeで開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openProjectInVSC', async (item: MemoryGroupItem) => {
			const projectPath = item.projectPath;
			let exists = false;
			if (projectPath) {
				try {
					await fs.promises.access(projectPath);
					exists = true;
				} catch { /* 存在しない */ }
			}
			if (exists) {
				vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), { forceNewWindow: true });
			} else {
				vscode.window.showWarningMessage(`プロジェクトフォルダが見つかりません: ${projectPath}`);
			}
		})
	);

	// --- セッション削除 ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteSession', async (item: SessionItem) => {
			const displayName = item.session.customName || item.session.claudeTitle || item.session.firstMessage.substring(0, 40);
			const linkedAgent = await dataStore.getAgentBySessionId(item.session.id);
			let warningMsg = `セッション「${displayName}」を削除しますか？`;
			if (linkedAgent) {
				warningMsg += `\n（エージェント「${linkedAgent.name}」の紐づけも解除されます）`;
			}

			const confirm = await vscode.window.showWarningMessage(
				warningMsg,
				{ modal: true },
				'削除'
			);
			if (confirm !== '削除') { return; }

			// .trash/ ディレクトリに移動（H-1共通関数）
			const configTrash = getConfig<string>('trash.folder', '');
			const trashDir = configTrash || path.join(os.homedir(), '.claude', '.trash');
			try {
				await moveToTrash(item.session.filePath, trashDir);
			} catch {
				vscode.window.showErrorMessage('セッションファイルの移動に失敗しました');
				return;
			}

			// 関連データのクリーンアップ
			await dataStore.cleanupSessionData(item.session.id);
			refreshAll();
			vscode.window.showInformationMessage(`セッション「${displayName}」を削除しました`);
		})
	);

	// --- ソート機能 ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.sortSessions', async () => {
			const options = [
				{ label: '更新日（新しい順）', description: 'デフォルト', value: 'updated-desc' },
				{ label: '更新日（古い順）', value: 'updated-asc' },
				{ label: '作成日（新しい順）', value: 'created-desc' },
				{ label: '作成日（古い順）', value: 'created-asc' },
				{ label: '名前', value: 'name' },
				{ label: 'メッセージ数', value: 'count' },
				{ label: 'モデル', value: 'model' },
			];
			const picked = await vscode.window.showQuickPick(options, {
				placeHolder: 'ソート基準を選択',
			});
			if (picked) {
				sessionProvider.setSortMode(picked.value as 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model');
			}
		})
	);

	// --- グループ化切り替え ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.groupSessions', async () => {
			const options = [
				{ label: '日付別（デフォルト）', value: 'date' },
				{ label: 'タグ別', value: 'tag' },
				{ label: 'エージェント別', value: 'agent' },
				{ label: 'フラット（グループなし）', value: 'flat' },
			];
			const picked = await vscode.window.showQuickPick(options, {
				placeHolder: 'グループ表示モードを選択',
			});
			if (picked) {
				sessionProvider.setGroupMode(picked.value as 'date' | 'tag' | 'agent' | 'flat');
			}
		})
	);

	// --- ウェルカム: 取締役プリセットで登録 ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.registerDirector', () => {
			const preset: AgentConfig = {
				name: '取締役',
				sessionId: '',
				role: '全体統括・タスク分割・承認判断',
				model: 'opus',
				sessionMode: 'fixed',
			};
			showAgentFormPanel(preset, '', async (config) => {
				// 取締役専用ルールファイル生成
				const finalConfig = await generateDirectorRuleFile(config);
				await dataStore.addAgent(finalConfig);
				// MEMORY.mdに組織情報を書き込み
				await writeOrgInfoToMemory(finalConfig);
				// SubagentStart/Stop フックを settings.json に登録
				await ensureSubagentHooks(extensionOutputChannel);
				// Extension Host分離設定（affinity）を自動追加
				await addAffinitySettings();
				refreshAll();
				vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
			});
		})
	);


	// --- セッションフィルター切り替え ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleSessionFilter', () => {
			const config = vscode.workspace.getConfiguration('claudeManager');
			const current = config.get<string>('sessionFilterMode', 'all');
			const next = current === 'project' ? 'all' : 'project';
			config.update('sessionFilterMode', next, vscode.ConfigurationTarget.Global);
			sessionProvider.setProjectFilter(next === 'project');
			vscode.window.showInformationMessage(`セッション表示: ${next === 'project' ? 'プロジェクトのみ' : 'すべて'}`);
		})
	);

	// --- ブックマークフィルター切り替え ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleBookmarkFilter', () => {
			const current = bookmarkProvider.isProjectFilterEnabled();
			bookmarkProvider.setProjectFilter(!current);
			vscode.window.showInformationMessage(`ブックマーク表示: ${!current ? 'プロジェクトのみ' : 'すべて'}`);
		})
	);

	// --- メモリフィルター切り替え ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleMemoryFilter', () => {
			const current = memoryProvider.isProjectFilterEnabled();
			memoryProvider.setProjectFilter(!current);
			vscode.window.showInformationMessage(`メモリ表示: ${!current ? 'プロジェクトのみ' : 'すべて'}`);
		})
	);

	// --- 設定を開く（歯車アイコン）---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openSettings', () => {
			vscode.commands.executeCommand('workbench.action.openSettings', 'claudeManager');
		})
	);

	// 検知方式比較ビュー: Phase 4 で削除済み（fswatch固定）

	// タスクログ自動クリーンアップ（起動時）
	dataStore.cleanupTaskLogs();

	// 初回読み込み＆監視開始
	updateHasAgentsContext();
	// セッションフィルターの初期状態を設定
	const initialFilterMode = getConfig<string>('sessionFilterMode', 'all');
	sessionProvider.setProjectFilter(initialFilterMode === 'project');
	sessionProvider.refresh();
	sessionProvider.startWatching();

	context.subscriptions.push({
		dispose: () => sessionProvider.stopWatching(),
	});
}

export function deactivate() {}
