import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeModel as normalizeModelFromCatalog, CsmModel } from '../models/modelCatalog';

/**
 * Windows形式のworkDirパスを実行環境のパスに変換する。
 *
 * Agent frontmatterはWindows/Linux両対応のためWindowsパスを維持している。
 * Linux (dev-lamp HGFS) 上では /mnt/hgfs/ に変換して使用する。
 * Windows上ではバックスラッシュ正規化のみ行い変換しない。
 *
 * マッピング（csm-ask-agent.pyのtranslate_path()と同一）:
 *   c:/workspace/...      → /mnt/hgfs/workspace/...
 *   c:/xampp/Project/...  → /mnt/hgfs/Project/...
 *   c:/GDrive/...         → /mnt/hgfs/GDrive/...
 */
export function translateWorkDirPath(workDir: string): string {
	if (!workDir) { return workDir; }

	// バックスラッシュ（1重・2重）を / に正規化
	const normalized = workDir.replace(/\\\\/g, '/').replace(/\\/g, '/');

	// Windows上はそのまま返す
	if (process.platform === 'win32') { return normalized; }

	// Linux: c:/ または C:/ で始まるパスを /mnt/hgfs/ にマッピング
	const m = normalized.match(/^[cC]:\/(.+)$/);
	if (!m) { return normalized; }

	const rest = m[1];
	// csm-ask-agent.py の translate_path() と同一の優先順位
	const mappings: [string, string][] = [
		['workspace/', '/mnt/hgfs/workspace/'],
		['xampp/Project/', '/mnt/hgfs/Project/'],
		['xampp/Project', '/mnt/hgfs/Project'],
		['xampp/', '/mnt/hgfs/Project/'],
		['xampp', '/mnt/hgfs/Project'],
		['GDrive/', '/mnt/hgfs/GDrive/'],
		['GDrive', '/mnt/hgfs/GDrive'],
	];
	for (const [prefix, target] of mappings) {
		if (rest.startsWith(prefix)) {
			return target + rest.slice(prefix.length);
		}
	}
	return normalized;
}

// v0.5.16 M-9 (v0.5.16 レビュー修正 (2)): cwd → ~/.claude/projects/ 配下のエンコード済みディレクトリ名
// -----------------------------------------------------------------------------
// Claude Code 本体の実装（実在フォルダの列挙で検証済み）:
//   - **大文字は保持する**（`C:` → `C-`、`c:` → `c-`）
//   - 英字（a-zA-Z）/ 数字（0-9）/ ハイフン以外の**全ての文字を 1 文字 = 1 個の `-`** に置換
//     例: 空白・`\`・`/`・`:`・`.`・`_`・日本語（1文字ずつ）等
//   - 例（実在フォルダで確認）:
//       `C:\GDrive`                        → `C--GDrive`
//       `c:\GDrive`                        → `c--GDrive`
//       `C:\Users\taro\OneDrive - 個人用`  → `C--Users-taro-OneDrive-------`  （末尾は7文字）
//       `C:\xampp\Project\LouverForge`     → `C--xampp-Project-LouverForge`
//
// v0.5.16 初版の実装は `.toLowerCase()` してから置換していたため、大文字保持で作成された
// フォルダ（`C--tmp` 等）に対して cwd が `C:\tmp` の場合、`c--tmp` で探しに行って沈黙していた。
// **v0.5.16 レビュー修正 (2) でこれを訂正**。加えて、過去バージョンで小文字化されたレガシー
// フォルダ（`c--gdrive-forest` など）も存在するため、direct match が外れた場合の候補として
// レガシー小文字版もチェックする（順序: primary → legacy lowercase → fallback scan）。
//
// - CC の 200 文字超ハッシュ切り詰めは仕様未公開でリスクがあるため実装せず、
//   findJsonlByFallbackScan（下記）でフォールバック逆引きを提供する。
//
// hookService.ts と orchestrationViewModel.ts、agentWatcher.ts に散らばっていた
// 3 か所の複製ロジックを本ヘルパーに集約する。
export function encodeCwdToProjectDir(cwd: string): string {
	if (!cwd) { return ''; }
	// CC 本体互換: 英字（大文字保持）/ 数字 / ハイフン以外は全て '-' に置換
	return cwd.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * v0.5.16 レビュー修正 (2): 旧 CSM が小文字化してから置換していた時期のレガシー版。
 * 大文字保持版で外れた場合の後方互換フォールバック用途。
 */
export function encodeCwdToProjectDirLegacyLowercase(cwd: string): string {
	if (!cwd) { return ''; }
	return cwd.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

// v0.5.16 M-9: sessionId から JSONL パスを算出。
//   1) まずエンコード規則で組み立てて実在すれば採用（大文字保持）
//   2) レガシー小文字版でも組み立てて実在すれば採用
//   3) 見つからない場合は projects/* を走査してフォールバック（CC 側の 200 文字ハッシュ切詰・
//      未対応記号への追従漏れをカバー）。scanProjectsForAutoLink の逆引きと同じ方式。
//
// 同期版は「単発呼び出し」互換 API として残す（orchestrationViewModel 等のパス）。
// 大量ループから呼ぶ場合は computeJsonlPathForSessionAsync + メモ化を使うこと（下記）。
export function computeJsonlPathForSession(sessionId: string, cwd: string): string | null {
	if (!sessionId) { return null; }
	const homeDir = os.homedir();
	const projectsDir = path.join(homeDir, '.claude', 'projects');
	if (cwd) {
		const enc1 = encodeCwdToProjectDir(cwd);
		const c1 = path.join(projectsDir, enc1, `${sessionId}.jsonl`);
		try { if (fs.existsSync(c1)) { return c1; } } catch { /* */ }
		const enc2 = encodeCwdToProjectDirLegacyLowercase(cwd);
		if (enc2 !== enc1) {
			const c2 = path.join(projectsDir, enc2, `${sessionId}.jsonl`);
			try { if (fs.existsSync(c2)) { return c2; } } catch { /* */ }
		}
	}
	// フォールバック: projects/*/<sid>.jsonl を全走査
	return findJsonlByFallbackScan(sessionId);
}

/** projects/* を走査して sessionId 一致の JSONL を返す（1 件目・同期）。M-9 フォールバック */
export function findJsonlByFallbackScan(sessionId: string): string | null {
	if (!sessionId) { return null; }
	const projectsDir = path.join(os.homedir(), '.claude', 'projects');
	try {
		const dirs = fs.readdirSync(projectsDir);
		for (const dir of dirs) {
			const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
			try {
				if (fs.statSync(candidate).isFile()) { return candidate; }
			} catch { /* not exists */ }
		}
	} catch { /* projectsDir 不在 */ }
	return null;
}

// -----------------------------------------------------------------------------
// v0.5.16 レビュー修正 (1): 非同期版 + メモ化対応
// -----------------------------------------------------------------------------
// agentWatcher.update() のループから毎サイクル呼ばれる経路では、direct match が外れると
// 同期 readdirSync + statSync が全エージェント分連鎖して拡張ホストをブロックする。
// - 呼び出し元で 1 サイクル分の projects ディレクトリ列挙を **共有** できるように、
//   FallbackScanCache 型を導入。update() 開始時に new FallbackScanCache() し、
//   全エージェントで dirs を共有する。
// - 各セッションの stat 探索は非同期で並列可能（呼び出し元次第）。

/** update() 1 サイクル内で projects/* の readdir 結果を共有するためのメモ */
export class FallbackScanCache {
	/** projects/ の直下のディレクトリ名一覧（初回呼び出しで load） */
	private dirsPromise: Promise<string[]> | null = null;
	/** sid → 見つかった jsonl パス or null（同一 sid の再照会を高速化） */
	private sidCache = new Map<string, string | null>();

	async getDirs(): Promise<string[]> {
		if (!this.dirsPromise) {
			const projectsDir = path.join(os.homedir(), '.claude', 'projects');
			this.dirsPromise = fs.promises.readdir(projectsDir).catch(() => [] as string[]);
		}
		return this.dirsPromise;
	}

	async findJsonl(sessionId: string): Promise<string | null> {
		if (!sessionId) { return null; }
		if (this.sidCache.has(sessionId)) { return this.sidCache.get(sessionId) ?? null; }
		const projectsDir = path.join(os.homedir(), '.claude', 'projects');
		const dirs = await this.getDirs();
		for (const dir of dirs) {
			const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
			try {
				const s = await fs.promises.stat(candidate);
				if (s.isFile()) {
					this.sidCache.set(sessionId, candidate);
					return candidate;
				}
			} catch { /* not exists */ }
		}
		this.sidCache.set(sessionId, null);
		return null;
	}
}

/**
 * 非同期版: primary encoding → legacy lowercase → fallback scan（メモ化）。
 * 呼び出し元で FallbackScanCache を共有すれば、1 サイクル内の readdir/stat が重複しない。
 */
export async function computeJsonlPathForSessionAsync(
	sessionId: string,
	cwd: string,
	cache?: FallbackScanCache,
): Promise<string | null> {
	if (!sessionId) { return null; }
	const homeDir = os.homedir();
	const projectsDir = path.join(homeDir, '.claude', 'projects');
	if (cwd) {
		const enc1 = encodeCwdToProjectDir(cwd);
		const c1 = path.join(projectsDir, enc1, `${sessionId}.jsonl`);
		try { const s = await fs.promises.stat(c1); if (s.isFile()) { return c1; } } catch { /* */ }
		const enc2 = encodeCwdToProjectDirLegacyLowercase(cwd);
		if (enc2 !== enc1) {
			const c2 = path.join(projectsDir, enc2, `${sessionId}.jsonl`);
			try { const s = await fs.promises.stat(c2); if (s.isFile()) { return c2; } } catch { /* */ }
		}
	}
	// フォールバックスキャン（メモ化）
	const scanner = cache || new FallbackScanCache();
	return scanner.findJsonl(sessionId);
}

/**
 * H-1: ファイルを .trash/ に移動する共通関数（rm禁止ルール準拠）
 */
export async function moveToTrash(srcPath: string, trashDir: string): Promise<void> {
	await fs.promises.mkdir(trashDir, { recursive: true });
	const dest = path.join(trashDir, `${path.basename(srcPath)}.${Date.now()}`);
	await fs.promises.rename(srcPath, dest);
}

// L-1: モデル名正規化（短縮名・正式ID両対応）
//
// v0.5.14 変更（C-1 / C-2 修正 + Fable 5 解禁）:
//  - fable 判定を [1m] 判定より **前** に置く（旧: `claude-fable-5[1m]` が sonnet-1m に化けた）
//  - fable → opus のサイレント丸めを削除（Fable 5 は第一級モデル）
//  - 実装は modelCatalog.ts の normalizeModel に一元化
export function normalizeModel(raw: string): CsmModel {
	return normalizeModelFromCatalog(raw);
}

// L-1: ステータス正規化（agentFileManager.ts から移動）
export function normalizeStatus(raw: unknown): 'active' | 'idle' | 'archived' | undefined {
	const s = String(raw || 'idle');
	if (s === 'active' || s === 'idle' || s === 'archived') { return s; }
	return 'idle';
}

/**
 * エージェント表示判定ユーティリティ
 *
 * B案: parentAgent の有無で組織図表示を自動判定する。
 * showInOrgChart が明示的に設定されていればそちらを優先（手動オーバーライド）。
 */

interface OrgChartCheckable {
	showInOrgChart?: boolean;
	parentAgent?: string;
	name: string;
}

/**
 * エージェントが組織図に表示されるべきかを判定する。
 *
 * 判定ルール:
 * 1. showInOrgChart が明示的に設定されている → その値を使用
 * 2. parentAgent が設定されている → true（部門エージェント）
 * 3. それ以外 → false（グローバルエージェント）
 */
export function shouldShowInOrgChart(agent: OrgChartCheckable): boolean {
	if (agent.showInOrgChart !== undefined) {
		return agent.showInOrgChart;
	}
	return !!agent.parentAgent;
}
