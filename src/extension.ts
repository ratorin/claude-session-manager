import * as vscode from 'vscode';
import { SessionTreeProvider, SessionDecorationProvider } from './providers/sessionTreeProvider';
import { BookmarkTreeProvider } from './providers/bookmarkTreeProvider';
import { TagTreeProvider } from './providers/tagTreeProvider';
import { MemoryTreeProvider } from './providers/memoryTreeProvider';
import { AgentTreeProvider, AgentDecorationProvider } from './providers/agentTreeProvider';
import { AgentLiveTreeProvider } from './providers/agentLiveTreeProvider';
import { AgentFavoritesTreeProvider } from './providers/agentFavoritesTreeProvider';
import { OrchestrationTreeProvider } from './providers/orchestrationTreeProvider';
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
import { getConfig, getLocaleConfig, getAutoTranslateConfig } from './utils/config';
import { ensurePreCompactHook, ensurePreCompactSummaryHook, ensureGovernanceHook, ensureSessionAgentInjectHook, ensureSessionStopHook, ensureRecapCaptureHook, ensureInjectionDetectHook, migrateHooksToExecForm, healForeignOsHookPaths, removeAllCsmHooks } from './services/hookService';
import { runV04Migration, runV05Migration } from './services/migrationService';
import { initErrorReporter, logError } from './utils/errorReporter';
import { MainTabPanel } from './panels/mainTabPanel';
import { HelpFeedbackProvider } from './providers/helpFeedbackProvider';
import { setLocale, setAutoTranslate } from './services/i18nService';
// v0.5.22: ClaudeAgentsService は撤去（claude agents --json は TTY 必須で拡張ホストから使用不可）。


export function activate(context: vscode.ExtensionContext) {
	// パッケージバージョン取得
	const currentVersion: string = context.extension.packageJSON?.version ?? '0.0.0';

	// エラーレポータ初期化（ローカルログ蓄積）
	initErrorReporter(currentVersion);

	// i18n: ロケールと自動翻訳フラグを設定値から初期化
	setLocale(getLocaleConfig());
	setAutoTranslate(getAutoTranslateConfig());

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
	runV05Migration(context, currentVersion, extensionOutputChannelEarly).catch(() => {
		// マイグレーション失敗は致命的ではない
	});

	// クロス OS パス self-heal: Windows ホストで書かれた C:/... の CSM hook を
	// 現在 OS の ~/.claude 配下へ修復する（VMware 共有 settings.json 対策）。
	// migrate/ensure より先に enqueue することで、後続の冪等判定が正しいパスを見る。
	healForeignOsHookPaths(extensionOutputChannelEarly).catch(() => {
		// パス修復失敗は致命的ではない
	});

	// 既存 hook を exec-form (args[]) に一括マイグレーション（Claude Code 2.1.139+）
	migrateHooksToExecForm(extensionOutputChannelEarly).catch(() => {
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
	// Injection Detect hookの自動デプロイ（WebFetch/WebSearch のプロンプトインジェクション検知）
	ensureInjectionDetectHook(context.extensionPath, extensionOutputChannelEarly).catch(() => {
		// hook登録失敗は致命的ではない
	});

	// desktopNotification 設定を session-manager.json に同期（hook スクリプトが読む）
	const syncDesktopNotification = (): void => {
		const enabled = vscode.workspace.getConfiguration('claudeManager.hooks').get<boolean>('desktopNotification.enabled', false);
		dataStore.setHookSetting('desktopNotification', enabled).catch(() => { /* 失敗は無視 */ });
	};
	syncDesktopNotification();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('claudeManager.hooks.desktopNotification.enabled')) {
				syncDesktopNotification();
			}
		})
	);

	// TreeViewプロバイダーを作成
	const sessionProvider = new SessionTreeProvider();
	const bookmarkProvider = new BookmarkTreeProvider(() => sessionProvider.getAllParentSessions(), sessionProvider);
	const tagProvider = new TagTreeProvider(() => sessionProvider.getSessions());
	const memoryProvider = new MemoryTreeProvider();
	const sessionDecoProvider = new SessionDecorationProvider();
	// AgentWatcher: PIDベース監視 + サブエージェント検出を統合
	const agentWatcher = new AgentWatcher();
	context.subscriptions.push(agentWatcher);

	// T2.16: claudeManager.agents.showOtherProjects 設定から初期状態を読み込む
	const showOtherProjectsInit = vscode.workspace.getConfiguration('claudeManager').get<boolean>('agents.showOtherProjects', true);
	const agentProvider = new AgentTreeProvider(
		() => sessionProvider.getSessions(),
		(id) => agentWatcher.isLive(id),
		() => agentWatcher.getActiveAgentNames(),
		(sessionId) => agentWatcher.getSessionMtime(sessionId),
	);
	agentProvider.setHideOtherProjects(!showOtherProjectsInit);

	// ライブ状態ビュー専用プロバイダ
	const agentLiveProvider = new AgentLiveTreeProvider();

	// お気に入りビュー専用プロバイダ
	const agentFavoritesProvider = new AgentFavoritesTreeProvider(
		() => sessionProvider.getSessions(),
		(id) => agentWatcher.isLive(id),
		() => agentWatcher.getActiveAgentNames()
	);

	// オーケストレーション可視化ビュープロバイダ
	const orchestrationProvider = new OrchestrationTreeProvider();

	// TreeDataProviderのEventEmitter解放を追跡
	context.subscriptions.push(sessionProvider, bookmarkProvider, tagProvider, memoryProvider, agentProvider, agentLiveProvider, agentFavoritesProvider, orchestrationProvider);

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
		agentFavoritesProvider.setWatcherStates(agentWatcher.getStates());
		agentFavoritesProvider.refresh();
		// ライブ状態ビューをリフレッシュ（agentWatcher ベースに切替済み）
		agentLiveProvider.refresh();
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

	// v0.5.22: ClaudeAgentsService（claude agents --json 依存）を撤去。
	//   agentWatcher の PID + sessions/*.json 監視が唯一のライブデータソース。
	agentLiveProvider.setAgentWatcher(agentWatcher);
	orchestrationProvider.setAgentWatcher(agentWatcher);

	// AgentWatcher を起動
	agentWatcher.start();

	// 起動時スキャン: 過去の JSONL から未紐づけエージェントを一括自動紐づけ
	agentWatcher.scanProjectsForAutoLink().catch(() => {
		// スキャン失敗は致命的ではない
	});

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

	// CSM hook 全除去コマンド（アンインストール前の手動クリーンアップ・B案）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.removeAllHooks', async () => {
			const choice = await vscode.window.showWarningMessage(
				'CSM が登録したすべての hook を ~/.claude/settings.json から削除し、'
				+ '~/.claude/hooks/csm-*.js を .trash/ へ退避します。\n\n'
				+ '※ CSM を有効なまま実行すると次回起動時に再登録されます。'
				+ 'アンインストール直前の最終クリーンアップとしてお使いください。',
				{ modal: true },
				'削除する'
			);
			if (choice !== '削除する') { return; }
			try {
				const { removed, trashed } = await removeAllCsmHooks(extensionOutputChannelEarly);
				vscode.window.showInformationMessage(
					`CSM hook を削除しました（settings: ${removed} 件 / スクリプト ${trashed} 件を .trash/ へ退避）。`
				);
			} catch (err) {
				vscode.window.showErrorMessage(`CSM hook の削除に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
			}
		})
	);

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

	// 利用率メニュー（StatusBarクリック時）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openUsageMenu', async () => {
			// v0.5.17 §4-2: 現在のステータスバースタイルを取得
			const cfgUsage = vscode.workspace.getConfiguration('claudeManager.usage');
			const currentStyle = cfgUsage.get<string>('statusBarStyle', 'full');
			const styleLabels: Record<string, string> = {
				full: 'フル表示（%＋リセット時刻）',
				compact: 'コンパクト表示（%のみ）',
				'max-only': '最逼迫のみ（1枠のみ表示）',
			};
			const items: vscode.QuickPickItem[] = [
				{
					label: '$(browser) Claude Code を開く',
					description: 'Account & Usage はサイドバーから参照',
					detail: 'Claude Code パネルをサイドバーに表示します',
				},
				{
					label: '$(link-external) claude.ai/settings/usage をブラウザで開く',
					description: '使用量ページをブラウザで表示',
					detail: 'https://claude.ai/settings/usage',
				},
				{
					label: '$(refresh) 利用率を再取得',
					description: '最新の利用率データを取得します',
				},
				{
					label: '$(list-selection) 表示スタイルを切替',
					description: `現在: ${styleLabels[currentStyle] || currentStyle}`,
					detail: 'full / compact / max-only を選択します',
				},
			];

			const selected = await vscode.window.showQuickPick(items, {
				placeHolder: 'Claude 利用率 — 操作を選択',
				title: 'Claude 利用状況',
			});

			if (!selected) { return; }

			if (selected.label.startsWith('$(browser)')) {
				// Claude Code パネルを開く（fallback あり）
				try {
					await vscode.commands.executeCommand('claude-vscode.sidebar.open');
				} catch {
					try {
						await vscode.commands.executeCommand('claude-vscode.editor.open');
					} catch {
						vscode.window.showWarningMessage('Claude Code 拡張が見つかりません。拡張機能マーケットプレースからインストールしてください。');
					}
				}
			} else if (selected.label.startsWith('$(link-external)')) {
				// claude.ai をブラウザで開く
				const primaryUrl = vscode.Uri.parse('https://claude.ai/settings/usage');
				await vscode.env.openExternal(primaryUrl);
			} else if (selected.label.startsWith('$(refresh)')) {
				// 利用率を再取得
				const enabled = getConfig<boolean>('enableUsageMonitor', false);
				if (!enabled) {
					vscode.window.showWarningMessage('利用制限モニターが無効です。設定から claudeManager.enableUsageMonitor を有効にしてください');
					return;
				}
				await usageMonitor.refresh();
				vscode.window.showInformationMessage('利用制限を更新しました');
			} else if (selected.label.startsWith('$(list-selection)')) {
				// v0.5.17 §4-2: ステータスバースタイル切替
				const styleItems: (vscode.QuickPickItem & { value: string })[] = [
					{ label: 'フル表示', description: '5% 4.5h / 7% 7d / S 3% 5d20h / O 20% 5d10h', value: 'full' },
					{ label: 'コンパクト', description: '5% / 7% / S 3% / O 20%', value: 'compact' },
					{ label: '最逼迫のみ', description: '最も利用率が高い1枠のみ', value: 'max-only' },
				];
				for (const s of styleItems) { if (s.value === currentStyle) { s.label = `$(check) ${s.label}`; } }
				const chosen = await vscode.window.showQuickPick(styleItems, {
					placeHolder: 'ステータスバー表示スタイルを選択',
					title: 'Claude 利用率 — 表示スタイル',
				});
				if (chosen) {
					await cfgUsage.update('statusBarStyle', chosen.value, vscode.ConfigurationTarget.Global);
					await usageMonitor.refresh();
					vscode.window.showInformationMessage(`表示スタイルを「${styleLabels[chosen.value]}」に切替しました`);
				}
			}
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
		// v0.5.17 §4-2: ステータスバースタイル / show5dColumns の変更は即時反映
		if (
			e.affectsConfiguration('claudeManager.usage.statusBarStyle') ||
			e.affectsConfiguration('claudeManager.usage.show5dColumns')
		) {
			void usageMonitor.refresh();
		}
		// v0.5.17 §4-6 / §4-12: セッション表示・タブバー・description 設定の変更を反映
		if (
			e.affectsConfiguration('claudeManager.sessions.descriptionFields') ||
			e.affectsConfiguration('claudeManager.sessions.expandRecentDateGroupsOnly') ||
			e.affectsConfiguration('claudeManager.sessions.showFileSize') ||
			e.affectsConfiguration('claudeManager.ui.showTabBar')
		) {
			sessionProvider.refresh();
		}
		// v0.5.18 §4-4 §4-8: agents 表示設定の変更を反映
		if (
			e.affectsConfiguration('claudeManager.agents.expandMode') ||
			e.affectsConfiguration('claudeManager.agents.activeOnly') ||
			e.affectsConfiguration('claudeManager.agents.defaultGroupMode')
		) {
			const cfg2 = vscode.workspace.getConfiguration('claudeManager');
			const gm = cfg2.get<string>('agents.defaultGroupMode', 'org');
			if (gm === 'org' || gm === 'model' || gm === 'status' || gm === 'flat') {
				agentProvider.setGroupMode(gm);
			}
			agentProvider.setActiveOnly(cfg2.get<boolean>('agents.activeOnly', false));
			agentProvider.refresh();
		}
		if (e.affectsConfiguration('claudeManager.locale')) {
			setLocale(getLocaleConfig());
		}
		if (e.affectsConfiguration('claudeManager.locale.autoTranslate')) {
			setAutoTranslate(getAutoTranslateConfig());
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
		agentFavoritesProvider.refresh();
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
	const claudeAgentsTreeView = vscode.window.createTreeView('claudeAgents', {
		treeDataProvider: agentProvider,
		dragAndDropController: agentProvider,
		canSelectMany: false,
	});
	const claudeAgentsLiveTreeView = vscode.window.createTreeView('claudeAgentsLive', {
		treeDataProvider: agentLiveProvider,
	});
	const claudeOrchestrationTreeView = vscode.window.createTreeView('claudeOrchestration', {
		treeDataProvider: orchestrationProvider,
	});

	// v0.5.18 §4-4: TreeView.badge — 稼働中エージェント数を claudeAgents / claudeAgentsLive のビューアイコンに表示
	const applyBadge = (view: vscode.TreeView<unknown>, badge: { count: number; total: number }): void => {
		if (badge.count > 0) {
			view.badge = {
				value: badge.count,
				tooltip: `${badge.count} 件のエージェントが稼働中（登録 ${badge.total} 件中）`,
			};
		} else {
			view.badge = undefined;
		}
	};
	context.subscriptions.push(agentProvider.onDidChangeBadge((badge) => {
		applyBadge(claudeAgentsTreeView, badge);
		applyBadge(claudeAgentsLiveTreeView, badge);
	}));
	// 初期値を反映
	applyBadge(claudeAgentsTreeView, agentProvider.getLastBadge());
	applyBadge(claudeAgentsLiveTreeView, agentProvider.getLastBadge());

	// v0.5.18 §4-4 §4-8: 起動時に defaultGroupMode / activeOnly を反映
	{
		const cfg0 = vscode.workspace.getConfiguration('claudeManager');
		const gm = cfg0.get<string>('agents.defaultGroupMode', 'org');
		if (gm === 'model' || gm === 'status' || gm === 'flat') {
			agentProvider.setGroupMode(gm);
		}
		if (cfg0.get<boolean>('agents.activeOnly', false)) {
			agentProvider.setActiveOnly(true);
		}
	}
	context.subscriptions.push(
		vscode.window.createTreeView('claudeSessions', { treeDataProvider: sessionProvider }),
		vscode.window.createTreeView('claudeBookmarks', { treeDataProvider: bookmarkProvider }),
		vscode.window.createTreeView('claudeTags', { treeDataProvider: tagProvider }),
		vscode.window.createTreeView('claudeMemory', { treeDataProvider: memoryProvider }),
		vscode.window.createTreeView('claudeAgentsFavorites', { treeDataProvider: agentFavoritesProvider }),
		claudeAgentsTreeView,
		claudeAgentsLiveTreeView,
		claudeOrchestrationTreeView,
	);

	// T1.10: claudeMain WebviewView Container（プロジェクト用 WebView）を登録
	const mainTabPanel = new MainTabPanel(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(MainTabPanel.viewType, mainTabPanel, {
			webviewOptions: { retainContextWhenHidden: true },
		})
	);

	// T1.13: claudeHelp — Help & Feedback ビュー登録
	const extensionVersion = context.extension.packageJSON.version as string ?? '0.0.0';
	const helpFeedbackProvider = new HelpFeedbackProvider(extensionVersion);
	context.subscriptions.push(
		vscode.window.createTreeView('claudeHelp', { treeDataProvider: helpFeedbackProvider })
	);

	// セッション・メモリ関連コマンド登録
	registerSessionCommands(context, {
		sessionProvider, bookmarkProvider, tagProvider, memoryProvider, refreshAll,
	});

	// エージェント管理コマンド登録
	registerAgentCommands(context, {
		sessionProvider, agentProvider, agentWatcher, sessionServiceDeps,
		refreshAll, getExtensionOutputChannel, updateStatusBar, extensionOutputChannel,
		claudeAgentsTreeView, // v0.5.17 §4-1: searchAgents で reveal に使用
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

	// ライブ状態の手動リフレッシュコマンド（agentWatcher ベース）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshLiveAgents', () => {
			agentWatcher.scheduleUpdate();
			vscode.window.showInformationMessage('ライブ状態を更新しました');
		})
	);

	// v0.5.22: ClaudeAgentsService 撤去に伴い、可視性通知は agentLiveProvider 側で no-op 実装済み。
	//   agentWatcher は可視性に依存しない常時監視なので、tab 可視性通知は将来的な拡張のため残置。
	context.subscriptions.push(
		claudeAgentsLiveTreeView.onDidChangeVisibility(e => {
			agentLiveProvider.notifyTabVisible(e.visible);
		})
	);
	// 起動時: TreeView が既に可視なら即座にポーリング開始
	if (claudeAgentsLiveTreeView.visible) {
		agentLiveProvider.notifyTabVisible(true);
	}

	// T7 オーケストレーション: ビューの可視性変化でポーリング制御
	context.subscriptions.push(
		claudeOrchestrationTreeView.onDidChangeVisibility(e => {
			orchestrationProvider.setVisible(e.visible);
		})
	);
	if (claudeOrchestrationTreeView.visible) {
		orchestrationProvider.setVisible(true);
	}

	// T7.6: オーケストレーション専用コマンド
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshOrchestration', () => {
			orchestrationProvider.refresh();
			vscode.window.showInformationMessage('オーケストレーション状態を更新しました');
		}),
		vscode.commands.registerCommand('claudeManager.openSessionInOrchestration', async (session: import('./services/orchestrationViewModel').OrchestrationSession) => {
			if (session.sessionId) {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(session.sessionId)}`);
				await vscode.env.openExternal(uri);
			}
		}),
		vscode.commands.registerCommand('claudeManager.copyOrchestrationSessionId', async (item: import('./providers/orchestrationTreeProvider').SessionItem) => {
			const sid = item.session.sessionId;
			if (sid) {
				await vscode.env.clipboard.writeText(sid);
				vscode.window.showInformationMessage(`セッション ID をコピーしました: ${sid.substring(0, 8)}…`);
			}
		}),
		vscode.commands.registerCommand('claudeManager.openOrchestrationSessionInClaude', async (item: import('./providers/orchestrationTreeProvider').SessionItem) => {
			const sid = item.session.sessionId;
			if (sid) {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sid)}`);
				await vscode.env.openExternal(uri);
			}
		}),
	);

	// TASK-7: /goal コマンド連動 PoC — CSM タスクログを目標として表示
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.showGoals', async () => {
			const logs = await dataStore.getTaskLogs();
			const running = logs.filter(l => l.status === 'running' || l.status === 'pending');
			if (running.length === 0) {
				vscode.window.showInformationMessage('現在実行中のタスク目標はありません');
				return;
			}
			// タスクの要約を改行区切りでクリップボードにコピー（/goal コマンドへの貼り付け用）
			const goalText = running
				.map((l, i) => `${i + 1}. [${l.agentName}] ${l.summary}`)
				.join('\n');
			await vscode.env.clipboard.writeText(goalText);
			vscode.window.showInformationMessage(
				`${running.length} 件の目標をクリップボードにコピーしました。Claude Code で /goal を実行して貼り付けてください。`
			);
		})
	);

	// エージェントフィルター: 他プロジェクトのエージェントを非表示/表示切り替え (T2.16: 設定に永続化)
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.toggleAgentFilter', () => {
			const currentHide = agentProvider.getHideOtherProjects();
			const newHide = !currentHide;
			agentProvider.setHideOtherProjects(newHide);
			// 設定に永続化（グローバル）
			vscode.workspace.getConfiguration('claudeManager').update('agents.showOtherProjects', !newHide, vscode.ConfigurationTarget.Global).then(undefined, () => { /* 無視 */ });
			vscode.window.showInformationMessage(`他プロジェクトのエージェント: ${newHide ? '非表示' : '表示（灰色）'}`);
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
