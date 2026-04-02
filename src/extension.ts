import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SessionTreeProvider, SessionItem, SessionDecorationProvider } from './sessionTreeProvider';
import { BookmarkTreeProvider } from './bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from './tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem } from './memoryTreeProvider';
import { AgentTreeProvider, AgentItem } from './agentTreeProvider';
import { showSessionPreview, showMemoryPreview, updatePreviewTitle } from './webviewPanel';
import { showAgentFormPanel } from './agentFormPanel';
import { showAgentPreview } from './agentPreviewPanel';
import { showOrgChart } from './orgChartPanel';
import * as dataStore from './dataStore';
import { AgentConfig } from './types';
import { loadMemoryFiles, deleteMemoryFile, mergeMemoryFiles, extractFromMemory, addToIndex } from './memoryManager';
import { resolveRuleFilePath } from './agentManager';

// VS Code設定から値を取得するヘルパー
function getConfig<T>(key: string, defaultValue: T): T {
	return vscode.workspace.getConfiguration('claudeManager').get<T>(key, defaultValue);
}

export function activate(context: vscode.ExtensionContext) {
	// TreeViewプロバイダーを作成
	const sessionProvider = new SessionTreeProvider();
	const bookmarkProvider = new BookmarkTreeProvider(() => sessionProvider.getSessions(), sessionProvider);
	const tagProvider = new TagTreeProvider(() => sessionProvider.getSessions());
	const memoryProvider = new MemoryTreeProvider();
	const sessionDecoProvider = new SessionDecorationProvider();
	const agentProvider = new AgentTreeProvider(
		() => sessionProvider.getSessions(),
		(id) => sessionProvider.isLiveSession(id)
	);

	// デコレーションプロバイダーを登録
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionDecoProvider));

	// ステータスバーにエージェント稼働状況表示
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	statusBarItem.command = 'claudeManager.openOrgChart';
	statusBarItem.tooltip = '組織図を開く';
	context.subscriptions.push(statusBarItem);

	// claude.exeの全PIDを取得（tasklistコマンド）
	function getClaudeProcessPids(): number[] {
		try {
			const output = execSync('tasklist /FI "IMAGENAME eq claude.exe" /FO CSV /NH', {
				encoding: 'utf-8',
				timeout: 5000,
				windowsHide: true,
			});
			const pids: number[] = [];
			for (const line of output.split('\n')) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('INFO:')) { continue; }
				// CSV形式: "claude.exe","1234","Console","1","50,000 K"
				const match = trimmed.match(/^"[^"]+","(\d+)"/);
				if (match) {
					pids.push(parseInt(match[1], 10));
				}
			}
			return pids;
		} catch {
			return [];
		}
	}

	// sessions/ JSONから既知セッションのPIDを取得（interactive/vscode等）
	function getSessionPids(): Set<number> {
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		const pids = new Set<number>();
		try {
			const files = fs.readdirSync(sessionsDir);
			for (const file of files) {
				if (!file.endsWith('.json')) { continue; }
				try {
					const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
					const data = JSON.parse(content);
					if (data.pid) {
						pids.add(data.pid);
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
		return pids;
	}

	function updateStatusBar(): void {
		const allPids = getClaudeProcessPids();
		const sessionPids = getSessionPids();

		// sessions/ JSONに登録されていないclaude.exe = --printモードの子エージェント
		const agentPids = allPids.filter((pid) => !sessionPids.has(pid));
		const activeCount = agentPids.length;
		const totalAgents = dataStore.getAgents().length;

		if (activeCount === 0) {
			statusBarItem.text = `👥 ${totalAgents}`;
			statusBarItem.tooltip = `動作中のエージェントなし（全${totalAgents}件）`;
		} else {
			statusBarItem.text = `🟢 ${activeCount} 👥 ${totalAgents}`;
			const pidList = agentPids.map((pid) => `• PID ${pid}`).join('\n');
			statusBarItem.tooltip = `動作中: ${activeCount}プロセス / 全${totalAgents}件\n${pidList}`;
		}
		statusBarItem.show();
	}
	updateStatusBar();

	// 設定からデフォルトのソート/グループモードを適用
	const initialSortMode = getConfig<string>('defaultSortMode', 'updated-desc');
	const initialGroupMode = getConfig<string>('defaultGroupMode', 'date');
	sessionProvider.setSortMode(initialSortMode as 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model');
	sessionProvider.setGroupMode(initialGroupMode as 'date' | 'tag' | 'agent' | 'flat');

	// エージェント監視ポーリングタイマー（tasklist用）
	let agentPollTimer: ReturnType<typeof setInterval> | undefined;
	function startAgentPolling(): void {
		if (agentPollTimer) { clearInterval(agentPollTimer); }
		const intervalSec = getConfig<number>('agentMonitorInterval', 5);
		agentPollTimer = setInterval(() => updateStatusBar(), intervalSec * 1000);
	}
	startAgentPolling();
	context.subscriptions.push({ dispose: () => { if (agentPollTimer) { clearInterval(agentPollTimer); } } });

	// 設定変更時にポーリング間隔を再適用
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('claudeManager.agentMonitorInterval')) {
			startAgentPolling();
		}
	}));

	// 全ビューをリフレッシュするヘルパー
	function refreshAll(): void {
		sessionProvider.refresh();
		bookmarkProvider.refresh();
		tagProvider.refresh();
		agentProvider.refresh();
		sessionDecoProvider.refresh();
		updateStatusBar();
	}

	// TreeViewを登録
	vscode.window.createTreeView('claudeSessions', { treeDataProvider: sessionProvider });
	vscode.window.createTreeView('claudeBookmarks', { treeDataProvider: bookmarkProvider });
	vscode.window.createTreeView('claudeTags', { treeDataProvider: tagProvider });
	vscode.window.createTreeView('claudeMemory', { treeDataProvider: memoryProvider });
	vscode.window.createTreeView('claudeAgents', { treeDataProvider: agentProvider });

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
					fs.appendFileSync(item.session.filePath, '\n' + titleEntry);
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
		vscode.commands.registerCommand('claudeManager.editMemory', (item: MemoryFileItem) => {
			vscode.workspace.openTextDocument(item.memoryFile.filePath).then((doc) => {
				vscode.window.showTextDocument(doc);
			});
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
				deleteMemoryFile(item.memoryFile.filePath);
				memoryProvider.refresh();
				vscode.window.showInformationMessage('メモリを削除しました');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.mergeMemories', async (item: MemoryFileItem) => {
			const groups = loadMemoryFiles();
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
			fs.writeFileSync(item.memoryFile.filePath, mergedContent, 'utf-8');
			deleteMemoryFile(picked.file.filePath);
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
			fs.writeFileSync(newFilePath, newContent, 'utf-8');
			addToIndex(memoryDir, `${newFileName}.md`, newName, newDescription);
			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${newName}」を抽出しました`);
		})
	);

	// セッションIDをクリップボードにコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copySessionId', (item: SessionItem) => {
			vscode.env.clipboard.writeText(item.session.id).then(() => {
				vscode.window.showInformationMessage(`セッションID をコピーしました: ${item.session.id}`);
			});
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
			showAgentFormPanel(undefined, item.session.id, (config) => {
				dataStore.addAgent(config);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」をエージェントとして登録しました`);
			});
		})
	);

	// エージェント設定を編集（Webviewフォーム）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editAgent', (item: SessionItem | AgentItem) => {
			let existing: AgentConfig | undefined;
			let sessionId: string;
			if (item instanceof AgentItem) {
				existing = item.agent;
				sessionId = existing.sessionId;
			} else {
				existing = dataStore.getAgentBySessionId(item.session.id);
				sessionId = item.session.id;
			}
			if (!existing) {
				vscode.window.showWarningMessage('エージェントが見つかりません');
				return;
			}

			const oldName = existing.name;
			showAgentFormPanel(existing, sessionId, (config) => {
				if (config.name !== oldName) {
					dataStore.removeAgent(oldName);
				}
				dataStore.addAgent(config);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
			});
		})
	);

	// プレビューヘッダからの設定編集（セッションIDベース）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editAgentBySessionId', (sessionId: string) => {
			const existing = dataStore.getAgentBySessionId(sessionId);
			if (!existing) { return; }
			const oldName = existing.name;
			showAgentFormPanel(existing, sessionId, (config) => {
				if (config.name !== oldName) { dataStore.removeAgent(oldName); }
				dataStore.addAgent(config);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
			});
		})
	);

	// プレビューヘッダからのルールファイル編集（セッションIDベース）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editRuleFileBySessionId', async (sessionId: string) => {
			const agent = dataStore.getAgentBySessionId(sessionId);
			if (!agent || !agent.ruleFile) { return; }
			const resolved = resolveRuleFilePath(agent.ruleFile);
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
				agent = dataStore.getAgentBySessionId(item.session.id);
			}
			if (!agent || !agent.ruleFile) {
				vscode.window.showWarningMessage('ルールファイルが設定されていません');
				return;
			}
			const resolved = resolveRuleFilePath(agent.ruleFile);
			const uri = vscode.Uri.file(resolved);
			const doc = await vscode.workspace.openTextDocument(uri);
			await vscode.window.showTextDocument(doc);
		})
	);

	// セッションを紐づけ（エージェントサイドバーから）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.linkSession', async (item: AgentItem) => {
			const sessions = sessionProvider.getSessions();
			const sessionItems = sessions.map((s) => {
				const existingAgent = dataStore.getAgentBySessionId(s.id);
				const usedLabel = existingAgent ? ` [${existingAgent.name}に紐づけ済み]` : '';
				return {
					label: (s.customName || s.claudeTitle || s.firstMessage.substring(0, 50)) + usedLabel,
					description: `${s.project} — ${s.lastTimestamp.toLocaleString('ja-JP')}`,
					sessionId: s.id,
					alreadyLinked: !!existingAgent,
					linkedAgentName: existingAgent?.name,
				};
			});

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
				const oldAgent = dataStore.getAgentBySessionId(picked.sessionId);
				if (oldAgent) {
					dataStore.addAgent({ ...oldAgent, sessionId: '' });
				}
			}

			const agent = { ...item.agent, sessionId: picked.sessionId };
			dataStore.addAgent(agent);
			refreshAll();
			vscode.window.showInformationMessage(`「${item.agent.name}」にセッションを紐づけました`);
		})
	);

	// エージェントのセッションを開く（Claude Codeで開く）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openAgentSession', (item: AgentItem) => {
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

	// セッションを新しくする（遺言を残して新セッション作成）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.renewAgentSession', async (item: AgentItem) => {
			const agent = item.agent;
			if (!agent.sessionId) {
				vscode.window.showWarningMessage('セッションが紐づけされていません');
				return;
			}

			// 引き継ぎメッセージの入力
			const testament = await vscode.window.showInputBox({
				prompt: '引き継ぎメッセージ（遺言）を入力してください',
				placeHolder: '次のセッションへの引き継ぎ事項...',
				value: `${agent.name}の前セッションから引き継ぎ。`,
			});
			if (testament === undefined) { return; } // キャンセル

			// 旧セッションのJSONLに引き継ぎメッセージを追記
			const oldSession = sessionProvider.getSessionById(agent.sessionId);
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
							content: `[セッション終了] ${testament}`,
						},
					});
					fs.appendFileSync(oldSession.filePath, '\n' + entry);
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

	// 使い方ガイドを開く（Webviewパネル）
	let guidePanel: vscode.WebviewPanel | undefined;
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openGuide', () => {
			const guidePath = path.join(context.extensionPath, 'guide.html');
			if (!fs.existsSync(guidePath)) {
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
			let html = fs.readFileSync(guidePath, 'utf-8');
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
		vscode.commands.registerCommand('claudeManager.copySessionPath', (item: SessionItem) => {
			vscode.env.clipboard.writeText(item.session.filePath).then(() => {
				vscode.window.showInformationMessage(`セッションパスをコピーしました`);
			});
		})
	);

	// メモリパスをコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copyMemoryPath', (item: MemoryFileItem) => {
			vscode.env.clipboard.writeText(item.memoryFile.filePath).then(() => {
				vscode.window.showInformationMessage(`メモリパスをコピーしました`);
			});
		})
	);

	// --- セッション削除 ---
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteSession', async (item: SessionItem) => {
			const displayName = item.session.customName || item.session.claudeTitle || item.session.firstMessage.substring(0, 40);
			const linkedAgent = dataStore.getAgentBySessionId(item.session.id);
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
			if (!fs.existsSync(trashDir)) {
				fs.mkdirSync(trashDir, { recursive: true });
			}
			try {
				const fileName = path.basename(item.session.filePath);
				const trashPath = path.join(trashDir, `${Date.now()}_${fileName}`);
				fs.renameSync(item.session.filePath, trashPath);
			} catch {
				vscode.window.showErrorMessage('セッションファイルの移動に失敗しました');
				return;
			}

			// 関連データのクリーンアップ
			dataStore.cleanupSessionData(item.session.id);
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
			showAgentFormPanel(preset, '', (config) => {
				dataStore.addAgent(config);
				refreshAll();
				vscode.window.showInformationMessage(`「${config.name}」をエージェントとして登録しました`);
			});
		})
	);

	// 初回読み込み＆ライブセッション監視開始
	sessionProvider.refresh();
	sessionProvider.onLiveChange(() => updateStatusBar());
	sessionProvider.startWatching();

	context.subscriptions.push({
		dispose: () => sessionProvider.stopWatching(),
	});
}

export function deactivate() {}
