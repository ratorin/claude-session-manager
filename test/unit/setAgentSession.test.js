/**
 * setAgentSession ユニットテスト
 *
 * 実行方法:
 *   npm run compile && node test/unit/setAgentSession.test.js
 *
 * テストケース:
 *   1. empty  → new  OK  (sessionId 未設定 → 紐づけ成功)
 *   2. existing → skip   (sessionId 設定済み → スキップ)
 *   3. force=true → overwrite OK (既存でも force=true なら上書き)
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// ── vscode モック（dataStore が import する vscode API を偽装） ──────────────
const vscodeMock = {
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({ get: () => '' }),
    },
    OutputChannel: class {
        appendLine(msg) { this._lines = (this._lines || []); this._lines.push(msg); }
    },
};

const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeMock; }
    return origLoad(request, parent, isMain);
};

// ── ヘルパー: 各テスト用に独立した tmpHome を用意 ────────────────────────────
function setupTmpHome() {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csm-test-'));
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    return tmpHome;
}

function loadFresh(tmpHome) {
    // HOME を一時ディレクトリに向け、モジュールキャッシュをクリアして再ロード
    // ⚠️ Windows の os.homedir() は USERPROFILE を参照するため両方差し替え、失敗時は即中断する
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    if (path.resolve(os.homedir()) !== path.resolve(tmpHome)) {
        throw new Error(`FATAL: home isolation failed (os.homedir()=${os.homedir()}) — 実 ~/.claude 保護のため中断`);
    }
    const dataStorePath = require.resolve('../../out/models/dataStore');
    delete require.cache[dataStorePath];
    return require(dataStorePath);
}

// ── テストケース ──────────────────────────────────────────────────────────────

test('empty → new OK: sessionId 未設定のエージェントに紐づけ成功', async () => {
    const tmpHome = setupTmpHome();
    const { setAgentSession } = loadFresh(tmpHome);

    const result = await setAgentSession('test-agent', 'ses-001');

    assert.equal(result, true, '戻り値が true であること');
});

test('existing → skip: sessionId 設定済みはスキップ', async () => {
    const tmpHome = setupTmpHome();
    const { setAgentSession } = loadFresh(tmpHome);

    // 1回目: 紐づけ
    await setAgentSession('test-agent', 'ses-001');

    // 2回目: 同エージェントに別 sessionId → スキップ
    const result = await setAgentSession('test-agent', 'ses-002');

    assert.equal(result, false, 'スキップ時は false を返すこと');
});

test('force=true → overwrite OK: force=true なら既存 sessionId を上書き', async () => {
    const tmpHome = setupTmpHome();
    const { setAgentSession } = loadFresh(tmpHome);

    // 1回目: 紐づけ
    await setAgentSession('test-agent', 'ses-001');

    // force=true で上書き
    const result = await setAgentSession('test-agent', 'ses-999', undefined, true);

    assert.equal(result, true, 'force=true では true を返すこと');

    // session-manager.json を直接読んで確認
    const dataFile = path.join(tmpHome, '.claude', 'session-manager.json');
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
    const sessionId = data?.agentSessions?.['test-agent']?.sessionId;
    assert.equal(sessionId, 'ses-999', 'sessionId が上書きされていること');
});
