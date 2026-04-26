import * as vscode from 'vscode';
import { SessionTreeProvider, SessionDecorationProvider } from './providers/sessionTreeProvider';
import { BookmarkTreeProvider } from './providers/bookmarkTreeProvider';
import { TagTreeProvider } from './providers/tagTreeProvider';
import { MemoryTreeProvider } from './providers/memoryTreeProvider';
import { AgentTreeProvider, AgentDecorationProvider } from './providers/agentTreeProvider';
import { shouldShowInOrgChart } from './utils/agentUtils';
import { AgentWatcher } from './watchers/agentWatcher';
import { TaskTracker } from './watchers/taskTracker';
import { UsageMonitor } from './utils/usageMonitor';
import * as dataStore from './models/dataStore';
import { SessionServiceDeps } from './services/sessionService';
import { registerSessionCommands } from './commands/sessionCommands';
import { registerAgentCommands } from './commands/agentCommands';
import { registerMigrationCommands } from './commands/migrationCommands';
import { registerOrgChartCommands } from './commands/orgChartCommands';
import { registerUtilityCommands } from './commands/utilityCommands';
import { getConfig } from './utils/config';
import { ensurePreCompactHook, ensurePreCompactSummaryHook, ensureGovernanceHook, ensureSessionAgentInjectHook, ensureSessionStopHook, ensureRecapCaptureHook } from './services/hookService';
import { runV04Migration } from './services/migrationService';
import { initErrorReporter, logError } from './utils/errorReporter';


export function activate(context: vscode.ExtensionContext) {
	// パッケージバージョン取得
	const currentVersion: string = context.extension.packageJSON?.version ?? '0.0.0';

	// エラーレポータ初期化（ローカルログ蓄積）
	initErrorReporter(currentVersion);

	// プロセス全体の未捕捉エラーを拾う
	process.on('unhandledRejection', (reason) => {
		void logError('error', 'unhandledRejection', reason);
	});
	process.on('uncaughtException', (err) => {
		void logError('error', 'uncaughtException', err);
	});

	// session-manager.json マイグレーション: agents[] → agentSessions（一度だけ実行）
	dataStore.migrateAgentsToAgentSessions().catch(() => {
		// マイグレーション失敗は致命的ではないため、エラーを無視
	});

	// /csm-ask-agent のインストール状態はエージェントツリーのバナーで表示

	// v0.4.x マイグレーション（バージョン追跡＋バックスラッシュ自動修正）
	const extensionOutputChannelEarly = vscode.window.createOutputChannel('CSM Hook Setup');
	// dispose漏れ防止: Extension Host 共有プロセスでリークしないよう subscriptions に登録
	context.subscriptions.push(extensionOutputChannelEarly);
	runV04Migration(context, currentVersion, extensionOutputChannelEarly).catch(() => {
		// マイグレーション失敗は致命的ではない
	});

	// PreCompact hook の自動デプロイ（テンプレート→~/.claude/hooks/ + settings.json登録）
	ensurePreCompactHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});
	// PreCompact Summary hook の自動デプロイ（全セッション対象・CSM_SUMMARY生成で文脈保持強化）
	ensurePreCompactSummaryHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});
	// Stop hook の自動デプロイ（セッション終了時のHISTORY.md追記）
	ensureSessionStopHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});
	// Recap Capture hook の自動デプロイ（/recap 結果を HISTORY.md へ自動追記）
	ensureRecapCaptureHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});
	// Governance Capture hookの自動デプロイ（JSONL記録）
	ensureGovernanceHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});

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
	const agentDecoProvider = new AgentDecorationProvider();
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(agentDecoProvider));

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
		vscode.window.createTreeView('claudeAgents', { treeDataProvider: agentProvider, dragAndDropController: agentProvider, canSelectMany: false }),
	);

	// セッション・メモリ関連コマンド登録
	registerSessionCommands(context, {
		sessionProvider, bookmarkProvider, tagProvider, memoryProvider, refreshAll,
	});

	// エージェント管理コマンド登録
	registerAgentCommands(context, {
		sessionProvider, agentProvider, agentWatcher, sessionServiceDeps,
		refreshAll, getExtensionOutputChannel, updateStatusBar, extensionOutputChannel,
	});

	// 組織図・ディレクター関連コマンド登録
	registerOrgChartCommands(context, {
		sessionProvider, bookmarkProvider, tagProvider,
		refreshAll, getExtensionOutputChannel, extensionOutputChannel,
	});

	// マイグレーション・インストール関連コマンド登録
	registerMigrationCommands(context, {
		refreshAll, getExtensionOutputChannel, extensionOutputChannel,
	});

	// ユーティリティコマンド登録
	registerUtilityCommands(context, {
		sessionProvider, bookmarkProvider, memoryProvider, refreshAll,
	});

	// エージェントフィルター: 他プロジェクトのエージェントを非表示/表示切り替え
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleAgentFilter', () => {
			const current = agentProvider.getHideOtherProjects();
			agentProvider.setHideOtherProjects(!current);
			vscode.window.showInformationMessage(`他プロジェクトのエージェント: ${!current ? '非表示' : '表示（灰色）'}`);
		})
	);

	// エージェント役割自動認識の有効化（バナーからのボタン）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.enableSessionAgentInject', async () => {
			await ensureSessionAgentInjectHook(context.extensionPath, extensionOutputChannel);
			agentProvider.refresh();
			vscode.window.showInformationMessage('エージェント役割自動認識を有効化しました。次回セッション開始時から動作します。');
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
