#!/usr/bin/env node
// CSM-VERSION: 0.4.7
/**
 * CSM PreToolUse(Bash) hook — claude -p を --agent/--resume なしで実行しようとしたら警告
 * CSM v0.4.7+
 *
 * 入力: stdin JSON { tool_name, tool_input: { command }, ... }
 * 動作:
 *   - command に `claude.*(-p|--print)` が含まれ、かつ `--agent|--resume` が含まれない場合にblock
 *   - それ以外は pass
 *
 * Node.js のみ使用（bash/python 不要 → Windows 素環境対応）
 * 旧実装: check-csm-ask-agent.sh (bash + python)
 */

'use strict';

const fs = require('fs');

function main() {
	let input;
	try {
		const raw = fs.readFileSync(0, 'utf-8');
		input = JSON.parse(raw);
	} catch {
		process.stdout.write('{}');
		return;
	}

	const toolInput = input.tool_input || {};
	const command = typeof toolInput.command === 'string' ? toolInput.command : '';

	// claude を含まないコマンドはスルー
	if (!command.includes('claude')) {
		process.stdout.write('{}');
		return;
	}

	// `claude -p` または `claude --print` を含むかチェック
	const hasPrint = /claude\s[^|&;\n]*(-p|--print)/.test(command);
	if (!hasPrint) {
		process.stdout.write('{}');
		return;
	}

	// --agent または --resume を含む場合はpass（正常なエージェント起動）
	if (/--agent|--resume/.test(command)) {
		process.stdout.write('{}');
		return;
	}

	// PreToolUse でツールをブロックする現行の正しい値は permissionDecision: 'deny'。
	// （'block' は無効値でブロックされない。'deny' の理由は permissionDecisionReason で
	//   Claude にフィードバックされ、ターンは継続する。）
	const reason =
		'claude -p を --agent/--resume なしで実行しようとしています。' +
		'正しい形式: claude --agent <name> -p または claude --resume <sessionId> -p。' +
		'/csm-ask-agent スキルを使ってください。';
	const response = {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason,
		},
	};
	process.stdout.write(JSON.stringify(response));
}

main();
