/**
 * 管理外 frontmatter キーの保持テスト
 *
 * 背景: CSM の保存処理は既知キーだけを組み立て直すため、Claude Code 本体が後から追加したキー
 * （CC 2.1.271 の omitClaudeMd など）がフォーム保存のたびに黙って消えていた。
 *
 * 実行方法: npm run compile && node --test test/unit/frontmatter-preserve.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { extractUnmanagedFrontmatterLines } = require('../../out/utils/frontmatterUtils');

const MANAGED = new Set(['name', 'description', 'model', 'tools', 'effort', 'workDir']);

function doc(frontmatterLines, body = '本文') {
	return ['---', ...frontmatterLines, '---', '', body].join('\n');
}

test('P1 管理外の単一行キー（omitClaudeMd）を保持する', () => {
	const content = doc(['name: "qa"', 'omitClaudeMd: true', 'model: opus']);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), ['omitClaudeMd: true']);
});

test('P2 管理対象キーは返さない（二重出力の防止）', () => {
	const content = doc(['name: "qa"', 'description: "レビュー"', 'model: opus', 'effort: high']);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), []);
});

test('P3 ネストした YAML ブロック（hooks / mcpServers）を丸ごと保持する', () => {
	const content = doc([
		'name: "qa"',
		'hooks:',
		'  PreToolUse:',
		'    - matcher: "Bash"',
		'      hooks:',
		'        - type: command',
		'          command: "echo hi"',
		'model: opus',
		'skills:',
		'  - review',
		'  - security',
	]);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), [
		'hooks:',
		'  PreToolUse:',
		'    - matcher: "Bash"',
		'      hooks:',
		'        - type: command',
		'          command: "echo hi"',
		'skills:',
		'  - review',
		'  - security',
	]);
});

test('P4 管理対象キーの複数行値は巻き込まない', () => {
	// description のブロックスカラーは管理対象。続くインデント行を管理外として拾ってはいけない
	const content = doc([
		'name: "qa"',
		'description: |',
		'  1行目',
		'  color: これは本文であってキーではない',
		'color: blue',
	]);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), ['color: blue']);
});

test('P5 ハイフン入りのキー名も 1 つのキーとして扱う', () => {
	const content = doc(['name: "qa"', 'initial-prompt: "はじめに"']);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), ['initial-prompt: "はじめに"']);
});

test('P6 CRLF のファイルでも行末の \r を残さない', () => {
	const content = ['---', 'name: "qa"', 'omitClaudeMd: true', '---', '', '本文'].join('\r\n');
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), ['omitClaudeMd: true']);
});

test('P7 末尾の空行は溜めない（保存を繰り返しても frontmatter が伸びない）', () => {
	const content = doc(['name: "qa"', 'color: blue', '', '']);
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), ['color: blue']);
});

test('P8 frontmatter が無い・壊れているファイルは空配列', () => {
	assert.deepEqual(extractUnmanagedFrontmatterLines('本文だけ', MANAGED), []);
	assert.deepEqual(extractUnmanagedFrontmatterLines('---\nname: "qa"\n閉じていない', MANAGED), []);
});

test('P9 本文中の「key: value」は拾わない', () => {
	const content = doc(['name: "qa"'], 'omitClaudeMd: true\ncolor: red');
	assert.deepEqual(extractUnmanagedFrontmatterLines(content, MANAGED), []);
});

// ---------------------------------------------------------------------------
// 結合: 実際の保存経路（writeAgentFile）で未知キーが生き残ること
// ---------------------------------------------------------------------------

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

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

/** 隔離したホームで agentFileManager を読み込む。隔離に失敗したら実環境保護のため即中断する */
function loadManagerIsolated() {
	const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-fm-'));
	fs.mkdirSync(path.join(tmpHome, '.claude', 'agents'), { recursive: true });
	process.env.HOME = tmpHome;
	process.env.USERPROFILE = tmpHome; // Windows の os.homedir() はこちらを見る
	if (path.resolve(os.homedir()) !== path.resolve(tmpHome)) {
		throw new Error(`FATAL: home isolation failed (os.homedir()=${os.homedir()}) — 実 ~/.claude 保護のため中断`);
	}
	const modPath = require.resolve('../../out/agents/agentFileManager');
	delete require.cache[modPath];
	return { mgr: require(modPath), agentsDir: path.join(tmpHome, '.claude', 'agents') };
}

test('W1 writeAgentFile: 保存しても omitClaudeMd とネストした hooks が残り、管理対象キーは重複しない', async () => {
	const { mgr, agentsDir } = loadManagerIsolated();
	const file = path.join(agentsDir, 'keeper.md');
	fs.writeFileSync(file, [
		'---',
		'name: "keeper"',
		'description: "古い説明"',
		'model: sonnet',
		'omitClaudeMd: true',
		'hooks:',
		'  PreToolUse:',
		'    - matcher: "Bash"',
		'---',
		'',
		'本文はそのまま',
	].join('\n'), 'utf-8');

	await mgr.writeAgentFile({ name: 'keeper', description: '新しい説明', role: 'テスト', model: 'opus' });

	const saved = fs.readFileSync(file, 'utf-8');
	assert.match(saved, /^omitClaudeMd: true$/m, '未知キーが保持されること');
	assert.match(saved, /^hooks:\n {2}PreToolUse:\n {4}- matcher: "Bash"$/m, 'ネストしたブロックが形を保つこと');
	assert.match(saved, /新しい説明/, '管理対象キーは更新されること');
	assert.doesNotMatch(saved, /古い説明/);
	assert.equal((saved.match(/^description:/gm) || []).length, 1, 'description が二重に出力されないこと');
	assert.equal((saved.match(/^model:/gm) || []).length, 1, 'model が二重に出力されないこと');
	assert.match(saved, /本文はそのまま/, '本文が保持されること');
});

test('W2 writeAgentFile: 保存を繰り返しても未知キーが増殖しない', async () => {
	const { mgr, agentsDir } = loadManagerIsolated();
	const file = path.join(agentsDir, 'stable.md');
	fs.writeFileSync(file, ['---', 'name: "stable"', 'description: "d"', 'color: blue', '---', '', '本文'].join('\n'), 'utf-8');

	for (let i = 0; i < 3; i++) {
		await mgr.writeAgentFile({ name: 'stable', description: `d${i}`, role: 'r' });
	}
	const saved = fs.readFileSync(file, 'utf-8');
	assert.equal((saved.match(/^color: blue$/gm) || []).length, 1);
});
