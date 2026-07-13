// liveAgentTypes.ts — ライブエージェント表示用の共通型 + フォーマッタ
// v0.5.22 で claudeAgentsService.ts から切り出し（同ファイルは撤去）。
//
// CC ランタイム CLI（`claude agents --json`）は VS Code 拡張ホストから TTY 無しで
// 呼び出せないため、v0.5.22 以降は agentWatcher（PID + sessions/*.json 監視）が
// 唯一のライブデータソース。本ファイルは表示層（agentLiveTreeProvider /
// orchestrationTreeProvider）が共有する型と 1 関数のみを保持する。

/**
 * ライブ状態のエージェント／セッション 1 件分の情報。
 *
 * v0.5.21 まで claude agents --json 由来のフィールドも含んでいたが、
 * v0.5.22 で agentWatcher の sessions/*.json + JSONL 解析のみが供給元となった。
 * `source` フィールドは将来別供給源が復活したときの識別用に残置。
 */
export interface ClaudeAgentEntry {
	/** CC のセッション ID（UUID） */
	sessionId?: string;
	/** CSM 登録エージェント名（照合後に設定） */
	agentName?: string;
	/** ステータス */
	status: 'running' | 'blocked' | 'done' | 'unknown';
	/** 作業ディレクトリ */
	cwd: string;
	/** 経過秒数 */
	elapsedSec?: number;
	/** プロセス ID */
	pid?: number;
	/** セッションの種別（CC 公式 `kind` フィールド: 'interactive' | 'background' 等） */
	kind?: string;
	/** セッション開始時刻（Unix ms） */
	startedAt?: number;
	/** v0.5.22: CC 公式のセッション表示名（`name` フィールド） */
	sessionName?: string;
	/** v0.5.22: name の由来（'derived' 等） */
	nameSource?: string;
	/** 取得元識別子（将来別供給源が復活した場合のため残置） */
	source?: 'session-json' | 'json-api' | 'text-parse';
	/** テキストパース時のデバッグ用（将来復活時のため型のみ残置） */
	rawLine?: string;
}

/** ライブ表示用モデル（CSM AgentInfo とのジョイン結果） */
export interface LiveAgentView {
	entry: ClaudeAgentEntry;
	/** CSM 登録エージェント名（マッチした場合） */
	linkedAgentName?: string;
	/** CSM 登録エージェントの表示名 */
	linkedDisplayName?: string;
	/** マッチの確度 */
	matchLevel: 'session-id' | 'cwd' | 'none';
}

/** 秒数を "HH:MM:SS" 形式に変換 */
export function formatElapsed(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * v0.5.22 レビュー修正 L3: sessions/*.json（`~/.claude/sessions/<pid>.json`）から
 *   agentWatcher が収集するリッチメタの共通型。従来 agentWatcher.ts に 3 か所複製されていた
 *   匿名 shape を一本化する。types.ts の SessionMeta（旧・死に型）もこの構造に一致させる。
 *
 * 例（CC 2.1.207 実物）:
 *   { pid, sessionId, cwd, startedAt, version:"2.1.207", peerProtocol:1,
 *     kind:"interactive", entrypoint:"claude-vscode", name:"xampp-07", nameSource:"derived" }
 */
export interface SessionJsonMeta {
	kind?: string;
	entrypoint?: string;
	version?: string;
	name?: string;
	nameSource?: string;
	agent?: string;
	pid?: number;
	/** v0.5.22 レビュー修正 M2: セッション開始時刻（Unix ms）。orchestration の経過秒計算に使用。 */
	startedAt?: number;
}
