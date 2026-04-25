#!/usr/bin/env node
// CSM-VERSION: 0.4.7
/**
 * CSM PreCompact hook — コンパクション前にCSM_SUMMARYを生成し文脈を保持
 * CSM v0.4.7+
 *
 * 入力: stdin JSON { session_id, transcript_path, hook_event_name, cwd, ... }
 * 動作:
 *   1. JSONL トランスクリプトの末尾から直近のやり取りを抽出
 *   2. CSM_SUMMARY マーカー付きで要約を生成
 *   3. ~/.claude/projects/<encoded_cwd>/csm-compact-summary.md に保存
 *      → 次回 SessionStart 時に CSM が文脈として読み込める
 *   4. stdout に {} を出力（コンパクションをブロックしない）
 *
 * Node.js のみ使用（bash/python 不要 → Windows 素環境対応）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// cwd を Claude Code のプロジェクトフォルダ名形式にエンコード
function encodeCwd(cwd) {
	return cwd
		.toLowerCase()
		.replace(/\\/g, '/')
		.replace(/^([a-z]):/, '$1-')
		.replace(/[\s/]/g, '-');
}

function main() {
	let input;
	try {
		const raw = fs.readFileSync(0, 'utf-8');
		input = JSON.parse(raw);
	} catch {
		process.stdout.write('{}');
		return;
	}

	const sessionId = input.session_id;
	const transcriptPath = input.transcript_path;
	const cwd = input.cwd || process.cwd();

	if (!sessionId) {
		process.stdout.write('{}');
		return;
	}

	// session-manager.json からエージェント名を取得（あれば）
	let agentName = '';
	try {
		const smPath = path.join(os.homedir(), '.claude', 'session-manager.json');
		const data = JSON.parse(fs.readFileSync(smPath, 'utf-8'));
		const bindings = data.agentSessions || {};
		for (const [name, info] of Object.entries(bindings)) {
			if (info && info.sessionId === sessionId) { agentName = name; break; }
		}
	} catch { /* 無視 */ }

	// トランスクリプト末尾からやり取りを抽出
	if (!transcriptPath || !fs.existsSync(transcriptPath)) {
		process.stdout.write('{}');
		return;
	}

	let tail = '';
	try {
		const stat = fs.statSync(transcriptPath);
		const readSize = Math.min(65536, stat.size);
		const fd = fs.openSync(transcriptPath, 'r');
		try {
			const buf = Buffer.alloc(readSize);
			fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
			tail = buf.toString('utf-8');
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		process.stdout.write('{}');
		return;
	}

	const lines = tail.split('\n').filter(l => l.trim());
	const safeLines = lines.length > 1 ? lines.slice(1) : lines;

	// ツール使用・ユーザー発言・アシスタント発言を収集
	const tasks = [];
	const parts = [];
	let userMsgCount = 0;
	let toolCount = 0;

	for (const line of safeLines) {
		try {
			const entry = JSON.parse(line);
			const msg = entry.message || {};

			if (entry.type === 'user' && msg.role === 'user') {
				userMsgCount++;
				const c = msg.content;
				if (typeof c === 'string' && c && !c.startsWith('<')) {
					parts.push('[User] ' + c.substring(0, 120));
				} else if (Array.isArray(c)) {
					for (const b of c) {
						if (b && b.type === 'text' && b.text && !b.text.startsWith('<')) {
							parts.push('[User] ' + b.text.substring(0, 120));
							break;
						}
						if (b && b.type === 'tool_result') {
							toolCount++;
						}
					}
				}
			} else if (entry.type === 'assistant' && msg.role === 'assistant') {
				const c = msg.content;
				if (typeof c === 'string' && c) {
					parts.push('[Asst] ' + c.substring(0, 180));
				} else if (Array.isArray(c)) {
					// tool_use を tasks に収集
					for (const b of c) {
						if (b && b.type === 'tool_use' && b.name) {
							tasks.push(b.name);
						}
					}
					const text = c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
					if (text) { parts.push('[Asst] ' + text.substring(0, 180)); }
				}
			}
		} catch { /* skip */ }
	}

	if (parts.length === 0 && tasks.length === 0) {
		process.stdout.write('{}');
		return;
	}

	// CSM_SUMMARY マーカー付きで要約を生成
	const now = new Date();
	const dateStr = now.toISOString().substring(0, 10);
	const timeStr = now.toTimeString().substring(0, 5);

	const summaryLines = [];
	summaryLines.push(`## Session Summary`);
	summaryLines.push('');
	summaryLines.push(`### Tasks`);

	// 直近のユーザー発言をタスクとして抽出（最大10件）
	const recentUserMsgs = parts.filter(p => p.startsWith('[User]')).slice(-10);
	for (const msg of recentUserMsgs) {
		summaryLines.push('- ' + msg.replace(/^\[User\] /, ''));
	}
	if (recentUserMsgs.length === 0) {
		summaryLines.push('- (no user messages found)');
	}

	summaryLines.push('');
	summaryLines.push('### Tools Used');
	const uniqueTools = [...new Set(tasks)];
	summaryLines.push(uniqueTools.length > 0 ? uniqueTools.join(', ') : '(none)');

	summaryLines.push('');
	summaryLines.push('### Stats');
	summaryLines.push(`- Total user messages: ${userMsgCount}`);

	if (agentName) {
		summaryLines.push(`- Agent: ${agentName}`);
	}

	summaryLines.push('');
	summaryLines.push('### Notes for Next Session');
	summaryLines.push('-');
	summaryLines.push('');
	summaryLines.push('### Context to Load');
	summaryLines.push('```');
	summaryLines.push('[relevant files]');
	summaryLines.push('```');

	const sessionLabel = agentName || sessionId.substring(0, 8);
	const header = [
		`# Session: ${dateStr}`,
		`**Date:** ${dateStr}`,
		`**Started:** ${timeStr}`,
		agentName ? `**Agent:** ${agentName}` : `**Session:** ${sessionId.substring(0, 8)}`,
		`**Branch:** (see git status)`,
		`**Worktree:** ${cwd}`,
		'',
		'---',
		'<!-- ECC:SUMMARY:START -->',
	].join('\n');

	const footer = [
		'<!-- ECC:SUMMARY:END -->',
		'',
		`### Notes for Next Session`,
		'-',
		'',
		`### Context to Load`,
		'```',
		'[relevant files]',
		'```',
		'',
		'---',
		`**[Compaction occurred at ${timeStr}]** - Context was summarized`,
		'',
	].join('\n');

	const summaryBody = summaryLines.join('\n');
	const fullSummary = `${header}\n${summaryBody}\n${footer}`;

	// ~/.claude/projects/<encoded_cwd>/csm-compact-summary.md に保存
	try {
		const encodedCwd = encodeCwd(cwd);
		const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedCwd);
		fs.mkdirSync(projectDir, { recursive: true });
		const summaryFile = path.join(projectDir, 'csm-compact-summary.md');

		// セッションラベルとコンパクション時刻をヘッダーに付加
		const fileContent = [
			`<!-- CSM_SUMMARY:START session="${sessionLabel}" compacted_at="${dateStr}T${timeStr}" -->`,
			fullSummary,
			`<!-- CSM_SUMMARY:END -->`,
		].join('\n') + '\n';

		fs.writeFileSync(summaryFile, fileContent, 'utf-8');
	} catch { /* 保存失敗は無視 */ }

	// コンパクションをブロックしない
	process.stdout.write('{}');
}

main();
