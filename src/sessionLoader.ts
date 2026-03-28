import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ParsedSession, SessionMessage, SimpleMessage, ContentBlock } from './types';

// Claude Codeのデータディレクトリを取得
export function getClaudeDir(): string {
	return path.join(os.homedir(), '.claude');
}

// プロジェクトディレクトリ内の全JSONLファイルを取得
export function getSessionFiles(): string[] {
	const claudeDir = getClaudeDir();
	const projectsDir = path.join(claudeDir, 'projects');

	if (!fs.existsSync(projectsDir)) {
		return [];
	}

	const files: string[] = [];
	const projects = fs.readdirSync(projectsDir);

	for (const project of projects) {
		const projectPath = path.join(projectsDir, project);
		if (!fs.statSync(projectPath).isDirectory()) {
			continue;
		}

		const entries = fs.readdirSync(projectPath);
		for (const entry of entries) {
			if (entry.endsWith('.jsonl')) {
				files.push(path.join(projectPath, entry));
			}
		}
	}

	return files;
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
function extractText(content: string | ContentBlock[]): string {
	if (typeof content === 'string') {
		return stripSystemTags(content);
	}
	if (Array.isArray(content)) {
		// テキストブロックを収集
		const texts = content
			.filter((b) => b.type === 'text' && b.text)
			.map((b) => stripSystemTags(b.text!))
			.filter((t) => t.length > 0);

		if (texts.length > 0) {
			return texts.join('\n');
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

// プロジェクト名をディレクトリ名からデコード
function decodeProjectName(dirName: string): string {
	// "c--xampp" → "c:\xampp" のようなデコード
	return dirName
		.replace(/^([a-zA-Z])--/, '$1:\\')
		.replace(/--/g, '\\')
		.replace(/-/g, ' ');
}

// JSONLファイルからセッションをパース
export function parseSessionFile(filePath: string): ParsedSession | null {
	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		const lines = content.split('\n').filter((line) => line.trim());

		const messages: SimpleMessage[] = [];
		let firstUserMessage = '';
		let model: string | undefined;
		let gitBranch: string | undefined;
		let sessionId = '';
		let claudeTitle: string | undefined;

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

		// ファイルパスからプロジェクト名を抽出
		const projectDir = path.basename(path.dirname(filePath));
		const project = decodeProjectName(projectDir);
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
export function loadAllSessions(): ParsedSession[] {
	const files = getSessionFiles();
	const sessions: ParsedSession[] = [];

	for (const file of files) {
		const session = parseSessionQuick(file);
		if (session) {
			sessions.push(session);
		}
	}

	// 最終更新日時で降順ソート
	sessions.sort((a, b) => b.lastTimestamp.getTime() - a.lastTimestamp.getTime());
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
		const project = decodeProjectName(projectDir);
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
		};
	} catch {
		return null;
	}
}

// セッション全メッセージを読み込み（プレビュー用）
export function loadSessionFull(filePath: string): ParsedSession | null {
	return parseSessionFile(filePath);
}
