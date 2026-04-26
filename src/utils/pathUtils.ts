/**
 * pathUtils.ts — クロスプラットフォーム対応パスユーティリティ
 * v0.5.0 T1.1
 *
 * 公開 API:
 *   expand(p)           — ~/... / ${HOME}/... / ${PROJECT_DIR}/... を絶対パスに展開
 *   contract(p)         — ホームディレクトリ部分を ~ に短縮
 *   normalize(p)        — 区切り文字・ケースを正規化（比較用）
 *   isContainedIn(a, b) — a が b 配下にある（または一致する）か
 */

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// ─── expand ──────────────────────────────────────────────────────────────────

/**
 * パスに含まれるプレースホルダを実際のパスに展開する。
 *
 * 対応プレースホルダ:
 *   ~                → os.homedir()
 *   ${HOME}          → os.homedir()
 *   ${USERPROFILE}   → os.homedir() (Windows 互換)
 *   ${PROJECT_DIR}   → 現在の VS Code ワークスペースの最初のフォルダ (なければ cwd)
 *
 * 例:
 *   expand('~/foo')        → '/home/user/foo'
 *   expand('${HOME}/foo')  → '/home/user/foo'
 */
export function expand(p: string): string {
	if (!p) { return p; }
	const home = os.homedir();
	const projectDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	let result = p;
	// ${USERPROFILE} / ${HOME} — 先に処理（長い方優先）
	result = result.replace(/\$\{USERPROFILE\}/gi, home);
	result = result.replace(/\$\{HOME\}/gi, home);
	result = result.replace(/\$\{PROJECT_DIR\}/gi, projectDir);
	// 先頭の ~ （Windows では ~\ または ~/、Unix では ~/）
	if (result === '~') {
		result = home;
	} else if (result.startsWith('~/') || result.startsWith('~\\')) {
		result = home + result.slice(1);
	}
	return path.resolve(result);
}

// ─── contract ─────────────────────────────────────────────────────────────────

/**
 * 絶対パスの先頭がホームディレクトリに一致する場合に `~` へ短縮する。
 * 保存時に人間可読な形式にするために使用。
 *
 * 例:
 *   contract('/home/user/foo') → '~/foo'
 *   contract('/etc/foo')       → '/etc/foo'
 */
export function contract(p: string): string {
	if (!p) { return p; }
	const home = os.homedir();
	const normalized = normalize(p);
	const normalizedHome = normalize(home);
	if (normalized === normalizedHome) {
		return '~';
	}
	// home に path.sep が末尾にない形でチェック（normalize 後はスラッシュ統一）
	const homeWithSep = normalizedHome.endsWith('/') ? normalizedHome : normalizedHome + '/';
	if (normalized.startsWith(homeWithSep)) {
		return '~/' + p.slice(home.length).replace(/^[/\\]/, '');
	}
	return p;
}

// ─── normalize ───────────────────────────────────────────────────────────────

/**
 * パスを比較用に正規化する。
 * - バックスラッシュをスラッシュに統一
 * - Windows では小文字化（case-insensitive fs）
 * - 末尾スラッシュを除去
 * - path.normalize を適用（.. / . を解決）
 *
 * 例:
 *   normalize('C:\\foo\\Bar\\')  → 'c:/foo/bar'  (Windows)
 *   normalize('/home/user/foo/') → '/home/user/foo'
 */
export function normalize(p: string): string {
	if (!p) { return p; }
	let result = path.normalize(p).replace(/\\/g, '/');
	// 末尾スラッシュを除去（ルート '/' は除く）
	if (result.length > 1 && result.endsWith('/')) {
		result = result.slice(0, -1);
	}
	// Windows: ファイルシステムが case-insensitive
	if (process.platform === 'win32') {
		result = result.toLowerCase();
	}
	return result;
}

// ─── isContainedIn ────────────────────────────────────────────────────────────

/**
 * `child` が `parent` 配下に存在するか（または同一パスか）を判定する。
 *
 * 用途:
 *   - workDir と workspace の包含関係チェック (F7)
 *   - プロジェクトのパス照合
 *
 * 例:
 *   isContainedIn('/a/b/c', '/a/b')  → true
 *   isContainedIn('/a/b', '/a/b')    → true   (同一)
 *   isContainedIn('/a/b', '/a/b/c')  → false
 *   isContainedIn('/a/bc', '/a/b')   → false  (prefix だけでは不十分)
 */
export function isContainedIn(child: string, parent: string): boolean {
	if (!child || !parent) { return false; }
	const nc = normalize(child);
	const np = normalize(parent);
	if (nc === np) { return true; }
	// parent に区切り文字を付けて prefix チェック（/a/b が /a/bc の親でないことを保証）
	const parentWithSep = np.endsWith('/') ? np : np + '/';
	return nc.startsWith(parentWithSep);
}
