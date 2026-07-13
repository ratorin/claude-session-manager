/**
 * orchestrationViewModel.ts — オーケストレーション可視化タブのデータモデル構築サービス。
 *
 * v0.5.22: claude agents --json 依存を撤去。agentWatcher（PID + sessions/*.json 監視）が
 * 唯一のライブデータソースとなった。sessions/*.json の kind/name/nameSource/entrypoint/agent
 * を公式値として優先利用し、従来の "subagents.length >= 3" ヒューリスティックはフォールバック
 * に降格。
 *
 * データソース:
 *   1. AgentWatcher         — PID + sessions/*.json 監視（唯一の live 供給源）
 *   2. subagentDetector     — JSONL 末尾解析（稼働中サブエージェント）
 *   3. dataStore            — CSM エージェント登録情報
 */

import * as fs from 'fs';
import { computeJsonlPathForSession } from '../utils/agentUtils';
import { AgentWatcher } from '../watchers/agentWatcher';
import { detectSubagents } from '../utils/subagentDetector';
import * as dataStore from '../models/dataStore';
import { SubagentInfo } from '../models/types';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

/** セッション1件のオーケストレーションノード */
export interface OrchestrationSession {
	sessionId: string;
	cwd: string;
	/** CC 公式 `kind` フィールド（interactive / background 等） */
	kind: 'interactive' | 'background' | string;
	/** 開始タイムスタンプ (ms) */
	startedAt: number;
	/**
	 * 経過秒数。sessions/*.json の startedAt が取れなかった場合は undefined。
	 * UI 側では undefined のとき経過時間行を非表示にする（虚偽の 00:00:00 を出さない）。
	 */
	elapsedSec?: number;
	pid?: number;
	/** CC 公式のセッション表示名（sessions/*.json の name） */
	sessionName?: string;
	/** name の由来（'derived' 等） */
	nameSource?: string;
	/** CC ランタイムのバージョン */
	sessionVersion?: string;
	/** entrypoint（'claude-vscode' 等） */
	entrypoint?: string;
	/** --agent 起動セッションでの agent 名（agentSessions 補強に利用） */
	sessionAgent?: string;
	/** CSM に登録されたエージェント名 */
	linkedAgentName?: string;
	/** CSM 表示名 */
	linkedDisplayName?: string;
	/**
	 * ワークフロー的セッションか。
	 *   v0.5.22 以降は kind === 'background' を公式値として優先し、
	 *   kind が空 or 'interactive' の場合のみ subagents.length >= 3 のヒューリスティックにフォールバック。
	 */
	isWorkflowLike: boolean;
	/** 稼働中サブエージェント */
	subagents: SubagentInfo[];
}

/** オーケストレーション全体のビューモデル */
export interface OrchestrationViewModel {
	sessions: OrchestrationSession[];
	interactiveCount: number;
	backgroundCount: number;
	totalSubagentCount: number;
	updatedAt: number;
	/** v0.5.22: 供給源は agent-watcher のみ */
	source: 'agent-watcher';
}

// -------------------------------------------------------------------
// JSONL パス計算（agentUtils に集約）
// -------------------------------------------------------------------

function computeJsonlPath(sessionId: string, cwd: string): string | null {
	return computeJsonlPathForSession(sessionId, cwd);
}

// -------------------------------------------------------------------
// ビューモデル構築
// -------------------------------------------------------------------

/**
 * agentWatcher が集めた sessions/*.json メタ + サブエージェント情報を組み合わせて
 * OrchestrationViewModel を返す。
 */
export async function buildOrchestrationViewModel(
	agentWatcher: AgentWatcher,
): Promise<OrchestrationViewModel> {
	const now = Date.now();

	// CSM 登録エージェント (sessionId → agent のマッピング用)
	const allAgents = await dataStore.getAgents();
	const sidToAgent = new Map(
		allAgents.filter(a => a.sessionId).map(a => [a.sessionId!, a])
	);

	// ライブセッションを agentWatcher から取得
	const cwdMap = agentWatcher.getLiveSessionCwdMap();
	const metaMap = agentWatcher.getLiveSessionMetaMap();
	const sessionIds = [...cwdMap.keys()];

	// 各セッションのサブエージェントを並列検出
	const sessions = await Promise.all(sessionIds.map(async (sessionId): Promise<OrchestrationSession> => {
		const cwd = cwdMap.get(sessionId) ?? '';
		const meta = metaMap.get(sessionId);
		const kind = meta?.kind ?? 'interactive';

		// サブエージェント検出
		let subagents: SubagentInfo[] = [];
		if (sessionId && cwd) {
			const jsonlPath = computeJsonlPath(sessionId, cwd);
			if (jsonlPath) {
				try {
					if (fs.existsSync(jsonlPath)) {
						subagents = await detectSubagents(jsonlPath);
					}
				} catch { /* 検出失敗はサイレントに無視 */ }
			}
		}

		// CSM エージェント紐づけ（sessionId → 公式 agent フィールド の順で試す）
		let linkedAgent = sessionId ? sidToAgent.get(sessionId) : undefined;
		if (!linkedAgent && meta?.agent) {
			linkedAgent = allAgents.find(a => a.name === meta.agent);
		}

		// v0.5.22 レビュー修正 L2: 公式 kind を厳密に優先。
		//   旧: kind === 'interactive' でも subagents>=3 なら background に上書きしていた（公式値の上書きバグ）。
		//   新: meta.kind が undefined のときのみ subagents>=3 のヒューリスティックにフォールバック。
		//        公式値が interactive を明示していれば、サブエージェント数に関係なく interactive として扱う。
		const isWorkflowLike = kind === 'background'
			|| (meta?.kind === undefined && subagents.length >= 3);

		// v0.5.22 レビュー修正 M2: startedAt を実収集値から採用し経過秒を正しく計算。
		//   旧: startedAt=now / elapsedSec=0 で常に 00:00:00 の虚偽表示だった。
		//   新: meta.startedAt があれば (now - startedAt) / 1000 で経過秒。不明時は undefined を返し、
		//        UI 側（SessionItem）で経過時間行を非表示にする。
		const startedAt = meta?.startedAt;
		const elapsedSec = startedAt !== undefined
			? Math.max(0, Math.floor((now - startedAt) / 1000))
			: undefined;

		return {
			sessionId,
			cwd,
			kind,
			startedAt: startedAt ?? now, // 型互換のため近似値を残置（elapsedSec が信頼できる指標）
			elapsedSec,
			pid: meta?.pid,
			sessionName: meta?.name,
			nameSource: meta?.nameSource,
			sessionVersion: meta?.version,
			entrypoint: meta?.entrypoint,
			sessionAgent: meta?.agent,
			linkedAgentName: linkedAgent?.name,
			linkedDisplayName: linkedAgent?.displayName || linkedAgent?.name,
			isWorkflowLike,
			subagents,
		};
	}));

	// 集計
	const interactiveCount = sessions.filter(s => !s.isWorkflowLike).length;
	const backgroundCount = sessions.filter(s => s.isWorkflowLike).length;
	const totalSubagentCount = sessions.reduce((sum, s) => sum + s.subagents.length, 0);

	return {
		sessions,
		interactiveCount,
		backgroundCount,
		totalSubagentCount,
		updatedAt: now,
		source: 'agent-watcher',
	};
}
