import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem, SessionDecorationProvider } from './sessionTreeProvider';
import { BookmarkTreeProvider } from './bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from './tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem, MemoryGroupItem } from './memoryTreeProvider';
import { AgentTreeProvider, AgentItem } from './agentTreeProvider';
import { showSessionPreview, showMemoryPreview, updatePreviewTitle } from './webviewPanel';
import { showAgentFormPanel } from './agentFormPanel';
import { showAgentPreview } from './agentPreviewPanel';
import { showOrgChart } from './orgChartPanel';
import { AgentWatcher } from './agentWatcher';
import { TaskTracker } from './taskTracker';
import { UsageMonitor } from './usageMonitor';
import * as dataStore from './dataStore';
import { AgentConfig } from './types';
import { loadMemoryFiles, deleteMemoryFile, mergeMemoryFiles, extractFromMemory, addToIndex } from './memoryManager';
import { resolveRuleFilePath } from './agentManager';

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
				const totalAgents = agents.length;

				if (!agentWatcher.isEnabled()) {
					// 監視無効時は静的表示のみ
					statusBarItem.text = `👥 ${totalAgents}`;
					statusBarItem.tooltip = 'エージェント監視: OFF（設定で有効化できます）';
					statusBarItem.backgroundColor = undefined;
					statusBarItem.show();
					return;
				}

				const activeNames = agentWatcher.getActiveAgentNames();
				const activeCount = activeNames.size;

				if (activeCount === 0) {
					statusBarItem.text = `👥 ${totalAgents}`;
					statusBarItem.tooltip = `動作中のエージェントなし（全${totalAgents}件）`;
					statusBarItem.backgroundColor = undefined;
				} else {
					statusBarItem.text = `🟢 ${activeCount} 👥 ${totalAgents}`;
					statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
					const nameList = [...activeNames].map((n) => `▶ ${n}`).join('\n');
					statusBarItem.tooltip = `動作中: ${activeCount}件 / 全${totalAgents}件\n${nameList}`;
				}
				statusBarItem.show();
			} catch {
				statusBarItem.text = `👥 ${agents.length}`;
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
		if (e.affectsConfiguration('claudeManager.enableAgentMonitor') || e.affectsConfiguration('claudeManager.agentMonitorInterval')) {
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

	// CSM:AUTOマーカーのインジェクション対策: マーカー文字列を除去
	function sanitizeForAutoSection(value: string): string {
		return value.replace(/<!--\s*CSM:AUTO:(START|END)\s*-->/gi, '');
	}

	// 自動生成セクションの内容を構築
	function buildAutoSection(config: AgentConfig): string {
		const safeName = sanitizeForAutoSection(config.name);
		const safeRole = sanitizeForAutoSection(config.role || '（役割未設定）');
		const lines: string[] = [
			`あなたは${safeName}所属のエンジニアです。`,
			`- ${safeRole}を担当する`,
			`- 変更前に既存コードを確認し、既存の設計方針を尊重する`,
			`- セッション開始時にMEMORY.md（自動メモリ）を確認し、組織図・行動規範・プロジェクト情報を把握すること`,
			`- session-manager.json の agents 一覧から自分の位置づけ・他エージェントとの関係を把握すること`,
			`- 「※子エージェントはこのセクションを無視すること」とマークされたセクションは読み飛ばすこと`,
		];
		if (config.parentAgent) {
			const safeParent = sanitizeForAutoSection(config.parentAgent);
			lines.push(`- 報告先: ${safeParent}（親エージェント）。作業完了時は結果を報告すること`);
		}
		if (config.workDir) {
			const safeWorkDir = sanitizeForAutoSection(config.workDir);
			lines.push(`- 編集対象は \`${safeWorkDir}\` 内のみ。それ以外のフォルダは絶対に変更しない`);
		}
		return lines.join('\n');
	}

	// 既存ファイルの自動セクションのみを更新（カスタム部分は保持）— 非同期
	async function updateAutoSection(filePath: string, config: AgentConfig): Promise<void> {
		try {
			const content = await fs.promises.readFile(filePath, 'utf-8');
			const autoContent = buildAutoSection(config);
			const START_MARKER = '<!-- CSM:AUTO:START -->';
			const END_MARKER = '<!-- CSM:AUTO:END -->';

			const startIdx = content.indexOf(START_MARKER);
			const endIdx = content.indexOf(END_MARKER);

			if (startIdx >= 0 && endIdx > startIdx) {
				// マーカーが見つかった → マーカー内のみ更新
				const before = content.substring(0, startIdx);
				const after = content.substring(endIdx + END_MARKER.length);
				const newContent = before + START_MARKER + '\n' + autoContent + '\n' + END_MARKER + after;
				await fs.promises.writeFile(filePath, newContent, 'utf-8');
			} else {
				// マーカーがない → 先頭にマーカー付き自動セクションを追加、既存内容は後ろに保持
				const newContent = START_MARKER + '\n' + autoContent + '\n' + END_MARKER + '\n\n' + content;
				await fs.promises.writeFile(filePath, newContent, 'utf-8');
			}
		} catch {
			// ファイル読み書きエラーは無視
		}
	}

	// ruleFileが未設定の場合にルールファイルを自動生成するヘルパー（子エージェント用）— 非同期
	async function autoGenerateRuleFile(config: AgentConfig): Promise<AgentConfig> {
		if (config.ruleFile) {
			// 既にルールファイルがある場合 → マーカー内の自動生成部分のみ更新
			await updateAutoSection(config.ruleFile, config);
			return config;
		}
		const ruleFolder = await dataStore.getRuleFolderForScope(config.scope);
		if (!ruleFolder) { return config; }
		const filePath = path.join(ruleFolder, `${config.name}.md`);
		// 既にファイルが存在する場合は紐づけ + 自動セクション更新
		try {
			await fs.promises.access(filePath);
			await updateAutoSection(filePath, config);
			return { ...config, ruleFile: filePath };
		} catch {
			// ファイルが存在しない → 新規作成
		}
		// 重複チェック: 他スコープに同名ファイルが存在する場合は警告
		const otherScope = config.scope === 'global' ? 'project' : 'global';
		const otherFolder = await dataStore.getRuleFolderForScope(otherScope);
		const otherPath = path.join(otherFolder, `${config.name}.md`);
		try {
			await fs.promises.access(otherPath);
			vscode.window.showWarningMessage(
				`同名のルールファイルが${otherScope === 'global' ? 'グローバル' : 'プロジェクト'}スコープに既に存在します: ${otherPath}`
			);
		} catch {
			// 他スコープには存在しない → OK
		}
		try {
			await fs.promises.mkdir(ruleFolder, { recursive: true });
			const autoContent = buildAutoSection(config);
			const content = `<!-- CSM:AUTO:START -->\n${autoContent}\n<!-- CSM:AUTO:END -->\n\n<!-- 以下にカスタムルールを自由に追記してください -->\n`;
			await fs.promises.writeFile(filePath, content, 'utf-8');
			return { ...config, ruleFile: filePath };
		} catch {
			return config;
		}
	}

	// 全ビューをリフレッシュするヘルパー
	function refreshAll(): void {
		sessionProvider.refresh();
		bookmarkProvider.refresh();
		tagProvider.refresh();
		agentProvider.refresh();
		sessionDecoProvider.refresh();
		updateStatusBar();
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

			showAgentPreview(
				agent,
				isLive,
				sessionTitle,
				// 設定ボタン → 編集フォームを開く
				(a) => {
					const oldName = a.name;
					showAgentFormPanel(a, a.sessionId, (config) => {
						if (config.name !== oldName) { dataStore.removeAgent(oldName); }
						dataStore.addAgent(config);
						refreshAll();
						vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
					});
				},
				// ルールファイル編集
				async (a) => {
					if (!a.ruleFile) { return; }
					const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.ruleFile));
					await vscode.window.showTextDocument(doc);
				},
				// セッション履歴を開く
				(sessionId) => {
					const s = sessionProvider.getSessionById(sessionId);
					if (s) {
						sessionProvider.setActiveSession(s.id);
						bookmarkProvider.refresh();
						tagProvider.refresh();
						showSessionPreview(s, context, getConfig<boolean>('preview.showThinkingBlocks', false));
					}
				}
			);
		})
	);

	// エージェントとして登録（新規 — Webviewフォーム）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.registerAgent', (item: SessionItem) => {
			showAgentFormPanel(undefined, item.session.id, async (config) => {
				const finalConfig = await autoGenerateRuleFile(config);
				dataStore.addAgent(finalConfig);
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
				const finalConfig = await autoGenerateRuleFile(config);
				dataStore.addAgent(finalConfig);
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
			showAgentFormPanel(existing, sessionId, async (config) => {
				if (config.name !== oldName) {
					await dataStore.removeAgent(oldName);
				}
				await dataStore.addAgent(config);
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
			showAgentFormPanel(existing, sessionId, async (config) => {
				if (config.name !== oldName) { await dataStore.removeAgent(oldName); }
				await dataStore.addAgent(config);
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
			const sessionItems: { label: string; description: string; sessionId: string; alreadyLinked: boolean; linkedAgentName: string | undefined }[] = [];
			for (const s of sessions) {
				const existingAgent = await dataStore.getAgentBySessionId(s.id);
				const usedLabel = existingAgent ? ` [${existingAgent.name}に紐づけ済み]` : '';
				sessionItems.push({
					label: (s.customName || s.claudeTitle || s.firstMessage.substring(0, 50)) + usedLabel,
					description: `${s.project} — ${s.lastTimestamp.toLocaleString('ja-JP')}`,
					sessionId: s.id,
					alreadyLinked: !!existingAgent,
					linkedAgentName: existingAgent?.name,
				});
			}

			if (sessionItems.length === 0) {
				vscode.window.showInformationMessage('紐づけ可能なセッションがありません');
				return;
			}

			const isAlreadyLinked = !!item.agent.sessionId;
			const picked = await vscode.window.showQuickPick(sessionItems, {
				placeHolder: '紐づけるセッションを選択',
				title: `「${item.agent.name}」に${isAlreadyLinked ? 'セッションを変更' : 'セッションを紐づけ'}`,
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

			const agent = { ...item.agent, sessionId: picked.sessionId };
			await dataStore.addAgent(agent);
			refreshAll();
			vscode.window.showInformationMessage(`「${item.agent.name}」にセッションを紐づけました`);
		})
	);

	// エージェントのセッションを開く（Claude Codeで開く）
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
			const scheme = vscode.env.uriScheme;
			const uri = vscode.Uri.parse(
				`${scheme}://anthropic.claude-code/open?session=` +
				encodeURIComponent(item.agent.sessionId)
			);
			vscode.env.openExternal(uri);
		})
	);

	// セッションを新しくする（自動遺言生成して新セッション作成）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.renewAgentSession', async (item: AgentItem) => {
			const agent = item.agent;
			if (!agent.sessionId) {
				vscode.window.showWarningMessage('セッションが紐づけされていません');
				return;
			}

			// 旧セッションから自動で遺言（引き継ぎサマリー）を生成
			const oldSession = sessionProvider.getSessionById(agent.sessionId);
			let testament = `${agent.name}の前セッションから引き継ぎ。`;
			if (oldSession) {
				try {
					const content = await fs.promises.readFile(oldSession.filePath, 'utf-8');
					const lines = content.split('\n').filter((l: string) => l.trim());
					// 最後のユーザーメッセージとアシスタントメッセージを抽出
					const summaryParts: string[] = [];
					const recentLines = lines.slice(-50); // 直近50行から探索
					for (const line of recentLines) {
						try {
							const entry = JSON.parse(line);
							if (entry.type === 'user' && entry.message?.role === 'user' && typeof entry.message.content === 'string') {
								summaryParts.push(`[User] ${entry.message.content.substring(0, 200)}`);
							} else if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
								const text = typeof entry.message.content === 'string'
									? entry.message.content
									: Array.isArray(entry.message.content)
										? entry.message.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
										: '';
								if (text) {
									summaryParts.push(`[Assistant] ${text.substring(0, 300)}`);
								}
							}
						} catch { /* パース失敗は無視 */ }
					}
					// 直近のやり取りから遺言を構築
					if (summaryParts.length > 0) {
						const lastParts = summaryParts.slice(-4); // 直近2往復分
						testament = `${agent.name}の前セッション引き継ぎ:\n${lastParts.join('\n')}`;
					}
				} catch {
					// 読み込み失敗時はデフォルトメッセージのまま
				}
			}

			// 確認ダイアログ（自動生成した遺言を表示、編集可能）
			const finalTestament = await vscode.window.showInputBox({
				prompt: '自動生成された引き継ぎメッセージ（編集可能）',
				placeHolder: '次のセッションへの引き継ぎ事項...',
				value: testament,
			});
			if (finalTestament === undefined) { return; } // キャンセル

			// 旧セッションのJSONLに引き継ぎメッセージを追記
			if (oldSession) {
				try {
					const entry = JSON.stringify({
						type: 'user',
						uuid: `testament-${Date.now()}`,
						parentUuid: null,
						timestamp: new Date().toISOString(),
						sessionId: agent.sessionId,
						message: {
							role: 'user',
							content: `[セッション終了] ${finalTestament}`,
						},
					});
					await fs.promises.appendFile(oldSession.filePath, '\n' + entry);
				} catch {
					// 書き込み失敗は無視
				}
			}

			// セッションID紐づけを解除（空にする）
			const updatedAgent = { ...agent, sessionId: '' };
			dataStore.addAgent(updatedAgent);
			refreshAll();
			vscode.window.showInformationMessage(
				`「${agent.name}」のセッション紐づけを解除しました。新しいセッションを紐づけてください。`
			);
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

			dataStore.removeAgent(item.agent.name);
			refreshAll();
			vscode.window.showInformationMessage(`「${item.agent.name}」を削除しました`);
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

	// --- タスクログ関連コマンド ---

	// タスクログ追加
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.addTaskLog', async () => {
			const agents = await dataStore.getAgents();
			if (agents.length === 0) {
				vscode.window.showWarningMessage('エージェントが登録されていません');
				return;
			}
			const agentPick = await vscode.window.showQuickPick(
				agents.map(a => ({ label: a.name, description: a.sessionId ? `Session: ${a.sessionId.substring(0, 8)}...` : '未紐づけ', agent: a })),
				{ placeHolder: 'タスクを追加するエージェントを選択' }
			);
			if (!agentPick || !agentPick.agent.sessionId) {
				if (agentPick && !agentPick.agent.sessionId) {
					vscode.window.showWarningMessage('セッションが紐づけされていないエージェントにはタスクを追加できません');
				}
				return;
			}
			const summary = await vscode.window.showInputBox({ prompt: 'タスク概要', placeHolder: '例: v0.3.0のビルド確認' });
			if (!summary) { return; }
			const outputFile = await vscode.window.showInputBox({ prompt: '出力先ファイル（任意）', placeHolder: '例: c:/tmp/report.txt' });
			// outputFile のパストラバーサル検証
			if (outputFile && !validateOutputFile(outputFile)) {
				vscode.window.showWarningMessage('出力先ファイルはワークスペース配下またはtmpフォルダのみ指定可能です');
				return;
			}
			const log = {
				id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7),
				agentName: agentPick.agent.name,
				sessionId: agentPick.agent.sessionId,
				summary: summary.slice(0, 200),
				outputFile: outputFile || undefined,
				status: 'pending' as const,
				createdAt: Date.now(),
			};
			await dataStore.addTaskLog(log);
			agentProvider.refresh();
			vscode.window.showInformationMessage(`タスクログを追加しました: ${summary}`);
		})
	);

	// タスクログ完了
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.completeTaskLog', async (taskLogOrId?: string | { id: string }) => {
			let logId: string | undefined;
			if (typeof taskLogOrId === 'string') {
				logId = taskLogOrId;
			} else if (taskLogOrId && typeof taskLogOrId === 'object' && 'id' in taskLogOrId) {
				logId = taskLogOrId.id;
			}
			if (!logId) {
				// QuickPickで選択
				const allLogs = await dataStore.getTaskLogs();
				const logs = allLogs.filter(t => t.status !== 'completed' && t.status !== 'error');
				if (logs.length === 0) {
					vscode.window.showInformationMessage('完了可能なタスクがありません');
					return;
				}
				const pick = await vscode.window.showQuickPick(
					logs.map(t => ({ label: `${t.agentName}: ${t.summary}`, description: t.status, logId: t.id })),
					{ placeHolder: '完了するタスクを選択' }
				);
				if (!pick) { return; }
				logId = pick.logId;
			}
			await dataStore.updateTaskLog(logId, { status: 'completed', completedAt: Date.now() });
			agentProvider.refresh();
			vscode.window.showInformationMessage('タスクを完了にしました');
		})
	);

	// タスクログ削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteTaskLog', async (taskLogOrId?: string | { id: string }) => {
			let logId: string | undefined;
			if (typeof taskLogOrId === 'string') {
				logId = taskLogOrId;
			} else if (taskLogOrId && typeof taskLogOrId === 'object' && 'id' in taskLogOrId) {
				logId = taskLogOrId.id;
			}
			if (!logId) {
				const logs = await dataStore.getTaskLogs();
				if (logs.length === 0) {
					vscode.window.showInformationMessage('タスクログがありません');
					return;
				}
				const pick = await vscode.window.showQuickPick(
					logs.map(t => ({ label: `${t.agentName}: ${t.summary}`, description: t.status, logId: t.id })),
					{ placeHolder: '削除するタスクを選択' }
				);
				if (!pick) { return; }
				logId = pick.logId;
			}
			await dataStore.removeTaskLog(logId);
			agentProvider.refresh();
			vscode.window.showInformationMessage('タスクログを削除しました');
		})
	);

	// タスク出力ファイルを開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openTaskOutput', async (taskLogOrId?: string | { id: string; outputFile?: string }) => {
			let outputFile: string | undefined;
			if (taskLogOrId && typeof taskLogOrId === 'object' && 'outputFile' in taskLogOrId) {
				outputFile = taskLogOrId.outputFile;
			}
			if (!outputFile) {
				const allLogs = await dataStore.getTaskLogs();
				const logs = allLogs.filter(t => t.outputFile);
				if (logs.length === 0) {
					vscode.window.showInformationMessage('出力ファイル付きのタスクがありません');
					return;
				}
				const pick = await vscode.window.showQuickPick(
					logs.map(t => ({ label: `${t.agentName}: ${t.summary}`, description: t.outputFile, file: t.outputFile })),
					{ placeHolder: '出力ファイルを開くタスクを選択' }
				);
				if (!pick || !pick.file) { return; }
				outputFile = pick.file;
			}
			try {
				const doc = await vscode.workspace.openTextDocument(outputFile);
				await vscode.window.showTextDocument(doc);
			} catch {
				vscode.window.showErrorMessage(`ファイルを開けません: ${outputFile}`);
			}
		})
	);

	// タスクログ全クリア
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.clearTaskLogs', async () => {
			const confirm = await vscode.window.showWarningMessage(
				'すべてのタスクログを削除しますか？',
				{ modal: true },
				'削除'
			);
			if (confirm !== '削除') { return; }
			await dataStore.clearTaskLogs();
			agentProvider.refresh();
			vscode.window.showInformationMessage('タスクログをすべて削除しました');
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
				vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), { forceNewWindow: false });
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

			// .trash/ ディレクトリに移動（rm禁止ルール準拠）
			const configTrash = getConfig<string>('trash.folder', '');
			const trashDir = configTrash || path.join(os.homedir(), '.claude', '.trash');
			await fs.promises.mkdir(trashDir, { recursive: true });
			try {
				const fileName = path.basename(item.session.filePath);
				const trashPath = path.join(trashDir, `${Date.now()}_${fileName}`);
				await fs.promises.rename(item.session.filePath, trashPath);
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
				// Extension Host分離設定（affinity）を自動追加
				await addAffinitySettings();
				refreshAll();
				vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
			});
		})
	);

	// Extension Host分離設定（affinity）を自動追加
	async function addAffinitySettings(): Promise<void> {
		try {
			const settingsPath = path.join(
				process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
				'Code', 'User', 'settings.json'
			);
			let settings: Record<string, unknown> = {};
			try {
				const raw = await fs.promises.readFile(settingsPath, 'utf-8');
				settings = JSON.parse(raw);
			} catch {
				// ファイルが存在しないか読めない場合はスキップ
				return;
			}
			const affinityKey = 'extensions.experimental.affinity';
			if (settings[affinityKey]) {
				// 既に設定されている場合は上書きしない
				return;
			}
			settings[affinityKey] = {
				'ratorin.claude-session-manager': 1,
				'anthropic.claude-code': 2,
			};
			await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
			vscode.window.showInformationMessage(
				'Extension Host分離設定を追加しました。VS Code再起動後に反映されます。'
			);
		} catch {
			// settings.json書き込み失敗は無視（権限不足等）
		}
	}

	// 取締役専用ルールファイル生成（CSM:AUTOマーカー対応）
	async function generateDirectorRuleFile(config: AgentConfig): Promise<AgentConfig> {
		if (config.ruleFile) {
			// 既にルールファイルがある → マーカー内の自動生成部分のみ更新
			await updateDirectorAutoSection(config.ruleFile, config);
			return config;
		}
		const ruleFolder = await dataStore.getRuleFolderForScope(config.scope);
		if (!ruleFolder) { return config; }
		const filePath = path.join(ruleFolder, `${config.name}.md`);
		// 既にファイルが存在する場合は紐づけ + 自動セクション更新
		try {
			await fs.promises.access(filePath);
			await updateDirectorAutoSection(filePath, config);
			return { ...config, ruleFile: filePath };
		} catch {
			// ファイルが存在しない → 新規作成
		}
		try {
			await fs.promises.mkdir(ruleFolder, { recursive: true });
			const autoContent = buildDirectorAutoSection(config);
			const content = `<!-- CSM:AUTO:START -->\n${autoContent}\n<!-- CSM:AUTO:END -->\n\n<!-- 以下にカスタムルールを自由に追記してください。このエリアはCSMによる自動更新の対象外です。 -->\n`;
			await fs.promises.writeFile(filePath, content, 'utf-8');
			return { ...config, ruleFile: filePath };
		} catch {
			return config;
		}
	}

	// 取締役ルールファイルの自動生成セクション内容を構築
	function buildDirectorAutoSection(config: AgentConfig): string {
		const safeName = sanitizeForAutoSection(config.name);
		const lines: string[] = [
			`あなたは${safeName}です。プロジェクト全体を統括する最上位のエージェントです。`,
			``,
			`## 行動規範`,
			`1. **方針決定** — ユーザーの指示を受けて実行方針を決定する`,
			`2. **指示起案** — 各部署（エージェント）への指示案を作成する`,
			`3. **承認取得** — 指示案をユーザーに提示し、承認を得てから実行する`,
			`4. **実行委任** — 実装作業は各部署のエージェントに委任する。自分ではコードを書かない`,
			`5. **結果確認** — 各部署からの報告を確認し、ユーザーに最終報告する`,
			``,
			`## 初期行動`,
			`- セッション開始時にMEMORY.md（自動メモリ）を読み込み、組織図・行動規範・プロジェクト情報を把握すること`,
			`- session-manager.json の agents 一覧を読み込み、配下のエージェント体制を把握すること`,
			`- 不明な情報はユーザーに確認してから行動すること`,
			``,
			`## エージェント操作`,
			`- 子エージェントの起動: \`claude --resume {sessionId} --append-system-prompt-file {ruleFile} --print\``,
			`- session-manager.json を読み込んで各エージェントの sessionId, ruleFile を取得すること`,
			`- session-manager.json のパス: \`~/.claude/session-manager.json\``,
			`- agents[] 配列に全エージェントの情報が格納されている`,
			``,
			`## 禁止事項`,
			`- 実装作業を自分で行わない（必ず担当部署に委任する）`,
			`- ユーザーの承認なく指示を出さない`,
			`- MEMORY.mdに部署一覧やエージェント情報を直接書き込まない（session-manager.jsonが唯一の情報源）`,
		];
		return lines.join('\n');
	}

	// 取締役ルールファイルの自動セクションのみを更新（カスタム部分は保持）
	async function updateDirectorAutoSection(filePath: string, config: AgentConfig): Promise<void> {
		try {
			const content = await fs.promises.readFile(filePath, 'utf-8');
			const autoContent = buildDirectorAutoSection(config);
			const START_MARKER = '<!-- CSM:AUTO:START -->';
			const END_MARKER = '<!-- CSM:AUTO:END -->';

			const startIdx = content.indexOf(START_MARKER);
			const endIdx = content.indexOf(END_MARKER);

			if (startIdx >= 0 && endIdx > startIdx) {
				// マーカーが見つかった → マーカー内のみ更新
				const before = content.substring(0, startIdx);
				const after = content.substring(endIdx + END_MARKER.length);
				const newContent = before + START_MARKER + '\n' + autoContent + '\n' + END_MARKER + after;
				await fs.promises.writeFile(filePath, newContent, 'utf-8');
			} else {
				// マーカーがないファイル → 先頭にマーカー付き自動セクションを追加
				const newContent = START_MARKER + '\n' + autoContent + '\n' + END_MARKER + '\n\n' + content;
				await fs.promises.writeFile(filePath, newContent, 'utf-8');
			}
		} catch {
			// ファイル読み書きエラーは無視
		}
	}

	// MEMORY.mdに組織情報を書き込む（v0.2.8: メモリファイル＋ポインタ方式・非同期）
	async function writeOrgInfoToMemory(config: AgentConfig): Promise<void> {
		try {
			const homeDir = os.homedir();
			const projectsDir = path.join(homeDir, '.claude', 'projects');
			try { await fs.promises.access(projectsDir); } catch { return; }
			const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
			if (!cwd) { return; }
			// memory/ ディレクトリを持つプロジェクトフォルダを探す
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
				return; // 最初に見つかったプロジェクトメモリに書き込んで終了
			}
		} catch {
			// MEMORY.md書き込み失敗は無視
		}
	}

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
