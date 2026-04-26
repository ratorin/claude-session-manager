#!/usr/bin/env node
/**
 * CSM Stop hook — セッション終了時にエージェントのHISTORY.mdへ要約を追記
 * CSM v0.4.5+
 *
 * 入力: stdin JSON { session_id, transcript_path, hook_event_name, ... }
 * 条件:
 *   - session_id が session-manager.json の agentSessions 内に存在
 *   - そのエージェントの historyEnabled フロントマターが true
 *   - HISTORY.md がエージェントフォルダに存在
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

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
	if (!sessionId) { process.stdout.write('{}'); return; }

	const home = os.homedir();

	// session-manager.json からエージェント名を特定
	let agentName = '';
	try {
		const smPath = path.join(home, '.claude', 'session-manager.json');
		const data = JSON.parse(fs.readFileSync(smPath, 'utf-8'));
		const bindings = data.agentSessions || {};
		for (const [name, info] of Object.entries(bindings)) {
			if (info && info.sessionId === sessionId) { agentName = name; break; }
		}
	} catch {
		process.stdout.write('{}');
		return;
	}
	if (!agentName) { process.stdout.write('{}'); return; }

	// エージェント定義 .md を プロジェクト優先 → グローバル の順で検索。
	// デフォルトは scope-follows-md（見つかったスコープに書く）。
	// フロントマターに historyScope: "global" | "project" があれば強制。
	const cwd = input.cwd || process.cwd();
	const globalHistory = path.join(home, '.claude', 'agents', agentName, 'HISTORY.md');
	const projectHistory = path.join(cwd, '.claude', 'agents', agentName, 'HISTORY.md');
	const scopedLookup = [
		{ scope: 'project', md: path.join(cwd, '.claude', 'agents', `${agentName}.md`), history: projectHistory },
		{ scope: 'global', md: path.join(home, '.claude', 'agents', `${agentName}.md`), history: globalHistory },
	];

	let historyEnabled = false;
	let historyPath = '';
	let overrideScope = '';
	for (const { md, history } of scopedLookup) {
		if (!fs.existsSync(md)) { continue; }
		try {
			const content = fs.readFileSync(md, 'utf-8');
			const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (!m) { continue; }
			if (!/^historyEnabled:\s*true\s*$/m.test(m[1])) { continue; }
			historyEnabled = true;
			// historyScope 上書き
			const sm = m[1].match(/^historyScope:\s*["']?(global|project)["']?\s*$/m);
			if (sm) { overrideScope = sm[1]; }
			historyPath = history;
			break;
		} catch { /* next */ }
	}
	if (!historyEnabled) { process.stdout.write('{}'); return; }
	// overrideScope が指定されていれば差し替え
	if (overrideScope === 'global') { historyPath = globalHistory; }
	else if (overrideScope === 'project') { historyPath = projectHistory; }
	if (!historyPath || !fs.existsSync(historyPath)) { process.stdout.write('{}'); return; }

	// transcript末尾から要約を生成
	if (!transcriptPath || !fs.existsSync(transcriptPath)) { process.stdout.write('{}'); return; }

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
	// 先頭行は途中切れの可能性
	const safeLines = lines.length > 1 ? lines.slice(1) : lines;

	const parts = [];
	for (const line of safeLines.slice(-20)) {
		try {
			const entry = JSON.parse(line);
			const msg = entry.message || {};
			if (entry.type === 'user' && msg.role === 'user') {
				const c = msg.content;
				if (typeof c === 'string' && c) {
					parts.push('[User] ' + c.substring(0, 100));
				}
			} else if (entry.type === 'assistant' && msg.role === 'assistant') {
				const c = msg.content;
				if (typeof c === 'string' && c) {
					parts.push('[Asst] ' + c.substring(0, 150));
				} else if (Array.isArray(c)) {
					const text = c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
					if (text) { parts.push('[Asst] ' + text.substring(0, 150)); }
				}
			}
		} catch { /* skip */ }
	}

	if (parts.length === 0) { process.stdout.write('{}'); return; }

	const now = new Date();
	const dateStr = now.toISOString().substring(0, 10);
	const timeStr = now.toTimeString().substring(0, 5);
	const summary = parts.slice(-4).join('\n');
	const entryText = `\n### ${dateStr} ${timeStr} (セッション終了時自動記録)\n${summary}\n`;

	try {
		fs.appendFileSync(historyPath, entryText, 'utf-8');
	} catch { /* noop */ }
	process.stdout.write('{}');
}

main();
