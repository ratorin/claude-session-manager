import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem, SessionDecorationProvider } from './sessionTreeProvider';
import { BookmarkTreeProvider } from './bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from './tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem, MemoryGroupItem } from './memoryTreeProvider';
import { AgentTreeProvider, AgentItem, MigrationBannerItem } from './agentTreeProvider';
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
import { syncParentRuleFile, syncAllParentRuleFiles, hasCircularRef } from './parentChildSync';
import {
	parseFrontmatter, generateFrontmatter, updateFrontmatterInContent,
	migrateAutoToYaml, isLegacyAutoFormat, hasFrontmatter, sanitizeForYaml,
} from './frontmatterUtils';

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

	// 子エージェント用 description テキストを構築
	function buildDescription(config: AgentConfig): string {
		const safeName = sanitizeForYaml(config.name);
		const safeRole = sanitizeForYaml(config.role || '（役割未設定）');
		const lines: string[] = [
			`あなたは${safeName}所属のエンジニアです。`,
			`- ${safeRole}`,
			`- 変更前に既存コードを確認し、既存の設計方針を尊重する`,
			`- セッション開始時にMEMORY.md（自動メモリ）を確認し、組織図・行動規範・プロジェクト情報を把握すること`,
			`- session-manager.json の agents 一覧から自分の位置づけ・他エージェントとの関係を把握すること`,
			`- 「※子エージェントはこのセクションを無視すること」とマークされたセクションは読み飛ばすこと`,
		];
		if (config.parentAgent) {
			const safeParent = sanitizeForYaml(config.parentAgent);
			lines.push(`- 報告先: ${safeParent}（親エージェント）。作業完了時は結果を報告すること`);
		}
		if (config.workDir) {
			const safeWorkDir = sanitizeForYaml(config.workDir);
			lines.push(`- 編集対象は \`${safeWorkDir}\` 内のみ。それ以外のフォルダは絶対に変更しない`);
		}
		return lines.join('\n');
	}

	// 既存ファイルのフロントマター（description含む）を更新（本文は保持）— 非同期
	async function updateRuleFrontmatter(filePath: string, config: AgentConfig, description: string): Promise<void> {
		try {
			const content = await fs.promises.readFile(filePath, 'utf-8');

			// 旧 CSM:AUTO 形式 → YAML フロントマターに自動移行
			if (isLegacyAutoFormat(content)) {
				const migrated = migrateAutoToYaml(content, config);
				// 移行後に description を最新化
				const newContent = updateFrontmatterInContent(migrated, config, description);
				await fs.promises.writeFile(filePath, newContent, 'utf-8');
				return;
			}

			// YAML フロントマター形式 → フロントマターのみ更新
			const newContent = updateFrontmatterInContent(content, config, description);
			await fs.promises.writeFile(filePath, newContent, 'utf-8');
		} catch {
			// ファイル読み書きエラーは無視
		}
	}

	// セッション自動作成: claude CLIをspawnしてセッションIDを取得
	// 固定セッション（sessionMode !== 'disposable'）かつsessionIdが空の場合のみ実行
	async function createSessionForAgent(config: AgentConfig): Promise<string> {
		const { spawn } = require('child_process') as typeof import('child_process');

		return new Promise<string>((resolve, reject) => {
			// CLI引数を構築
			const args: string[] = [
				'--model', config.model,
				'--verbose',
				'--output-format', 'stream-json',
				'--max-turns', '1',
				'-p', `あなたは「${config.name}」です。${config.role || '指示された業務'}を担当します。ルールファイルを確認して準備完了を報告してください。`,
			];

			// ルールファイルがあれば付与
			if (config.ruleFile) {
				args.push('--append-system-prompt-file', config.ruleFile);
			}

			// 環境変数: ネストセッション検出を回避
			const env = { ...process.env };
			delete env.CLAUDE_CODE;
			delete env.CLAUDECODE;

			const child = spawn('claude', args, {
				env,
				cwd: config.workDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: true,
				windowsHide: true,
			});

			let output = '';
			let sessionId = '';
			const timeout = setTimeout(() => {
				child.kill('SIGTERM');
				reject(new Error('セッション作成がタイムアウトしました（60秒）'));
			}, 60000);

			child.stdout?.on('data', (data: Buffer) => {
				output += data.toString('utf-8');
				// stream-json形式: 各行が独立したJSON
				const lines = output.split('\n');
				for (const line of lines) {
					if (!line.trim()) { continue; }
					try {
						const parsed = JSON.parse(line);
						// セッションIDは init / system / result メッセージに含まれる
						if (parsed.session_id) {
							sessionId = parsed.session_id;
						}
					} catch {
						// 不完全な行は次回に持ち越し
					}
				}
			});

			child.stderr?.on('data', (data: Buffer) => {
				extensionOutputChannel.appendLine(`[createSession stderr] ${data.toString('utf-8').trim()}`);
			});

			child.on('close', (code: number | null) => {
				clearTimeout(timeout);
				if (sessionId) {
					resolve(sessionId);
				} else if (code === 0) {
					// 終了コード0でもsessionIdが取れなかった場合: 出力からフォールバック検索
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
	}

	// エージェント保存時にセッションを自動作成（固定セッション＋sessionId未設定の場合）
	async function autoCreateSessionIfNeeded(config: AgentConfig): Promise<AgentConfig> {
		// 使い捨てセッション or 既にsessionIdがある場合はスキップ
		if (config.sessionMode === 'disposable' || config.sessionId) {
			return config;
		}

		try {
			const sessionId = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `「${config.name}」のセッションを作成中...`,
					cancellable: false,
				},
				async () => createSessionForAgent(config)
			);

			extensionOutputChannel.appendLine(`[INFO] ${config.name} のセッションを自動作成: ${sessionId}`);
			return { ...config, sessionId };
		} catch (err) {
			// エラー時はsessionId無しで保存（従来と同じ動作にフォールバック）
			extensionOutputChannel.appendLine(`[WARN] ${config.name} のセッション自動作成に失敗: ${err}`);
			vscode.window.showWarningMessage(
				`セッションの自動作成に失敗しました。エージェントはセッション未紐づけで保存されます。`
			);
			return config;
		}
	}

	// ruleFileが未設定の場合にルールファイルを自動生成するヘルパー（子エージェント用）— 非同期
	// v0.3.1: YAML フロントマター形式（CSM:AUTOマーカー廃止）
	async function autoGenerateRuleFile(config: AgentConfig): Promise<AgentConfig> {
		const description = buildDescription(config);

		if (config.ruleFile) {
			// 既にルールファイルがある → フロントマター更新（旧形式は自動移行）
			await updateRuleFrontmatter(config.ruleFile, config, description);
			return config;
		}
		const ruleFolder = await dataStore.getRuleFolderForScope(config.scope);
		if (!ruleFolder) { return config; }

		// フォルダ構造: .agent-rules/<部署名>/<部署名>.md
		const agentFolder = path.join(ruleFolder, config.name);
		const filePath = path.join(agentFolder, `${config.name}.md`);

		// フラット構造の旧ファイルが存在するか確認（後方互換）
		const flatPath = path.join(ruleFolder, `${config.name}.md`);
		try {
			await fs.promises.access(flatPath);
			const flatStat = await fs.promises.stat(flatPath);
			if (flatStat.isFile()) {
				// フラット構造が存在 → フロントマター更新（旧形式は自動移行）
				await updateRuleFrontmatter(flatPath, config, description);
				return { ...config, ruleFile: flatPath };
			}
		} catch {
			// フラットファイルが存在しない → OK
		}

		// フォルダ構造のファイルが既に存在する場合は紐づけ + フロントマター更新
		try {
			await fs.promises.access(filePath);
			await updateRuleFrontmatter(filePath, config, description);
			// TODO.md / HISTORY.md が無ければ作成
			await ensureAgentFolderFiles(agentFolder, config.name);
			return { ...config, ruleFile: filePath };
		} catch {
			// ファイルが存在しない → 新規作成
		}

		// 重複チェック: 他スコープに同名が存在する場合は警告
		const otherScope = config.scope === 'global' ? 'project' : 'global';
		const otherFolder = await dataStore.getRuleFolderForScope(otherScope);
		const otherPath = path.join(otherFolder, config.name, `${config.name}.md`);
		const otherFlatPath = path.join(otherFolder, `${config.name}.md`);
		try {
			await fs.promises.access(otherPath);
			vscode.window.showWarningMessage(
				`同名のルールファイルが${otherScope === 'global' ? 'グローバル' : 'プロジェクト'}スコープに既に存在します: ${otherPath}`
			);
		} catch {
			try {
				await fs.promises.access(otherFlatPath);
				const s = await fs.promises.stat(otherFlatPath);
				if (s.isFile()) {
					vscode.window.showWarningMessage(
						`同名のルールファイルが${otherScope === 'global' ? 'グローバル' : 'プロジェクト'}スコープに既に存在します: ${otherFlatPath}`
					);
				}
			} catch {
				// 他スコープには存在しない → OK
			}
		}

		try {
			// 部署フォルダ作成
			await fs.promises.mkdir(agentFolder, { recursive: true });
			// YAML フロントマター形式で新規作成
			const frontmatter = generateFrontmatter(config, description);
			const content = frontmatter + '\n\n<!-- 以下にカスタムルールを自由に追記してください -->\n';
			await fs.promises.writeFile(filePath, content, 'utf-8');
			// TODO.md / HISTORY.md テンプレート作成
			await ensureAgentFolderFiles(agentFolder, config.name);
			return { ...config, ruleFile: filePath };
		} catch {
			return config;
		}
	}

	// 部署フォルダに TODO.md / HISTORY.md が存在しなければテンプレートを作成
	async function ensureAgentFolderFiles(agentFolder: string, agentName: string): Promise<void> {
		const todoPath = path.join(agentFolder, 'TODO.md');
		const historyPath = path.join(agentFolder, 'HISTORY.md');
		try {
			await fs.promises.access(todoPath);
		} catch {
			const todoTemplate = `# ${agentName} — TODO\n\n> 最終更新: ${new Date().toISOString()}\n\n## 未完了\n\n## 完了（直近10件）\n\n## 保留\n`;
			await fs.promises.writeFile(todoPath, todoTemplate, 'utf-8');
		}
		try {
			await fs.promises.access(historyPath);
		} catch {
			const historyTemplate = `# ${agentName} — 歴代セッション記録\n\n`;
			await fs.promises.writeFile(historyPath, historyTemplate, 'utf-8');
		}
	}

	// ファイル末尾だけ読み取る（巨大JSONL対策・非同期・fdリーク対策済み）
	async function readFileTail(filePath: string, bytes: number): Promise<string> {
		const handle = await fs.promises.open(filePath, 'r');
		try {
			const stat = await handle.stat();
			if (stat.size === 0) { return ''; }
			const readSize = Math.min(bytes, stat.size);
			const startPos = Math.max(0, stat.size - readSize);
			const buffer = Buffer.alloc(readSize);
			await handle.read(buffer, 0, readSize, startPos);
			return buffer.toString('utf-8');
		} finally {
			await handle.close();
		}
	}

	// OutputChannel（エラーログ出力用）— 起動時に即作成
	const extensionOutputChannel = vscode.window.createOutputChannel('CSM Session Manager');
	context.subscriptions.push(extensionOutputChannel);
	function getExtensionOutputChannel(): vscode.OutputChannel {
		return extensionOutputChannel;
	}

	// 簡易遺言生成: JSONL末尾から直近のやり取りを抽出（コストゼロ・即時）
	async function generateSimpleTestament(agent: AgentConfig, oldSession: { filePath: string } | undefined): Promise<string> {
		let testament = `${agent.name}の前セッションから引き継ぎ。`;
		if (!oldSession) { return testament; }
		try {
			const tail = await readFileTail(oldSession.filePath, 128 * 1024); // 128KB
			const lines = tail.split('\n').filter((l: string) => l.trim());
			// 先頭行は途中で切れている可能性があるのでスキップ
			if (lines.length > 1) { lines.shift(); }
			const summaryParts: string[] = [];
			const recentLines = lines.slice(-50);
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
			if (summaryParts.length > 0) {
				const lastParts = summaryParts.slice(-4);
				testament = `${agent.name}の前セッション引き継ぎ:\n${lastParts.join('\n')}`;
			}
		} catch {
			// 読み込み失敗時はデフォルトメッセージのまま
		}
		return testament;
	}

	// 詳細遺言生成: Claude CLIでAI要約を生成（トークンコストあり）
	async function generateDetailedTestament(agent: AgentConfig, oldSession: { filePath: string } | undefined, model: string): Promise<string> {
		if (!oldSession) { return `${agent.name}の前セッションから引き継ぎ。`; }
		try {
			// JSONL末尾から直近の内容を取得（末尾256KBのみ読み取り）
			const tail = await readFileTail(oldSession.filePath, 256 * 1024); // 256KB
			const lines = tail.split('\n').filter((l: string) => l.trim());
			// 先頭行は途中で切れている可能性があるのでスキップ
			if (lines.length > 1) { lines.shift(); }
			const recentLines = lines.slice(-100);
			const recentContent = recentLines.join('\n').substring(0, 8000);

			// Claude CLIで要約生成
			const { execFile } = require('child_process') as typeof import('child_process');
			const prompt = `以下はClaude Codeのセッションログ（JSONL形式）の末尾です。このセッションで何をしたか・何が未完了かを300文字以内で簡潔に要約してください。次のセッションへの引き継ぎ情報として使います。\n\n${recentContent}`;

			const result = await new Promise<string>((resolve, reject) => {
				const child = execFile('claude', ['-p', prompt, '--model', model, '--max-tokens', '600'], {
					timeout: 60000,
					maxBuffer: 1024 * 64,
				}, (err: Error | null, stdout: string) => {
					if (err) { reject(err); return; }
					resolve(stdout.trim());
				});
				child.stdin?.end();
			});
			return result || `${agent.name}の前セッションから引き継ぎ。`;
		} catch (err) {
			vscode.window.showWarningMessage(`AI要約の生成に失敗しました。簡易モードにフォールバックします。`);
			return generateSimpleTestament(agent, oldSession);
		}
	}

	// ルールファイルの本文に「歴代セッションの記録」を追記（直近3世代保持）
	// v0.3.1: フロントマター方式対応（本文=フロントマター以降の部分に書き込む）
	async function appendSessionHistoryToRuleFile(ruleFilePath: string, oldSessionId: string, testament: string): Promise<void> {
		const HISTORY_HEADER = '## 歴代セッションの記録';
		const MAX_GENERATIONS = 3;

		try {
			let content = await fs.promises.readFile(ruleFilePath, 'utf-8');

			// 日付文字列
			const dateStr = new Date().toISOString().split('T')[0];
			const newEntry = `### ${dateStr} (旧ID: ${oldSessionId})\n${testament}`;

			const historyIdx = content.indexOf(HISTORY_HEADER);
			if (historyIdx >= 0) {
				// 既存の歴代セクションを解析
				const sectionStart = historyIdx;
				const afterHeader = content.substring(sectionStart + HISTORY_HEADER.length);
				// 「## 」で始まる次のセクション（空行の後に来る同レベル以上のヘッダ）を探す
				// 歴代記録内の ## ヘッダを誤検出しないよう、空行を前提とする
				const nextSectionMatch = afterHeader.match(/\n\n## [^#]/);
				const sectionEnd = nextSectionMatch
					? sectionStart + HISTORY_HEADER.length + (nextSectionMatch.index ?? afterHeader.length)
					: content.length;
				const sectionBody = content.substring(sectionStart + HISTORY_HEADER.length, sectionEnd);

				// ### で始まるエントリを抽出
				const entries: string[] = [];
				const entryRegex = /### .+/g;
				let match;
				const entryStarts: number[] = [];
				while ((match = entryRegex.exec(sectionBody)) !== null) {
					entryStarts.push(match.index);
				}
				for (let i = 0; i < entryStarts.length; i++) {
					const start = entryStarts[i];
					const end = i + 1 < entryStarts.length ? entryStarts[i + 1] : sectionBody.length;
					entries.push(sectionBody.substring(start, end).trim());
				}

				// 新エントリを追加し、直近3世代に制限
				entries.push(newEntry);
				while (entries.length > MAX_GENERATIONS) { entries.shift(); }

				// セクションを再構築
				const newSection = HISTORY_HEADER + '\n\n' + entries.join('\n\n') + '\n';
				content = content.substring(0, sectionStart) + newSection + content.substring(sectionEnd);
			} else {
				// 歴代セクションが存在しない → フロントマター直後（本文の先頭）に追加
				const parsed = parseFrontmatter(content);
				if (parsed) {
					// フロントマター形式 → 本文の先頭に歴代セクションを挿入
					const fm = content.substring(0, content.length - parsed.body.length);
					const newSection = HISTORY_HEADER + '\n\n' + newEntry + '\n\n';
					content = fm + newSection + parsed.body;
				} else {
					// フロントマターなし → ファイル末尾に追加
					content += '\n\n' + HISTORY_HEADER + '\n\n' + newEntry + '\n';
				}
			}

			await fs.promises.writeFile(ruleFilePath, content, 'utf-8');
		} catch (err) {
			// ルールファイル書き込みエラーをOutputChannelにログ出力
			const ch = getExtensionOutputChannel();
			ch.appendLine(`[${new Date().toISOString()}] appendSessionHistoryToRuleFile エラー: ${err instanceof Error ? err.message : String(err)}`);
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
				const finalConfig = await autoCreateSessionIfNeeded(ruleConfig);
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
			const ch = getExtensionOutputChannel();
			const agent = item.agent;
			if (!agent.sessionId) {
				vscode.window.showWarningMessage('セッションが紐づけされていません');
				return;
			}

			try {
				// 遺言生成モードを選択
				const mode = await vscode.window.showQuickPick(
					[
						{ label: '簡易（即時）', description: 'JSONL末尾から自動抽出。コストゼロ', value: 'simple' as const },
						{ label: '詳細（AI要約）', description: 'Claude CLIで要約生成。高品質だがトークンコストあり', value: 'detailed' as const },
					],
					{ placeHolder: '遺言の生成方法を選択してください' }
				);
				if (!mode) { return; }

				const oldSession = sessionProvider.getSessionById(agent.sessionId);
				const oldSessionId = agent.sessionId;
				let testament = `${agent.name}の前セッションから引き継ぎ。`;

				// 遺言生成（エラー時はデフォルトメッセージで続行）
				try {
					if (mode.value === 'simple') {
						testament = await generateSimpleTestament(agent, oldSession);
					} else {
						// 詳細モード: モデル選択 → Claude CLIでAI要約生成
						const modelPick = await vscode.window.showQuickPick(
							[
								{ label: 'opus', description: '最高品質（推奨）', value: 'opus' },
								{ label: 'sonnet', description: 'バランス重視', value: 'sonnet' },
								{ label: 'haiku', description: '高速・低コスト', value: 'haiku' },
							],
							{ placeHolder: '要約に使用するモデルを選択', title: 'AI要約モデル' }
						);
						if (!modelPick) { return; }
						testament = await generateDetailedTestament(agent, oldSession, modelPick.value);
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
						await appendSessionHistoryToRuleFile(agent.ruleFile, oldSessionId, trimmedTestament);
					} catch (historyErr) {
						ch.appendLine(`[${new Date().toISOString()}] 歴代セッション記録追記エラー: ${historyErr instanceof Error ? historyErr.message : String(historyErr)}`);
						// 追記失敗でもセッション更新は続行
					}
				}

				// previousSessionIds を更新（直近5件保持）
				const prevIds = [...(agent.previousSessionIds || [])];
				prevIds.push(oldSessionId);
				while (prevIds.length > 5) { prevIds.shift(); }

				// セッションID紐づけを解除、previousSessionIds を保存
				const updatedAgent: AgentConfig = { ...agent, sessionId: '', previousSessionIds: prevIds };
				await dataStore.addAgent(updatedAgent);
				refreshAll();
				vscode.window.showInformationMessage(
					`「${agent.name}」のセッション紐づけを解除しました。新しいセッションを紐づけてください。`
				);
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
					const trashDir = path.join(ruleFolder, '.trash');
					await fs.promises.mkdir(trashDir, { recursive: true });
					const trashDest = path.join(trashDir, `${agent.name}.md.${Date.now()}`);
					await fs.promises.rename(resolved, trashDest);

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
								const trashDir = path.join(ruleFolder, '.trash');
								await fs.promises.mkdir(trashDir, { recursive: true });
								await fs.promises.rename(resolved, path.join(trashDir, `${agent.name}.md.${Date.now()}`));

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

			await ensureSubagentHooks();
			refreshAll();
			const parts: string[] = [`移行完了: ${migrated.length}件成功`];
			if (skipped.length > 0) { parts.push(`${skipped.length}件スキップ`); }
			if (errors.length > 0) { parts.push(`${errors.length}件エラー（OutputChannel参照）`); }
			vscode.window.showInformationMessage(parts.join('、'));
			if (errors.length > 0) { ch.show(true); }
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
				// SubagentStart/Stop フックを settings.json に登録
				await ensureSubagentHooks();
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

	// 取締役専用ルールファイル生成（v0.3.1: YAML フロントマター形式）
	async function generateDirectorRuleFile(config: AgentConfig): Promise<AgentConfig> {
		const description = buildDirectorDescription(config);

		if (config.ruleFile) {
			// 既にルールファイルがある → フロントマター更新（旧形式は自動移行���
			await updateRuleFrontmatter(config.ruleFile, config, description);
			return config;
		}
		const ruleFolder = await dataStore.getRuleFolderForScope(config.scope);
		if (!ruleFolder) { return config; }
		const filePath = path.join(ruleFolder, `${config.name}.md`);
		// 既にファイルが存在する場合は紐づけ + フロントマター更新
		try {
			await fs.promises.access(filePath);
			await updateRuleFrontmatter(filePath, config, description);
			return { ...config, ruleFile: filePath };
		} catch {
			// ファイルが存在しない → 新規作成
		}
		try {
			await fs.promises.mkdir(ruleFolder, { recursive: true });
			// YAML フロントマター形式で新規作成
			const frontmatter = generateFrontmatter(config, description);
			const content = frontmatter + '\n\n<!-- 以下にカスタムルールを自由に追記してください。このエリアはCSMによる自動更新の対象外です。 -->\n';
			await fs.promises.writeFile(filePath, content, 'utf-8');
			return { ...config, ruleFile: filePath };
		} catch {
			return config;
		}
	}

	// 取締役用 description テキストを構築
	function buildDirectorDescription(config: AgentConfig): string {
		const safeName = sanitizeForYaml(config.name);
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

	// v0.3.1: SubagentStart/Stop フックを settings.json に登録する
	async function ensureSubagentHooks(): Promise<void> {
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
				// settings.json が存在しないか読み取り不可
				return;
			}

			// hooks はイベントタイプをキーとするオブジェクト（例: { Stop: [...], PreToolUse: [...] }）
			const hooksObj = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
				? settings.hooks as Record<string, unknown>
				: {};
			if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
				settings.hooks = hooksObj;
			}
			const CSM_SIGNAL_MARKER = 'csm/subagent-signal.js';

			// 指定イベントキー内にCSMシグナルフックが既に存在するか確認するヘルパー
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

			// 旧エントリ除去: Stop イベントに誤登録された csm-signal.js を検出・除去
			const removeStaleSignalHooks = (eventKey: string): boolean => {
				const entries = hooksObj[eventKey];
				if (!Array.isArray(entries)) { return false; }
				const originalLen = entries.length;
				const filtered = entries.filter((entry: Record<string, unknown>) => {
					const innerHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
					if (!Array.isArray(innerHooks)) { return true; }
					// csm-signal.js が含まれるエントリは不正な場所から除去
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
			// Stop / SessionStart イベントに誤登録された csm-signal.js を除去
			const removedFromStop = removeStaleSignalHooks('Stop');
			const removedFromSessionStart = removeStaleSignalHooks('SessionStart');

			const hasStart = hasSignalHook('SubagentStart', 'start');
			const hasStop = hasSignalHook('SubagentStop', 'stop');

			let changed = removedFromStop || removedFromSessionStart;

			// イベントキーにCSMシグナルフックを追加するヘルパー
			// 既存の matcher:"*" エントリがあればその hooks 配列にマージ、なければ新規作成
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
				// 既存の matcher:"*" エントリを探してマージ
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
				// バックアップ作成
				const backupPath = settingsPath + `.bak.${Date.now()}`;
				try {
					await fs.promises.copyFile(settingsPath, backupPath);
				} catch { /* バックアップ失敗は無視 */ }
				await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
				const ch = getExtensionOutputChannel();
				ch.appendLine(`[${new Date().toISOString()}] SubagentStart/Stop フックを settings.json に登録しました`);
			}
		} catch (err) {
			const ch = getExtensionOutputChannel();
			ch.appendLine(`[${new Date().toISOString()}] フック登録エラー: ${err instanceof Error ? err.message : String(err)}`);
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
