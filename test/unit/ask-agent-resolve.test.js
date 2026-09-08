// ask-agent-resolve.test.js
// templates/csm-ask-agent.py の R1（定義探索のスコープ統合）/ R2（resume cwd 導出）を検証する。
// 設計背景: docs/agent-invocation-architecture.md
//
// HOME 隔離について:
//   Python の os.path.expanduser は Windows では USERPROFILE を見る（HOME ではない）。
//   実 ~/.claude を絶対に触らないよう、子プロセスの env で USERPROFILE と HOME の
//   両方をテンポラリへ差し替える。スクリプトは expanduser 配下しか読み書きしないため、
//   これで実環境から完全に隔離される。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'templates', 'csm-ask-agent.py');

/** 一時ディレクトリを作って返す（テストごとに独立） */
function mkTmp(label) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `csm-ask-${label}-`));
}

/** 隔離された偽ホームを構築する */
function makeFakeHome(label) {
	const home = mkTmp(label);
	fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
	fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
	return home;
}

/** agents/<name>.md を書く */
function writeAgent(dir, name, frontmatter) {
	fs.mkdirSync(dir, { recursive: true });
	const body = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: "${v}"`)
		.join('\n');
	fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: "${name}"\n${body}\n---\n\n本文\n`, 'utf-8');
}

/** session-manager.json に紐づけを書く */
function writeBinding(home, agentSessions) {
	fs.writeFileSync(
		path.join(home, '.claude', 'session-manager.json'),
		JSON.stringify({ agentSessions }, null, 2),
		'utf-8'
	);
}

/**
 * セッション JSONL を作る。
 * slug はわざと cwd と対応しない名前も渡せるようにして、
 * 「スラグ逆引きではなく cwd フィールドを読んでいる」ことを検証できるようにする。
 */
function writeSession(home, slug, sid, cwd) {
	const dir = path.join(home, '.claude', 'projects', slug);
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		// 先頭には cwd を持たない行が来る（実データと同じ形）
		JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId: sid }),
		JSON.stringify({ type: 'user', sessionId: sid, cwd, version: '2.1.263' }),
	];
	fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join('\n') + '\n', 'utf-8');
}

/** スクリプトを隔離環境で実行する */
function run(args, { home, cwd, env = {} }) {
	const res = spawnSync('python', [SCRIPT, ...args], {
		cwd,
		encoding: 'utf-8',
		env: {
			...process.env,
			USERPROFILE: home, // Windows の expanduser はこれを見る
			HOME: home,        // POSIX 用
			HOMEDRIVE: '',
			HOMEPATH: '',
			PYTHONIOENCODING: 'utf-8',
			CSM_ALLOW_ANY_WORKDIR: '1', // F7 チェックは別関心なので無効化
			...env,
		},
	});
	return {
		status: res.status,
		stdout: (res.stdout || '').trim(),
		stderr: (res.stderr || '').trim(),
	};
}

/** 比較用にパス表記を揃える */
function norm(p) {
	return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const pythonAvailable = spawnSync('python', ['--version'], { encoding: 'utf-8' }).status === 0;
const skip = pythonAvailable ? false : 'python が見つからないためスキップ';

// ---------------------------------------------------------------------------
// R1: 定義探索のスコープ統合
// ---------------------------------------------------------------------------

test('A1 R1: プロジェクトスコープにしか定義が無いエージェントを解決できる', { skip }, () => {
	const home = makeFakeHome('a1');
	const project = mkTmp('a1-proj');
	const child = path.join(project, 'sub', 'deeper');
	fs.mkdirSync(child, { recursive: true });
	// 定義はプロジェクトルート、呼び出しは子ディレクトリから（事故の再現形）
	writeAgent(path.join(project, '.claude', 'agents'), 'proj-only', { permissionMode: 'acceptEdits' });
	writeBinding(home, {});

	const r = run(['proj-only'], { home, cwd: child });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	// sessionId 無し → 新規起動想定。permissionMode は読めている
	assert.strictEqual(r.stdout, '|acceptEdits|');
	assert.match(r.stderr, /scope=project/);
});

test('A2 R1: 同名定義はプロジェクトスコープがユーザースコープより優先される', { skip }, () => {
	const home = makeFakeHome('a2');
	const project = mkTmp('a2-proj');
	writeAgent(path.join(home, '.claude', 'agents'), 'dup', { permissionMode: 'default' });
	writeAgent(path.join(project, '.claude', 'agents'), 'dup', { permissionMode: 'auto' });
	writeBinding(home, {});

	const r = run(['dup'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	// プロジェクト側の auto が採用される
	assert.strictEqual(r.stdout, '|auto|');
});

test('A3 R1: どこにも無ければ探索したディレクトリを挙げてエラー終了する', { skip }, () => {
	const home = makeFakeHome('a3');
	const project = mkTmp('a3-proj');
	writeBinding(home, {});

	const r = run(['nope'], { home, cwd: project });
	assert.strictEqual(r.status, 1);
	assert.strictEqual(r.stdout, '', '失敗時に stdout を出してはいけない');
	assert.match(r.stderr, /ERROR: Agent file not found: nope\.md/);
	assert.match(r.stderr, /searched:/);
});

test('A4 R1: CSM_AGENT_DIRS で明示したディレクトリも探索される', { skip }, () => {
	const home = makeFakeHome('a4');
	const extra = mkTmp('a4-extra');
	const elsewhere = mkTmp('a4-cwd');
	writeAgent(path.join(extra, '.claude', 'agents'), 'extern', { permissionMode: 'auto' });
	writeBinding(home, {});

	const r = run(['extern'], { home, cwd: elsewhere, env: { CSM_AGENT_DIRS: extra } });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	assert.strictEqual(r.stdout, '|auto|');
});

// ---------------------------------------------------------------------------
// R2: resume cwd の導出
// ---------------------------------------------------------------------------

test('B1 R2: resume cwd はスラグ逆引きではなくセッション JSONL の cwd から取る', { skip }, () => {
	const home = makeFakeHome('b1');
	const project = mkTmp('b1-proj');
	const sid = '11111111-2222-3333-4444-555555555555';
	// スラグは実 cwd と全く対応しない名前にする。
	// 逆引き実装ならここで誤った値が出る。
	writeSession(home, 'totally-unrelated-slug', sid, project);
	writeAgent(path.join(project, '.claude', 'agents'), 'bound', { permissionMode: 'acceptEdits' });
	writeBinding(home, { bound: { sessionId: sid } });

	const r = run(['bound'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	const [outSid, perm, cwd] = r.stdout.split('|');
	assert.strictEqual(outSid, sid);
	assert.strictEqual(perm, 'acceptEdits');
	assert.strictEqual(norm(cwd), norm(project));
	assert.match(r.stderr, /source=session-jsonl/);
});

test('B2 R2: パスにハイフンを含んでも cwd が壊れない（スラグ逆引きの非可逆性）', { skip }, () => {
	const home = makeFakeHome('b2');
	const base = mkTmp('b2');
	// 「yosuga-xs」のようにセグメント自体がハイフンを含むケース。
	// スラグ逆引きは "-" を区切りと誤認して yosuga/xs に割ってしまう。
	const project = path.join(base, 'yosuga-xs');
	fs.mkdirSync(project, { recursive: true });
	const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	writeSession(home, 'c--tmp-yosuga-xs', sid, project);
	writeAgent(path.join(project, '.claude', 'agents'), 'hyphen', { permissionMode: 'auto' });
	writeBinding(home, { hyphen: { sessionId: sid } });

	const r = run(['hyphen'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	const cwd = r.stdout.split('|')[2];
	assert.strictEqual(norm(cwd), norm(project));
	assert.ok(!norm(cwd).includes('yosuga/xs'), 'ハイフンを区切りとして割ってはいけない');
});

test('B3 R2: セッション cwd がフロントマターの workDir より優先される', { skip }, () => {
	const home = makeFakeHome('b3');
	const project = mkTmp('b3-proj');
	const sub = path.join(project, 'sub');
	fs.mkdirSync(sub, { recursive: true });
	const sid = 'ffffffff-0000-1111-2222-333333333333';
	// セッションはプロジェクトルートで作られたが、定義は子ディレクトリを指している。
	// この状態で workDir を採用すると --resume が新規セッションを作ってしまう。
	writeSession(home, 'slug-b3', sid, project);
	writeAgent(path.join(project, '.claude', 'agents'), 'drift', {
		permissionMode: 'acceptEdits',
		workDir: sub.replace(/\\/g, '/'),
	});
	writeBinding(home, { drift: { sessionId: sid } });

	const r = run(['drift'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	assert.strictEqual(norm(r.stdout.split('|')[2]), norm(project));
	assert.match(r.stderr, /セッション cwd を採用/);
});

test('B4 R2: セッション実体が無い場合は空を返さずエラー終了する', { skip }, () => {
	const home = makeFakeHome('b4');
	const project = mkTmp('b4-proj');
	writeAgent(path.join(project, '.claude', 'agents'), 'orphan', { permissionMode: 'acceptEdits' });
	// 紐づけはあるが JSONL は存在しない（Claude の自動削除で消えた状態）
	writeBinding(home, { orphan: { sessionId: '99999999-8888-7777-6666-555555555555' } });

	const r = run(['orphan'], { home, cwd: project });
	assert.strictEqual(r.status, 1);
	assert.strictEqual(r.stdout, '', '黙って空 cwd を返すと新規セッションが作られてしまう');
	assert.match(r.stderr, /ERROR: session file not found/);
});

test('B5 R2: cwd が実在しないディレクトリならエラー終了する', { skip }, () => {
	const home = makeFakeHome('b5');
	const project = mkTmp('b5-proj');
	const sid = '12121212-3434-5656-7878-909090909090';
	writeSession(home, 'slug-b5', sid, path.join(project, 'deleted-dir'));
	writeAgent(path.join(project, '.claude', 'agents'), 'gone', { permissionMode: 'acceptEdits' });
	writeBinding(home, { gone: { sessionId: sid } });

	const r = run(['gone'], { home, cwd: project });
	assert.strictEqual(r.status, 1);
	assert.match(r.stderr, /ERROR: resume cwd does not exist/);
});

test('B6 R2: 紐づけが無いエージェントは従来どおり workDir を返す（新規起動）', { skip }, () => {
	const home = makeFakeHome('b6');
	const project = mkTmp('b6-proj');
	writeAgent(path.join(project, '.claude', 'agents'), 'fresh', {
		permissionMode: 'auto',
		workDir: project.replace(/\\/g, '/'),
	});
	writeBinding(home, {});

	const r = run(['fresh'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	const [sid, perm, cwd] = r.stdout.split('|');
	assert.strictEqual(sid, '');
	assert.strictEqual(perm, 'auto');
	assert.strictEqual(norm(cwd), norm(project));
	assert.match(r.stderr, /source=frontmatter/);
});

// ---------------------------------------------------------------------------
// --list / --where
// ---------------------------------------------------------------------------

test('C1 --list: プロジェクトスコープの定義も含み scope 列が付く', { skip }, () => {
	const home = makeFakeHome('c1');
	const project = mkTmp('c1-proj');
	writeAgent(path.join(home, '.claude', 'agents'), 'g-agent', { displayName: 'グローバル' });
	writeAgent(path.join(project, '.claude', 'agents'), 'p-agent', { displayName: 'プロジェクト' });
	writeBinding(home, {});

	const r = run(['--list'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	const rows = r.stdout.split(/\r?\n/).map(l => l.trim().split('|'));
	const byName = Object.fromEntries(rows.map(c => [c[0], c]));
	assert.ok(byName['p-agent'], 'プロジェクトスコープが一覧に出ること');
	assert.ok(byName['g-agent'], 'ユーザースコープも従来どおり出ること');
	assert.strictEqual(byName['p-agent'][4], 'project');
	assert.strictEqual(byName['g-agent'][4], 'global');
	// 既存の 4 フィールド前提の読み取りを壊さない
	assert.strictEqual(byName['p-agent'][1], 'プロジェクト');
});

test('C2 --where: 副作用なしに探索順を表示する', { skip }, () => {
	const home = makeFakeHome('c2');
	const project = mkTmp('c2-proj');
	writeAgent(path.join(project, '.claude', 'agents'), 'seen', {});
	writeBinding(home, {});

	const r = run(['--where', 'seen'], { home, cwd: project });
	assert.strictEqual(r.status, 0, `stderr=${r.stderr}`);
	assert.match(r.stdout, /search order:/);
	assert.match(r.stdout, /\* \[project\]/);
	// --where は連携ログを書かない
	assert.ok(
		!fs.existsSync(path.join(home, '.claude', 'csm-collab-log.jsonl')),
		'--where は副作用を持たない'
	);
});
