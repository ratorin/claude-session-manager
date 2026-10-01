/**
 * 「Claude で開く」の開き先フォルダ判定 ユニットテスト
 *
 * 実行方法:
 *   npm run compile && node --test test/unit/open-in-claude-cwd.test.js
 *
 * 背景:
 *   セッション中に `cd` すると JSONL の後半には移動先の cwd が記録される。
 *   Claude Code がセッションを探すのは「起動時の cwd」に対応する projects/<slug> なので、
 *   開き先フォルダは JSONL 先頭の cwd で決めなければならない。
 *
 * テストケース:
 *   1. loadSessionTail は末尾に別の cwd があっても起動時（先頭）の cwd を返す
 *   2. 呼び出し側が移動先の cwd を渡しても、JSONL 先頭の cwd が現ワークスペースなら新ウィンドウを開かない
 *   3. JSONL が無い場合は渡された sessionCwd にフォールバックする（従来動作）
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const LAUNCH_CWD = 'C:\\work\\proj';
const MOVED_CWD = 'C:\\elsewhere\\deep';
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const TAIL_MESSAGES = 200;
// loadSessionTail は最大 TAIL_MESSAGES * 4 行を末尾から読む。先頭行に届かない行数にする。
const MOVED_LINE_COUNT = TAIL_MESSAGES * 4 * 2;
// 全角 1 文字 = UTF-8 で 3 バイト。約 240KB の行になり、64KB の読み取り単位を複数またぐ。
const HUGE_LINE_CHARS = 80 * 1024;

// ── vscode モック（呼び出しを記録する） ──────────────────────────────────────
const calls = { executeCommand: [], openExternal: [], info: [], warning: [] };
const vscodeMock = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: LAUNCH_CWD } }],
        getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
    },
    window: {
        showInformationMessage: (msg) => { calls.info.push(msg); },
        showWarningMessage: (msg) => { calls.warning.push(msg); },
    },
    commands: {
        executeCommand: async (...args) => { calls.executeCommand.push(args); },
    },
    env: {
        uriScheme: 'vscode',
        openExternal: async (uri) => { calls.openExternal.push(String(uri)); return true; },
    },
    Uri: {
        parse: (value) => ({ toString: () => value }),
        file: (fsPath) => ({ fsPath, toString: () => fsPath }),
    },
};

const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeMock; }
    return origLoad(request, parent, isMain);
};

function resetCalls() {
    for (const key of Object.keys(calls)) { calls[key] = []; }
}

// ── ヘルパー: 実 ~/.claude を触らないよう HOME を一時ディレクトリに隔離 ──────
function setupTmpHome() {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    if (path.resolve(os.homedir()) !== path.resolve(tmpHome)) {
        throw new Error(`FATAL: home isolation failed (os.homedir()=${os.homedir()}) — 実 ~/.claude 保護のため中断`);
    }
    return tmpHome;
}

function loadFresh(relPath) {
    const resolved = require.resolve(relPath);
    delete require.cache[resolved];
    return require(resolved);
}

function messageLine(index, cwd) {
    const isUser = index % 2 === 0;
    const base = {
        type: isUser ? 'user' : 'assistant',
        sessionId: SESSION_ID,
        cwd,
        uuid: `uuid-${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    };
    const message = isUser
        ? { role: 'user', content: `user message ${index}` }
        : { role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: `assistant message ${index}` }] };
    return JSON.stringify({ ...base, message });
}

/**
 * 先頭 2 行は起動時 cwd、以降は cd 後の cwd を持つ JSONL を作る。
 * leadingLines は cwd を持たない行（大きな貼り付け・スナップショット等）を先頭に置くためのもの。
 */
function writeSessionWithMovedCwd(tmpHome, leadingLines = []) {
    const projectDir = path.join(tmpHome, '.claude', 'projects', 'C--work-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const lines = [...leadingLines, messageLine(0, LAUNCH_CWD), messageLine(1, LAUNCH_CWD)];
    for (let i = 2; i < MOVED_LINE_COUNT; i++) { lines.push(messageLine(i, MOVED_CWD)); }
    const filePath = path.join(projectDir, `${SESSION_ID}.jsonl`);
    fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
    return filePath;
}

/** cwd を持たない巨大な 1 行（実セッションでは最大 190KB 超を確認） */
function hugeLineWithoutCwd() {
    return JSON.stringify({ type: 'file-history-snapshot', payload: 'あ'.repeat(HUGE_LINE_CHARS) });
}

// ── テストケース ──────────────────────────────────────────────────────────────

test('loadSessionTail: 末尾に別の cwd があっても起動時（先頭）の cwd を返す', async () => {
    const tmpHome = setupTmpHome();
    const filePath = writeSessionWithMovedCwd(tmpHome);
    const { loadSessionTail } = loadFresh('../../out/utils/sessionLoader');

    const result = await loadSessionTail(filePath, TAIL_MESSAGES, false);

    assert.ok(result && result.session, 'セッションが読めること');
    assert.equal(result.session.cwd, LAUNCH_CWD, 'cwd は cd 後の値ではなく起動時の値であること');
});

test('openSessionInClaudeSmart: 移動先 cwd を渡されても JSONL 先頭の cwd で判定し、新ウィンドウを開かない', async () => {
    const tmpHome = setupTmpHome();
    writeSessionWithMovedCwd(tmpHome);
    loadFresh('../../out/utils/sessionLoader');
    const { openSessionInClaudeSmart } = loadFresh('../../out/commands/openInClaudeHelper');
    resetCalls();

    await openSessionInClaudeSmart({ sessionId: SESSION_ID, sessionCwd: MOVED_CWD });

    const openedFolders = calls.executeCommand.filter((args) => args[0] === 'vscode.openFolder');
    assert.equal(openedFolders.length, 0, '現ワークスペースのセッションなので新ウィンドウは開かないこと');
    assert.equal(calls.openExternal.length, 1, 'URI ハンドラへ 1 回だけ送ること');
    assert.ok(calls.openExternal[0].includes(SESSION_ID), 'URI にセッション ID が含まれること');
});

test('先頭に cwd を持たない巨大な行があっても起動時 cwd を取り出せる', async () => {
    const tmpHome = setupTmpHome();
    const filePath = writeSessionWithMovedCwd(tmpHome, [hugeLineWithoutCwd()]);
    const { loadSessionTail, readLaunchCwd } = loadFresh('../../out/utils/sessionLoader');
    const { openSessionInClaudeSmart } = loadFresh('../../out/commands/openInClaudeHelper');
    resetCalls();

    assert.equal(await readLaunchCwd(filePath), LAUNCH_CWD, 'readLaunchCwd が巨大行を越えて読むこと');
    const result = await loadSessionTail(filePath, TAIL_MESSAGES, false);
    assert.equal(result.session.cwd, LAUNCH_CWD, 'loadSessionTail も起動時 cwd を返すこと');

    await openSessionInClaudeSmart({ sessionId: SESSION_ID, sessionCwd: MOVED_CWD });
    const openedFolders = calls.executeCommand.filter((args) => args[0] === 'vscode.openFolder');
    assert.equal(openedFolders.length, 0, '新ウィンドウを開かないこと');
});

test('readLaunchCwd: ファイルが無い・cwd 行が無いときは undefined', async () => {
    const tmpHome = setupTmpHome();
    const { readLaunchCwd } = loadFresh('../../out/utils/sessionLoader');
    const noCwdFile = path.join(tmpHome, 'no-cwd.jsonl');
    fs.writeFileSync(noCwdFile, JSON.stringify({ type: 'summary', summary: 'x' }), 'utf-8');

    assert.equal(await readLaunchCwd(path.join(tmpHome, 'missing.jsonl')), undefined);
    assert.equal(await readLaunchCwd(noCwdFile), undefined);
});

test('readLaunchCwd: 末尾に改行の無い 1 行だけのファイルからも取り出せる', async () => {
    const tmpHome = setupTmpHome();
    const { readLaunchCwd } = loadFresh('../../out/utils/sessionLoader');
    const oneLineFile = path.join(tmpHome, 'one-line.jsonl');
    fs.writeFileSync(oneLineFile, messageLine(0, LAUNCH_CWD), 'utf-8');

    assert.equal(await readLaunchCwd(oneLineFile), LAUNCH_CWD);
});

test('openSessionInClaudeSmart: JSONL が無いときは渡された sessionCwd にフォールバックする', async () => {
    setupTmpHome();
    loadFresh('../../out/utils/sessionLoader');
    const { openSessionInClaudeSmart } = loadFresh('../../out/commands/openInClaudeHelper');
    resetCalls();

    await openSessionInClaudeSmart({ sessionId: SESSION_ID, sessionCwd: MOVED_CWD });

    const openedFolders = calls.executeCommand.filter((args) => args[0] === 'vscode.openFolder');
    assert.equal(openedFolders.length, 1, 'ワークスペース外のフォルダなので新ウィンドウを開くこと');
});
