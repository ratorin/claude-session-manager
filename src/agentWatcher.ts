// 統合監視エンジン
// PIDベースのライブセッション検出 + サブエージェント検出を一本化
// EventEmitter方式で変更を通知する
// v0.3.0 perf: setInterval廃止、fs.watchデバウンス一本化、全sync I/O排除
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentWatcherState } from './types';
import * as dataStore from './dataStore';
import { detectSubagents } from './subagentDetector';

// シグナルファイルから読み取った情報
interface SignalData {
	type: 'start' | 'stop';
	timestamp: string;
	pid?: number;
	cwd?: string;
	sessionId?: string;
	agentType?: string;
	description?: string;
	parentSessionId?: string;
}

export class AgentWatcher implements vscode.Disposable {
	// 状態変更イベント（ツリーリフレッシュ等に利用）
	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	// ウォッチャー（setIntervalは廃止）
	private watcher: fs.FSWatcher | undefined;
	private signalWatcher: fs.FSWatcher | undefined;
	private signalDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// 状態
	private liveSessionIds = new Set<string>();
	private states = new Map<string, AgentWatcherState>();
	private sessionMtimes = new Map<string, number>(); // セッションIDごとのJSONL mtime
	private sessionCwdMap = new Map<string, string>(); // セッションID → cwd（JSONL特定用）
	// シグナルベースの子エージェント追跡（sessionId → true/false）
	private signalLiveSessions = new Map<string, boolean>();
	private enabled = false;
	private updating = false; // 二重実行防止

	// 監視を開始する
	// enableAgentMonitor が false の場合は何もしない（完全停止）
	start(): void {
		const config = vscode.workspace.getConfiguration('claudeManager');
		this.enabled = config.get<boolean>('enableAgentMonitor', false);

		// 既存ウォッチャーをクリア
		this.stop();

		if (!this.enabled) { return; }

		// 初回即更新（非同期）
		this.scheduleUpdate();

		// sessions/ ディレクトリの fs.watch（デバウンス付き）
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		try {
			this.watcher = fs.watch(sessionsDir, () => this.scheduleUpdate());
		} catch {
			// ディレクトリが存在しない場合はスキップ
		}

		// .csm-signals/ ディレクトリの監視（シグナルファイル方式の子エージェント検出）
		this.startSignalWatcher();
	}

	// デバウンス付き更新スケジュール（300ms）
	public scheduleUpdate(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.updateAsync();
		}, 300);
	}

	// 監視を停止する
	stop(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		if (this.signalDebounceTimer) {
			clearTimeout(this.signalDebounceTimer);
			this.signalDebounceTimer = undefined;
		}
		if (this.watcher) {
			this.watcher.close();
			this.watcher = undefined;
		}
		if (this.signalWatcher) {
			this.signalWatcher.close();
			this.signalWatcher = undefined;
		}
	}

	// 設定変更時などに再起動する
	restart(): void {
		this.start();
	}

	// PIDが生存しているか確認（シグナル0 = 存在確認のみ）
	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	// メイン更新ロジック（完全非同期）
	private async updateAsync(): Promise<void> {
		// 二重実行防止
		if (this.updating) { return; }
		this.updating = true;
		try {
			await this.update();
		} finally {
			this.updating = false;
		}
	}

	// cwdからJSONLファイルパスを算出
	// Claude Code は cwd をエンコードしてプロジェクトフォルダ名にする
	// 例: c:\xampp → c--xampp
	private getJsonlPath(sessionId: string, cwd: string): string | null {
		if (!cwd || !sessionId) { return null; }
		// cwdをClaude Code形式のフォルダ名にエンコード
		const encoded = cwd
			.replace(/\\/g, '/')
			.replace(/^([a-zA-Z]):/, '$1-')
			.replace(/\//g, '-');
		return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
	}

	private async update(): Promise<void> {
		// 1. sessions/*.json からPIDベースでライブセッション検出
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		const newLiveSessionIds = new Set<string>();
		const newSessionMtimes = new Map<string, number>();
		const newSessionCwdMap = new Map<string, string>();

		try {
			const files = await fs.promises.readdir(sessionsDir);
			// 並列処理（Promise.allSettledで個別エラーを無視）
			await Promise.allSettled(files.map(async (file) => {
				if (!file.endsWith('.json')) { return; }
				const filePath = path.join(sessionsDir, file);
				try {
					const content = await fs.promises.readFile(filePath, 'utf-8');
					const data = JSON.parse(content);
					if (data.sessionId && data.pid && this.isProcessAlive(data.pid)) {
						newLiveSessionIds.add(data.sessionId);
						// cwdを記録（サブエージェント検出用）
						if (data.cwd) {
							newSessionCwdMap.set(data.sessionId, data.cwd);
						}
						// sessions/*.json の mtime を活動指標として記録（stalled判定用）
						try {
							const jsonStat = await fs.promises.stat(filePath);
							newSessionMtimes.set(data.sessionId, jsonStat.mtimeMs);
						} catch { /* stat失敗は無視 */ }
					} else if (data.pid && !this.isProcessAlive(data.pid)) {
						// プロセス終了済み → ゾンビJSONを.trash/へ移動（rm禁止ルール準拠）
						try {
							const trashDir = path.join(os.homedir(), '.claude', '.trash');
							await fs.promises.mkdir(trashDir, { recursive: true });
							await fs.promises.rename(filePath, path.join(trashDir, `${Date.now()}_${path.basename(filePath)}`));
						} catch { /* 移動失敗は無視 */ }
					}
				} catch {
					// 読み込み/パースエラーはスキップ
				}
			}));
		} catch {
			// sessionsディレクトリが存在しない場合はスキップ
		}

		this.liveSessionIds = newLiveSessionIds;
		this.sessionMtimes = newSessionMtimes;
		this.sessionCwdMap = newSessionCwdMap;

		// シグナルベースの状態を反映（start シグナルがあればライブに追加）
		this.applySignalState();

		// 2. 各エージェントの状態を更新（サブエージェント検出含む）
		const agents = await dataStore.getAgents();
		const prevStates = new Map(this.states);
		this.states.clear();

		// ライブエージェントのサブエージェント検出を並列実行
		await Promise.allSettled(agents.map(async (agent) => {
			const isLive = agent.sessionId
				? this.liveSessionIds.has(agent.sessionId)
				: false;

			// サブエージェント検出: ライブかつセッションIDがある場合のみ
			let activeSubagentIds: string[] = [];
			if (isLive && agent.sessionId) {
				const cwd = this.sessionCwdMap.get(agent.sessionId);
				if (cwd) {
					const jsonlPath = this.getJsonlPath(agent.sessionId, cwd);
					if (jsonlPath) {
						try {
							const subagents = await detectSubagents(jsonlPath);
							activeSubagentIds = subagents.map(s => s.toolUseId);
						} catch { /* 検出失敗は無視 */ }
					}
				}
			}

			this.states.set(agent.name, {
				agentName: agent.name,
				sessionId: agent.sessionId,
				isLive,
				activeSubagentIds,
			});
		}));

		// 3. 変更があればイベント発火
		if (this.hasChanged(prevStates)) {
			this._onDidChange.fire();
		}
	}

	// --- SignalWatcher: ~/.claude/.csm-signals/ 監視 ---

	private startSignalWatcher(): void {
		const signalsDir = path.join(os.homedir(), '.claude', '.csm-signals');

		// ディレクトリがなければ作成
		fs.promises.mkdir(signalsDir, { recursive: true }).then(() => {
			// 起動時に既存シグナルファイルを処理
			this.processSignals(signalsDir);

			// fs.watch で監視
			try {
				this.signalWatcher = fs.watch(signalsDir, () => this.scheduleSignalProcessing(signalsDir));
			} catch {
				// 監視開始失敗はスキップ
			}
		}).catch(() => {
			// ディレクトリ作成失敗はスキップ
		});
	}

	// デバウンス付きシグナル処理スケジュール（200ms）
	private scheduleSignalProcessing(signalsDir: string): void {
		if (this.signalDebounceTimer) {
			clearTimeout(this.signalDebounceTimer);
		}
		this.signalDebounceTimer = setTimeout(() => {
			this.signalDebounceTimer = undefined;
			this.processSignals(signalsDir);
		}, 200);
	}

	// シグナルファイルを読み取り・処理・削除
	private async processSignals(signalsDir: string): Promise<void> {
		try {
			const files = await fs.promises.readdir(signalsDir);
			const jsonFiles = files.filter(f => f.endsWith('.json'));
			if (jsonFiles.length === 0) { return; }

			let changed = false;

			for (const file of jsonFiles) {
				const filePath = path.join(signalsDir, file);
				try {
					const raw = await fs.promises.readFile(filePath, 'utf-8');
					const signal: SignalData = JSON.parse(raw);

					if (signal.sessionId) {
						if (signal.type === 'start') {
							this.signalLiveSessions.set(signal.sessionId, true);
							changed = true;
						} else if (signal.type === 'stop') {
							this.signalLiveSessions.set(signal.sessionId, false);
							changed = true;
						}
					}

					// 処理済みシグナルファイルを削除
					await fs.promises.unlink(filePath);
				} catch {
					// 個別ファイルの読み取り/削除エラーは無視
				}
			}

			if (changed) {
				// シグナルベースの変更をライブセッションに反映し、ツリー更新
				this.applySignalState();
				this._onDidChange.fire();
			}
		} catch {
			// readdir失敗は無視
		}
	}

	// シグナルベースのライブ状態をメイン状態に反映
	private applySignalState(): void {
		for (const [sessionId, isLive] of this.signalLiveSessions) {
			if (isLive) {
				// PIDベースで既に確認済みでなければシグナルを信頼
				if (!this.liveSessionIds.has(sessionId)) {
					this.liveSessionIds.add(sessionId);
				}
			} else {
				this.liveSessionIds.delete(sessionId);
				this.signalLiveSessions.delete(sessionId); // 処理済みstopシグナルを除去
			}
		}
		// startシグナルもPIDベースで確認済みなら除去（重複防止）
		for (const [sessionId] of this.signalLiveSessions) {
			if (this.liveSessionIds.has(sessionId)) {
				this.signalLiveSessions.delete(sessionId);
			}
		}
	}

	// 前回の状態と比較して変更があるか判定
	private hasChanged(prev: Map<string, AgentWatcherState>): boolean {
		if (prev.size !== this.states.size) { return true; }
		for (const [name, state] of this.states) {
			const p = prev.get(name);
			if (!p) { return true; }
			if (p.isLive !== state.isLive) { return true; }
			if (p.sessionId !== state.sessionId) { return true; }
			// activeSubagentIds の変更も検出
			if (p.activeSubagentIds.length !== state.activeSubagentIds.length) { return true; }
			if (p.activeSubagentIds.some((id, i) => id !== state.activeSubagentIds[i])) { return true; }
		}
		return false;
	}

	// --- 外部API ---

	// セッションIDでライブ判定
	isLive(sessionId: string): boolean {
		return this.liveSessionIds.has(sessionId);
	}

	// エージェント名でライブ判定
	isLiveByName(name: string): boolean {
		return this.states.get(name)?.isLive ?? false;
	}

	// 稼働中のエージェント名一覧を取得
	getActiveAgentNames(): Set<string> {
		const names = new Set<string>();
		for (const [name, state] of this.states) {
			if (state.isLive) { names.add(name); }
		}
		return names;
	}

	// ライブセッションIDセットを取得（sessionTreeProvider連携用）
	getLiveSessionIds(): Set<string> {
		return new Set(this.liveSessionIds);
	}

	// 全エージェントの状態マップを取得（コピーを返す）
	getStates(): Map<string, AgentWatcherState> {
		return new Map(this.states);
	}

	// セッションIDの最終更新時刻を取得（TaskTracker の stalled 判定用）
	getSessionMtime(sessionId: string): number | undefined {
		return this.sessionMtimes.get(sessionId);
	}

	// 監視が有効かどうか
	isEnabled(): boolean {
		return this.enabled;
	}

	// リソース解放
	dispose(): void {
		this.stop();
		this._onDidChange.dispose();
	}
}
