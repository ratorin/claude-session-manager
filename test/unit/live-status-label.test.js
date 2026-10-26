/**
 * liveStatusLabel ユニットテスト
 *
 * v0.6.4: sessions/*.json の公式 status（busy/idle）を一覧の [応答中]/[N分] 表示に使う。
 * 公式 status が無いとき（古い Claude Code）は従来の mtime 推定に戻ること。
 *
 * 実行方法: npm run compile && node --test test/unit/live-status-label.test.js
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { formatLivePrefix, formatLiveElapsed, describeLiveStatus } = require('../../out/utils/liveStatusLabel');

const NOW = 1_800_000_000_000;

test('L1 停止中は空', () => {
	assert.equal(formatLivePrefix({ isLive: false, status: 'busy', now: NOW }), '');
	assert.equal(describeLiveStatus({ isLive: false, status: 'busy' }), undefined);
});

test('L2 公式 status=busy は [応答中]（mtime が古くても）', () => {
	assert.equal(formatLivePrefix({ isLive: true, status: 'busy', mtimeMs: NOW - 3_600_000, now: NOW }), '[応答中] ');
	assert.match(describeLiveStatus({ isLive: true, status: 'busy' }), /応答中/);
});

test('L3 公式 status=idle は待機してからの経過（statusUpdatedAt 基準）', () => {
	assert.equal(formatLivePrefix({ isLive: true, status: 'idle', statusUpdatedAt: NOW - 5 * 60_000, mtimeMs: NOW - 1000, now: NOW }), '[5分] ');
	assert.match(describeLiveStatus({ isLive: true, status: 'idle' }), /待機中/);
});

test('L4 idle で statusUpdatedAt が無ければ mtime、それも無ければ [待機]', () => {
	assert.equal(formatLivePrefix({ isLive: true, status: 'idle', mtimeMs: NOW - 2 * 3_600_000, now: NOW }), '[2時間] ');
	assert.equal(formatLivePrefix({ isLive: true, status: 'idle', now: NOW }), '[待機] ');
});

test('L5 公式 status が無いときは従来の推定（30 秒以内は対話中）', () => {
	assert.equal(formatLivePrefix({ isLive: true, mtimeMs: NOW - 10_000, now: NOW }), '[対話中] ');
	assert.equal(formatLivePrefix({ isLive: true, mtimeMs: NOW - 3 * 60_000, now: NOW }), '[3分] ');
	assert.equal(formatLivePrefix({ isLive: true, now: NOW }), '[実行中] ');
	assert.equal(describeLiveStatus({ isLive: true, mtimeMs: NOW }), undefined);
});

test('L6 formatLiveElapsed の単位切り替えと負値', () => {
	assert.equal(formatLiveElapsed(0), '0秒');
	assert.equal(formatLiveElapsed(59_000), '59秒');
	assert.equal(formatLiveElapsed(60_000), '1分');
	assert.equal(formatLiveElapsed(3_600_000), '1時間');
	assert.equal(formatLiveElapsed(26 * 3_600_000), '1日');
	assert.equal(formatLiveElapsed(-5000), '0秒', '時計のずれで負になっても落ちない');
});
