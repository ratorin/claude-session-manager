/**
 * claudeAgentsService.ts — v0.5.0 TASK-5
 * `claude agents` コマンドを呼び出してライブエージェント状態を取得するサービス。
 *
 * 設計方針:
 *   - `claude agents [--cwd <path>]` をテキスト出力でパース（--json は存在しない）
 *   - タブ可視時のみポーリング（デフォルト 5 秒）
 *   - 非対応環境は可用性フラグを false にしてセクション非表示
 *   - 連続失敗時にバックオフ（5s → 30s → 5min）
 *
 * 設定キー:
 *   claudeManager.claudeAgentsIntegration.enabled          (boolean, default: true)
 *   claudeManager.claudeAgentsIntegration.pollingIntervalMs (number,  default: 5000)
 *   claudeManager.claudeAgentsIntegration.scopeToWorkspace  (boolean, default: true)
 *   claudeManager.claudeAgentsIntegration.showUnregistered  (boolean, default: true)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFilep = promisify(execFile);

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export interface ClaudeAgentEntry {
	/** claude agents 出力から得られる識別子（session ID 等。取得できれば）*/
	sessionId?: string;
	/** エージェント名（出力から得られれば） */
	agentName?: string;
	/** ステータス */
	status: 'running' | 'blocked' | 'done' | 'unknown';
	/** 作業ディレクトリ */
	cwd: string;
	/** 経過秒数（パースできれば） */
	elapsedSec?: number;
	/** 元のテキスト行（デバッグ・将来のフォーマット変化対策） */
	rawLine: string;
}

/** ライブ表示用モデル（CSM AgentInfo とのジョイン結果） */
export interface LiveAgentView {
	/** ClaudeAgentEntry 由来 */
	entry: ClaudeAgentEntry;
	/** CSM 登録エージェント名（マッチした場合） */
	linkedAgentName?: string;
	/** CSM 登録エージェントの表示名 */
	linkedDisplayName?: string;
	/** マッチの確度 */
	matchLevel: 'session-id' | 'cwd' | 'none';
}

/** 可用性状態 */
export type AvailabilityStatus =
	| 'unknown'    // まだ確認していない
	| 'available'  // 正常に動作している
	| 'unavailable' // 環境非対応（エラーメッセージあり）
	| 'disabled';  // ユーザー設定で無効化

// -------------------------------------------------------------------
// エラークラス
// -------------------------------------------------------------------

export class ClaudeAgentsUnavailableError extends Error {
	constructor(msg = 'claude agents is not available in this environment') {
		super(msg);
		this.name = 'ClaudeAgentsUnavailableError';
	}
}

// -------------------------------------------------------------------
// パーサー
// -------------------------------------------------------------------

/**
 * `claude agents` のテキスト出力をパースして ClaudeAgentEntry[] に変換する。
 *
 * 出力例（実機確認前のベスト推定フォーマット）:
 *   ● director   [running]  /home/user/projects/foo   00:12:34
 *   ◔ planner    [blocked]  /home/user/projects/bar   00:00:45
 *   ◯ qa         [done]     /home/user/projects/baz   01:30:12
 *
 * または表形式:
 *   ID              STATUS    CWD                        ELAPSED
 *   abc123          running   /home/user/projects/foo    00:12:34
 *
 * どちらも行単位で柔軟にパースし、パース失敗行は rawLine として保存する。
 */
export function parseClaudeAgentsOutput(raw: string): ClaudeAgentEntry[] {
	const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	const entries: ClaudeAgentEntry[] = [];

	for (const line of lines) {
		// ヘッダ行はスキップ（'ID', 'STATUS', 'NAME' などを含む行）
		if (/^\s*(ID|STATUS|NAME|CWD|ELAPSED|Agent|Session)\s/i.test(line)) { continue; }
		// 区切り線スキップ
		if (/^[-=─]+$/.test(line)) { continue; }

		const entry = parseLine(line);
		if (entry) {
			entries.push(entry);
		}
	}

	return entries;
}

/** 1行をパースして ClaudeAgentEntry | undefined を返す */
function parseLine(line: string): ClaudeAgentEntry | undefined {
	// --- フォーマット A: 絵文字アイコン + 名前 + [status] + cwd + elapsed ---
	// 例: ● director [running] /home/user/projects/foo 00:12:34
	const iconPattern = /^[●◔◯✗▶•\-*]\s+(\S+)\s+\[(\w+)\]\s+(\S+)(?:\s+(\d{1,3}:\d{2}:\d{2}))?/;
	const iconMatch = line.match(iconPattern);
	if (iconMatch) {
		return {
			agentName: iconMatch[1],
			status: normalizeStatus(iconMatch[2]),
			cwd: iconMatch[3],
			elapsedSec: iconMatch[4] ? parseElapsed(iconMatch[4]) : undefined,
			rawLine: line,
		};
	}

	// --- フォーマット B: ID STATUS CWD ELAPSED (表形式) ---
	// 例: abc12345  running  /home/user/projects/foo  00:12:34
	const tablePattern = /^([a-f0-9]{8,})\s+(\w+)\s+(\S+)(?:\s+(\d{1,3}:\d{2}:\d{2}))?/;
	const tableMatch = line.match(tablePattern);
	if (tableMatch) {
		return {
			sessionId: tableMatch[1],
			status: normalizeStatus(tableMatch[2]),
			cwd: tableMatch[3],
			elapsedSec: tableMatch[4] ? parseElapsed(tableMatch[4]) : undefined,
			rawLine: line,
		};
	}

	// --- フォーマット C: status + cwd のみ（簡素形式） ---
	// 例: running  /home/user/projects/foo
	const simplePattern = /^(running|blocked|done|idle|error)\s+(\S+)/i;
	const simpleMatch = line.match(simplePattern);
	if (simpleMatch) {
		return {
			status: normalizeStatus(simpleMatch[1]),
			cwd: simpleMatch[2],
			rawLine: line,
		};
	}

	// --- フォーマット D: フリーテキスト（セッションIDらしきものを探す） ---
	// sessionId like UUID
	const uuidPattern = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;
	const uuidMatch = line.match(uuidPattern);
	const statusInLine = line.match(/\b(running|blocked|done|idle|error)\b/i);
	const cwdInLine = line.match(/(?:^|\s)(\/[^\s]+)/);

	if (statusInLine && cwdInLine) {
		return {
			sessionId: uuidMatch?.[1],
			status: normalizeStatus(statusInLine[1]),
			cwd: cwdInLine[1],
			rawLine: line,
		};
	}

	// パース不能行（ただし空でない行はデバッグ用に保持しない → undefined）
	return undefined;
}

/** ステータス文字列を正規化 */
function normalizeStatus(s: string): ClaudeAgentEntry['status'] {
	const lower = s.toLowerCase();
	if (lower === 'running' || lower === 'active') { return 'running'; }
	if (lower === 'blocked' || lower === 'waiting' || lower === 'idle') { return 'blocked'; }
	if (lower === 'done' || lower === 'completed' || lower === 'finished') { return 'done'; }
	return 'unknown';
}

/** "HH:MM:SS" → 秒数に変換 */
function parseElapsed(s: string): number {
	const parts = s.split(':').map(Number);
	if (parts.length === 3) {
		return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
	}
	if (parts.length === 2) {
		return (parts[0] * 60) + parts[1];
	}
	return 0;
}

/** 秒数を "HH:MM:SS" 形式に変換 */
export function formatElapsed(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// -------------------------------------------------------------------
// ClaudeAgentsService
// -------------------------------------------------------------------

export class ClaudeAgentsService implements vscode.Disposable {
	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	/** 最後に取得したエントリ一覧 */
	private _entries: ClaudeAgentEntry[] = [];
	/** 可用性状態 */
	private _availability: AvailabilityStatus = 'unknown';
	/** 連続失敗回数 */
	private _consecutiveFailures = 0;
	/** ポーリングタイマー */
	private _timer: ReturnType<typeof setTimeout> | undefined;
	/** タブが可視かどうか */
	private _tabVisible = false;
	/** 廃棄済みフラグ */
	private _disposed = false;

	// バックオフ間隔定義（ms）
	private static readonly BACKOFF_INTERVALS = [5000, 30000, 300000];

	constructor() {
		// 設定変更を監視
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('claudeManager.claudeAgentsIntegration')) {
				this._handleConfigChange();
			}
		});
	}

	// -------------------------------------------------------------------
	// パブリック API
	// -------------------------------------------------------------------

	/** 現在のエントリ一覧を取得 */
	getEntries(): ClaudeAgentEntry[] {
		return this._entries;
	}

	/** 可用性状態を取得 */
	getAvailability(): AvailabilityStatus {
		return this._availability;
	}

	/** タブ可視性を更新してポーリングを制御 */
	setTabVisible(visible: boolean): void {
		const wasVisible = this._tabVisible;
		this._tabVisible = visible;
		if (visible && !wasVisible) {
			// タブが表示されたら即時取得してポーリング開始
			this._schedulePoll(0);
		} else if (!visible && wasVisible) {
			// タブが非表示になったらポーリング停止
			this._stopTimer();
		}
	}

	/** 即時リフレッシュ（手動更新ボタン用） */
	async forceRefresh(): Promise<void> {
		await this._fetchAndUpdate();
		this._scheduleNextPoll();
	}

	/** 設定が有効かどうか */
	isEnabled(): boolean {
		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		return config.get<boolean>('enabled', true);
	}

	dispose(): void {
		this._disposed = true;
		this._stopTimer();
		this._onDidChange.dispose();
	}

	// -------------------------------------------------------------------
	// 内部処理
	// -------------------------------------------------------------------

	private _handleConfigChange(): void {
		if (this.isEnabled() && this._tabVisible) {
			this._schedulePoll(0);
		} else {
			this._stopTimer();
			if (!this.isEnabled()) {
				this._availability = 'disabled';
				this._entries = [];
				this._onDidChange.fire();
			}
		}
	}

	private _stopTimer(): void {
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _schedulePoll(delayMs: number): void {
		if (this._disposed) { return; }
		this._stopTimer();
		this._timer = setTimeout(() => {
			this._timer = undefined;
			this._fetchAndUpdate().then(() => {
				this._scheduleNextPoll();
			}).catch(() => {
				this._scheduleNextPoll();
			});
		}, delayMs);
	}

	private _scheduleNextPoll(): void {
		if (!this._tabVisible || !this.isEnabled() || this._disposed) { return; }
		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		const baseInterval = config.get<number>('pollingIntervalMs', 5000);
		// バックオフ計算
		const backoffIdx = Math.min(this._consecutiveFailures, ClaudeAgentsService.BACKOFF_INTERVALS.length - 1);
		const backoff = ClaudeAgentsService.BACKOFF_INTERVALS[backoffIdx];
		const interval = this._consecutiveFailures > 0 ? backoff : Math.max(1000, baseInterval);
		this._schedulePoll(interval);
	}

	/** 実際の取得＋更新ロジック */
	private async _fetchAndUpdate(): Promise<void> {
		if (!this.isEnabled()) {
			this._availability = 'disabled';
			return;
		}

		const config = vscode.workspace.getConfiguration('claudeManager.claudeAgentsIntegration');
		const scopeToWorkspace = config.get<boolean>('scopeToWorkspace', true);
		const cwd = scopeToWorkspace
			? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
			: undefined;

		try {
			const entries = await fetchClaudeAgents(cwd);
			this._entries = entries;
			this._availability = 'available';
			this._consecutiveFailures = 0;
			this._onDidChange.fire();
		} catch (err) {
			if (err instanceof ClaudeAgentsUnavailableError) {
				this._availability = 'unavailable';
				this._entries = [];
				this._consecutiveFailures = 0;
				this._onDidChange.fire();
				// 利用不可の場合はポーリング停止（環境変わらないので）
				this._stopTimer();
				return;
			}
			// その他エラー（タイムアウト等）
			this._consecutiveFailures++;
			this._onDidChange.fire();
		}
	}
}

// -------------------------------------------------------------------
// 低レベル取得関数（テスト容易性のため分離）
// -------------------------------------------------------------------

/**
 * `claude agents [--cwd <path>]` を実行して ClaudeAgentEntry[] を返す。
 * 非対応環境では ClaudeAgentsUnavailableError を throw する。
 */
export async function fetchClaudeAgents(cwd?: string): Promise<ClaudeAgentEntry[]> {
	const args = ['agents', ...(cwd ? ['--cwd', cwd] : [])];

	try {
		const { stdout, stderr } = await execFilep('claude', args, {
			timeout: 8000,
			maxBuffer: 1024 * 1024,
			// Windows では .cmd シムのため shell が必要
			...(process.platform === 'win32' ? { shell: true } : {}),
		});
		const combined = stdout + stderr;

		// 非対応環境の検出
		if (/not available in this environment/i.test(combined)) {
			throw new ClaudeAgentsUnavailableError(combined.trim());
		}

		// JSON 出力対応（将来バージョンで --json が追加された場合に自動採用）
		const trimmed = stdout.trim();
		if (trimmed.startsWith('[')) {
			try {
				const arr = JSON.parse(trimmed) as unknown[];
				return arr.map(item => jsonEntryToClaudeAgentEntry(item));
			} catch {
				// JSON パース失敗 → テキストパースにフォールバック
			}
		}

		return parseClaudeAgentsOutput(stdout);
	} catch (err: unknown) {
		if (err instanceof ClaudeAgentsUnavailableError) { throw err; }

		const nodeErr = err as NodeJS.ErrnoException;
		// コマンド不在
		if (nodeErr.code === 'ENOENT') {
			throw new ClaudeAgentsUnavailableError('claude command not found');
		}
		// タイムアウト
		if ((nodeErr as { killed?: boolean }).killed) {
			throw new Error('claude agents timed out');
		}
		// 出力に "not available" が含まれる場合
		const msg = String(nodeErr.message ?? '');
		if (/not available in this environment/i.test(msg)) {
			throw new ClaudeAgentsUnavailableError(msg);
		}

		throw err;
	}
}

/** JSON 形式エントリを ClaudeAgentEntry に変換（将来の --json 対応） */
function jsonEntryToClaudeAgentEntry(item: unknown): ClaudeAgentEntry {
	if (!item || typeof item !== 'object') {
		return { status: 'unknown', cwd: '', rawLine: JSON.stringify(item) };
	}
	const obj = item as Record<string, unknown>;
	return {
		sessionId: typeof obj['sessionId'] === 'string' ? obj['sessionId'] : undefined,
		agentName: typeof obj['name'] === 'string' ? obj['name']
			: typeof obj['agentName'] === 'string' ? obj['agentName'] : undefined,
		status: normalizeStatus(String(obj['status'] ?? 'unknown')),
		cwd: typeof obj['cwd'] === 'string' ? obj['cwd'] : '',
		elapsedSec: typeof obj['elapsedSec'] === 'number' ? obj['elapsedSec'] : undefined,
		rawLine: JSON.stringify(item),
	};
}

