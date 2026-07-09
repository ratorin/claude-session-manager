import * as fs from 'fs';
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
