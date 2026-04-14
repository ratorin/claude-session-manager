import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession, SessionMessage, SimpleMessage, ContentBlock } from '../models/types';

// Claude Codeのデータディレクトリを取得
export function getClaudeDir(): string {
	return path.join(os.homedir(), '.claude');
}

// セッションファイル情報（親/子の区別付き）
export interface SessionFileInfo {
	filePath: string;
	isSubagent: boolean;
	parentSessionId?: string;  // 親セッションのUUID（ディレクトリ名から）
	agentHash?: string;        // agent-a{HASH} のHASH部分
}

// --- TTLキャッシュ（P1-9: getSessionFileInfos の頻繁な再帰走査を抑制） ---
const FILE_INFO_CACHE_TTL_MS = 7000; // 7秒
let cachedFileInfos: SessionFileInfo[] | null = null;
// キャッシュ強制無効化フラグ（手動リフレッシュ時に使用）
let forceInvalidateFileInfoCache = false;
let cachedFileInfosTimestamp = 0;

// プロジェクトパスマップキャッシュ
const PATH_MAP_CACHE_TTL_MS = 30000; // 30秒（変更頻度が低い）
let cachedPathMap: Map<string, string> | null = null;
let cachedPathMapTimestamp = 0;

// プロジェクトディレクトリ内の全JSONLファイルを取得（subagents含む）
export async function getSessionFiles(): Promise<string[]> {
	const infos = await getSessionFileInfos();
	return infos.map((info) => info.filePath);
}

// キャッシュを強制無効化（手動リフレッシュ用）
export function invalidateSessionCache(): void {
	forceInvalidateFileInfoCache = true;
	cachedPathMap = null;
	cachedPathMapTimestamp = 0;
}

// プロジェクトディレクトリ内の全セッションファイル情報を取得（非同期+TTLキャッシュ）
export async function getSessionFileInfos(): Promise<SessionFileInfo[]> {
	const now = Date.now();
	if (!forceInvalidateFileInfoCache && cachedFileInfos && (now - cachedFileInfosTimestamp) < FILE_INFO_CACHE_TTL_MS) {
		return cachedFileInfos;
	}
	forceInvalidateFileInfoCache = false;

	const claudeDir = getClaudeDir();
	const projectsDir = path.join(claudeDir, 'projects');

	const files: SessionFileInfo[] = [];
	let projects: string[];
	try {
		projects = await fs.promises.readdir(projectsDir);
	} catch {
		// ENOENT またはアクセスエラー → projects ディレクトリなし
		cachedFileInfos = [];
		cachedFileInfosTimestamp = now;
		return [];
	}

	// 並列でプロジェクトディレクトリを走査
	await Promise.allSettled(projects.map(async (project) => {
		const projectPath = path.join(projectsDir, project);
		try {
			const stat = await fs.promises.stat(projectPath);
			if (!stat.isDirectory()) { return; }
		} catch { return; }

		let entries: string[];
		try {
			entries = await fs.promises.readdir(projectPath);
		} catch { return; }

		for (const entry of entries) {
			// 直下のJSONL = 親セッション
			if (entry.endsWith('.jsonl')) {
				files.push({ filePath: path.join(projectPath, entry), isSubagent: false });
			}

			// セッションディレクトリ内の subagents/ を探索
			const subagentsDir = path.join(projectPath, entry, 'subagents');
			try {
				const subStat = await fs.promises.stat(subagentsDir);
				if (!subStat.isDirectory()) { continue; }
				const parentId = entry;
				const subFiles = await fs.promises.readdir(subagentsDir);
				for (const sf of subFiles) {
					// compact-ファイルは除外、meta.jsonも除外
					if (sf.endsWith('.jsonl') && !sf.includes('compact-')) {
						const hashMatch = sf.match(/^agent-a(.+)\.jsonl$/);
						files.push({
							filePath: path.join(subagentsDir, sf),
							isSubagent: true,
							parentSessionId: parentId,
							agentHash: hashMatch ? hashMatch[1] : undefined,
						});
					}
				}
			} catch {
				// subagentsディレクトリがない場合はスキップ
			}
		}
	}));

	cachedFileInfos = files;
	cachedFileInfosTimestamp = now;
	return files;
}

// subagentのmeta.jsonを読み込み
export async function readSubagentMeta(jsonlPath: string): Promise<{ agentType?: string; description?: string }> {
	// agent-a{HASH}.jsonl → agent-a{HASH}.meta.json
	const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
	try {
		const content = await fs.promises.readFile(metaPath, 'utf-8');
		return JSON.parse(content);
	} catch {
		return {};
	}
}

// システムタグを除去してユーザーの実際の発言を抽出
function stripSystemTags(text: string): string {
	return text
		.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
		.replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
		.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
		.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
		.trim();
}

// ツール名 → 日本語ラベルのマッピング（webviewPanel.ts でも共有）
export const TOOL_LABELS: Record<string, string> = {
	Read: '📄 ファイル読み取り',
	Edit: '✏️ ファイル編集',
	Write: '📝 ファイル作成',
	Bash: '💻 コマンド実行',
	Grep: '🔍 コード検索',
	Glob: '📂 ファイル検索',
	Agent: '🤖 エージェント',
	TodoWrite: '📋 タスク更新',
	WebSearch: '🌐 Web検索',
	WebFetch: '🌐 Web取得',
};

// ツール名を日本語に変換
function toolLabel(name: string): string {
	return TOOL_LABELS[name] || `🔧 ${name}`;
}

// コンテンツブロックからテキストを抽出
function extractText(content: string | ContentBlock[], includeThinking: boolean = false): string {
	if (typeof content === 'string') {
		return stripSystemTags(content);
	}
	if (Array.isArray(content)) {
		// 思考ブロックを収集（オプション）
		const thinkingTexts = includeThinking
			? content
				.filter((b) => b.type === 'thinking' && b.text)
				.map((b) => `[思考]${b.text!.substring(0, 500)}`)
			: [];

		// テキストブロックを収集
		const texts = content
			.filter((b) => b.type === 'text' && b.text)
			.map((b) => stripSystemTags(b.text!))
			.filter((t) => t.length > 0);

		if (texts.length > 0 || thinkingTexts.length > 0) {
			return [...thinkingTexts, ...texts].join('\n');
		}

		// テキストがない場合、ツール操作の概要を表示
		const toolUses = content.filter((b) => b.type === 'tool_use' && b.name);
		if (toolUses.length > 0) {
			return toolUses.map((b) => {
				const label = toolLabel(b.name!);
				const input = b.input as Record<string, unknown> | undefined;
				let detail = '';
				if (input) {
					if (input.file_path) { detail = ` ${String(input.file_path).split(/[/\\]/).pop()}`; }
					else if (input.command) { detail = ` ${String(input.command).substring(0, 60)}`; }
					else if (input.pattern) { detail = ` ${String(input.pattern)}`; }
					else if (input.prompt) { detail = ` ${String(input.prompt).substring(0, 50)}`; }
				}
				return `${label}${detail}`;
			}).join('\n');
		}

		// tool_result（許可）の場合
		const toolResults = content.filter((b) => b.type === 'tool_result');
		if (toolResults.length > 0) {
			return '✅ ツール実行を許可';
		}
	}
	return '';
}

// プロジェクト名をディレクトリ名からデコード（フォールバック用）
function decodeProjectName(dirName: string): string {
	// "c--xampp" のような形式
	return dirName
		.replace(/^([a-zA-Z])--/, '$1:\\')
		.replace(/--/g, '\\')
		.replace(/-/g, ' ');
}

// エンコードされたプロジェクトディレクトリ名→実パスのマッピングを構築（非同期+キャッシュ）
export async function buildProjectPathMap(): Promise<Map<string, string>> {
	const now = Date.now();
	if (cachedPathMap && (now - cachedPathMapTimestamp) < PATH_MAP_CACHE_TTL_MS) {
		return cachedPathMap;
	}

	const claudeDir = getClaudeDir();
	const projectsDir = path.join(claudeDir, 'projects');
	const map = new Map<string, string>();

	try {
		await fs.promises.access(projectsDir);
	} catch {
		cachedPathMap = map;
		cachedPathMapTimestamp = now;
		return map;
	}

	let projects: string[];
	try {
		projects = await fs.promises.readdir(projectsDir);
	} catch {
		cachedPathMap = map;
		cachedPathMapTimestamp = now;
		return map;
	}

	for (const project of projects) {
		const projectPath = path.join(projectsDir, project);
		try {
			const stat = await fs.promises.stat(projectPath);
			if (!stat.isDirectory()) { continue; }
		} catch { continue; }

		// JSONLファイルから1つだけcwdを取得
		let entries: string[];
		try {
			entries = await fs.promises.readdir(projectPath);
		} catch { continue; }

		for (const entry of entries) {
			if (!entry.endsWith('.jsonl')) { continue; }
			const cwd = await extractCwdFromJsonl(path.join(projectPath, entry));
			if (cwd) {
				map.set(project, cwd);
				break;
			}
		}
	}

	cachedPathMap = map;
	cachedPathMapTimestamp = now;
	return map;
}

// JSONLファイルの先頭数行からcwdを抽出（軽量・非同期）
async function extractCwdFromJsonl(filePath: string): Promise<string | undefined> {
	try {
		const handle = await fs.promises.open(filePath, 'r');
		try {
			const buf = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buf, 0, 4096, 0);
			const chunk = buf.toString('utf-8', 0, bytesRead);
			const lines = chunk.split('\n');
			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const parsed = JSON.parse(line);
					if (parsed.cwd) {
						return parsed.cwd;
					}
				} catch {
					// 不完全な行はスキップ
				}
			}
		} finally {
			await handle.close();
		}
	} catch {
		// ファイル読み取り失敗
	}
	return undefined;
}

// JSONLファイルからセッションをパース（非同期版）
export async function parseSessionFile(filePath: string, includeThinking: boolean = false): Promise<ParsedSession | null> {
	try {
		const content = await fs.promises.readFile(filePath, 'utf-8');
		const contentFileSize = Buffer.byteLength(content, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		const messages: SimpleMessage[] = [];
		let firstUserMessage = '';
		let model: string | undefined;
		let gitBranch: string | undefined;
		let sessionId = '';
		let claudeTitle: string | undefined;
		let cwd: string | undefined;

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);

				// Claude Codeの /rename で設定されたタイトル（custom-titleを優先）
				if (parsed.type === 'custom-title' && parsed.customTitle) {
					claudeTitle = parsed.customTitle;
					continue;
				}
				// Claude Codeが自動生成したタイトル
				if (parsed.type === 'ai-title' && parsed.aiTitle && !claudeTitle) {
					claudeTitle = parsed.aiTitle;
					continue;
				}

				// cwdを取得（最初に見つかったものを使用）
				if (!cwd && parsed.cwd) {
					cwd = parsed.cwd;
				}

				if (parsed.type === 'user' && parsed.message) {
					const text = extractText(parsed.message.content);
					if (!firstUserMessage && text) {
						firstUserMessage = text.substring(0, 100);
					}
					if (parsed.sessionId) {
						sessionId = parsed.sessionId;
					}
					if (parsed.gitBranch) {
						gitBranch = parsed.gitBranch;
					}
					messages.push({
						role: 'user',
						content: text,
						timestamp: new Date(parsed.timestamp),
					});
				} else if (parsed.type === 'assistant' && parsed.message) {
					// thinkingブロックを別メッセージとして分離
					if (includeThinking && Array.isArray(parsed.message.content)) {
						const thinkingBlocks = parsed.message.content
							.filter((b: ContentBlock) => b.type === 'thinking' && b.text);
						for (const tb of thinkingBlocks) {
							messages.push({
								role: 'system',
								content: `[思考]${tb.text!.substring(0, 1000)}`,
								timestamp: new Date(parsed.timestamp),
							});
						}
					}
					const text = extractText(parsed.message.content);
					if (parsed.message.model) {
						model = parsed.message.model;
					}
					messages.push({
						role: 'assistant',
						content: text,
						timestamp: new Date(parsed.timestamp),
						model: parsed.message.model,
					});
				}
			} catch {
				// 不正なJSON行はスキップ
			}
		}

		if (messages.length === 0) {
			return null;
		}

		// プロジェクトパス: JSONLのcwdを優先、なければディレクトリ名からデコード
		const projectDir = path.basename(path.dirname(filePath));
		const project = cwd || decodeProjectName(projectDir);
		const id = sessionId || path.basename(filePath, '.jsonl');

		return {
			id,
			filePath,
			project,
			firstMessage: firstUserMessage || '(内容なし)',
			firstTimestamp: messages[0].timestamp,
			lastTimestamp: messages[messages.length - 1].timestamp,
			fileSize: contentFileSize,
			model,
			gitBranch,
			claudeTitle,
			messages,
		};
	} catch {
		return null;
	}
}

// 全セッションを読み込み（軽量版：最初と最後のメッセージのみ）
export async function loadAllSessions(maxSessions: number = 500): Promise<ParsedSession[]> {
	const fileInfos = await getSessionFileInfos();
	const sessions: ParsedSession[] = [];

	// 並列処理（全ファイルを同時にパース）
	const results = await Promise.allSettled(
		fileInfos.map(async (info) => {
			const session = await parseSessionQuick(info.filePath);
			if (!session) { return null; }
			// サブエージェント情報を付与
			if (info.isSubagent) {
				session.isSidechain = true;
				session.parentSessionId = info.parentSessionId;
				const meta = await readSubagentMeta(info.filePath);
				session.agentType = meta.agentType;
				session.agentDescription = meta.description;
				const hashMatch = path.basename(info.filePath).match(/^agent-a(.+)\.jsonl$/);
				if (hashMatch) {
					session.agentId = hashMatch[1];
				}
			}
			return session;
		})
	);

	for (const result of results) {
		if (result.status === 'fulfilled' && result.value) {
			sessions.push(result.value);
		}
	}

	// 最終更新日時で降順ソート
	sessions.sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime());
	// 最大件数制限
	if (maxSessions > 0 && sessions.length > maxSessions) {
		return sessions.slice(0, maxSessions);
	}
	return sessions;
}

// 1行分のJSON文字列を安全にパースする（失敗時はnullを返す）
function tryParseLine(line: string): Record<string, unknown> | null {
	try {
		return JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// 先頭・末尾の部分読み取りでフィールドを抽出するヘルパー
// 先頭行群からセッション基本情報を収集する
function extractFromHeadLines(lines: string[], state: {
	cwd?: string;
	sessionId?: string;
	gitBranch?: string;
	model?: string;
	firstUserMessage?: string;
	firstTimestamp?: Date;
	claudeTitle?: string;
	isSidechain?: boolean;
	agentId?: string;
}): void {
	// フォールバック用: queue-operation等のタイムスタンプ
	let fallbackTimestamp: Date | undefined;

	for (const line of lines) {
		if (!line.trim()) { continue; }
		const parsed = tryParseLine(line);
		if (!parsed) { continue; }

		// cwd（最初に見つかったものを使用）
		if (!state.cwd && parsed.cwd) {
			state.cwd = String(parsed.cwd);
		}
		// サブエージェントフラグ
		if (parsed.isSidechain) {
			state.isSidechain = true;
		}
		if (parsed.agentId && !state.agentId) {
			state.agentId = String(parsed.agentId);
		}
		// sessionId（queue-operation等からも取得）
		if (parsed.sessionId && !state.sessionId) {
			state.sessionId = String(parsed.sessionId);
		}
		// custom-title（/renameで設定されたタイトル）を優先
		if (parsed.type === 'custom-title' && parsed.customTitle) {
			state.claudeTitle = String(parsed.customTitle);
		}
		// ai-title（自動生成タイトル）はcustom-titleがない場合のみ
		if (parsed.type === 'ai-title' && parsed.aiTitle && !state.claudeTitle) {
			state.claudeTitle = String(parsed.aiTitle);
		}
		// last-prompt（-pセッション用）: firstUserMessageのフォールバック
		if (parsed.type === 'last-prompt' && parsed.lastPrompt && !state.firstUserMessage) {
			state.firstUserMessage = String(parsed.lastPrompt).substring(0, 100);
		}
		// queue-operationのcontent（-pセッションやresume時のプロンプト）をfirstUserMessageのフォールバックに
		if (parsed.type === 'queue-operation' && parsed.content && !state.firstUserMessage) {
			state.firstUserMessage = String(parsed.content).substring(0, 100);
		}
		// queue-operation等のタイムスタンプをフォールバックとして保持
		if (!fallbackTimestamp && parsed.timestamp &&
			(parsed.type === 'queue-operation' || parsed.type === 'progress' || parsed.type === 'system')) {
			fallbackTimestamp = new Date(String(parsed.timestamp));
		}
		// file-history-snapshotのsnapshot.timestampもフォールバックとして利用
		if (!fallbackTimestamp && parsed.type === 'file-history-snapshot') {
			const snapshot = parsed.snapshot as Record<string, unknown> | undefined;
			if (snapshot?.timestamp) {
				fallbackTimestamp = new Date(String(snapshot.timestamp));
			}
		}
		// ユーザーメッセージから基本情報を抽出
		if (parsed.type === 'user' && parsed.message) {
			const msg = parsed.message as Record<string, unknown>;
			if (parsed.gitBranch && !state.gitBranch) {
				state.gitBranch = String(parsed.gitBranch);
			}
			// 最初のユーザーメッセージを取得
			if (!state.firstUserMessage) {
				const text = extractText(msg.content as string | ContentBlock[]);
				if (text) {
					state.firstUserMessage = text.substring(0, 100);
				}
			}
			// 最初のタイムスタンプ
			if (!state.firstTimestamp && parsed.timestamp) {
				state.firstTimestamp = new Date(String(parsed.timestamp));
			}
		}
		// アシスタントメッセージからモデル名を取得
		if (parsed.type === 'assistant' && parsed.message) {
			const msg = parsed.message as Record<string, unknown>;
			if (msg.model && !state.model) {
				state.model = String(msg.model);
			}
			// 最初のタイムスタンプ（ユーザーメッセージがない場合のフォールバック）
			if (!state.firstTimestamp && parsed.timestamp) {
				state.firstTimestamp = new Date(String(parsed.timestamp));
			}
		}
	}

	// user/assistantメッセージがなくてもqueue-operation等のタイムスタンプで補完
	if (!state.firstTimestamp && fallbackTimestamp) {
		state.firstTimestamp = fallbackTimestamp;
	}
}

// 末尾行群から最新情報（lastTimestamp、最新モデル、カスタムタイトル）を収集する
function extractFromTailLines(lines: string[], state: {
	lastTimestamp?: Date;
	model?: string;
	claudeTitle?: string;
	isSidechain?: boolean;
	agentId?: string;
}): void {
	// 末尾の最初の行は切れている可能性があるためスキップ
	const tailLines = lines.slice(1);
	for (const line of tailLines) {
		if (!line.trim()) { continue; }
		const parsed = tryParseLine(line);
		if (!parsed) { continue; }

		// サブエージェントフラグ（末尾にも出現することがある）
		if (parsed.isSidechain) {
			state.isSidechain = true;
		}
		if (parsed.agentId && !state.agentId) {
			state.agentId = String(parsed.agentId);
		}
		// custom-title は末尾にも出現するため最新のものを優先
		if (parsed.type === 'custom-title' && parsed.customTitle) {
			state.claudeTitle = String(parsed.customTitle);
		}
		// ai-title は末尾にも出現するがcustom-titleがない場合のみ
		if (parsed.type === 'ai-title' && parsed.aiTitle && !state.claudeTitle) {
			state.claudeTitle = String(parsed.aiTitle);
		}
		// タイムスタンプを更新（user/assistant + queue-operation/progress/system も対象）
		if (parsed.timestamp) {
			const ts = new Date(String(parsed.timestamp));
			if (parsed.type === 'user' || parsed.type === 'assistant') {
				// user/assistantメッセージは最優先
				if (!state.lastTimestamp || ts > state.lastTimestamp) {
					state.lastTimestamp = ts;
				}
			} else if (parsed.type === 'queue-operation' || parsed.type === 'progress' ||
				parsed.type === 'system' || parsed.type === 'last-prompt') {
				// user/assistantがない場合のフォールバック
				if (!state.lastTimestamp || ts > state.lastTimestamp) {
					state.lastTimestamp = ts;
				}
			}
		}
		// file-history-snapshotのsnapshot.timestampもフォールバック
		if (parsed.type === 'file-history-snapshot' && !state.lastTimestamp) {
			const snapshot = parsed.snapshot as Record<string, unknown> | undefined;
			if (snapshot?.timestamp) {
				state.lastTimestamp = new Date(String(snapshot.timestamp));
			}
		}
		// 最新のモデル名（末尾にある方が新しい）
		if (parsed.type === 'assistant' && parsed.message) {
			const msg = parsed.message as Record<string, unknown>;
			if (msg.model) {
				state.model = String(msg.model);
			}
		}
	}
}

// 軽量パース：先頭32KB + 末尾8KBのみ読み取り（非同期・fdリーク対策済み）
// HEAD_BYTESを大きめに取る理由: ECC hookやdeferred_tools_delta、attachment行が先頭に
// 大量に挿入されるため、16KBでは最初のuserメッセージまで到達しないケースがある
async function parseSessionQuick(filePath: string): Promise<ParsedSession | null> {
	try {
		const HEAD_BYTES = 32768;
		const TAIL_BYTES = 32768;

		// ファイルハンドルを開いてサイズを確認（try/finallyで確実にclose）
		const handle = await fs.promises.open(filePath, 'r');
		let headStr: string;
		let tailStr: string;
		let fileSize: number;
		try {
			const stat = await handle.stat();
			if (stat.size === 0) { return null; }
			fileSize = stat.size;

			// 先頭32KBを読み取り
			const headSize = Math.min(HEAD_BYTES, fileSize);
			const headBuf = Buffer.alloc(headSize);
			await handle.read(headBuf, 0, headSize, 0);
			headStr = headBuf.toString('utf-8');

			// 末尾8KBを読み取り（先頭と重複しない範囲で）
			tailStr = '';
			if (fileSize > HEAD_BYTES) {
				const tailSize = Math.min(TAIL_BYTES, fileSize - HEAD_BYTES);
				const tailStart = fileSize - tailSize;
				const tailBuf = Buffer.alloc(tailSize);
				await handle.read(tailBuf, 0, tailSize, tailStart);
				tailStr = tailBuf.toString('utf-8');
			}
		} finally {
			await handle.close();
		}

		// 先頭行群をパース
		const headLines = headStr.split('\n');
		const headState: {
			cwd?: string;
			sessionId?: string;
			gitBranch?: string;
			model?: string;
			firstUserMessage?: string;
			firstTimestamp?: Date;
			claudeTitle?: string;
			isSidechain?: boolean;
			agentId?: string;
		} = {};
		extractFromHeadLines(headLines, headState);

		// 末尾行群をパース（末尾の最初の行は切れている可能性があるためスキップ済み）
		const tailLines = tailStr ? tailStr.split('\n') : [];
		const tailState: {
			lastTimestamp?: Date;
			model?: string;
			claudeTitle?: string;
			isSidechain?: boolean;
			agentId?: string;
		} = {};
		if (tailLines.length > 0) {
			extractFromTailLines(tailLines, tailState);
		}

		// 先頭から取得したlastTimestampの初期値（末尾読み取りがない場合のフォールバック）
		let lastTimestamp = tailState.lastTimestamp || headState.firstTimestamp;
		const firstTimestamp = headState.firstTimestamp;

		if (!firstTimestamp || !lastTimestamp) {
			return null;
		}

		// lastTimestamp が firstTimestamp より古い場合は firstTimestamp を使用
		if (lastTimestamp < firstTimestamp) {
			lastTimestamp = firstTimestamp;
		}

		// custom-titleは末尾にある方が優先（後から設定された可能性）
		const claudeTitle = tailState.claudeTitle || headState.claudeTitle;

		// 末尾の方が新しいモデル名を優先
		const model = tailState.model || headState.model;

		// サブエージェントフラグは先頭・末尾どちらで見つかってもOK
		const isSidechain = headState.isSidechain || tailState.isSidechain;
		const agentId = headState.agentId || tailState.agentId;

		// ファイルサイズはそのまま保持（セッションのボリューム指標として使用）

		const projectDir = path.basename(path.dirname(filePath));
		const project = headState.cwd || decodeProjectName(projectDir);
		const id = headState.sessionId || path.basename(filePath, '.jsonl');

		return {
			id,
			filePath,
			project,
			firstMessage: headState.firstUserMessage || '(内容なし)',
			firstTimestamp,
			lastTimestamp,
			fileSize,
			model,
			gitBranch: headState.gitBranch,
			claudeTitle,
			messages: [], // 軽量版では空
			isSidechain,
			agentId,
		};
	} catch {
		return null;
	}
}

// セッション全メッセージを読み込み（プレビュー用）
export async function loadSessionFull(filePath: string, showThinking: boolean = false): Promise<ParsedSession | null> {
	return parseSessionFile(filePath, showThinking);
}
