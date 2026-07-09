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
import * as agentFileManager from '../agents/agentFileManager';
import { detectSubagents } from '../utils/subagentDetector';
import { MODEL_CATALOG, CSM_MODELS } from '../models/modelCatalog';

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

	// 自動紐づけ済みセッションID（二重処理防止）
	private processedAutoLinkSids = new Set<string>();

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
		// v0.5.14 レビュー修正 (8): modelCatalog（単一真実源）から生成。
		//   旧: ハードコード（新モデル追加時に prefixMap も更新する必要があった）
		//   新: MODEL_CATALOG に追記するだけで自動で反映される
		const prefixMap: Record<string, string> = Object.fromEntries(
			CSM_MODELS.map(m => [m, MODEL_CATALOG[m].idPrefix])
		);
		const prefix = prefixMap[cfg];
		if (prefix) {
			// 短縮名「opus」→「claude-opus-」で始まるなら一致
			if (act.startsWith(prefix)) { return true; }
		}

		// 逆方向: actualModelが短縮名を含む（例: claude-opus-4-7 → "opus" を含む）
		// ただし '-1m' 付き cfg は素の包含判定だと取りこぼすので除外
		if (!cfg.endsWith('-1m') && act.includes(cfg)) { return true; }

		// 1Mコンテキスト: <model>-1m ↔ claude-<model>-*[1m]
		// v0.5.14: fable-1m 追加
		if (cfg === 'fable-1m' && act.includes('fable') && act.includes('[1m]')) { return true; }
		if (cfg === 'sonnet-1m' && act.includes('sonnet') && act.includes('[1m]')) { return true; }
		if (cfg === 'opus-1m' && act.includes('opus') && act.includes('[1m]')) { return true; }

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

		// 新規ライブセッションの agent-setting 自動紐づけ（未処理分のみ）
		{
			const autoLinkTargets: { sid: string; cwd: string }[] = [];
			for (const [sid, cwd] of newSessionCwdMap) {
				if (!this.processedAutoLinkSids.has(sid)) {
					autoLinkTargets.push({ sid, cwd });
				}
			}
			if (autoLinkTargets.length > 0) {
				await Promise.allSettled(
					autoLinkTargets.map(({ sid, cwd }) => this.tryAutoLinkSession(sid, cwd))
				);
			}
		}

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

	// ライブセッションのセッションID→cwd マップを取得（agentLiveTreeProvider 連携用）
	getLiveSessionCwdMap(): Map<string, string> {
		return new Map(this.sessionCwdMap);
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

	// --- TASK-5 Phase 3: claude agents 由来データで PID チェックを補完 ---

	/**
	 * claude agents 出力の running セッションを PID ライブセットに補完する。
	 * extension.ts から claudeAgentsService.onDidChange 時に呼ばれる。
	 * フォールバック: 既存 PID チェックに干渉しない（追加のみ）
	 */
	supplementLiveFromClaudeAgents(runningSessions: ReadonlySet<string>): void {
		let changed = false;
		for (const sid of runningSessions) {
			if (!this.liveSessionIds.has(sid)) {
				this.liveSessionIds.add(sid);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChange.fire();
		}
	}

	// --- 自動紐づけ (agent-setting JSONL 先頭行解析) ---

	/** JSONL ファイルの先頭行を効率よく読み取る（最大 1 KB） */
	private async readFirstLine(filePath: string): Promise<string | undefined> {
		try {
			const handle = await fs.promises.open(filePath, 'r');
			try {
				const buf = Buffer.alloc(1024);
				const { bytesRead } = await handle.read(buf, 0, 1024, 0);
				const text = buf.slice(0, bytesRead).toString('utf-8');
				const newlineIdx = text.indexOf('\n');
				return newlineIdx >= 0 ? text.slice(0, newlineIdx).trim() : text.trim();
			} finally {
				await handle.close();
			}
		} catch { return undefined; }
	}

	/**
	 * TASK-4: JSONL の先頭数行から attributes フィールド内の agent_id を読み取る。
	 * OTEL/ヘッダー由来の x-claude-code-agent-id を検索する。
	 * 最大 4 KB を読んで先頭 10 行を確認する。
	 */
	private async readAgentIdFromAttributes(filePath: string): Promise<string | undefined> {
		try {
			const handle = await fs.promises.open(filePath, 'r');
			try {
				const buf = Buffer.alloc(4096);
				const { bytesRead } = await handle.read(buf, 0, 4096, 0);
				const text = buf.slice(0, bytesRead).toString('utf-8');
				const lines = text.split('\n').slice(0, 10); // 先頭10行のみ確認
				for (const line of lines) {
					const s = line.trim();
					if (!s) { continue; }
					try {
						const obj = JSON.parse(s) as Record<string, unknown>;
						// attributes フィールドから agent_id を探す
						const attrs = obj['attributes'] as Record<string, unknown> | undefined;
						if (attrs && typeof attrs === 'object') {
							const agentId =
								attrs['x-claude-code-agent-id'] ??
								attrs['agent_id'] ??
								attrs['agentId'] ??
								attrs['agent.name'];
							if (typeof agentId === 'string' && agentId) {
								return agentId;
							}
						}
						// systemPrompt / metadata からも探す
						const meta = obj['metadata'] as Record<string, unknown> | undefined;
						if (meta && typeof meta === 'object') {
							const agentId = meta['agentId'] ?? meta['agent_id'];
							if (typeof agentId === 'string' && agentId) { return agentId; }
						}
					} catch { continue; }
				}
			} finally {
				await handle.close();
			}
		} catch { /* ファイル読み取り失敗は無視 */ }
		return undefined;
	}

	/**
	 * 単一セッションの JSONL を確認して agent-setting があれば自動紐づけを試みる。
	 * TASK-4: agent-setting が見つからない場合は attributes フィールドから agent_id を探す。
	 * processedAutoLinkSids に追加して二重処理を防ぐ。
	 */
	private async tryAutoLinkSession(sessionId: string, cwd: string): Promise<void> {
		// 先に処理済みとしてマーク（並列呼び出し時の二重処理を防ぐ）
		this.processedAutoLinkSids.add(sessionId);

		const jsonlPath = this.getJsonlPath(sessionId, cwd);
		if (!jsonlPath) { return; }

		try {
			const firstLine = await this.readFirstLine(jsonlPath);
			if (!firstLine) { return; }

			let parsed: Record<string, unknown>;
			try { parsed = JSON.parse(firstLine); } catch { return; }

			// --- 方法1: agent-setting タイプ（既存）---
			if (parsed['type'] === 'agent-setting') {
				const agentName = typeof parsed['agentSetting'] === 'string' ? parsed['agentSetting'] : undefined;
				const sid = typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : undefined;
				if (agentName && sid) {
					const agentDef = await agentFileManager.getAgentByName(agentName);
					if (!agentDef) { return; }
					const linked = await dataStore.setAgentSession(agentName, sid);
					if (linked) { this._onDidChange.fire(); }
					return;
				}
			}

			// --- 方法2: TASK-4 — attributes フィールドから agent_id を読み取り ---
			const agentIdFromAttrs = await this.readAgentIdFromAttributes(jsonlPath);
			if (agentIdFromAttrs) {
				const agentDef = await agentFileManager.getAgentByName(agentIdFromAttrs);
				if (!agentDef) { return; }
				const linked = await dataStore.setAgentSession(agentIdFromAttrs, sessionId);
				if (linked) { this._onDidChange.fire(); }
			}
		} catch { /* ファイル読み取り失敗はサイレントに無視 */ }
	}

	/**
	 * 起動時スキャン: ~/.claude/projects/ 配下の全 JSONL を走査し、
	 * sessionId が未設定のエージェントを一括自動紐づけする。
	 * 最新の JSONL（mtime 降順）を優先して採用する。
	 */
	public async scanProjectsForAutoLink(): Promise<void> {
		const projectsDir = path.join(os.homedir(), '.claude', 'projects');

		// 未紐づけエージェントのみ対象（高速化）
		const agents = await dataStore.getAgents();
		const unlinkedNames = new Set(
			agents
				.filter(a => !a.sessionId || a.sessionId === '' || a.sessionId === 'unlinked')
				.map(a => a.name)
		);
		if (unlinkedNames.size === 0) { return; }

		// agentName → [{sessionId, mtime}] の候補マップ
		const candidates = new Map<string, { sessionId: string; mtime: number }[]>();

		try {
			const projectDirs = await fs.promises.readdir(projectsDir);
			await Promise.allSettled(projectDirs.map(async (dir) => {
				const dirPath = path.join(projectsDir, dir);
				try {
					const files = await fs.promises.readdir(dirPath);
					await Promise.allSettled(
						files
							.filter(f => f.endsWith('.jsonl'))
							.map(async (file) => {
								const sid = file.slice(0, -6); // ".jsonl" を除去
								if (this.processedAutoLinkSids.has(sid)) { return; }

								const filePath = path.join(dirPath, file);
								try {
									const [firstLine, stat] = await Promise.all([
										this.readFirstLine(filePath),
										fs.promises.stat(filePath),
									]);
									if (!firstLine) { return; }

									let parsed: Record<string, unknown>;
									try { parsed = JSON.parse(firstLine); } catch { return; }

									// 方法1: agent-setting タイプ（既存）
								let agentName: string | undefined;
								if (parsed['type'] === 'agent-setting') {
									agentName = typeof parsed['agentSetting'] === 'string'
										? parsed['agentSetting']
										: undefined;
								}

								// TASK-4: 方法2 — attributes フィールドから agent_id を探す
								if (!agentName) {
									const attrs = parsed['attributes'] as Record<string, unknown> | undefined;
									if (attrs && typeof attrs === 'object') {
										const attrAgentId =
											attrs['x-claude-code-agent-id'] ??
											attrs['agent_id'] ??
											attrs['agentId'] ??
											attrs['agent.name'];
										if (typeof attrAgentId === 'string' && attrAgentId) {
											agentName = attrAgentId;
										}
									}
								}

								if (!agentName || !unlinkedNames.has(agentName)) { return; }

								if (!candidates.has(agentName)) { candidates.set(agentName, []); }
								candidates.get(agentName)!.push({ sessionId: sid, mtime: stat.mtimeMs });
								} catch { /* skip */ }
							})
					);
				} catch { /* プロジェクトディレクトリ読み取り失敗は無視 */ }
			}));
		} catch { return; /* projects ディレクトリが存在しない等 */ }

		if (candidates.size === 0) { return; }

		// 各エージェントについて最新セッション（mtime 降順）を採用して紐づけ
		let anyLinked = false;
		await Promise.allSettled(
			[...candidates.entries()].map(async ([agentName, entries]) => {
				// mtime 降順でソート → 最新を採用
				entries.sort((a, b) => b.mtime - a.mtime);
				const best = entries[0];

				// agents/*.md 存在確認
				const agentDef = await agentFileManager.getAgentByName(agentName);
				if (!agentDef) { return; }

				const linked = await dataStore.setAgentSession(agentName, best.sessionId);
				if (linked) {
					this.processedAutoLinkSids.add(best.sessionId);
					anyLinked = true;
				}
			})
		);

		if (anyLinked) {
			this._onDidChange.fire();
		}
	}

	// リソース解放
	dispose(): void {
		this.stop();
		this._onDidChange.dispose();
	}
}
