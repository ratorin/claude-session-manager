// 統合監視エンジン
// PIDベースのライブセッション検出 + サブエージェント検出を一本化
// EventEmitter方式で変更を通知する
// v0.4.0: 検知モード簡素化（fswatch + jsonlMtime の2方式のみ）
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentWatcherState } from '../models/types';
import * as dataStore from '../models/dataStore';
import { detectSubagents } from '../utils/subagentDetector';

// 検知モードの型定義（Phase 4: fswatch のみ残す）
type DetectionMode = 'fswatch';

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

	// ウォッチャー
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

	// 検知モード
	private detectionMode: DetectionMode = 'fswatch';

	// レイテンシ計測（直近5回の計測値をリングバッファで保持）
	private latencyBuffer: number[] = [];
	private readonly LATENCY_BUFFER_SIZE = 5;
	private latencyPendingStart: number | undefined; // 変更検知開始時刻

	// 監視を開始する
	// enableAgentMonitor が false の場合は何もしない（完全停止）
	start(): void {
		const config = vscode.workspace.getConfiguration('claudeManager');
		this.enabled = config.get<boolean>('enableAgentMonitor', false);
		this.detectionMode = 'fswatch'; // Phase 4: fswatch固定

		// 既存ウォッチャーをクリア
		this.stop();

		if (!this.enabled) { return; }

		// 初回即更新（非同期）
		this.scheduleUpdate();

		// fswatchモード: sessions/ ディレクトリの fs.watch（デバウンス300ms）
		const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
		try {
			this.watcher = fs.watch(sessionsDir, () => {
				this.recordLatencyStart();
				this.scheduleUpdate();
			});
		} catch {
			// ディレクトリが存在しない場合はスキップ
		}
		// .csm-signals/ ディレクトリの監視（補助）
		this.startSignalWatcher(false);
	}

	// レイテンシ計測: 変更検知開始時刻を記録
	private recordLatencyStart(): void {
		// まだ保留中の計測がなければ新しく開始
		if (this.latencyPendingStart === undefined) {
			this.latencyPendingStart = Date.now();
		}
	}

	// レイテンシ計測: onDidChange発火時に終了時刻を記録して計算
	private recordLatencyEnd(): void {
		if (this.latencyPendingStart !== undefined) {
			const latency = Date.now() - this.latencyPendingStart;
			this.latencyPendingStart = undefined;
			// リングバッファに追加
			this.latencyBuffer.push(latency);
			if (this.latencyBuffer.length > this.LATENCY_BUFFER_SIZE) {
				this.latencyBuffer.shift();
			}
		}
	}

	// 平均レイテンシを取得（ms）、計測データなしの場合は undefined
	getAverageLatency(): number | undefined {
		if (this.latencyBuffer.length === 0) { return undefined; }
		const sum = this.latencyBuffer.reduce((a, b) => a + b, 0);
		return Math.round(sum / this.latencyBuffer.length);
	}

	// 現在の検知モードを取得
	getDetectionMode(): DetectionMode {
		return this.detectionMode;
	}

	// ステータスバー表示用テキストを取得（例: "fswatch 245ms"）
	getStatusBarModeText(): string {
		const avg = this.getAverageLatency();
		if (avg !== undefined) {
			return `${this.detectionMode} ${avg}ms`;
		}
		return this.detectionMode;
	}

	// デバウンス付き更新スケジュール（300ms固定）
	public scheduleUpdate(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		const delay = 300;
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = undefined;
			this.updateAsync();
		}, delay);
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
	// 例: C:\My Project → c--my-project
	// v0.4.6: ドライブレター小文字化・空白→'-' を追加して Claude Code の実装と対称化
	private getJsonlPath(sessionId: string, cwd: string): string | null {
		if (!cwd || !sessionId) { return null; }
		// cwdをClaude Code形式のフォルダ名にエンコード（lowercase + 空白も変換）
		const encoded = cwd
			.toLowerCase()
			.replace(/\\/g, '/')
			.replace(/^([a-z]):/, '$1-')
			.replace(/[\s/]/g, '-');
		return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
	}

	// JSONL末尾から実際のモデル名を読み取る（末尾32KBのみ）
	private async readActualModel(jsonlPath: string): Promise<string | undefined> {
		const TAIL_BYTES = 32768;
		try {
			const stat = await fs.promises.stat(jsonlPath);
			const size = stat.size;
			if (size === 0) { return undefined; }
			const handle = await fs.promises.open(jsonlPath, 'r');
			try {
				const tailSize = Math.min(TAIL_BYTES, size);
				const buf = Buffer.alloc(tailSize);
				await handle.read(buf, 0, tailSize, size - tailSize);
				const lines = buf.toString('utf-8').split('\n').reverse();
				for (const line of lines) {
					const s = line.trim();
					if (!s) { continue; }
					try {
						const obj = JSON.parse(s);
						if (obj.type === 'assistant' && obj.message?.model) {
							return String(obj.message.model);
						}
					} catch { /* skip */ }
				}
			} finally {
				await handle.close();
			}
		} catch { /* ファイル読み取り失敗 */ }
		return undefined;
	}

	// 設定モデル（短縮名）と実モデル（正式ID）が一致するか判定（外部公開用）
	modelsMatchPublic(configModel: string, actualModel: string): boolean {
		return this.modelsMatch(configModel, actualModel);
	}

	private modelsMatch(configModel: string, actualModel: string): boolean {
		// 正規化: どちらも小文字に
		const cfg = configModel.toLowerCase();
		const act = actualModel.toLowerCase();
		if (cfg === act) { return true; }

		// 短縮名 → 正式IDプレフィックスのマッピング（バージョン番号は問わない）
		const prefixMap: Record<string, string> = {
			'opus':     'claude-opus-',
			'sonnet':   'claude-sonnet-',
			'haiku':    'claude-haiku-',
			'sonnet-1m': 'claude-sonnet-',
		};
		const prefix = prefixMap[cfg];
		if (prefix) {
			// 短縮名「opus」→「claude-opus-」で始まるなら一致
			if (act.startsWith(prefix)) { return true; }
		}

		// 逆方向: actualModelが短縮名を含む（例: claude-opus-4-7 → "opus" を含む）
		if (act.includes(cfg)) { return true; }

		// 1Mコンテキスト: sonnet-1m ↔ claude-sonnet-*[1m]
		if (cfg === 'sonnet-1m' && act.includes('sonnet') && act.includes('[1m]')) { return true; }

		return false;
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

			// サブエージェント検出＋実モデル読み取り: セッションIDがある場合
			let activeSubagentIds: string[] = [];
			let actualModel: string | undefined;
			if (agent.sessionId) {
				const cwd = this.sessionCwdMap.get(agent.sessionId);
				if (cwd) {
					const jsonlPath = this.getJsonlPath(agent.sessionId, cwd);
					if (jsonlPath) {
						if (isLive) {
							try {
								const subagents = await detectSubagents(jsonlPath);
								activeSubagentIds = subagents.map(s => s.toolUseId);
							} catch { /* 検出失敗は無視 */ }
						}
						// 実モデルをJSONL末尾から読み取る（ライブ問わず）
						try {
							actualModel = await this.readActualModel(jsonlPath);
						} catch { /* 読み取り失敗は無視 */ }
					}
				}
			}

			// モデル不一致チェック: 設定モデルと実モデルを比較
			const modelMismatch = actualModel !== undefined && agent.model
				? !this.modelsMatch(agent.model, actualModel)
				: false;

			this.states.set(agent.name, {
				agentName: agent.name,
				sessionId: agent.sessionId,
				isLive,
				activeSubagentIds,
				actualModel,
				modelMismatch,
			});
		}));

		// 3. 変更があればイベント発火 + レイテンシ終了記録
		if (this.hasChanged(prevStates)) {
			this.recordLatencyEnd();
			this._onDidChange.fire();
		}
	}

	// --- SignalWatcher: ~/.claude/.csm-signals/ 監視 ---

	// isPrimary: falseのみ使用（fswatchモード補助、デバウンス200ms）
	private startSignalWatcher(isPrimary: boolean): void {
		const signalsDir = path.join(os.homedir(), '.claude', '.csm-signals');

		// ディレクトリがなければ作成
		fs.promises.mkdir(signalsDir, { recursive: true }).then(() => {
			// 起動時に既存シグナルファイルを処理
			this.processSignals(signalsDir, isPrimary);

			// fs.watch で監視
			try {
				this.signalWatcher = fs.watch(signalsDir, () => {
					this.recordLatencyStart();
					this.scheduleSignalProcessing(signalsDir, isPrimary);
				});
			} catch {
				// 監視開始失敗はスキップ
			}
		}).catch(() => {
			// ディレクトリ作成失敗はスキップ
		});
	}

	// デバウンス付きシグナル処理スケジュール
	private scheduleSignalProcessing(signalsDir: string, isPrimary: boolean): void {
		if (this.signalDebounceTimer) {
			clearTimeout(this.signalDebounceTimer);
		}
		// 補助時: 200ms
		const delay = isPrimary ? 100 : 200;
		this.signalDebounceTimer = setTimeout(() => {
			this.signalDebounceTimer = undefined;
			this.processSignals(signalsDir, isPrimary);
		}, delay);
	}

	// シグナルファイルを読み取り・処理・削除
	private async processSignals(signalsDir: string, isPrimary: boolean): Promise<void> {
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
				// シグナルベースの変更を反映 → 全体再スキャンでstatesも再構築
				this.scheduleUpdate();
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

	// 稼働中のエージェント名一覧を取得（dataStore登録エージェント名）
	getActiveAgentNames(): Set<string> {
		const names = new Set<string>();
		for (const [name, state] of this.states) {
			if (state.isLive) { names.add(name); }
		}
		return names;
	}

	// 稼働中セッションの表示名一覧を取得
	// dataStore登録エージェント名 → cwd末尾フォルダ名 → セッションID先頭8文字 の順でフォールバック
	getActiveSessionDisplayNames(): string[] {
		// dataStore登録エージェントの sessionId → name マップ
		const sessionIdToName = new Map<string, string>();
		for (const [name, state] of this.states) {
			if (state.isLive && state.sessionId) {
				sessionIdToName.set(state.sessionId, name);
			}
		}

		const displayNames: string[] = [];
		for (const sessionId of this.liveSessionIds) {
			if (sessionIdToName.has(sessionId)) {
				// dataStore登録エージェント名を優先
				displayNames.push(sessionIdToName.get(sessionId)!);
			} else {
				// cwd末尾フォルダ名でフォールバック
				const cwd = this.sessionCwdMap.get(sessionId);
				if (cwd) {
					// パス区切り（/ または \）で分割して末尾要素を取得
					const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
					const folderName = parts[parts.length - 1] || sessionId.substring(0, 8);
					displayNames.push(folderName);
				} else {
					// セッションID先頭8文字
					displayNames.push(sessionId.substring(0, 8));
				}
			}
		}
		return displayNames;
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

	// セッションID→表示名のマッピングを返す
	getSessionIdToNameMap(): Record<string, string> {
		const map: Record<string, string> = {};
		for (const [name, state] of this.states) {
			if (state.sessionId) {
				map[state.sessionId] = name;
			}
		}
		// dataStore登録外のセッションはcwdの末尾フォルダ名でフォールバック
		for (const [sessionId, cwd] of this.sessionCwdMap) {
			if (!map[sessionId]) {
				const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
				map[sessionId] = parts[parts.length - 1] || sessionId.substring(0, 8);
			}
		}
		return map;
	}

	// リソース解放
	dispose(): void {
		this.stop();
		this._onDidChange.dispose();
	}
}
