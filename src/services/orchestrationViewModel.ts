/**
 * orchestrationViewModel.ts — v0.5.x T7.3
 * オーケストレーション可視化タブ用のデータモデル構築サービス。
 *
 * データソース:
 *   1. ClaudeAgentsService  — claude agents --json (ライブセッション一覧)
 *   2. AgentWatcher         — PID/JSONL 監視 (フォールバック + cwd 解決)
 *   3. subagentDetector     — JSONL 末尾解析 (稼働中サブエージェント)
 *   4. dataStore            — CSM エージェント登録情報
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ClaudeAgentsService, ClaudeAgentEntry } from './claudeAgentsService';
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
	/** claude agents --json の kind フィールド */
	kind: 'interactive' | 'background' | string;
	/** 開始タイムスタンプ (ms) — startedAt または Date.now() */
	startedAt: number;
	/** 経過秒数 */
	elapsedSec: number;
	/** PID (JSON API 時のみ) */
	pid?: number;
	/** CSM に登録されたエージェント名 (sessionId でマッチした場合) */
	linkedAgentName?: string;
	/** CSM 表示名 */
	linkedDisplayName?: string;
	/** ワークフロー的セッションか (ヒューリスティック: background || subagent 数 >= 3) */
	isWorkflowLike: boolean;
	/** 稼働中サブエージェント */
	subagents: SubagentInfo[];
}

/** オーケストレーション全体のビューモデル */
export interface OrchestrationViewModel {
	/** 全セッション一覧 */
	sessions: OrchestrationSession[];
	/** interactive セッション数 */
	interactiveCount: number;
	/** background / workflow セッション数 */
	backgroundCount: number;
	/** 全稼働中サブエージェント数 */
	totalSubagentCount: number;
	/** 最終更新時刻 */
	updatedAt: number;
	/** データソース識別子 */
	source: 'claude-agents-json' | 'agent-watcher-fallback';
}

// -------------------------------------------------------------------
// JSONL パス計算 (agentWatcher.getJsonlPath と同ロジック)
// -------------------------------------------------------------------

function computeJsonlPath(sessionId: string, cwd: string): string | null {
	if (!cwd || !sessionId) { return null; }
	const encoded = cwd
		.toLowerCase()
		.replace(/\\/g, '/')
		.replace(/^([a-z]):/, '$1-')
		.replace(/[\s/]/g, '-');
	return path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

// -------------------------------------------------------------------
// ビューモデル構築
// -------------------------------------------------------------------

/**
 * ライブセッション一覧とサブエージェント情報を組み合わせて
 * OrchestrationViewModel を返す。
 */
export async function buildOrchestrationViewModel(
	claudeAgentsService: ClaudeAgentsService,
	agentWatcher: AgentWatcher,
): Promise<OrchestrationViewModel> {
	const now = Date.now();

	// CSM 登録エージェント (sessionId → agent のマッピング用)
	const allAgents = await dataStore.getAgents();
	const sidToAgent = new Map(
		allAgents.filter(a => a.sessionId).map(a => [a.sessionId!, a])
	);

	// --- ライブセッション取得 ---
	let rawEntries: ClaudeAgentEntry[];
	let source: OrchestrationViewModel['source'];

	const availability = claudeAgentsService.getAvailability();
	if (availability === 'available') {
		rawEntries = claudeAgentsService.getEntries();
		source = 'claude-agents-json';
	} else {
		// フォールバック: agentWatcher の PID/JSONL データ
		const cwdMap = agentWatcher.getLiveSessionCwdMap();
		rawEntries = [...cwdMap.entries()].map(([sessionId, cwd]) => ({
			sessionId,
			status: 'running' as const,
			cwd,
			rawLine: '',
		}));
		source = 'agent-watcher-fallback';
	}

	// --- 各セッションのサブエージェントを並列検出 ---
	const sessions = await Promise.all(rawEntries.map(async (entry): Promise<OrchestrationSession> => {
		const sessionId = entry.sessionId ?? '';
		const cwd = entry.cwd ?? '';
		const startedAt = entry.startedAt ?? now;
		const elapsedSec = entry.elapsedSec ?? Math.floor((now - startedAt) / 1000);

		// サブエージェント検出
		let subagents: SubagentInfo[] = [];
		if (sessionId && cwd) {
			const jsonlPath = computeJsonlPath(sessionId, cwd);
			if (jsonlPath) {
				try {
					if (fs.existsSync(jsonlPath)) {
						subagents = await detectSubagents(jsonlPath);
					}
				} catch {
					// 検出失敗はサイレントに無視
				}
			}
		}

		// CSM エージェント紐づけ
		const linkedAgent = sessionId ? sidToAgent.get(sessionId) : undefined;

		// ワークフロー的判定 (ヒューリスティック)
		const isWorkflowLike = entry.kind === 'background' || subagents.length >= 3;

		return {
			sessionId,
			cwd,
			kind: entry.kind ?? 'interactive',
			startedAt,
			elapsedSec,
			pid: entry.pid,
			linkedAgentName: linkedAgent?.name,
			linkedDisplayName: linkedAgent?.displayName || linkedAgent?.name,
			isWorkflowLike,
			subagents,
		};
	}));

	// --- 集計 ---
	const interactiveCount = sessions.filter(s => s.kind === 'interactive' && !s.isWorkflowLike).length;
	const backgroundCount = sessions.filter(s => s.kind === 'background' || s.isWorkflowLike).length;
	const totalSubagentCount = sessions.reduce((sum, s) => sum + s.subagents.length, 0);

	return {
		sessions,
		interactiveCount,
		backgroundCount,
		totalSubagentCount,
		updatedAt: now,
		source,
	};
}
