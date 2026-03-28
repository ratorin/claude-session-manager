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

// 拡張機能の永続データ
export interface ManagerData {
	bookmarks: string[]; // セッションIDの配列
	tags: Record<string, string[]>; // タグ名 → セッションIDの配列
	customNames: Record<string, string>; // セッションID → カスタム名
	notes: Record<string, string>; // セッションID → メモ
}
