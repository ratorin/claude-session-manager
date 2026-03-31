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
	messageCount: number;
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
	name: string;                // 部署名（例: CSM開発部）
	sessionId: string;           // 紐づけセッションID
	role: string;                // 役割（例: デバッグ・品質確認）
	description?: string;        // 詳細説明
	model: 'opus' | 'sonnet' | 'haiku';
	effort?: 'low' | 'medium' | 'high';
	ruleFile?: string;           // ルールファイルパス
	parentAgent?: string;        // 親エージェント名（班の場合）
	allowedTools?: string[];     // 許可ツール一覧
	workDir?: string;            // 作業ディレクトリ
	status?: 'active' | 'idle' | 'archived';
	costLimitUsd?: number;       // コスト上限（$）
	maxIterations?: number;      // 最大反復回数
}

// 拡張機能の永続データ
export interface ManagerData {
	bookmarks: string[]; // セッションIDの配列
	tags: Record<string, string[]>; // タグ名 → セッションIDの配列
	customNames: Record<string, string>; // セッションID → カスタム名
	notes: Record<string, string>; // セッションID → メモ
	agents?: AgentConfig[]; // エージェント設定
}
