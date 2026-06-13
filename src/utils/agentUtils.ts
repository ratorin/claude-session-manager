import * as fs from 'fs';
import * as path from 'path';

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
export function normalizeModel(raw: string): 'opus' | 'opus-1m' | 'sonnet' | 'sonnet-1m' | 'haiku' {
	const lower = raw.toLowerCase();
	// 短縮名（エイリアス）
	if (lower === 'opus') { return 'opus'; }
	if (lower === 'opus-1m') { return 'opus-1m'; }
	if (lower === 'haiku') { return 'haiku'; }
	if (lower === 'sonnet-1m') { return 'sonnet-1m'; }
	// 正式ID / CLI 値（フロントマターに書き込まれた値からの逆変換）
	if (lower.includes('[1m]')) { return lower.includes('opus') ? 'opus-1m' : 'sonnet-1m'; }
	// fable(Fable 5) は選択不可。最上位枠なので opus にフォールバック（禁止モデルを保持しない）
	if (lower.includes('fable')) { return 'opus'; }
	if (lower.includes('opus')) { return 'opus'; }
	if (lower.includes('haiku')) { return 'haiku'; }
	return 'sonnet';
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
