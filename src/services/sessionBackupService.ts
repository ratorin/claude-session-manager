// sessionBackupService.ts — v0.5.32
//
// エージェントに紐づいたセッション（会話ログ JSONL）を CSM 管理フォルダへバックアップし、
// Claude Code の自動削除（cleanupPeriodDays、既定 30 日）等でオリジナルが消えても
// 「リンク切れ」から復元できるようにする。
//
// **背景**: Claude Code は `~/.claude/settings.json` の `cleanupPeriodDays`（既定 30）で
//   古い会話ログを自動削除する。この設定の存在を知らないユーザーが多く、気づかぬうちに
//   エージェントの sessionId 紐づけが切れてしまう。retention 設定に依存せず CSM 側で守るため、
//   紐づけ済みセッションを増分バックアップし、リンク切れ検出（agentTreeProvider）と連動して
//   ワンクリック復元できるようにする。
//
// **保存先**: `~/.claude/csm-session-backups/<projectSlug>/<sid>.jsonl`
//   projects/ の構造をミラーするので、復元は「同じ slug の projects/ 配下へ戻す」だけで済む。

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getClaudeDir } from '../utils/sessionLoader';

/** バックアップ 1 セッションの結果 */
export type BackupResult = 'copied' | 'skipped' | 'missing' | 'toolarge';

/** バックアップ処理の集計 */
export interface BackupSummary {
	copied: number;
	skipped: number;
	missing: number;
	tooLarge: number;
}

/** CSM セッションバックアップのルートフォルダ */
export function getSessionBackupRoot(): string {
	return path.join(getClaudeDir(), 'csm-session-backups');
}

/**
 * QA: sessionId を使ってパスを組み立てる前の安全確認（パストラバーサル防止）。
 * 通常の sessionId は UUID だが、外部由来の値が混ざる可能性に備え、
 * パス区切り・`..` を含む値は拒否する。
 */
function isSafeSid(sid: string): boolean {
	return typeof sid === 'string' && /^[A-Za-z0-9._-]+$/.test(sid) && !sid.includes('..');
}

/**
 * `~/.claude/projects/<slug>/<sid>.jsonl` を全プロジェクト横断で探す。
 * 見つかれば実ファイルパスと slug（= projects 直下のディレクトリ名）を返す。
 */
async function findSessionFileForBackup(sid: string): Promise<{ filePath: string; slug: string } | null> {
	const projectsDir = path.join(getClaudeDir(), 'projects');
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const e of entries) {
		if (!e.isDirectory()) { continue; }
		const fp = path.join(projectsDir, e.name, `${sid}.jsonl`);
		try {
			await fs.promises.access(fp);
			return { filePath: fp, slug: e.name };
		} catch {
			// このプロジェクトには無い → 次へ
		}
	}
	return null;
}

/**
 * 1 セッションを増分バックアップする。
 * - オリジナルが存在しない → 'missing'（既にバックアップ済みなら温存されるので復元可能）
 * - maxBytes を超える → 'toolarge'（巨大な稼働中セッションは対象外。稼働中＝削除されにくい）
 * - バックアップが最新（mtime/size 一致）→ 'skipped'
 * - それ以外 → コピーして 'copied'
 */
export async function backupOneSession(sid: string, maxBytes: number): Promise<BackupResult> {
	if (!isSafeSid(sid)) { return 'missing'; }
	const found = await findSessionFileForBackup(sid);
	if (!found) { return 'missing'; }

	const st = await fs.promises.stat(found.filePath);
	if (maxBytes > 0 && st.size > maxBytes) { return 'toolarge'; }

	const destDir = path.join(getSessionBackupRoot(), found.slug);
	const dest = path.join(destDir, `${sid}.jsonl`);

	// 既存バックアップと同一ならスキップ。会話ログは追記のみ（append-only）なのでサイズが
	// 変わらなければ内容も同一とみなせる。mtime は utimes のサブ秒精度落ちを吸収するため
	// 2 秒の許容差で「元より新しくない」ことを確認する（誤って毎回コピーするのを防ぐ）。
	try {
		const dstat = await fs.promises.stat(dest);
		if (dstat.size === st.size && dstat.mtimeMs >= st.mtimeMs - 2000) {
			return 'skipped';
		}
	} catch {
		// バックアップ未作成 → コピーへ
	}

	await fs.promises.mkdir(destDir, { recursive: true });
	// 同一ボリューム内の一時ファイル経由でアトミックに置換（コピー中断で壊れないように）
	const tmp = `${dest}.tmp-${st.size}`;
	await fs.promises.copyFile(found.filePath, tmp);
	await fs.promises.utimes(tmp, st.atime, st.mtime); // 次回の増分判定用に mtime を合わせる
	await fs.promises.rename(tmp, dest);
	return 'copied';
}

/** 紐づけ済み sessionId 群をまとめて増分バックアップする */
export async function backupLinkedSessions(sids: readonly string[], maxBytes: number): Promise<BackupSummary> {
	const summary: BackupSummary = { copied: 0, skipped: 0, missing: 0, tooLarge: 0 };
	const seen = new Set<string>();
	for (const sid of sids) {
		if (!sid || seen.has(sid)) { continue; }
		seen.add(sid);
		try {
			const r = await backupOneSession(sid, maxBytes);
			if (r === 'copied') { summary.copied++; }
			else if (r === 'skipped') { summary.skipped++; }
			else if (r === 'missing') { summary.missing++; }
			else if (r === 'toolarge') { summary.tooLarge++; }
		} catch {
			// 個別失敗は無視して次へ（バックアップは best-effort）
		}
	}
	return summary;
}

/** 指定 sid のバックアップを探す */
export async function findBackup(sid: string): Promise<{ backupPath: string; slug: string } | null> {
	const root = getSessionBackupRoot();
	let slugs: fs.Dirent[];
	try {
		slugs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const s of slugs) {
		if (!s.isDirectory() || s.name.startsWith('.')) { continue; } // .trash は復元元にしない
		const bp = path.join(root, s.name, `${sid}.jsonl`);
		try {
			await fs.promises.access(bp);
			return { backupPath: bp, slug: s.name };
		} catch {
			// 次の slug へ
		}
	}
	return null;
}

/** 指定 sid のバックアップが存在するか */
export async function hasBackup(sid: string): Promise<boolean> {
	return (await findBackup(sid)) !== null;
}

/** 復元結果 */
export type RestoreResult =
	| { status: 'restored'; restoredTo: string }
	| { status: 'exists'; restoredTo: string }   // 既に projects/ に存在（復元不要）
	| { status: 'no-backup' };

/**
 * バックアップから `~/.claude/projects/<slug>/<sid>.jsonl` へ復元する。
 * 既にオリジナルが存在する場合は上書きせず 'exists' を返す（安全側）。
 */
export async function restoreSession(sid: string): Promise<RestoreResult> {
	if (!isSafeSid(sid)) { return { status: 'no-backup' }; }
	const bk = await findBackup(sid);
	if (!bk) { return { status: 'no-backup' }; }

	const destDir = path.join(getClaudeDir(), 'projects', bk.slug);
	const dest = path.join(destDir, `${sid}.jsonl`);
	try {
		await fs.promises.access(dest);
		return { status: 'exists', restoredTo: dest };
	} catch {
		// オリジナル無し → 復元する
	}
	await fs.promises.mkdir(destDir, { recursive: true });
	await fs.promises.copyFile(bk.backupPath, dest);
	return { status: 'restored', restoredTo: dest };
}

// ─── 管理・クリーンアップ ────────────────────────────────────────────────────

/** バックアップ 1 件のメタ */
export interface BackupEntry {
	sid: string;
	slug: string;
	filePath: string;
	sizeBytes: number;
	mtimeMs: number;
}

/** バックアップのゴミ箱フォルダ（削除＝ここへ退避。復元可） */
export function getBackupTrashRoot(): string {
	return path.join(getSessionBackupRoot(), '.trash');
}

/** バックアップフォルダ内の全バックアップを列挙する（.trash 等のドットディレクトリは除外） */
export async function listBackups(): Promise<BackupEntry[]> {
	const root = getSessionBackupRoot();
	const out: BackupEntry[] = [];
	let slugs: fs.Dirent[];
	try {
		slugs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const s of slugs) {
		if (!s.isDirectory() || s.name.startsWith('.')) { continue; }
		const dir = path.join(root, s.name);
		let files: string[];
		try {
			files = await fs.promises.readdir(dir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith('.jsonl')) { continue; }
			const fp = path.join(dir, f);
			try {
				const st = await fs.promises.stat(fp);
				if (!st.isFile()) { continue; }
				out.push({ sid: f.replace(/\.jsonl$/, ''), slug: s.name, filePath: fp, sizeBytes: st.size, mtimeMs: st.mtimeMs });
			} catch {
				// stat 失敗はスキップ
			}
		}
	}
	return out;
}

/**
 * 「保護対象」の sessionId 集合を作る純関数。
 * エージェント紐づけ・お気に入り（bookmark）・タグ・カスタム名・メモのいずれかが付いた
 * セッションは保護され、孤立判定・自動削除の対象外になる。
 */
export function computeProtectedSids(input: {
	agentSids: readonly string[];
	bookmarks: readonly string[];
	tagSids: readonly string[];
	customNameSids: readonly string[];
	noteSids: readonly string[];
}): Set<string> {
	const set = new Set<string>();
	for (const list of [input.agentSids, input.bookmarks, input.tagSids, input.customNameSids, input.noteSids]) {
		for (const sid of list) { if (sid) { set.add(sid); } }
	}
	return set;
}

/**
 * 指定バックアップ群を**ゴミ箱（.trash）へ退避**する（ハード削除しない・復元可能）。
 * 返り値の bytes は移動したバイト数（実際の空き容量は「ゴミ箱を空にする」で解放される）。
 */
export async function deleteBackups(entries: readonly BackupEntry[]): Promise<{ moved: number; bytes: number }> {
	let moved = 0;
	let bytes = 0;
	const trashRoot = getBackupTrashRoot();
	for (const e of entries) {
		try {
			const trashDir = path.join(trashRoot, e.slug);
			await fs.promises.mkdir(trashDir, { recursive: true });
			// 同名衝突を避けて連番を付与
			let dest = path.join(trashDir, `${e.sid}.jsonl`);
			let n = 1;
			// eslint-disable-next-line no-constant-condition
			while (true) {
				try { await fs.promises.access(dest); dest = path.join(trashDir, `${e.sid}.jsonl.${n++}`); }
				catch { break; }
			}
			await fs.promises.rename(e.filePath, dest);
			moved++;
			bytes += e.sizeBytes;
		} catch {
			// 既に無い等は無視
		}
	}
	// 空になった slug ディレクトリを掃除
	await removeEmptyBackupDirs();
	return { moved, bytes };
}

/** ゴミ箱の統計（件数・合計バイト） */
export async function getTrashStats(): Promise<{ count: number; bytes: number }> {
	const trashRoot = getBackupTrashRoot();
	let count = 0;
	let bytes = 0;
	let slugs: fs.Dirent[];
	try {
		slugs = await fs.promises.readdir(trashRoot, { withFileTypes: true });
	} catch {
		return { count, bytes };
	}
	for (const s of slugs) {
		if (!s.isDirectory()) { continue; }
		const dir = path.join(trashRoot, s.name);
		let files: string[];
		try { files = await fs.promises.readdir(dir); } catch { continue; }
		for (const f of files) {
			try {
				const st = await fs.promises.stat(path.join(dir, f));
				if (st.isFile()) { count++; bytes += st.size; }
			} catch { /* skip */ }
		}
	}
	return { count, bytes };
}

/** ゴミ箱を空にする（ハード削除。ここで実際に容量が解放される） */
export async function emptyBackupTrash(): Promise<{ deleted: number; freedBytes: number }> {
	const trashRoot = getBackupTrashRoot();
	const stats = await getTrashStats();
	try {
		await fs.promises.rm(trashRoot, { recursive: true, force: true });
	} catch {
		// 無視
	}
	return { deleted: stats.count, freedBytes: stats.bytes };
}

/** 空の slug ディレクトリを削除する（best-effort、.trash は対象外） */
async function removeEmptyBackupDirs(): Promise<void> {
	const root = getSessionBackupRoot();
	let slugs: fs.Dirent[];
	try {
		slugs = await fs.promises.readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const s of slugs) {
		if (!s.isDirectory() || s.name.startsWith('.')) { continue; }
		const dir = path.join(root, s.name);
		try {
			const rest = await fs.promises.readdir(dir);
			if (rest.length === 0) { await fs.promises.rmdir(dir); }
		} catch {
			// 無視
		}
	}
}

/**
 * どのバックアップを削除すべきか判定する純関数（自動クリーンアップ用）。
 * **保護対象（紐づけ・お気に入り等）は決して削除しない**。
 * 孤立（非保護）かつ「N 日以上前」のものだけを対象にする（N=0 or null なら日数条件なしで孤立全て）。
 */
export function selectAutoCleanupTargets(
	entries: readonly BackupEntry[],
	protectedSids: ReadonlySet<string>,
	olderThanDays: number | null,
	nowMs: number,
): BackupEntry[] {
	const ageThresholdMs = (olderThanDays && olderThanDays > 0) ? olderThanDays * 24 * 60 * 60 * 1000 : 0;
	return entries.filter((e) => {
		if (protectedSids.has(e.sid)) { return false; } // 保護対象は残す
		if (ageThresholdMs > 0 && (nowMs - e.mtimeMs) < ageThresholdMs) { return false; } // まだ新しい孤立は猶予
		return true;
	});
}

/**
 * 紐づけ済みセッションを定期バックアップするマネージャ。
 * UsageMonitor と同じく Disposable。extension.ts から start()/dispose() する。
 */
/** 自動クリーンアップ設定 */
export interface AutoCleanupOptions {
	enabled: boolean;
	olderThanDays: number | null; // null/0 = 孤立なら日数不問で削除
}

export class SessionBackupManager implements vscode.Disposable {
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private maxBytes = 0;
	private cleanup: AutoCleanupOptions = { enabled: false, olderThanDays: null };
	private readonly getLinkedSessionIds: () => Promise<string[]>;
	private readonly getProtectedSids: () => Promise<Set<string>>;
	private readonly log: vscode.OutputChannel;

	constructor(
		getLinkedSessionIds: () => Promise<string[]>,
		getProtectedSids: () => Promise<Set<string>>,
		log: vscode.OutputChannel,
	) {
		this.getLinkedSessionIds = getLinkedSessionIds;
		this.getProtectedSids = getProtectedSids;
		this.log = log;
	}

	/** 監視を開始/再起動する（intervalMinutes 間隔 + 起動直後に 1 回実行） */
	start(intervalMinutes: number, maxFileSizeMB: number, cleanup: AutoCleanupOptions): void {
		this.stop();
		this.maxBytes = Math.max(0, maxFileSizeMB) * 1024 * 1024;
		this.cleanup = cleanup;
		const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;
		void this.runOnce();
		this.timer = setInterval(() => { void this.runOnce(); }, intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/** 1 回ぶんのバックアップ + （有効なら）自動クリーンアップを実行（多重起動防止付き） */
	async runOnce(): Promise<BackupSummary | null> {
		if (this.running) { return null; }
		this.running = true;
		try {
			const sids = await this.getLinkedSessionIds();
			const summary = await backupLinkedSessions(sids, this.maxBytes);
			if (summary.copied > 0 || summary.tooLarge > 0) {
				this.log.appendLine(
					`[${new Date().toISOString()}] セッションバックアップ: `
					+ `新規/更新 ${summary.copied} / 変更なし ${summary.skipped} / `
					+ `オリジナル無し ${summary.missing} / サイズ超過 ${summary.tooLarge}`,
				);
			}
			// 自動クリーンアップ: 保護対象（紐づけ・お気に入り等）以外の孤立バックアップを間引く
			if (this.cleanup.enabled) {
				try {
					const entries = await listBackups();
					const protectedSids = await this.getProtectedSids();
					// QA-1: 保護対象が 0 件なのにバックアップが存在する状態は、session-manager.json の
					//   破損・一時読み取り失敗の可能性が高い。全件を孤立扱いして大量削除するのは危険なので
					//   安全側でスキップする（本当に全解除したい場合は管理画面から手動削除できる）。
					if (protectedSids.size === 0 && entries.length > 0) {
						this.log.appendLine(`[${new Date().toISOString()}] 自動クリーンアップをスキップ: 保護対象 0 件（データ読み取り異常の可能性）。手動削除は管理画面から。`);
						return summary;
					}
					const targets = selectAutoCleanupTargets(entries, protectedSids, this.cleanup.olderThanDays, Date.now());
					if (targets.length > 0) {
						const { moved, bytes } = await deleteBackups(targets);
						this.log.appendLine(
							`[${new Date().toISOString()}] 自動クリーンアップ: 孤立バックアップ ${moved} 件をゴミ箱へ退避 / ${Math.round(bytes / 1024 / 1024 * 10) / 10}MB（復元可。空にするには管理画面）`,
						);
					}
				} catch (cerr) {
					this.log.appendLine(`[${new Date().toISOString()}] 自動クリーンアップ失敗: ${cerr instanceof Error ? cerr.message : String(cerr)}`);
				}
			}
			return summary;
		} catch (err) {
			this.log.appendLine(`[${new Date().toISOString()}] セッションバックアップ失敗: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		} finally {
			this.running = false;
		}
	}

	dispose(): void {
		this.stop();
	}
}
