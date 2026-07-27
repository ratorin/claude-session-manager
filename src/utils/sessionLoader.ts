import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession, SessionMessage, SimpleMessage, ContentBlock } from '../models/types';
import { translateWorkDirPath } from './agentUtils';

// Claude Codeのデータディレクトリを取得
export function getClaudeDir(): string {
	return path.join(os.homedir(), '.claude');
}

// 指定sessionIdのタイトルを全プロジェクト横断で検索
// ~/.claude/projects/*/<sessionId>.jsonl を走査し claudeTitle/firstUserMessage を抽出
// エージェントツリーの「他プロジェクトにあるセッション」の表示名解決用
const _externalTitleCache = new Map<string, { title: string; found: boolean; ts: number }>();
const EXTERNAL_TITLE_TTL_MS = 60_000;

/**
 * 外部セッションの解決結果。
 * - found: `~/.claude/projects/` 内に `<sid>.jsonl` が実在したか（false = リンク切れ）
 * - title: 抽出したタイトル（見つからなければ空文字）
 */
export interface ExternalSessionInfo {
	found: boolean;
	title: string;
}

/**
 * 指定 sessionId 群を全プロジェクト横断で解決し、found（ファイル実在）+ title を返す。
 * `resolveExternalSessionTitles` のスーパーセット。リンク切れ（found=false）検出用。
 */
export async function resolveExternalSessionInfos(sessionIds: string[]): Promise<Map<string, ExternalSessionInfo>> {
	const result = new Map<string, ExternalSessionInfo>();
	const now = Date.now();
	const unresolved: string[] = [];
	for (const id of sessionIds) {
		if (!id) { continue; }
		const cached = _externalTitleCache.get(id);
		if (cached && (now - cached.ts) < EXTERNAL_TITLE_TTL_MS) {
			result.set(id, { found: cached.found, title: cached.title });
		} else {
			unresolved.push(id);
		}
	}
	if (unresolved.length === 0) { return result; }

	const projectsDir = path.join(getClaudeDir(), 'projects');
	let projectDirs: string[] = [];
	try {
		const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
		projectDirs = entries.filter(e => e.isDirectory()).map(e => path.join(projectsDir, e.name));
	} catch {
		// projects ディレクトリ自体が無い場合は「実在判定不能」= リンク切れ扱いにしない（found=true 相当で未確定）
		return result;
	}

	await Promise.all(unresolved.map(async (sid) => {
		for (const pDir of projectDirs) {
			const fp = path.join(pDir, `${sid}.jsonl`);
			try {
				await fs.promises.access(fp);
			} catch {
				continue;
			}
			const title = await extractSessionTitle(fp);
			_externalTitleCache.set(sid, { title, found: true, ts: now });
			result.set(sid, { found: true, title });
			return;
		}
		// 全プロジェクトを走査しても `<sid>.jsonl` が存在しない → リンク切れ
		_externalTitleCache.set(sid, { title: '', found: false, ts: now });
		result.set(sid, { found: false, title: '' });
	}));
	return result;
}

// 指定sessionIdのタイトルを全プロジェクト横断で検索（後方互換ラッパ）
// タイトルが取得できたものだけを返す（従来挙動を維持）
export async function resolveExternalSessionTitles(sessionIds: string[]): Promise<Map<string, string>> {
	const infos = await resolveExternalSessionInfos(sessionIds);
	const result = new Map<string, string>();
	for (const [sid, info] of infos) {
		if (info.title) { result.set(sid, info.title); }
	}
	return result;
}

/**
 * 指定 sessionId の JSONL が `~/.claude/projects/*` に実在するかを判定する（軽量）。
 * 「Claude で開く / ターミナルで開く」前のリンク切れ検出に使う。
 */
export async function sessionFileExists(sessionId: string): Promise<boolean> {
	if (!sessionId) { return false; }
	const projectsDir = path.join(getClaudeDir(), 'projects');
	try {
		const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) { continue; }
			try {
				await fs.promises.access(path.join(projectsDir, e.name, `${sessionId}.jsonl`));
				return true;
			} catch {
				// このプロジェクトには無い → 次へ
			}
		}
	} catch {
		// projects ディレクトリなし
	}
	return false;
}

// セッションJSONLから軽量にタイトル抽出（customTitle/ai-title 優先、次点で最初のユーザーメッセージ）
async function extractSessionTitle(filePath: string): Promise<string> {
	try {
		const handle = await fs.promises.open(filePath, 'r');
		try {
			const stat = await handle.stat();
			const readSize = Math.min(stat.size, 256 * 1024); // 先頭256KBのみ
			if (readSize === 0) { return ''; }
			const buf = Buffer.alloc(readSize);
			await handle.read(buf, 0, readSize, 0);
			const text = buf.toString('utf-8');
			const lines = text.split('\n');
			let firstUserMessage = '';
			let firstQueueContent = ''; // -p モードの初回プロンプト（user message より優先度低）
			for (const line of lines) {
				if (!line.trim()) { continue; }
				let parsed: { type?: string; customTitle?: string; aiTitle?: string; operation?: string; content?: string; message?: { role?: string; content?: unknown } } | null = null;
				try { parsed = JSON.parse(line); } catch { continue; }
				if (!parsed) { continue; }
				if (parsed.type === 'custom-title' && parsed.customTitle) { return String(parsed.customTitle); }
				if (parsed.type === 'ai-title' && parsed.aiTitle) { return String(parsed.aiTitle); }
				if (!firstUserMessage && parsed.type === 'user' && parsed.message?.role === 'user') {
					const content = parsed.message.content;
					if (typeof content === 'string') {
						firstUserMessage = content.substring(0, 40);
					} else if (Array.isArray(content)) {
						const textBlock = content.find((b: { type?: string; text?: string }) => b.type === 'text');
						if (textBlock?.text) { firstUserMessage = String(textBlock.text).substring(0, 40); }
					}
				}
				// -p モード（csm-ask-agent 経由）の初回プロンプトを queue-operation から拾う
				if (!firstQueueContent && parsed.type === 'queue-operation' && parsed.operation === 'enqueue' && typeof parsed.content === 'string') {
					firstQueueContent = parsed.content.substring(0, 40);
				}
			}
			return firstUserMessage || firstQueueContent;
		} finally {
			await handle.close();
		}
	} catch {
		return '';
	}
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

	// UUID重複排除: 同じsessionIdが複数のproject dirに存在する場合（クロスプラットフォームブリッジ等）、
	// mtimeが最新のものだけ残す。subagentファイルはネスト構造で実質ユニークなので除外せず温存。
	const dedupKey = (info: SessionFileInfo): string => {
		if (info.isSubagent) { return info.filePath; }
		return path.basename(info.filePath); // <UUID>.jsonl
	};
	const fileMtimes = new Map<string, number>();
	await Promise.all(files.map(async (f) => {
		try {
			const st = await fs.promises.stat(f.filePath);
			fileMtimes.set(f.filePath, st.mtimeMs);
		} catch {
			fileMtimes.set(f.filePath, 0);
		}
	}));
	const seen = new Map<string, SessionFileInfo>();
	for (const f of files) {
		const k = dedupKey(f);
		const prev = seen.get(k);
		if (!prev) { seen.set(k, f); continue; }
		const tNew = fileMtimes.get(f.filePath) ?? 0;
		const tPrev = fileMtimes.get(prev.filePath) ?? 0;
		if (tNew > tPrev) { seen.set(k, f); }
	}
	const dedupedFiles = Array.from(seen.values());

	cachedFileInfos = dedupedFiles;
	cachedFileInfosTimestamp = now;
	return dedupedFiles;
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
	// "c--xampp" のような形式（- はパス区切り文字）
	return dirName
		.replace(/^([a-zA-Z])--/, '$1:\\')
		.replace(/--/g, '\\')
		.replace(/-/g, '\\');
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
		// translateWorkDirPathでWindows→Linux HGFSパスに変換（dev-lamp対応）
		const projectDir = path.basename(path.dirname(filePath));
		const project = translateWorkDirPath(cwd || decodeProjectName(projectDir));
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
			// v0.5.15: 生の cwd（Claude --resume の起動 cwd に使用）
			cwd,
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
		const project = translateWorkDirPath(headState.cwd || decodeProjectName(projectDir));
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
			// v0.5.15: 生の cwd（Claude --resume の起動 cwd に使用）
			cwd: headState.cwd,
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

// ═══════════════════════════════════════════════════════════════════════════
// v0.5.20: 遅延読み込み用の tail リーダー + 範囲切り出し
// ═══════════════════════════════════════════════════════════════════════════
//
// 背景: parseSessionFile は readFile 一括 + 全行 JSON.parse で、276MB/154MB 級の
//   JSONL をビューワーで開くと数秒〜数十秒ブロックしていた。
//
// 方針:
//   (a) tail リーダー: 末尾から 1MB 単位で逆方向にチャンクを読み、必要な行数
//       を収集した時点で打ち切る。次の JSON.parse 対象は "必要末尾 N 行" だけ。
//   (b) 前方走査でメタデータ（cwd/model/gitBranch/sessionId/custom-title 等）
//       が抜けたら、先頭 64KB を追加読みして補う。
//   (c) 追加読み込み時（オンデマンド）は「読み込み済みの最古行より前の N 行」
//       を tail リーダーと同じ骨格で取得。
//
// 判断: readline + リングバッファ方式は 276MB 全ストリームを読むためディスク帯域
//   がボトルネックになる（1MB tail 読みは典型的な NVMe で 数十 ms）。
//   よって末尾チャンク逆読み方式を採用する。

const TAIL_CHUNK_BYTES = 1024 * 1024; // 1MB
const HEAD_META_BYTES  = 64 * 1024;   // 64KB（メタデータ補完用）

/**
 * ファイル末尾から N 個の非空行を効率的に読み取る。
 * @param filePath JSONL ファイルパス
 * @param maxLines 取りたい末尾の非空行数
 * @param stopAtOffset これ以降の offset を無視（オンデマンド追加読み時に使用）
 * @returns {lines, startOffset, totalSize, reachedHead}
 *   - lines: 昇順（古→新）の非空行配列
 *   - startOffset: 最古行のバイトオフセット
 *   - totalSize: ファイル全体のバイト数
 *   - reachedHead: 先頭に達したか
 */
export async function readTailLines(
	filePath: string,
	maxLines: number,
	stopAtOffset?: number,
): Promise<{ lines: string[]; startOffset: number; totalSize: number; reachedHead: boolean }> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const stat = await handle.stat();
		const totalSize = stat.size;
		const upperBound = stopAtOffset !== undefined ? Math.min(stopAtOffset, totalSize) : totalSize;
		let cursor = upperBound;
		let residual = ''; // 先頭に切れた部分行を次チャンクの末尾へ持ち越す
		const collected: string[] = []; // 逆順（新→古）に集める
		let earlyBreak = false;
		while (cursor > 0 && collected.length < maxLines) {
			const chunkSize = Math.min(TAIL_CHUNK_BYTES, cursor);
			const chunkStart = cursor - chunkSize;
			const buf = Buffer.alloc(chunkSize);
			await handle.read(buf, 0, chunkSize, chunkStart);
			// 前のチャンクと連結（境界の途中で切れた行に対応）
			const combined = buf.toString('utf-8') + residual;
			// この chunk の先頭は「行の途中」の可能性がある。先頭改行までを residual として次回に持ち越す。
			const firstNewline = combined.indexOf('\n');
			const partial = chunkStart > 0 && firstNewline >= 0 ? combined.substring(0, firstNewline + 1) : '';
			const usable = chunkStart > 0 && firstNewline >= 0 ? combined.substring(firstNewline + 1) : combined;
			residual = partial;
			// usable を改行で分割して逆順に取り込む
			const parts = usable.split('\n');
			let overflowFromIndex = -1; // maxLines に到達してカットされた「未処理の残り部分の末尾 index」
			for (let i = parts.length - 1; i >= 0; i--) {
				const line = parts[i];
				if (!line.trim()) { continue; }
				if (collected.length >= maxLines) {
					// この parts[i] は未処理 → 次回の cursor 位置に含める必要あり
					overflowFromIndex = i;
					break;
				}
				collected.push(line);
			}
			if (overflowFromIndex >= 0) {
				// 未処理部分 = parts[0..overflowFromIndex] を '\n' で join し直したバイト長
				const unprocessedText = parts.slice(0, overflowFromIndex + 1).join('\n');
				const unprocessedBytes = Buffer.byteLength(unprocessedText, 'utf-8');
				// 未処理領域の末尾位置 = chunkStart + partial のバイト長 + 未処理バイト長
				cursor = chunkStart + Buffer.byteLength(partial, 'utf-8') + unprocessedBytes;
				earlyBreak = true;
				break;
			}
			cursor = chunkStart;
		}
		// 先頭に達して residual が残っている場合も含める（chunkStart===0 のとき partial は空になっている）
		const reachedHead = !earlyBreak && cursor === 0;
		// 先頭に達した + 残り residual に有効行があれば取り込む（境界処理漏れ対策）
		if (reachedHead && residual.trim() && collected.length < maxLines) {
			for (const l of residual.split('\n').reverse()) {
				if (!l.trim()) { continue; }
				collected.push(l);
				if (collected.length >= maxLines) { break; }
			}
		}
		// 昇順にして返す
		collected.reverse();
		return { lines: collected, startOffset: cursor, totalSize, reachedHead };
	} finally {
		await handle.close();
	}
}

/** 先頭 N バイトを読み取る（メタデータ補完用） */
async function readHeadBytes(filePath: string, bytes: number): Promise<string> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const stat = await handle.stat();
		const size = Math.min(bytes, stat.size);
		if (size === 0) { return ''; }
		const buf = Buffer.alloc(size);
		await handle.read(buf, 0, size, 0);
		return buf.toString('utf-8');
	} finally {
		await handle.close();
	}
}

/**
 * 遅延読み込み用: 末尾 N メッセージだけをパースして ParsedSession を返す。
 * 全文 readFile を回避するため、大きなファイルでも高速に開ける。
 *
 * @param filePath          JSONL ファイル
 * @param maxInitialMessages 末尾から取りたい **user/assistant** メッセージ件数
 * @param showThinking      thinking ブロックを分離表示するか
 * @returns { session, oldestByteOffset, totalBytes, hasOlder }
 *   - oldestByteOffset: session.messages の最古行のバイト位置（追加読み時に stopAtOffset に渡す）
 *   - hasOlder:         これ以上古い行があるか
 */
export async function loadSessionTail(
	filePath: string,
	maxInitialMessages: number,
	showThinking: boolean = false,
): Promise<{
	session: ParsedSession | null;
	oldestByteOffset: number;
	totalBytes: number;
	hasOlder: boolean;
	totalMessagesEstimate?: number;
} | null> {
	try {
		// user/assistant + thinking を全部拾えるよう、余裕を持って多めに tail 行を確保する。
		// タイプ以外のメタ行（file-history-snapshot, custom-title 等）が含まれる想定で 4 倍を目安に。
		const targetLines = Math.max(maxInitialMessages * 4, 100);
		const tail = await readTailLines(filePath, targetLines);
		if (tail.lines.length === 0) { return null; }
		const parsed = parseLinesToMessages(tail.lines, showThinking);
		let { messages, cwd, model, gitBranch, sessionId, claudeTitle, firstUserMessage } = parsed;

		// 末尾 N 件のメッセージだけを保持
		if (messages.length > maxInitialMessages) {
			messages = messages.slice(messages.length - maxInitialMessages);
		}

		// メタデータが tail だけで揃わないケースは、先頭 64KB を読み足して補う
		const needsHeadFill = !cwd || !model || !sessionId || !firstUserMessage;
		if (needsHeadFill) {
			const head = await readHeadBytes(filePath, HEAD_META_BYTES);
			const headParsed = parseLinesToMessages(head.split('\n').filter(l => l.trim()), false);
			if (!cwd) { cwd = headParsed.cwd; }
			if (!model) { model = headParsed.model; }
			if (!gitBranch) { gitBranch = headParsed.gitBranch; }
			if (!sessionId) { sessionId = headParsed.sessionId; }
			if (!claudeTitle) { claudeTitle = headParsed.claudeTitle; }
			if (!firstUserMessage) { firstUserMessage = headParsed.firstUserMessage; }
		}

		if (messages.length === 0) { return null; }

		const projectDir = path.basename(path.dirname(filePath));
		const project = translateWorkDirPath(cwd || decodeProjectName(projectDir));
		const id = sessionId || path.basename(filePath, '.jsonl');

		const session: ParsedSession = {
			id,
			filePath,
			project,
			firstMessage: firstUserMessage || '(内容なし)',
			firstTimestamp: messages[0].timestamp,
			lastTimestamp: messages[messages.length - 1].timestamp,
			fileSize: tail.totalSize,
			model,
			gitBranch,
			claudeTitle,
			cwd,
			messages,
		};

		return {
			session,
			oldestByteOffset: tail.startOffset,
			totalBytes: tail.totalSize,
			hasOlder: !tail.reachedHead,
		};
	} catch {
		return null;
	}
}

/**
 * オンデマンド追加読み込み: 指定 offset より前の範囲を tail 方式で読み、
 * 追加のメッセージ件数を返す。
 */
export async function loadOlderMessages(
	filePath: string,
	stopAtOffset: number,
	maxMessages: number,
	showThinking: boolean = false,
): Promise<{
	messages: SimpleMessage[];
	newOffset: number;
	reachedHead: boolean;
} | null> {
	try {
		const targetLines = Math.max(maxMessages * 4, 100);
		const tail = await readTailLines(filePath, targetLines, stopAtOffset);
		if (tail.lines.length === 0) {
			return { messages: [], newOffset: tail.startOffset, reachedHead: tail.reachedHead };
		}
		const parsed = parseLinesToMessages(tail.lines, showThinking);
		let messages = parsed.messages;
		if (messages.length > maxMessages) {
			messages = messages.slice(messages.length - maxMessages);
		}
		return { messages, newOffset: tail.startOffset, reachedHead: tail.reachedHead };
	} catch {
		return null;
	}
}

/**
 * ファイル内の指定 lineIndex 相当のメッセージを 1 件だけフル読みで返す。
 * 「巨大メッセージの全文を表示」用。lineIndex はブラウザ側から `data-lidx` で渡される。
 *
 * 実装方針: lineIndex は「session.messages の中の 0-based インデックス」ではなく、
 *   セッション全体で表示された順序でのユニーク ID として **uuid** を使う。
 *   末尾走査で uuid 一致行を見つけたら返す。uuid が無い場合はフォールバックとして
 *   全文 readFile で該当 index の行を返す（大容量では低速だがワースト時のみ発火）。
 */
export async function loadSingleMessageByUuid(
	filePath: string,
	uuid: string,
): Promise<{ role: 'user' | 'assistant' | 'system'; content: string; timestamp: Date; model?: string } | null> {
	if (!uuid) { return null; }
	// tail 方式で 1M ずつ舐めて uuid 一致を探す（末尾に近い方から）。
	try {
		const handle = await fs.promises.open(filePath, 'r');
		try {
			const stat = await handle.stat();
			let cursor = stat.size;
			let residual = '';
			while (cursor > 0) {
				const chunkSize = Math.min(TAIL_CHUNK_BYTES, cursor);
				const chunkStart = cursor - chunkSize;
				const buf = Buffer.alloc(chunkSize);
				await handle.read(buf, 0, chunkSize, chunkStart);
				const combined = buf.toString('utf-8') + residual;
				const firstNewline = combined.indexOf('\n');
				const partial = chunkStart > 0 && firstNewline >= 0 ? combined.substring(0, firstNewline + 1) : '';
				const usable = chunkStart > 0 && firstNewline >= 0 ? combined.substring(firstNewline + 1) : combined;
				residual = partial;
				for (const line of usable.split('\n')) {
					if (!line.includes(uuid)) { continue; } // 軽量な substring 判定で不要行をスキップ（最適化）
					try {
						const p = JSON.parse(line);
						if (p.uuid !== uuid) { continue; }
						return extractSingleMessage(p);
					} catch { /* skip */ }
				}
				cursor = chunkStart;
			}
		} finally {
			await handle.close();
		}
	} catch { /* fall through */ }
	return null;
}

function extractSingleMessage(parsed: Record<string, unknown>): { role: 'user' | 'assistant' | 'system'; content: string; timestamp: Date; model?: string } | null {
	const type = parsed.type;
	const msg = parsed.message as { content: unknown; model?: string } | undefined;
	if (!msg) { return null; }
	const text = extractText(msg.content as string | ContentBlock[]);
	if (type === 'user') {
		return { role: 'user', content: text, timestamp: new Date(parsed.timestamp as string) };
	}
	if (type === 'assistant') {
		return { role: 'assistant', content: text, timestamp: new Date(parsed.timestamp as string), model: msg.model };
	}
	return null;
}

// --- 内部ヘルパー: 行配列を messages + メタに分解 ---
interface ParsedLinesResult {
	messages: SimpleMessage[];
	firstUserMessage?: string;
	model?: string;
	gitBranch?: string;
	sessionId?: string;
	claudeTitle?: string;
	cwd?: string;
}

function parseLinesToMessages(lines: string[], includeThinking: boolean): ParsedLinesResult {
	const messages: SimpleMessage[] = [];
	let firstUserMessage: string | undefined;
	let model: string | undefined;
	let gitBranch: string | undefined;
	let sessionId: string | undefined;
	let claudeTitle: string | undefined;
	let cwd: string | undefined;

	for (const line of lines) {
		// 軽量な substring 判定で「メッセージにも含まれない可能性が高い」不要行をスキップ
		if (line.length < 20) { continue; }
		try {
			const parsed = JSON.parse(line);
			if (parsed.type === 'custom-title' && parsed.customTitle) {
				claudeTitle = parsed.customTitle;
				continue;
			}
			if (parsed.type === 'ai-title' && parsed.aiTitle && !claudeTitle) {
				claudeTitle = parsed.aiTitle;
				continue;
			}
			if (!cwd && parsed.cwd) { cwd = parsed.cwd; }
			if (parsed.type === 'user' && parsed.message) {
				const text = extractText(parsed.message.content);
				if (!firstUserMessage && text) { firstUserMessage = text.substring(0, 100); }
				if (parsed.sessionId) { sessionId = parsed.sessionId; }
				if (parsed.gitBranch) { gitBranch = parsed.gitBranch; }
				messages.push({
					role: 'user',
					content: text,
					timestamp: new Date(parsed.timestamp),
					uuid: typeof parsed.uuid === 'string' ? parsed.uuid : undefined,
					fullBytes: Buffer.byteLength(text, 'utf-8'),
				});
			} else if (parsed.type === 'assistant' && parsed.message) {
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
				if (parsed.message.model) { model = parsed.message.model; }
				messages.push({
					role: 'assistant',
					content: text,
					timestamp: new Date(parsed.timestamp),
					model: parsed.message.model,
					uuid: typeof parsed.uuid === 'string' ? parsed.uuid : undefined,
					fullBytes: Buffer.byteLength(text, 'utf-8'),
				});
			}
		} catch { /* skip */ }
	}
	return { messages, firstUserMessage, model, gitBranch, sessionId, claudeTitle, cwd };
}
