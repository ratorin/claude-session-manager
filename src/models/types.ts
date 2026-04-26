// 会話メッセージの型定義
export interface SessionMessage {
	type: 'user' | 'assistant' | 'file-history-snapshot' | 'queue-operation';
	uuid: string;
	parentUuid: string | null;
	timestamp: string;
	sessionId: string;
	cwd?: string;
	message?: {
		role: 'user' | 'assistant';
		content: string | ContentBlock[];
		model?: string;
	};
	userType?: string;
	gitBranch?: string;
	version?: string;
}

export interface ContentBlock {
	type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
	text?: string;
	name?: string;
	input?: Record<string, unknown>;
}

// セッションメタデータ
export interface SessionMeta {
	pid: number;
	sessionId: string;
	cwd: string;
	startedAt: number;
	kind: string;
	entrypoint: string;
}

// 会話の解析済みデータ
export interface ParsedSession {
	id: string;
	filePath: string;
	project: string;
	firstMessage: string;
	lastTimestamp: Date;
	firstTimestamp: Date;
	fileSize: number;  // バイト単位のファイルサイズ
	model?: string;
	gitBranch?: string;
	claudeTitle?: string;  // Claude Codeの /rename で設定された名前
	customName?: string;   // Session Managerで設定した名前
	messages: SimpleMessage[];
	// サブエージェント関連
	isSidechain?: boolean;       // subagents/ 配下の子エージェントか
	agentId?: string;            // agent固有ID（agent-a{HASH}）
	agentType?: string;          // Explore, general-purpose, Plan, claude-code-guide
	agentDescription?: string;   // meta.jsonのdescription
	parentSessionId?: string;    // 親セッションのファイル名ベースID
}

export interface SimpleMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: Date;
	model?: string;
}

// メモリファイルの型
export interface MemoryFile {
	filePath: string;
	fileName: string;
	name: string;
	description: string;
	type: 'user' | 'feedback' | 'project' | 'reference';
	content: string;
	sizeBytes: number;
}

// エージェント設定
export interface AgentConfig {
	name: string;                // エージェント名（CLI用・英数字）
	displayName?: string;        // 日本語表示名（UI表示用）
	sessionId: string;           // 紐づけセッションID
	role: string;                // 役割（例: デバッグ・品質確認）
	displayRole?: string;        // 日本語役割説明（UI表示用）
	displayDescription?: string; // 日本語説明（UI表示用）
	model: 'opus' | 'sonnet' | 'sonnet-1m' | 'haiku'; // sonnet-1m = 長文コンテキスト対応モデル
	sessionMode?: 'fixed' | 'disposable'; // セッション運用（固定 / 使い捨て）
	ruleFile?: string;           // ルールファイルパス
	parentAgent?: string;        // 親エージェント名（班の場合）
	allowedTools?: string[];     // 許可ツール一覧
	workDir?: string;            // 作業ディレクトリ
	scope?: 'global' | 'project'; // ルールファイルのスコープ
	previousSessionIds?: string[]; // 過去のセッションID（直近5件）
	status?: 'active' | 'idle' | 'archived';
	// Phase 1b: モデル制御
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // 推論努力レベル（xhigh: v2.1.111追加, max は Opus 4.6 のみ）
	thinkingEnabled?: boolean;   // Extended Thinking 有効/無効
	permissionMode?: string;     // 権限モード（acceptEdits, auto, plan, default, bypassPermissions）
	// 記録機能
	historyEnabled?: boolean;    // HISTORY自動追記（デフォルト: false）
	historyScope?: 'global' | 'project';  // HISTORY保存先スコープ上書き（未指定=.md実在スコープ）
	todoEnabled?: boolean;       // TODO管理（デフォルト: false）
	// 表示制御
	showInOrgChart?: boolean;    // 組織図に表示するか（デフォルト: false → グローバル）
	// Phase 2-1: 名前ベース resume（Claude Code v2.1.101+）
	// sessionId が空の場合に --resume <name> を使用するフラグ（CSM が sessionId を管理できない場合のフォールバック）
	useNameResume?: boolean;
}

// agentWatcher のイベントデータ
export interface AgentWatcherState {
	agentName: string;
	sessionId: string;
	isLive: boolean;
	activeSubagentIds: string[];
	actualModel?: string;       // JONSLから読み取った実際のモデル名
	modelMismatch?: boolean;    // 設定モデルと実モデルが不一致
}

// サブエージェント情報
export interface SubagentInfo {
	toolUseId: string;
	name: string;           // Task or Agent
	description?: string;
	startedAt: number;      // タイムスタンプ
}

// ローカル（プロジェクト固有）永続データ
export interface LocalManagerData {
	agents?: AgentConfig[];  // プロジェクト固有エージェント
}

// タスク状態
export type TaskStatus = 'pending' | 'running' | 'stalled' | 'completed' | 'error';

// タスクログ
export interface TaskLog {
	id: string;               // ユニークID
	agentName: string;        // エージェント名
	sessionId: string;        // エージェントのセッションID
	summary: string;          // タスク概要（最大200文字）
	outputFile?: string;      // 出力先ファイルパス
	status: TaskStatus;       // 現在の状態
	createdAt: number;        // 作成タイムスタンプ（ms）
	completedAt?: number;     // 完了タイムスタンプ（ms）
	toolUseId?: string;       // 自動検出時の tool_use ID
	notifiedStatus?: TaskStatus; // 最後に通知した状態
	lastNotifiedAt?: number;  // 最後に通知した時刻
}

// エージェントのセッション紐づけ情報（session-manager.json に保持）
export interface AgentSessionBinding {
	sessionId: string;
	previousSessionIds?: string[];
	sessionMode?: 'fixed' | 'disposable';
}

// 拡張機能の永続データ（グローバル）
export interface ManagerData {
	bookmarks: string[]; // セッションIDの配列
	tags: Record<string, string[]>; // タグ名 → セッションIDの配列
	customNames: Record<string, string>; // セッションID → カスタム名
	notes: Record<string, string>; // セッションID → メモ
	agents?: AgentConfig[]; // レガシー（後方互換・読み取り専用）— 新規書き込み禁止
	agentSessions?: Record<string, AgentSessionBinding>; // エージェント名 → セッション紐づけ（Phase 3+）
	ruleFolder?: string; // ルールフォルダパス（例: ~/.claude/agents）
	taskLogs?: TaskLog[]; // タスクログ
}
