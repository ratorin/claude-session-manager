// sessionService.ts — セッション作成・遺言生成ロジック
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import { AgentConfig } from '../models/types';
import { parseFrontmatter } from '../utils/frontmatterUtils';

// 依存オブジェクト型（activate() 内のクロージャ変数を注入）
export interface SessionServiceDeps {
	outputChannel: vscode.OutputChannel;
	agentWatcher: { scheduleUpdate(): void };
}

// ファイル末尾を読み取る（巨大JSONL対策）
export async function readFileTail(filePath: string, bytes: number): Promise<string> {
	const handle = await fs.promises.open(filePath, 'r');
	try {
		const stat = await handle.stat();
		if (stat.size === 0) { return ''; }
		const readSize = Math.min(bytes, stat.size);
		const startPos = Math.max(0, stat.size - readSize);
		const buffer = Buffer.alloc(readSize);
		await handle.read(buffer, 0, readSize, startPos);
		return buffer.toString('utf-8');
	} finally {
		await handle.close();
	}
}

// セッション自動作成: claude CLIをspawnしてセッションIDを取得
export async function createSessionForAgent(config: AgentConfig, deps: SessionServiceDeps): Promise<string> {
	const { spawn } = require('child_process') as typeof import('child_process');

	return new Promise<string>((resolve, reject) => {
		// CLI引数を構築（--agentでフロントマターからmodel/effort自動適用）
		const args: string[] = [
			'--agent', config.name,
			'--verbose',
			'--output-format', 'stream-json',
			'--max-turns', '1',
			'-p', `あなたは「${config.name}」です。${config.role || '指示された業務'}を担当します。ルールファイルを確認して準備完了を報告してください。`,
		];

		// 環境変数: ネストセッション検出を回避
		const env = { ...process.env };
		delete env.CLAUDE_CODE;
		delete env.CLAUDECODE;

		// C-2: shell:false でコマンドインジェクションを防止
		// Windows環境では .cmd 拡張子が必要
		const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
		const child = spawn(claudeCmd, args, {
			env,
			cwd: config.workDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true,
		});

		let output = '';
		let sessionId = '';
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error('セッション作成がタイムアウトしました（60秒）'));
		}, 60000);

		child.stdout?.on('data', (data: Buffer) => {
			output += data.toString('utf-8');
			// stream-json形式: 各行が独立したJSON
			const lines = output.split('\n');
			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const parsed = JSON.parse(line);
					// セッションIDは init / system / result メッセージに含まれる
					if (parsed.session_id) {
						sessionId = parsed.session_id;
					}
				} catch {
					// 不完全な行は次回に持ち越し
				}
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			deps.outputChannel.appendLine(`[createSession stderr] ${data.toString('utf-8').trim()}`);
		});

		child.on('close', (code: number | null) => {
			clearTimeout(timeout);
			// セッション初期化プロセス終了時にagentWatcherを再スキャン
			deps.agentWatcher.scheduleUpdate();
			if (sessionId) {
				resolve(sessionId);
			} else if (code === 0) {
				// 終了コード0でもsessionIdが取れなかった場合: 出力からフォールバック検索
				const match = output.match(/"session_id"\s*:\s*"([a-f0-9-]{36})"/);
				if (match) {
					resolve(match[1]);
				} else {
					reject(new Error('セッションIDを取得できませんでした'));
				}
			} else {
				reject(new Error(`claude CLI がエラーコード ${code} で終了しました`));
			}
		});

		child.on('error', (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

// セッション更新（renew）: --agent で新セッション作成（引き継ぎメッセージ付き）
export async function createRenewSession(agentName: string, initPrompt: string, deps: SessionServiceDeps): Promise<string> {
	const { spawn } = require('child_process') as typeof import('child_process');

	return new Promise<string>((resolve, reject) => {
		const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
		const args = [
			'--agent', agentName,
			'-p', initPrompt,
			'--permission-mode', 'acceptEdits',
			'--output-format', 'stream-json',
			'--max-turns', '1',
		];

		const env = { ...process.env };
		delete env.CLAUDE_CODE;
		delete env.CLAUDECODE;

		const child = spawn(claudeCmd, args, {
			env,
			cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir(),
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
			windowsHide: true,
		});

		let output = '';
		let sessionId = '';
		const timeout = setTimeout(() => {
			child.kill('SIGTERM');
			reject(new Error('新セッション作成がタイムアウトしました（120秒）'));
		}, 120000);

		child.stdout?.on('data', (data: Buffer) => {
			output += data.toString('utf-8');
			const lines = output.split('\n');
			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const parsed = JSON.parse(line);
					if (parsed.session_id) {
						sessionId = parsed.session_id;
					}
				} catch {
					// 不完全な行は次回に持ち越し
				}
			}
		});

		child.stderr?.on('data', (data: Buffer) => {
			deps.outputChannel.appendLine(`[renew stderr] ${data.toString('utf-8').trim()}`);
		});

		child.on('close', (code: number | null) => {
			clearTimeout(timeout);
			deps.agentWatcher.scheduleUpdate();
			if (sessionId) {
				resolve(sessionId);
			} else if (code === 0) {
				const match = output.match(/"session_id"\s*:\s*"([a-f0-9-]{36})"/);
				if (match) {
					resolve(match[1]);
				} else {
					reject(new Error('セッションIDを取得できませんでした'));
				}
			} else {
				reject(new Error(`claude CLI がエラーコード ${code} で終了しました`));
			}
		});

		child.on('error', (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

// エージェント保存時にセッションを自動作成（固定セッション＋sessionId未設定の場合）
export async function autoCreateSessionIfNeeded(config: AgentConfig, deps: SessionServiceDeps): Promise<AgentConfig> {
	// 使い捨てセッション or 既にsessionIdがある場合はスキップ
	if (config.sessionMode === 'disposable' || config.sessionId) {
		return config;
	}

	try {
		const sessionId = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `「${config.name}」のセッションを作成中...`,
				cancellable: false,
			},
			async () => createSessionForAgent(config, deps)
		);

		deps.outputChannel.appendLine(`[INFO] ${config.name} のセッションを自動作成: ${sessionId}`);
		return { ...config, sessionId };
	} catch (err) {
		// エラー時はsessionId無しで保存（従来と同じ動作にフォールバック）
		deps.outputChannel.appendLine(`[WARN] ${config.name} のセッション自動作成に失敗: ${err}`);
		vscode.window.showWarningMessage(
			`セッションの自動作成に失敗しました。エージェントはセッション未紐づけで保存されます。`
		);
		return config;
	}
}

// 簡易遺言生成: JSONL末尾から直近のやり取りを抽出（コストゼロ・即時）
export async function generateSimpleTestament(agent: AgentConfig, oldSession: { filePath: string } | undefined): Promise<string> {
	let testament = `${agent.name}の前セッションから引き継ぎ。`;
	if (!oldSession) { return testament; }
	try {
		const tail = await readFileTail(oldSession.filePath, 128 * 1024); // 128KB
		const lines = tail.split('\n').filter((l: string) => l.trim());
		// 先頭行は途中で切れている可能性があるのでスキップ
		if (lines.length > 1) { lines.shift(); }
		const summaryParts: string[] = [];
		const recentLines = lines.slice(-50);
		for (const line of recentLines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === 'user' && entry.message?.role === 'user' && typeof entry.message.content === 'string') {
					summaryParts.push(`[User] ${entry.message.content.substring(0, 200)}`);
				} else if (entry.type === 'assistant' && entry.message?.role === 'assistant') {
					const text = typeof entry.message.content === 'string'
						? entry.message.content
						: Array.isArray(entry.message.content)
							? entry.message.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
							: '';
					if (text) {
						summaryParts.push(`[Assistant] ${text.substring(0, 300)}`);
					}
				}
			} catch { /* パース失敗は無視 */ }
		}
		if (summaryParts.length > 0) {
			const lastParts = summaryParts.slice(-4);
			testament = `${agent.name}の前セッション引き継ぎ:\n${lastParts.join('\n')}`;
		}
	} catch {
		// 読み込み失敗時はデフォルトメッセージのまま
	}
	return testament;
}

// 詳細遺言生成: 本人のセッションに直接聞く（--resume -p）
export async function generateDetailedTestament(agent: AgentConfig, oldSession: { filePath: string } | undefined, modelOrSessionId: string): Promise<string> {
	if (!agent.sessionId && !modelOrSessionId) { return `${agent.name}の前セッションから引き継ぎ。`; }
	try {
		const prompt = 'このセッションで何をしたか・何が達成されたか・何が未完了かを300文字以内で簡潔に要約してください。次のセッションへの引き継ぎ情報として使います。テキストのみで回答してください。';

		// セッションIDで本人 or 委任先に --resume
		const targetSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(modelOrSessionId)
			? modelOrSessionId
			: agent.sessionId;

		const cliArgs = targetSessionId
			? ['--resume', targetSessionId, '-p', prompt]
			: ['--agent', agent.name, '-p', prompt];

		const result = await new Promise<string>((resolve, reject) => {
			const { spawn } = require('child_process') as typeof import('child_process');
			const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
			const env = { ...process.env };
			delete env.CLAUDE_CODE;
			delete env.CLAUDECODE;
			const proc = spawn(claudeCmd, cliArgs, {
				env,
				shell: false,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			proc.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
			proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
			proc.on('close', (code: number | null) => {
				if (stdout.trim()) {
					resolve(stdout.trim());
				} else if (code !== 0 && code !== null) {
					reject(new Error(`exit ${code}: ${stderr.substring(0, 200)}`));
				} else {
					resolve('');
				}
			});
			proc.on('error', (err: Error) => reject(err));
			proc.stdin?.end();
		});
		return result || `${agent.name}の前セッションから引き継ぎ。`;
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		vscode.window.showWarningMessage(`AI要約の生成に失敗しました（${errMsg.substring(0, 100)}）。簡易モードにフォールバックします。`);
		return generateSimpleTestament(agent, oldSession);
	}
}

// ルールファイルの本文に「歴代セッションの記録」を追記（直近3世代保持）
export async function appendSessionHistoryToRuleFile(ruleFilePath: string, oldSessionId: string, testament: string, outputChannel: vscode.OutputChannel): Promise<void> {
	const HISTORY_HEADER = '## 歴代セッションの記録';
	const MAX_GENERATIONS = 3;

	try {
		let content = await fs.promises.readFile(ruleFilePath, 'utf-8');

		// 日付文字列
		const dateStr = new Date().toISOString().split('T')[0];
		const newEntry = `### ${dateStr} (旧ID: ${oldSessionId})\n${testament}`;

		const historyIdx = content.indexOf(HISTORY_HEADER);
		if (historyIdx >= 0) {
			// 既存の歴代セクションを解析
			const sectionStart = historyIdx;
			const afterHeader = content.substring(sectionStart + HISTORY_HEADER.length);
			const nextSectionMatch = afterHeader.match(/\n\n## [^#]/);
			const sectionEnd = nextSectionMatch
				? sectionStart + HISTORY_HEADER.length + (nextSectionMatch.index ?? afterHeader.length)
				: content.length;
			const sectionBody = content.substring(sectionStart + HISTORY_HEADER.length, sectionEnd);

			// ### で始まるエントリを抽出
			const entries: string[] = [];
			const entryRegex = /### .+/g;
			let match;
			const entryStarts: number[] = [];
			while ((match = entryRegex.exec(sectionBody)) !== null) {
				entryStarts.push(match.index);
			}
			for (let i = 0; i < entryStarts.length; i++) {
				const start = entryStarts[i];
				const end = i + 1 < entryStarts.length ? entryStarts[i + 1] : sectionBody.length;
				entries.push(sectionBody.substring(start, end).trim());
			}

			// 新エントリを追加し、直近3世代に制限
			entries.push(newEntry);
			while (entries.length > MAX_GENERATIONS) { entries.shift(); }

			// セクションを再構築
			const newSection = HISTORY_HEADER + '\n\n' + entries.join('\n\n') + '\n';
			content = content.substring(0, sectionStart) + newSection + content.substring(sectionEnd);
		} else {
			// 歴代セクションが存在しない → フロントマター直後（本文の先頭）に追加
			const parsed = parseFrontmatter(content);
			if (parsed) {
				const fm = content.substring(0, content.length - parsed.body.length);
				const newSection = HISTORY_HEADER + '\n\n' + newEntry + '\n\n';
				content = fm + newSection + parsed.body;
			} else {
				content += '\n\n' + HISTORY_HEADER + '\n\n' + newEntry + '\n';
			}
		}

		await fs.promises.writeFile(ruleFilePath, content, 'utf-8');
	} catch (err) {
		outputChannel.appendLine(`[${new Date().toISOString()}] appendSessionHistoryToRuleFile エラー: ${err instanceof Error ? err.message : String(err)}`);
	}
}
