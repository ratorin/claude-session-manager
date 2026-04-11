import * as fs from 'fs';
import * as path from 'path';

/**
 * H-1: ファイルを .trash/ に移動する共通関数（rm禁止ルール準拠）
 */
export async function moveToTrash(srcPath: string, trashDir: string): Promise<void> {
	await fs.promises.mkdir(trashDir, { recursive: true });
	const dest = path.join(trashDir, `${path.basename(srcPath)}.${Date.now()}`);
	await fs.promises.rename(srcPath, dest);
}

// L-1: モデル名正規化（agentFileManager.ts から移動）
export function normalizeModel(raw: string): 'opus' | 'sonnet' | 'sonnet-1m' | 'haiku' {
	switch (raw.toLowerCase()) {
		case 'opus': return 'opus';
		case 'haiku': return 'haiku';
		case 'sonnet-1m': return 'sonnet-1m';
		default: return 'sonnet';
	}
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
 * 1. 取締役（director）→ 常に true
 * 2. parentAgent が設定されている → true（部門エージェント）
 * 3. それ以外 → false（グローバルエージェント）
 *
 * showInOrgChart フラグは廃止。parentAgent の有無で自動判定する。
 */
export function shouldShowInOrgChart(agent: OrgChartCheckable): boolean {
	if (agent.name === 'director') {
		return true;
	}
	return !!agent.parentAgent;
}
