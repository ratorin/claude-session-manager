import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession, SessionMessage, SimpleMessage, ContentBlock } from './types';

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

// プロジェクトディレクトリ内の全JSONLファイルを取得（subagents含む）
export function getSessionFiles(): string[] {
	return getSessionFileInfos().map((info) => info.filePath);
}

// プロジェクトディレクトリ内の全セッションファイル情報を取得
export function getSessionFileInfos(): SessionFileInfo[] {
	const claudeDir = getClaudeDir();
	const projectsDir = path.join(claudeDir, 'projects');

	if (!fs.existsSync(projectsDir)) {
		return [];
	}

	const files: SessionFileInfo[] = [];
	const projects = fs.readdirSync(projectsDir);

	for (const project of projects) {
		const projectPath = path.join(projectsDir, project);
		if (!fs.statSync(projectPath).isDirectory()) {
			continue;
		}

		const entries = fs.readdirSync(projectPath);
		for (const entry of entries) {
			// 直下のJSONL = 親セッション
			if (entry.endsWith('.jsonl')) {
				files.push({ filePath: path.join(projectPath, entry), isSubagent: false });
			}

			// セッションディレクトリ内の subagents/ を探索
			const sessionDir = path.join(projectPath, entry);
			const subagentsDir = path.join(sessionDir, 'subagents');
			if (fs.existsSync(subagentsDir) && fs.statSync(subagentsDir).isDirectory()) {
				const parentId = entry; // ディレクトリ名 = 親セッションUUID
				try {
					const subFiles = fs.readdirSync(subagentsDir);
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
					// 読み取りエラーはスキップ
				}
			}
		}
	}

	return files;
}

// subagentのmeta.jsonを読み込み
export function readSubagentMeta(jsonlPath: string): { agentType?: string; description?: string } {
	// agent-a{HASH}.jsonl → agent-a{HASH}.meta.json
	const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
	try {
		if (fs.existsSync(metaPath)) {
			const content = fs.readFileSync(metaPath, 'utf-8');
			return JSON.parse(content);
		}
	} catch {
		// パースエラー
	}
	return {};
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

// ツール名を日本語に変換
function toolLabel(name: string): string {
	const map: Record<string, string> = {
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
	return map[name] || `🔧 ${name}`;
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
	// "c--Users-taro-OneDrive-------" のような形式
	// 日本語等の非ASCII文字は '-' にエンコードされるため完全な復元は不可能
	// → cwdFromJsonl があればそちらを優先する
	return dirName
		.replace(/^([a-zA-Z])--/, '$1:\\')
		.replace(/--/g, '\\')
		.replace(/-/g, ' ');
}

// エンコードされたプロジェクトディレクトリ名→実パスのマッピングを構築
// セッションJSONLのcwdフィールドから逆引きする
export function buildProjectPathMap(): Map<string, string> {
	const claudeDir = getClaudeDir();
	const projectsDir = path.join(claudeDir, 'projects');
	const map = new Map<string, string>();

	if (!fs.existsSync(projectsDir)) {
		return map;
	}

	const projects = fs.readdirSync(projectsDir);
	for (const project of projects) {
		const projectPath = path.join(projectsDir, project);
		if (!fs.statSync(projectPath).isDirectory()) {
			continue;
		}

		// JSONLファイルから1つだけcwdを取得
		const entries = fs.readdirSync(projectPath);
		for (const entry of entries) {
			if (!entry.endsWith('.jsonl')) {
				continue;
			}
			const cwd = extractCwdFromJsonl(path.join(projectPath, entry));
			if (cwd) {
				map.set(project, cwd);
				break;
			}
		}
	}

	return map;
}

// JSONLファイルの先頭数行からcwdを抽出（軽量）
function extractCwdFromJsonl(filePath: string): string | undefined {
	try {
		const fd = fs.openSync(filePath, 'r');
		const buf = Buffer.alloc(4096);
		const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
		fs.closeSync(fd);

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
	} catch {
		// ファイル読み取り失敗
	}
	return undefined;
}

// JSONLファイルからセッションをパース
export function parseSessionFile(filePath: string, includeThinking: boolean = false): ParsedSession | null {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
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
			messageCount: messages.length,
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
export function loadAllSessions(maxSessions: number = 500): ParsedSession[] {
	const fileInfos = getSessionFileInfos();
	const sessions: ParsedSession[] = [];

	for (const info of fileInfos) {
		const session = parseSessionQuick(info.filePath);
		if (session) {
			// サブエージェント情報を付与
			if (info.isSubagent) {
				session.isSidechain = true;
				session.parentSessionId = info.parentSessionId;
				// meta.jsonからagentType/descriptionを読み込み
				const meta = readSubagentMeta(info.filePath);
				session.agentType = meta.agentType;
				session.agentDescription = meta.description;
				// agentIdをファイル名から取得
				const hashMatch = path.basename(info.filePath).match(/^agent-a(.+)\.jsonl$/);
				if (hashMatch) {
					session.agentId = hashMatch[1];
				}
			}
			sessions.push(session);
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

// 軽量パース：最初と最後のメッセージだけ読む
function parseSessionQuick(filePath: string): ParsedSession | null {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		let firstUserMessage = '';
		let firstTimestamp: Date | null = null;
		let lastTimestamp: Date | null = null;
		let model: string | undefined;
		let gitBranch: string | undefined;
		let sessionId = '';
		let messageCount = 0;
		let claudeTitle: string | undefined;
		let cwd: string | undefined;
		let isSidechain: boolean | undefined;
		let agentId: string | undefined;

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);

				// cwdを取得（最初に見つかったものを使用）
				if (!cwd && parsed.cwd) {
					cwd = parsed.cwd;
				}

				// サブエージェントフラグ
				if (parsed.isSidechain) {
					isSidechain = true;
				}
				if (parsed.agentId && !agentId) {
					agentId = parsed.agentId;
				}

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

				if (parsed.type !== 'user' && parsed.type !== 'assistant') {
					continue;
				}
				messageCount++;

				const ts = new Date(parsed.timestamp);
				if (!firstTimestamp || ts < firstTimestamp) {
					firstTimestamp = ts;
				}
				if (!lastTimestamp || ts > lastTimestamp) {
					lastTimestamp = ts;
				}

				if (parsed.type === 'user' && parsed.message) {
					if (parsed.sessionId) { sessionId = parsed.sessionId; }
					if (parsed.gitBranch) { gitBranch = parsed.gitBranch; }
					if (!firstUserMessage) {
						const text = extractText(parsed.message.content);
						if (text) {
							firstUserMessage = text.substring(0, 100);
						}
					}
				}
				if (parsed.type === 'assistant' && parsed.message?.model) {
					model = parsed.message.model;
				}
			} catch {
				// スキップ
			}
		}

		if (!firstTimestamp || !lastTimestamp || messageCount === 0) {
			return null;
		}

		const projectDir = path.basename(path.dirname(filePath));
		const project = cwd || decodeProjectName(projectDir);
		const id = sessionId || path.basename(filePath, '.jsonl');

		return {
			id,
			filePath,
			project,
			firstMessage: firstUserMessage || '(内容なし)',
			firstTimestamp,
			lastTimestamp,
			messageCount,
			model,
			gitBranch,
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
export function loadSessionFull(filePath: string, showThinking: boolean = false): ParsedSession | null {
	return parseSessionFile(filePath, showThinking);
}
