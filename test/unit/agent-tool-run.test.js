/**
 * agentToolRunService ユニットテスト
 *
 * 対象: docs/agent-invocation-architecture.md の R3
 *   「Agent ツール経由の実行（＝使い捨て・永続セッションに残らない）を CSM から見えるようにする」
 *
 * 実行方法: npm run compile && node --test test/unit/agent-tool-run.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// vscode を import するモジュールが連鎖ロードされても落ちないようにモックする
const vscodeMock = {
	workspace: {
		workspaceFolders: [],
		getConfiguration: () => ({ get: (_k, d) => d }),
	},
};
const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') { return vscodeMock; }
	return origLoad(request, parent, isMain);
};

const svc = require('../../out/services/agentToolRunService');

function tmpDir(label) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `csm-atr-${label}-`));
}

/** 親セッション JSONL の 1 行（Agent ツール呼び出し）を作る */
function agentCallLine({ sessionId, agentName, description, ts, toolName = 'Task', id = 'toolu_x' }) {
	return JSON.stringify({
		type: 'assistant',
		sessionId,
		timestamp: ts,
		message: {
			role: 'assistant',
			content: [
				{ type: 'text', text: 'まかせてください' },
				{
					type: 'tool_use',
					name: toolName,
					id,
					input: { subagent_type: agentName, description, prompt: 'やって' },
				},
			],
		},
	});
}

/** Agent 呼び出しでは無い普通の行 */
function noiseLine(sessionId, n) {
	return JSON.stringify({
		type: 'assistant',
		sessionId,
		timestamp: '2026-09-08T00:00:00.000Z',
		message: { role: 'assistant', content: [{ type: 'text', text: `noise ${n}` }] },
	});
}

function writeSession(dir, name, lines) {
	const p = path.join(dir, name);
	fs.writeFileSync(p, lines.join('\n') + '\n', 'utf-8');
	return p;
}

// ---------------------------------------------------------------------------

test('S1 親セッションから Agent ツール呼び出しを抽出できる', async () => {
	const dir = tmpDir('s1');
	const sid = 'parent-1';
	const file = writeSession(dir, `${sid}.jsonl`, [
		noiseLine(sid, 1),
		agentCallLine({ sessionId: sid, agentName: 'Craft_sv', description: 'RDP 調査', ts: '2026-09-08T00:20:07.631Z' }),
		noiseLine(sid, 2),
	]);

	const state = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(state.runs.length, 1);
	assert.equal(state.runs[0].agentName, 'Craft_sv');
	assert.equal(state.runs[0].description, 'RDP 調査');
	assert.equal(state.runs[0].parentSessionId, sid);
	assert.equal(state.offset, fs.statSync(file).size, '全行を読み終えていること');
});

test('S2 Agent ツール以外のツール呼び出しは拾わない', async () => {
	const dir = tmpDir('s2');
	const sid = 'parent-2';
	const file = writeSession(dir, `${sid}.jsonl`, [
		JSON.stringify({
			type: 'assistant',
			sessionId: sid,
			timestamp: '2026-09-08T00:00:00.000Z',
			message: {
				role: 'assistant',
				// subagent_type という語は含むが Bash ツール
				content: [{ type: 'tool_use', name: 'Bash', id: 't1', input: { command: 'echo subagent_type' } }],
			},
		}),
	]);

	const state = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(state.runs.length, 0);
});

test('S3 ツール名 Agent / Task の両方に対応する', async () => {
	const dir = tmpDir('s3');
	const sid = 'parent-3';
	const file = writeSession(dir, `${sid}.jsonl`, [
		agentCallLine({ sessionId: sid, agentName: 'qa', description: 'A', ts: '2026-09-08T01:00:00.000Z', toolName: 'Task', id: 'a' }),
		agentCallLine({ sessionId: sid, agentName: 'qa', description: 'B', ts: '2026-09-08T02:00:00.000Z', toolName: 'Agent', id: 'b' }),
	]);

	const state = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(state.runs.length, 2);
});

test('S4 増分スキャン: 追記分だけを読み、既存の結果は保持する', async () => {
	const dir = tmpDir('s4');
	const sid = 'parent-4';
	const file = writeSession(dir, `${sid}.jsonl`, [
		agentCallLine({ sessionId: sid, agentName: 'qa', description: '1回目', ts: '2026-09-08T01:00:00.000Z', id: 'a' }),
	]);

	const first = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(first.runs.length, 1);
	const firstOffset = first.offset;

	fs.appendFileSync(
		file,
		agentCallLine({ sessionId: sid, agentName: 'qa', description: '2回目', ts: '2026-09-08T02:00:00.000Z', id: 'b' }) + '\n',
		'utf-8'
	);

	const second = await svc.scanSessionForAgentToolRuns(file, first);
	assert.equal(second.runs.length, 2, '既存 1 件 + 追記 1 件');
	assert.ok(second.offset > firstOffset, 'offset が進んでいること');
	assert.deepEqual(second.runs.map(r => r.description).sort(), ['1回目', '2回目']);
});

test('S5 増分スキャン: 書き込み途中の未完成行は消費しない', async () => {
	const dir = tmpDir('s5');
	const sid = 'parent-5';
	const complete = agentCallLine({ sessionId: sid, agentName: 'qa', description: '完了行', ts: '2026-09-08T01:00:00.000Z', id: 'a' });
	const file = path.join(dir, `${sid}.jsonl`);
	// 改行で終わっていない = まだ書き込み中の行
	fs.writeFileSync(file, complete + '\n' + '{"type":"assist', 'utf-8');

	const first = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(first.runs.length, 1);
	assert.equal(first.offset, Buffer.byteLength(complete + '\n'), '未完成行の手前で止まること');

	// 残りが書き終わる
	const rest = agentCallLine({ sessionId: sid, agentName: 'qa', description: '後から完成', ts: '2026-09-08T02:00:00.000Z', id: 'b' });
	fs.writeFileSync(file, complete + '\n' + rest + '\n', 'utf-8');

	const second = await svc.scanSessionForAgentToolRuns(file, first);
	assert.deepEqual(second.runs.map(r => r.description).sort(), ['完了行', '後から完成'].sort());
});

test('S6 ファイルが縮んでいたら先頭から読み直す', async () => {
	const dir = tmpDir('s6');
	const sid = 'parent-6';
	const file = writeSession(dir, `${sid}.jsonl`, [
		agentCallLine({ sessionId: sid, agentName: 'qa', description: '旧', ts: '2026-09-08T01:00:00.000Z', id: 'a' }),
		agentCallLine({ sessionId: sid, agentName: 'qa', description: '旧2', ts: '2026-09-08T01:10:00.000Z', id: 'b' }),
	]);
	const first = await svc.scanSessionForAgentToolRuns(file);
	assert.equal(first.runs.length, 2);

	// 作り直し（サイズが縮む）
	writeSession(dir, `${sid}.jsonl`, [
		agentCallLine({ sessionId: sid, agentName: 'qa', description: '新', ts: '2026-09-08T03:00:00.000Z', id: 'c' }),
	]);

	const second = await svc.scanSessionForAgentToolRuns(file, first);
	assert.deepEqual(second.runs.map(r => r.description), ['新'], '古い結果を引きずらないこと');
});

test('S7 複数セッションをエージェント名ごとに集約し、新しい順に並べる', async () => {
	const dir = tmpDir('s7');
	const fileA = writeSession(dir, 'pa.jsonl', [
		agentCallLine({ sessionId: 'pa', agentName: 'Craft_sv', description: '古い', ts: '2026-09-01T00:00:00.000Z', id: 'a' }),
	]);
	const fileB = writeSession(dir, 'pb.jsonl', [
		agentCallLine({ sessionId: 'pb', agentName: 'Craft_sv', description: '新しい', ts: '2026-09-08T00:00:00.000Z', id: 'b' }),
		agentCallLine({ sessionId: 'pb', agentName: 'qa', description: 'QA 依頼', ts: '2026-09-07T00:00:00.000Z', id: 'c' }),
	]);

	const cache = new Map();
	const byAgent = await svc.collectAgentToolRuns([fileA, fileB], cache);
	assert.equal(byAgent.get('Craft_sv').length, 2);
	assert.equal(byAgent.get('Craft_sv')[0].description, '新しい', '新しい順');
	assert.equal(byAgent.get('qa').length, 1);
	assert.equal(cache.size, 2, 'スキャン状態がキャッシュされること');
});

test('S8 存在しないファイルや壊れた行があっても全体を止めない', async () => {
	const dir = tmpDir('s8');
	const file = writeSession(dir, 'pc.jsonl', [
		'{ これは JSON ではない subagent_type',
		agentCallLine({ sessionId: 'pc', agentName: 'qa', description: '生き残り', ts: '2026-09-08T00:00:00.000Z', id: 'a' }),
	]);
	const byAgent = await svc.collectAgentToolRuns([path.join(dir, 'missing.jsonl'), file], new Map());
	assert.equal(byAgent.get('qa').length, 1);
	assert.equal(byAgent.get('qa')[0].description, '生き残り');
});

test('S9 一時トランスクリプト判定: バックグラウンド Bash の出力は除外される', async () => {
	// tasks/ には Agent のトランスクリプト（JSONL）と
	// バックグラウンド Bash のプレーンテキスト出力が混在する
	const root = tmpDir('s9');
	const sid = 'parent-9';
	const tasks = path.join(root, 'claude', 'c--slug', sid, 'tasks');
	fs.mkdirSync(tasks, { recursive: true });

	fs.writeFileSync(path.join(tasks, 'bash1.output'), 'total 736\ndrwxr-xr-x 1 taro\n', 'utf-8');
	fs.writeFileSync(
		path.join(tasks, 'aaa123.output'),
		[
			JSON.stringify({ isSidechain: true, agentId: 'aaa123', type: 'user', sessionId: sid, message: { role: 'user', content: 'よろしく' } }),
			JSON.stringify({ isSidechain: true, agentId: 'aaa123', type: 'assistant', attributionAgent: 'Craft_sv', message: { role: 'assistant', content: [] } }),
		].join('\n') + '\n',
		'utf-8'
	);

	// getEphemeralTranscriptRoot は os.tmpdir() を見るので、探索は自前で再現する
	const files = fs.readdirSync(tasks);
	assert.deepEqual(files.sort(), ['aaa123.output', 'bash1.output']);
	const jsonlOnly = files.filter((f) => {
		const head = fs.readFileSync(path.join(tasks, f), 'utf-8').split('\n')[0];
		if (!head.startsWith('{')) { return false; }
		const e = JSON.parse(head);
		return !!(e.isSidechain && e.agentId);
	});
	assert.deepEqual(jsonlOnly, ['aaa123.output'], 'JSONL かつ isSidechain のものだけが対象');

	// 実関数も同じ判定になることを確認（root が os.tmpdir 配下でない場合は undefined）
	const found = await svc.findEphemeralTranscript(sid, 'Craft_sv');
	assert.ok(found === undefined || found.endsWith('.output'));
});

test('S10 findEphemeralTranscript は不正な sessionId を弾く（パストラバーサル防止）', async () => {
	assert.equal(await svc.findEphemeralTranscript('../../etc', 'qa'), undefined);
	assert.equal(await svc.findEphemeralTranscript('', 'qa'), undefined);
});
