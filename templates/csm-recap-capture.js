#!/usr/bin/env node
// CSM-VERSION: 0.4.7
/**
 * CSM Recap Capture hook — セッション終了時に /recap 結果を HISTORY.md へ自動追記
 * CSM v0.4.7+
 *
 * 入力: stdin JSON { session_id, transcript_path, hook_event_name, cwd, ... }
 * 動作:
 *   1. JSONL トランスクリプトを走査し、/recap 呼び出しと直後のアシスタント応答を検出
 *   2. agentSessions で session_id → エージェント名を解決
 *   3. エージェントの historyEnabled が true かつ HISTORY.md が存在する場合のみ追記
 *   4. csm-session-stop.js との重複回避: recap セクションのみを書き込む
 *
 * 対象: historyEnabled: true のエージェントセッション
 * 出力先: ~/.claude/agents/<name>/HISTORY.md または <cwd>/.claude/agents/<name>/HISTORY.md
 * 非対象: csm-compact-summary.md（そちらは csm-precompact-summary.js が担当）
 *
 * Node.js のみ使用（bash/python 不要 → Windows 素環境対応）
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

	// エージェント定義 .md を プロジェクト優先 → グローバル の順で検索
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
	if (overrideScope === 'global') { historyPath = globalHistory; }
	else if (overrideScope === 'project') { historyPath = projectHistory; }
	if (!historyPath || !fs.existsSync(historyPath)) { process.stdout.write('{}'); return; }

	// トランスクリプト全体を読み込み /recap ペアを検出
	if (!transcriptPath || !fs.existsSync(transcriptPath)) { process.stdout.write('{}'); return; }

	let allLines = [];
	try {
		const raw = fs.readFileSync(transcriptPath, 'utf-8');
		allLines = raw.split('\n').filter(l => l.trim());
	} catch {
		process.stdout.write('{}');
		return;
	}

	// 先頭行は途中切れの可能性があるためスキップ
	const safeLines = allLines.length > 1 ? allLines.slice(1) : allLines;

	// JSONL をパースして entries 配列に変換
	const entries = [];
	for (const line of safeLines) {
		try {
			entries.push(JSON.parse(line));
		} catch { /* skip */ }
	}

	/**
	 * /recap 検出: ユーザーメッセージのテキストが /recap で始まる行を探し、
	 * その直後のアシスタント応答をキャプチャする
	 */
	const recapSections = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const msg = entry.message || {};

		if (entry.type !== 'user' || msg.role !== 'user') { continue; }

		// ユーザーメッセージのテキストを取得
		let userText = '';
		const c = msg.content;
		if (typeof c === 'string') {
			userText = c.trim();
		} else if (Array.isArray(c)) {
			for (const b of c) {
				if (b && b.type === 'text' && b.text) {
					userText = b.text.trim();
					break;
				}
			}
		}

		// /recap で始まるメッセージを検出（大文字小文字問わず）
		if (!userText.toLowerCase().startsWith('/recap')) { continue; }

		// 直後のアシスタントメッセージを取得
		let recapContent = '';
		for (let j = i + 1; j < entries.length && j < i + 5; j++) {
			const next = entries[j];
			const nextMsg = next.message || {};
			if (next.type !== 'assistant' || nextMsg.role !== 'assistant') { continue; }

			const nc = nextMsg.content;
			if (typeof nc === 'string' && nc) {
				recapContent = nc;
				break;
			} else if (Array.isArray(nc)) {
				const text = nc
					.filter(b => b && b.type === 'text')
					.map(b => b.text || '')
					.join('\n');
				if (text) { recapContent = text; break; }
			}
		}

		if (!recapContent) { continue; }

		// タイムスタンプを entry から取得（なければ現在時刻）
		let ts = entry.timestamp ? new Date(entry.timestamp) : new Date();
		recapSections.push({
			timestamp: ts,
			userText,
			recapContent,
		});
	}

	if (recapSections.length === 0) { process.stdout.write('{}'); return; }

	// HISTORY.md に追記（重複チェック: HISTORY.md に既に同内容が含まれていれば skip）
	let existingHistory = '';
	try {
		existingHistory = fs.readFileSync(historyPath, 'utf-8');
	} catch { /* noop */ }

	const appendLines = [];
	for (const { timestamp, userText, recapContent } of recapSections) {
		const dateStr = timestamp.toISOString().substring(0, 10);
		const timeStr = timestamp.toTimeString().substring(0, 5);

		// コンテンツの先頭50文字で重複チェック
		const fingerprint = recapContent.substring(0, 50);
		if (existingHistory.includes(fingerprint)) { continue; }

		appendLines.push('');
		appendLines.push(`### ${dateStr} ${timeStr} (/recap 自動キャプチャ)`);
		// /recap に引数があればサブタイトルとして付記
		const recapArg = userText.replace(/^\/recap\s*/i, '').trim();
		if (recapArg) {
			appendLines.push(`> ${recapArg}`);
			appendLines.push('');
		}
		appendLines.push(recapContent.trimEnd());
	}

	if (appendLines.length === 0) { process.stdout.write('{}'); return; }

	try {
		fs.appendFileSync(historyPath, appendLines.join('\n') + '\n', 'utf-8');
	} catch { /* noop */ }

	process.stdout.write('{}');
}

main();
