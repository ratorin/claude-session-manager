#!/usr/bin/env node
/**
 * CSM session-summary.js — Stop フック用スクリプト
 *
 * セッション終了時に JSONL からセッション内容を抽出し、
 * Claude CLI（claude -p）で日本語3行要約を生成して
 * session-manager.json の notes に記録する。
 *
 * Claude CLI が失敗した場合はヒューリスティックによる簡易要約にフォールバック。
 *
 * 入力: stdin（Stop フックからのセッションデータ）
 * 出力: stdout（stdin をそのままパススルー）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// ── 定数 ──────────────────────────────
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const DATA_FILE = path.join(CLAUDE_DIR, 'session-manager.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TAIL_SIZE = 48 * 1024; // 48KB
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 100;
const CLAUDE_TIMEOUT_MS = 90000; // 90秒

// ── stdin パススルー（同期） ──────────────────
let stdinData = '';
try {
	stdinData = fs.readFileSync(0, 'utf8');
} catch (e) { /* stdin読み取り失敗 */ }
process.stdout.write(stdinData);

// ── セッションIDを取得 ─────────────────────
function extractSessionId() {
	// stdin JSON から取得（複数行）
	const lines = stdinData.split('\n').filter(function(l) { return l.trim(); });
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			const obj = JSON.parse(lines[i]);
			if (obj.sessionId) return obj.sessionId;
			if (obj.session_id) return obj.session_id;
		} catch (e) { /* skip */ }
	}
	// 単一JSONの場合
	try {
		const obj = JSON.parse(stdinData);
		if (obj.sessionId) return obj.sessionId;
		if (obj.session_id) return obj.session_id;
		// transcript_path からUUID推測
		const tp = obj.transcript_path || '';
		const m = tp.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
		if (m) return m[1];
	} catch (e) { /* skip */ }
	// 環境変数フォールバック
	return process.env.SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
}

// ── JSONL ファイル検索 ─────────────────────
function findSessionJsonl(sessionId) {
	try {
		const projects = fs.readdirSync(PROJECTS_DIR);
		for (const project of projects) {
			const candidate = path.join(PROJECTS_DIR, project, sessionId + '.jsonl');
			if (fs.existsSync(candidate)) return candidate;
		}
	} catch (e) { /* skip */ }
	return null;
}

// ── ファイル末尾読み取り ─────────────────────
function readTail(filePath, bytes) {
	try {
		const fd = fs.openSync(filePath, 'r');
		try {
			const stat = fs.fstatSync(fd);
			const size = stat.size;
			const readSize = Math.min(bytes, size);
			const start = Math.max(0, size - readSize);
			const buf = Buffer.alloc(readSize);
			fs.readSync(fd, buf, 0, readSize, start);
			return buf.toString('utf-8');
		} finally {
			fs.closeSync(fd);
		}
	} catch (e) {
		return '';
	}
}

// ── セッション内容を抽出 ─────────────────────
function extractSessionContent(jsonlPath) {
	const tailText = readTail(jsonlPath, TAIL_SIZE);
	if (!tailText) return '';

	const messages = [];
	const toolsUsed = new Set();
	const filesModified = new Set();
	const lines = tailText.split('\n').filter(function(l) { return l.trim(); });

	for (const line of lines) {
		try {
			const obj = JSON.parse(line);

			// ユーザーメッセージ
			if ((obj.type === 'human' || obj.type === 'user') && obj.message && obj.message.content) {
				let text = '';
				if (typeof obj.message.content === 'string') {
					text = obj.message.content;
				} else if (Array.isArray(obj.message.content)) {
					text = obj.message.content
						.filter(function(b) { return b.type === 'text'; })
						.map(function(b) { return b.text || ''; })
						.join(' ');
				}
				// system-reminder は除外
				if (text.length > 5 && !text.startsWith('<system-reminder>')) {
					messages.push('User: ' + text.substring(0, 200));
				}
			}

			// アシスタントメッセージ
			if (obj.type === 'assistant' && obj.message && obj.message.content) {
				const contents = Array.isArray(obj.message.content) ? obj.message.content : [];
				for (const block of contents) {
					if (block.type === 'text' && block.text && block.text.length > 10) {
						messages.push('Assistant: ' + block.text.substring(0, 200));
					}
					if (block.type === 'tool_use') {
						toolsUsed.add(block.name);
						if (block.input) {
							const fp = block.input.file_path || block.input.path || '';
							if (fp) filesModified.add(path.basename(fp));
						}
					}
				}
			}
		} catch (e) { /* skip */ }
	}

	// コンテキスト構築
	let context = '';
	if (toolsUsed.size > 0) {
		context += 'Tools: ' + Array.from(toolsUsed).join(', ') + '\n';
	}
	if (filesModified.size > 0) {
		context += 'Files: ' + Array.from(filesModified).slice(0, 15).join(', ') + '\n';
	}
	context += '\nConversation:\n';
	context += messages.slice(-20).join('\n');
	return context;
}

// ── Claude CLI で要約生成 ─────────────────────
function generateSummaryWithClaude(content) {
	// 4000文字に制限
	const truncated = content.length > 4000
		? content.substring(content.length - 4000)
		: content;

	const promptLines = [
		'以下はClaude Codeセッションの会話ログ抜粋です。日本語3行で簡潔に要約してください。',
		'',
		'各行の形式:',
		'1行目: 主なタスク・目的',
		'2行目: 実施した作業内容',
		'3行目: 結果・現在の状態',
		'',
		'3行のみ出力してください。前置きや説明は不要です。',
		'',
		'---',
		truncated
	];
	const prompt = promptLines.join('\n');

	try {
		const result = spawnSync('claude', ['-p', prompt], {
			encoding: 'utf-8',
			timeout: CLAUDE_TIMEOUT_MS,
			windowsHide: true,
			env: Object.assign({}, process.env),
		});

		if (result.status === 0 && result.stdout && result.stdout.trim()) {
			return result.stdout.trim();
		}
		if (result.stderr) {
			process.stderr.write('[session-summary] Claude stderr: ' + result.stderr.substring(0, 300) + '\n');
		}
		if (result.error) {
			process.stderr.write('[session-summary] Claude error: ' + result.error.message + '\n');
		}
	} catch (err) {
		process.stderr.write('[session-summary] Claude CLI exception: ' + err.message + '\n');
	}
	return null;
}

// ── フォールバック要約（ヒューリスティック） ──────────
function generateFallbackSummary(jsonlPath) {
	const tailText = readTail(jsonlPath, TAIL_SIZE);
	if (!tailText) return null;

	const lines = tailText.split('\n').filter(function(l) { return l.trim(); });
	let firstUserMsg = '';
	let lastUserMsg = '';
	const toolsUsed = new Set();
	const filesModified = new Set();

	for (const line of lines) {
		try {
			const obj = JSON.parse(line);
			if ((obj.type === 'human' || obj.type === 'user') && obj.message && obj.message.content) {
				const text = typeof obj.message.content === 'string' ? obj.message.content : '';
				if (text.length > 5 && !text.startsWith('<system-reminder>')) {
					if (!firstUserMsg) firstUserMsg = text.substring(0, 100);
					lastUserMsg = text.substring(0, 100);
				}
			}
			if (obj.type === 'assistant' && obj.message && obj.message.content) {
				const contents = Array.isArray(obj.message.content) ? obj.message.content : [];
				for (const block of contents) {
					if (block.type === 'tool_use') {
						toolsUsed.add(block.name);
						if (block.input) {
							const fp = block.input.file_path || block.input.path || '';
							if (fp && (block.name === 'Edit' || block.name === 'Write')) {
								filesModified.add(path.basename(fp));
							}
						}
					}
				}
			}
		} catch (e) { /* skip */ }
	}

	if (!firstUserMsg) return null;

	const tools = Array.from(toolsUsed).slice(0, 6).join(', ') || 'なし';
	const files = Array.from(filesModified).slice(0, 5).join(', ') || 'なし';
	return 'タスク: ' + firstUserMsg + '\n変更: ' + files + ' (ツール: ' + tools + ')\n最終: ' + lastUserMsg;
}

// ── ロック（同期版） ──────────────────────
function acquireLockSync(lockPath) {
	const maxWait = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			const lockData = JSON.stringify({
				pid: process.pid,
				createdAt: new Date().toISOString()
			});
			fs.writeFileSync(lockPath, lockData, { flag: 'wx' });
			return true;
		} catch (e) {
			if (e.code === 'EEXIST') {
				try {
					const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
					let alive = false;
					try { process.kill(lock.pid, 0); alive = true; } catch (e2) { /* dead */ }
					const age = Date.now() - new Date(lock.createdAt).getTime();
					if (!alive || age > LOCK_TIMEOUT_MS) {
						try { fs.unlinkSync(lockPath); } catch (e3) { /* ignore */ }
						continue;
					}
				} catch (e2) {
					try { fs.unlinkSync(lockPath); } catch (e3) { /* ignore */ }
					continue;
				}
				if (Date.now() >= maxWait) return false;
				// 短いスリープ代替
				spawnSync('node', ['-e', ''], { timeout: LOCK_POLL_MS });
				continue;
			}
			return false;
		}
	}
}

function releaseLock(lockPath) {
	try { fs.unlinkSync(lockPath); } catch (e) { /* ignore */ }
}

// ── メイン処理 ─────────────────────────
function main() {
	// 1. セッションIDを取得
	const sessionId = extractSessionId();
	if (!sessionId) {
		process.stderr.write('[session-summary] No session ID found. Skip.\n');
		return;
	}

	// 2. session-manager.json を読む
	let data;
	try {
		data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
	} catch (e) {
		process.stderr.write('[session-summary] Cannot read session-manager.json. Skip.\n');
		return;
	}

	// 3. 既にノートがある場合はスキップ（手動ノートの上書き防止）
	//    前回の自動要約のみの場合は更新を許可
	const existingNote = (data.notes && data.notes[sessionId]) || '';
	const isAutoNote = existingNote.startsWith('[自動要約]') || existingNote.startsWith('[自動要約（簡易）]');
	if (existingNote.trim() && !isAutoNote) {
		return;
	}

	// 4. JSONL を検索
	const jsonlPath = findSessionJsonl(sessionId);
	if (!jsonlPath) return; // JSONL が無いセッション（print mode等）

	// 5. セッション内容を抽出
	const content = extractSessionContent(jsonlPath);
	if (!content || content.length < 50) return; // 短すぎるセッション

	// 6. Claude CLI で要約生成
	process.stderr.write('[session-summary] Generating summary... (' + sessionId.substring(0, 8) + ')\n');
	let summary = generateSummaryWithClaude(content);
	let isAI = true;

	// 7. フォールバック
	if (!summary) {
		process.stderr.write('[session-summary] Claude CLI failed. Using fallback.\n');
		summary = generateFallbackSummary(jsonlPath);
		isAI = false;
	}
	if (!summary) return;

	// 8. session-manager.json に書き込み（ロック付き）
	const lockPath = DATA_FILE + '.summary.lock';
	if (!acquireLockSync(lockPath)) {
		process.stderr.write('[session-summary] Lock acquisition failed. Skip.\n');
		return;
	}

	try {
		// 最新データを再読み込み（他のフックとの競合回避）
		try {
			data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
		} catch (e) { return; }

		data.notes = data.notes || {};
		data.agentSessions = data.agentSessions || {};

		// レース条件対策: 再チェック
		const recheck = data.notes[sessionId] || '';
		const recheckIsAuto = recheck.startsWith('[自動要約]') || recheck.startsWith('[自動要約（簡易）]');
		if (recheck.trim() && !recheckIsAuto) return;

		const label = isAI ? '[自動要約]' : '[自動要約（簡易）]';
		data.notes[sessionId] = label + '\n' + summary;
		fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
		process.stderr.write('[session-summary] Summary saved: ' + sessionId.substring(0, 8) + '...\n');

		// HISTORY.md に自動追記（エージェントに紐づいているセッションのみ）
		try {
			var agentName = null;
			for (var name in data.agentSessions) {
				if (data.agentSessions[name] && data.agentSessions[name].sessionId === sessionId) {
					agentName = name;
					break;
				}
			}
			if (agentName) {
				var historyPath = path.join(CLAUDE_DIR, 'agents', agentName, 'HISTORY.md');
				if (fs.existsSync(historyPath)) {
					var dateStr = new Date().toISOString().split('T')[0];
					var timeStr = new Date().toTimeString().substring(0, 5);
					var entry = '\n### ' + dateStr + ' ' + timeStr + ' (セッション終了・自動記録)\n' + summary + '\n';
					fs.appendFileSync(historyPath, entry, 'utf-8');
					process.stderr.write('[session-summary] HISTORY.md updated: ' + agentName + '\n');
				}
			}
		} catch (histErr) {
			process.stderr.write('[session-summary] HISTORY.md error: ' + histErr.message + '\n');
		}
	} finally {
		releaseLock(lockPath);
	}
}

try {
	main();
} catch (err) {
	process.stderr.write('[session-summary] Error: ' + err.message + '\n');
}
