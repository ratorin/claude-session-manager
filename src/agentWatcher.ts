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

export class AgentWatcher implements vscode.Disposable {
	// 状態変更イベント（ツリーリフレッシュ等に利用）
	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	// ウォッチャー（setIntervalは廃止）
	private watcher: fs.FSWatcher | undefined;
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;

	// 状態
	private liveSessionIds = new Set<string>();
	private states = new Map<string, AgentWatcherState>();
	private sessionMtimes = new Map<string, number>(); // セッションIDごとのJSONL mtime
	private sessionCwdMap = new Map<string, string>(); // セッションID → cwd（JSONL特定用）
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
	}

	// デバウンス付き更新スケジュール（300ms）
	private scheduleUpdate(): void {
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
		if (this.watcher) {
			this.watcher.close();
			this.watcher = undefined;
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
