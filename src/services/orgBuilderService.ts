/**
 * orgBuilderService.ts — v0.5.0 T3.11 / T3.12 / T3.14 / T3.15
 * マネージャー自律組織構築サービス (F10)
 *
 * 機能:
 *   - diagnose(projectId)   組織パターン検出・ボトルネック分析
 *   - propose(projectId)    診断結果から自然言語提案リストを生成
 *   - approve(proposal)     VS Code QuickPick / Modal で承認フロー
 *   - execute(proposal)     承認済み提案を実行（エージェント追加/削除）
 *   - isGuarded(name)       システムエージェント保護チェック
 *   - logAction(entry)      org-history.jsonl に監査ログを記録
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as dataStore from '../models/dataStore';
import { AgentConfig } from '../models/types';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export type DiagnosisCategory =
    | 'missing-qa'
    | 'missing-planner'
    | 'no-parent-assigned'
    | 'orphan-agent'
    | 'redundant-agents'
    | 'no-agents'
    | 'missing-specialist';

export interface DiagnosisItem {
    category: DiagnosisCategory;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    /** 関連エージェント名 */
    relatedAgents?: string[];
}

export type ProposalAction = 'add' | 'remove' | 'reassign';

export interface OrgProposal {
    id: string;
    action: ProposalAction;
    /** 提案の短いタイトル（UI表示用） */
    title: string;
    /** 詳細説明 */
    description: string;
    /** 追加対象エージェント設定（action=add 時） */
    agentToAdd?: Partial<AgentConfig>;
    /** 削除対象エージェント名（action=remove 時） */
    agentToRemove?: string;
    /** 元診断アイテム */
    diagnosis: DiagnosisItem;
    /** 関連エージェント名（reassign 用） */
    relatedAgents?: string[];
}

export interface OrgHistoryEntry {
    timestamp: string;
    action: ProposalAction;
    agentName: string;
    performedBy: 'user' | 'system';
    projectId?: string;
    note?: string;
}

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SYSTEM_AGENTS_FILE = path.join(
    path.dirname(path.dirname(__dirname)),
    'data',
    'system-agents.json'
);
const ORG_HISTORY_FILE = path.join(CLAUDE_DIR, 'csm-org-history.jsonl');

// -------------------------------------------------------------------
// システムエージェント保護リスト
// -------------------------------------------------------------------

let _systemAgentsCache: string[] | null = null;

interface SystemAgentsFile {
    systemAgents: string[];
}

function loadSystemAgents(): string[] {
    if (_systemAgentsCache !== null) { return _systemAgentsCache; }
    try {
        const raw = fs.readFileSync(SYSTEM_AGENTS_FILE, 'utf-8');
        const parsed = JSON.parse(raw) as SystemAgentsFile;
        _systemAgentsCache = Array.isArray(parsed.systemAgents) ? parsed.systemAgents : [];
    } catch {
        _systemAgentsCache = ['director'];
    }
    return _systemAgentsCache;
}

/**
 * エージェントがシステムエージェント（保護対象）か判定する。
 * `guarded: true` フラグまたは system-agents.json リストに含まれる場合は true。
 */
export function isGuarded(agentName: string, agentConfig?: AgentConfig): boolean {
    if (agentConfig?.guarded) { return true; }
    return loadSystemAgents().includes(agentName);
}

// -------------------------------------------------------------------
// 診断ロジック
// -------------------------------------------------------------------

/**
 * 指定プロジェクトのエージェント編成を診断する。
 * projectId が undefined の場合はグローバルエージェントを対象とする。
 */
export async function diagnose(projectId?: string): Promise<DiagnosisItem[]> {
    const allAgents = await dataStore.getAgents();
    const relevant = projectId
        ? allAgents.filter(a =>
            a.scope === 'global' ||
            (a.scope === 'project' && (a.projectIds ?? []).includes(projectId))
        )
        : allAgents;

    const items: DiagnosisItem[] = [];

    // エージェント0件チェック
    if (relevant.length === 0) {
        items.push({
            category: 'no-agents',
            severity: 'critical',
            message: 'エージェントが1件も登録されていません。まず director を作成することをお勧めします。',
        });
        return items;
    }

    const names = relevant.map(a => a.name.toLowerCase());

    // QA エージェント不在チェック
    const hasQa = names.some(n => n.includes('qa') || n.includes('tester') || n.includes('test'));
    if (!hasQa && relevant.length >= 3) {
        items.push({
            category: 'missing-qa',
            severity: 'warning',
            message: 'QA / テスト担当エージェントが見つかりません。品質管理エージェントの追加をお勧めします。',
        });
    }

    // Planner / Architect 不在チェック
    const hasPlanner = names.some(n =>
        n.includes('planner') || n.includes('architect') || n.includes('planning')
    );
    if (!hasPlanner && relevant.length >= 4) {
        items.push({
            category: 'missing-planner',
            severity: 'info',
            message: 'プランニング / アーキテクト担当エージェントが見つかりません。複雑なプロジェクトでは計画担当の追加が効果的です。',
        });
    }

    // 親エージェント未割当チェック（director 以外）
    const unassigned = relevant.filter(a =>
        !a.parentAgent &&
        a.name.toLowerCase() !== 'director' &&
        a.scope !== 'global'  // グローバルエージェントは親不要
    );
    if (unassigned.length > 0) {
        items.push({
            category: 'no-parent-assigned',
            severity: 'info',
            message: `${unassigned.length} 件のエージェントに親エージェントが割り当てられていません: ${unassigned.map(a => a.name).join(', ')}`,
            relatedAgents: unassigned.map(a => a.name),
        });
    }

    // 孤立エージェントチェック（parentAgent が存在しないエージェントを参照）
    const agentNameSet = new Set(relevant.map(a => a.name));
    const orphans = relevant.filter(a =>
        a.parentAgent && !agentNameSet.has(a.parentAgent)
    );
    if (orphans.length > 0) {
        items.push({
            category: 'orphan-agent',
            severity: 'warning',
            message: `親エージェントが存在しないエージェントがあります: ${orphans.map(a => `${a.name}(→${a.parentAgent})`).join(', ')}`,
            relatedAgents: orphans.map(a => a.name),
        });
    }

    // 重複役割チェック（同一モデル・同一役割キーワード）
    const roleCounts: Record<string, string[]> = {};
    for (const agent of relevant) {
        if (!agent.role) { continue; }
        // 役割の最初の単語をキーに（粗いチェック）
        const key = agent.role.toLowerCase().split(/\s|・|,/)[0].trim().slice(0, 10);
        if (!roleCounts[key]) { roleCounts[key] = []; }
        roleCounts[key].push(agent.name);
    }
    const redundant = Object.entries(roleCounts).filter(([, names]) => names.length >= 3);
    for (const [role, agentNames] of redundant) {
        items.push({
            category: 'redundant-agents',
            severity: 'info',
            message: `「${role}」系の役割を持つエージェントが ${agentNames.length} 件あります: ${agentNames.join(', ')}。統合を検討してください。`,
            relatedAgents: agentNames,
        });
    }

    return items;
}

// -------------------------------------------------------------------
// 提案生成
// -------------------------------------------------------------------

/** 診断結果から承認可能な提案リストを生成する */
export function generateProposals(diagItems: DiagnosisItem[], projectId?: string): OrgProposal[] {
    const proposals: OrgProposal[] = [];
    let idx = 0;

    for (const item of diagItems) {
        const id = `proposal-${Date.now()}-${idx++}`;

        switch (item.category) {
            case 'missing-qa':
                proposals.push({
                    id,
                    action: 'add',
                    title: 'QA エージェントを追加',
                    description: 'テスト・品質確認を担当する QA エージェントを新規作成します。モデルは Sonnet（推奨）、親は director に設定します。',
                    agentToAdd: {
                        name: 'qa',
                        displayName: '品質管理',
                        role: 'コードレビュー・品質確認',
                        model: 'sonnet',
                        scope: projectId ? 'project' : 'global',
                        parentAgent: 'director',
                        projectIds: projectId ? [projectId] : undefined,
                    },
                    diagnosis: item,
                });
                break;

            case 'missing-planner':
                proposals.push({
                    id,
                    action: 'add',
                    title: 'プランナーエージェントを追加',
                    description: '設計・タスク分解を担当する planner エージェントを新規作成します。',
                    agentToAdd: {
                        name: 'planner',
                        displayName: '企画・設計',
                        role: '設計・タスク分解・実装計画立案',
                        model: 'sonnet',
                        scope: projectId ? 'project' : 'global',
                        parentAgent: 'director',
                        projectIds: projectId ? [projectId] : undefined,
                    },
                    diagnosis: item,
                });
                break;

            case 'no-agents':
                proposals.push({
                    id,
                    action: 'add',
                    title: 'Director エージェントを作成',
                    description: '組織の起点となる director エージェントを新規作成します。',
                    agentToAdd: {
                        name: 'director',
                        displayName: '全体統括',
                        role: '全体統括・指示起案・エージェント管理',
                        model: 'opus',
                        scope: 'global',
                        guarded: true,
                    },
                    diagnosis: item,
                });
                break;

            case 'orphan-agent':
                if (item.relatedAgents && item.relatedAgents.length > 0) {
                    proposals.push({
                        id,
                        action: 'reassign',
                        title: `孤立エージェントの親を director に再割り当て`,
                        description: `${item.relatedAgents.join(', ')} の親エージェントが存在しません。director に再割り当てすることを提案します。`,
                        relatedAgents: item.relatedAgents,
                        diagnosis: item,
                    } as OrgProposal);
                }
                break;

            default:
                // info レベルは提案を生成しない（表示のみ）
                break;
        }
    }

    return proposals;
}

// -------------------------------------------------------------------
// 承認フロー (T3.13 — VS Code QuickPick / Modal)
// -------------------------------------------------------------------

/**
 * 提案リストを QuickPick で表示し、ユーザーに承認/スキップさせる。
 * 承認された提案の配列を返す。
 */
export async function promptApproval(proposals: OrgProposal[]): Promise<OrgProposal[]> {
    if (proposals.length === 0) { return []; }

    const items: vscode.QuickPickItem[] = proposals.map(p => ({
        label: `$(add) ${p.title}`,
        description: p.action,
        detail: p.description,
        picked: true,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        title: '🤖 組織構築の提案 — 実行する項目を選択してください',
        placeHolder: '承認する提案を選択（スペースでトグル、Enterで確定）',
        canPickMany: true,
        ignoreFocusOut: true,
    });

    if (!selected || selected.length === 0) { return []; }

    // 選択されたラベルから対応提案を抽出
    const selectedLabels = new Set(selected.map(s => s.label));
    return proposals.filter(p => selectedLabels.has(`$(add) ${p.title}`));
}

/**
 * 単一提案の詳細確認モーダル
 */
export async function confirmProposal(proposal: OrgProposal): Promise<boolean> {
    const detail = proposal.agentToAdd
        ? `名前: ${proposal.agentToAdd.name} / モデル: ${proposal.agentToAdd.model} / スコープ: ${proposal.agentToAdd.scope}`
        : proposal.agentToRemove
        ? `削除対象: ${proposal.agentToRemove}`
        : '詳細なし';

    const answer = await vscode.window.showInformationMessage(
        `${proposal.title}`,
        { modal: true, detail: `${proposal.description}\n\n${detail}` },
        '承認して実行',
        'スキップ'
    );
    return answer === '承認して実行';
}

// -------------------------------------------------------------------
// 提案実行
// -------------------------------------------------------------------

/**
 * 承認済み提案を実行する。
 * エージェント追加・削除・親再割り当てを行い、org-history.jsonl に記録する。
 */
export async function executeProposals(proposals: OrgProposal[], projectId?: string): Promise<number> {
    let executed = 0;

    for (const proposal of proposals) {
        try {
            if (proposal.action === 'add' && proposal.agentToAdd) {
                await addAgentFromProposal(proposal.agentToAdd as AgentConfig);
                await logAction({
                    timestamp: new Date().toISOString(),
                    action: 'add',
                    agentName: proposal.agentToAdd.name ?? '(unknown)',
                    performedBy: 'user',
                    projectId,
                    note: proposal.title,
                });
                executed++;
            } else if (proposal.action === 'remove' && proposal.agentToRemove) {
                if (isGuarded(proposal.agentToRemove)) {
                    vscode.window.showWarningMessage(
                        `⚠️ ${proposal.agentToRemove} はシステムエージェントのため削除できません。`
                    );
                    continue;
                }
                await dataStore.removeAgent(proposal.agentToRemove);
                await logAction({
                    timestamp: new Date().toISOString(),
                    action: 'remove',
                    agentName: proposal.agentToRemove,
                    performedBy: 'user',
                    projectId,
                    note: proposal.title,
                });
                executed++;
            } else if (proposal.action === 'reassign') {
                const agentsToReassign = proposal.relatedAgents ?? [];
                const allAgents = await dataStore.getAgents();
                for (const agentName of agentsToReassign) {
                    const agent = allAgents.find(a => a.name === agentName);
                    if (agent) {
                        // 既存エージェントを更新: 削除 → 再追加
                        await dataStore.removeAgent(agent.name);
                        await dataStore.addAgent({ ...agent, parentAgent: 'director' });
                    }
                }
                if (agentsToReassign.length > 0) {
                    await logAction({
                        timestamp: new Date().toISOString(),
                        action: 'reassign',
                        agentName: agentsToReassign.join(', '),
                        performedBy: 'user',
                        projectId,
                        note: proposal.title,
                    });
                    executed++;
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`提案実行エラー [${proposal.title}]: ${msg}`);
        }
    }

    return executed;
}

/** dataStore を使ってエージェントを新規作成する */
async function addAgentFromProposal(config: AgentConfig): Promise<void> {
    const existing = (await dataStore.getAgents()).find(a => a.name === config.name);
    if (existing) {
        throw new Error(`エージェント「${config.name}」は既に存在します。`);
    }
    const newAgent: AgentConfig = {
        sessionMode: 'fixed',
        scope: 'global',
        ...config,
        sessionId: config.sessionId || '',
    };
    await dataStore.addAgent(newAgent);
}

// -------------------------------------------------------------------
// 監査ログ (T3.15)
// -------------------------------------------------------------------

/**
 * 自律組織の操作を org-history.jsonl に追記する。
 * JSONL 形式（1行 = 1 JSON オブジェクト）
 */
export async function logAction(entry: OrgHistoryEntry): Promise<void> {
    try {
        fs.mkdirSync(path.dirname(ORG_HISTORY_FILE), { recursive: true });
        const line = JSON.stringify(entry) + '\n';
        fs.appendFileSync(ORG_HISTORY_FILE, line, 'utf-8');
    } catch { /* ログ書き込み失敗は無視 */ }
}

/**
 * 組織履歴を読み込む（最新 N 件）
 */
export function readHistory(limit: number = 100): OrgHistoryEntry[] {
    try {
        const raw = fs.readFileSync(ORG_HISTORY_FILE, 'utf-8');
        const lines = raw.trim().split('\n').filter(Boolean);
        const entries = lines.map(l => {
            try { return JSON.parse(l) as OrgHistoryEntry; } catch { return null; }
        }).filter((e): e is OrgHistoryEntry => e !== null);
        return entries.slice(-limit).reverse();
    } catch {
        return [];
    }
}

// -------------------------------------------------------------------
// コマンドエントリポイント (VS Code コマンドから呼び出す)
// -------------------------------------------------------------------

/**
 * 自律組織構築の全フロー:
 *   1. diagnose → 2. generateProposals → 3. promptApproval → 4. executeProposals
 */
export async function runOrgBuilder(projectId?: string): Promise<void> {
    // 診断
    const diagItems = await diagnose(projectId);

    if (diagItems.length === 0) {
        vscode.window.showInformationMessage('✅ 組織診断: 特に問題は見つかりませんでした。');
        return;
    }

    // 診断サマリー表示
    const criticalCount = diagItems.filter(d => d.severity === 'critical').length;
    const warningCount  = diagItems.filter(d => d.severity === 'warning').length;
    const summary = `診断結果: 🔴 ${criticalCount} 件 / ⚠️ ${warningCount} 件 / ℹ️ ${diagItems.length - criticalCount - warningCount} 件`;

    // 提案生成
    const proposals = generateProposals(diagItems, projectId);
    if (proposals.length === 0) {
        vscode.window.showInformationMessage(`${summary}\n提案可能なアクションはありません。`);
        return;
    }

    // 承認フロー
    const approved = await promptApproval(proposals);
    if (approved.length === 0) {
        vscode.window.showInformationMessage('組織構築をキャンセルしました。');
        return;
    }

    // 実行
    const count = await executeProposals(approved, projectId);
    vscode.window.showInformationMessage(`✅ 組織構築: ${count} 件のアクションを実行しました。`);
}

