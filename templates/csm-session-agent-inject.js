#!/usr/bin/env node
/**
 * CSM SessionStart hook — 紐づけられたエージェント定義をセッション開始時に注入
 * Node.js版（bash+python依存なし、Windows対応）
 * CSM v0.5.0+
 *
 * 入力: stdin JSON { session_id, transcript_path, cwd, hook_event_name }
 * 出力: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function main() {
	let rawInput = '';
	try {
		rawInput = fs.readFileSync(0, 'utf-8');
	} catch {
		process.stdout.write('{}');
		return;
	}

	let input;
	try {
		input = JSON.parse(rawInput);
	} catch {
		process.stdout.write('{}');
		return;
	}

	const sessionId = input.session_id || '';
	const cwd = input.cwd || '';
	if (!sessionId) {
		process.stdout.write('{}');
		return;
	}

	// session-manager.json からエージェント名を特定
	const smFile = path.join(os.homedir(), '.claude', 'session-manager.json');
	let agentName = '';
	try {
		const data = JSON.parse(fs.readFileSync(smFile, 'utf-8'));
		const bindings = data.agentSessions || {};
		for (const [name, info] of Object.entries(bindings)) {
			if (info && info.sessionId === sessionId) {
				agentName = name;
				break;
			}
		}
	} catch {
		process.stdout.write('{}');
		return;
	}

	if (!agentName) {
		process.stdout.write('{}');
		return;
	}

	// エージェント定義ファイルを探す（グローバル → cwd配下の順）
	const candidates = [
		path.join(os.homedir(), '.claude', 'agents', agentName + '.md'),
	];
	if (cwd) {
		candidates.push(path.join(cwd, '.claude', 'agents', agentName + '.md'));
	}

	let agentFile = '';
	for (const candidate of candidates) {
		try {
			fs.accessSync(candidate);
			agentFile = candidate;
			break;
		} catch { /* 次を試す */ }
	}

	if (!agentFile) {
		process.stdout.write('{}');
		return;
	}

	let content = '';
	try {
		content = fs.readFileSync(agentFile, 'utf-8');
	} catch {
		process.stdout.write('{}');
		return;
	}

	const context =
		'【CSM自動注入: エージェント役割定義】\n' +
		`あなたはこのセッションで ${agentName} として動作します。\n` +
		'CSM (Claude Session Manager) により以下のエージェント定義が紐づけられています。\n' +
		'セッション開始時にこの定義を読み込み、役割・行動規範・制約に従って応答してください。\n\n' +
		'---\n' +
		content + '\n' +
		'---\n';

	const output = {
		hookSpecificOutput: {
			hookEventName: 'SessionStart',
			additionalContext: context,
		},
	};

	process.stdout.write(JSON.stringify(output));
}

main();
