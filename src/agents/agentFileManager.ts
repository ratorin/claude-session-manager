// agentFileManager.ts — ~/.claude/agents/*.md の読み書きを担う Single Source of Truth
// CLI標準フィールド + CSM独自フィールドの YAML フロントマター解析
// Phase 3: session-manager.json の agents[] を置き換える

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { AgentConfig } from '../models/types';
import { sanitizeForYaml, parseFrontmatterExtended } from '../utils/frontmatterUtils';
import { normalizeModel, normalizeStatus } from '../utils/agentUtils';

// agents/*.md から読み取ったエージェント定義
export interface AgentDefinition {
	/** CLI標準: エージェント名（ファイル名から） */
	name: string;
	/** CSM独自: 日本語表示名 */
	displayName?: string;
	/** CLI標準: 説明（frontmatter の description） */
	description: string;
	/** CSM独自: 日本語説明（UI表示用） */
	displayDescription?: string;
	/** CLI標準: モデル */
	model: 'opus' | 'sonnet' | 'sonnet-1m' | 'haiku';
	/** CLI標準: メモリモード */
	memory?: string;
	/** CLI標準: 利用可能ツール */
	tools?: string[];
	/** CLI標準: 権限モード */
	permissionMode?: string;
	/** CLI標準: 隔離モード */
	isolation?: string;
	/** CSM独自: 親エージェント名 */
	parentAgent?: string;
	/** CSM独自: 稼働状態 */
	status?: 'active' | 'idle' | 'archived';
	/** CSM独自: 作業ディレクトリ */
	workDir?: string;
	/** CSM独自: 役割テキスト */
	role?: string;
	/** CSM独自: 日本語役割説明（UI表示用） */
	displayRole?: string;
	/** CSM独自: 推論努力レベル */
	effort?: 'low' | 'medium' | 'high' | 'max';
	/** CSM独自: Extended Thinking */
	thinkingEnabled?: boolean;
	/** CSM独自: 組織図表示 */
	showInOrgChart?: boolean;
	/** ファイルパス（フルパス） */
	filePath: string;
	/** 本文（システムプロンプト） */
	body: string;
	/** スコープ（グローバル or プロジェクト） */
	scope: 'global' | 'project';
}

// グローバル agents ディレクトリ
function getGlobalAgentsDir(): string {
	return path.join(os.homedir(), '.claude', 'agents');
}

// プロジェクト agents ディレクトリ
function getProjectAgentsDir(): string | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'agents');
	}
	return undefined;
}

// H-1: parseFrontmatterExtended は frontmatterUtils.ts に統合済み

// M-4: global-agents-i18n.json のモジュールスコープキャッシュ（起動時1回だけ読み込み）
let _i18nCache: Record<string, { displayName?: string; displayDescription?: string; displayRole?: string }> | null = null;
function getI18nData(): Record<string, { displayName?: string; displayDescription?: string; displayRole?: string }> {
	if (_i18nCache !== null) { return _i18nCache; }
	const i18nPath = path.join(path.dirname(__dirname), 'data', 'global-agents-i18n.json');
	try {
		_i18nCache = JSON.parse(fs.readFileSync(i18nPath, 'utf-8'));
	} catch {
		_i18nCache = {};
	}
	return _i18nCache!;
}

// agents/*.md を1ファイル読み込んで AgentDefinition に変換
async function parseAgentFile(filePath: string, scope: 'global' | 'project'): Promise<AgentDefinition | null> {
	try {
		const content = await fs.promises.readFile(filePath, 'utf-8');
		const parsed = parseFrontmatterExtended(content);
		if (!parsed) { return null; }

		const d = parsed.data;
		const fileName = path.basename(filePath, '.md');

		// モデル名の正規化
		const rawModel = String(d.model || 'sonnet');
		const model = normalizeModel(rawModel);

		return {
			name: String(d.name || fileName),
			displayName: d.displayName ? String(d.displayName) : undefined,
			description: String(d.description || ''),
			displayDescription: d.displayDescription ? String(d.displayDescription) : undefined,
			model,
			memory: d.memory ? String(d.memory) : undefined,
			tools: Array.isArray(d.tools) ? d.tools : undefined,
			permissionMode: d.permissionMode ? String(d.permissionMode) : undefined,
			isolation: d.isolation ? String(d.isolation) : undefined,
			parentAgent: d.parentAgent ? String(d.parentAgent) : undefined,
			status: normalizeStatus(d.status),
			workDir: d.workDir ? String(d.workDir) : undefined,
			role: d.role ? String(d.role) : undefined,
			displayRole: d.displayRole ? String(d.displayRole) : undefined,
			effort: normalizeEffort(d.effort),
			thinkingEnabled: typeof d.thinkingEnabled === 'boolean'
				? d.thinkingEnabled
				: (typeof d.thinking === 'boolean' ? d.thinking : undefined),
			showInOrgChart: typeof d.showInOrgChart === 'boolean' ? d.showInOrgChart : undefined,
			filePath,
			body: parsed.body,
			scope,
		};
	} catch {
		return null;
	}
}

// Effort を正規化
function normalizeEffort(raw: unknown): AgentDefinition['effort'] {
	if (!raw) { return undefined; }
	const s = String(raw);
	if (s === 'low' || s === 'medium' || s === 'high' || s === 'max') { return s; }
	return undefined;
}

// グローバルエージェント の日本語訳を適用
function applyGlobalAgentsI18n(agents: AgentDefinition[]): AgentDefinition[] {
	const i18nData = getI18nData();
	return agents.map(agent => {
		if (agent.scope === 'global' && i18nData[agent.name]) {
			const trans = i18nData[agent.name];
			return {
				...agent,
				displayName: trans.displayName || agent.displayName,
				displayDescription: trans.displayDescription || agent.displayDescription,
				displayRole: trans.displayRole || agent.displayRole,
			};
		}
		return agent;
	});
}

// 指定ディレクトリ内の *.md を全件読み込み
async function scanAgentsDir(dir: string, scope: 'global' | 'project'): Promise<AgentDefinition[]> {
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		// ENOENT またはアクセスエラー → ディレクトリなし
		return [];
	}


	const mdFiles = entries.filter(f => f.endsWith('.md'));
	const results = await Promise.allSettled(
		mdFiles.map(f => parseAgentFile(path.join(dir, f), scope))
	);

	const agents: AgentDefinition[] = [];
	for (const r of results) {
		if (r.status === 'fulfilled' && r.value) {
			agents.push(r.value);
		}
	}
	return agents;
}

// TTLキャッシュ
const CACHE_TTL_MS = 2000;
let cachedAgents: AgentDefinition[] | null = null;
let cachedTimestamp = 0;

/** キャッシュを無効化する */
export function invalidateCache(): void {
	cachedAgents = null;
	cachedTimestamp = 0;
}

/**
 * 全エージェント定義を取得（グローバル + プロジェクト、プロジェクト優先）
 * TTLキャッシュ付き（2秒間有効）
 */
export async function getAllAgents(): Promise<AgentDefinition[]> {
	const now = Date.now();
	if (cachedAgents && (now - cachedTimestamp) < CACHE_TTL_MS) {
		return cachedAgents;
	}

	const globalDir = getGlobalAgentsDir();
	const projectDir = getProjectAgentsDir();

	let globalAgents = await scanAgentsDir(globalDir, 'global');
	const projectAgents = projectDir ? await scanAgentsDir(projectDir, 'project') : [];

	// グローバルエージェント に和訳を適用
	globalAgents = applyGlobalAgentsI18n(globalAgents);

	// プロジェクトが優先（同名はプロジェクトのみ残す）
	const projectNames = new Set(projectAgents.map(a => a.name));
	const merged = [
		...projectAgents,
		...globalAgents.filter(a => !projectNames.has(a.name)),
	];

	cachedAgents = merged;
	cachedTimestamp = now;
	return merged;
}

/**
 * 名前でエージェント定義を取得
 */
export async function getAgentByName(name: string): Promise<AgentDefinition | null> {
	const agents = await getAllAgents();
	return agents.find(a => a.name === name) || null;
}

/**
 * AgentDefinition → AgentConfig 変換（既存コードとの互換用）
 */
export function toAgentConfig(def: AgentDefinition): AgentConfig {
	return {
		name: def.name,
		displayName: def.displayName,
		sessionId: '', // agents/*.md にはセッションID情報はない
		role: def.role || def.description,
		displayRole: def.displayRole,
		displayDescription: def.displayDescription,
		model: def.model,
		sessionMode: 'fixed', // CLI標準は固定セッション相当
		ruleFile: def.filePath,
		parentAgent: def.parentAgent,
		allowedTools: def.tools,
		workDir: def.workDir,
		scope: def.scope,
		status: def.status,
		effort: def.effort,
		thinkingEnabled: def.thinkingEnabled,
		permissionMode: def.permissionMode,
		showInOrgChart: def.showInOrgChart,
	};
}

/**
 * 全エージェントを AgentConfig 形式で取得（既存コードとの互換用）
 * session-manager.json の sessionId/previousSessionIds を補完する
 */
export async function getAllAgentsAsConfig(
	sessionIdMap?: Map<string, string>,
	previousSessionIdsMap?: Map<string, string[]>
): Promise<AgentConfig[]> {
	const defs = await getAllAgents();
	return defs.map(def => {
		const config = toAgentConfig(def);
		// session-manager.json からセッションID情報を補完
		if (sessionIdMap) {
			config.sessionId = sessionIdMap.get(def.name) || '';
		}
		if (previousSessionIdsMap) {
			config.previousSessionIds = previousSessionIdsMap.get(def.name);
		}
		return config;
	});
}

/**
 * エージェント名のバリデーション（パストラバーサル対策）
 * 許可: 英数字、ハイフン、アンダースコア、日本語文字
 */
function isValidAgentName(name: string): boolean {
	// パストラバーサル文字（/, \, ..）を含まないこと
	// 許可: Unicode文字（日本語等）、英数字、ハイフン、アンダースコア
	return /^[\p{L}\p{N}_\-]+$/u.test(name) && !name.includes('..');
}

/**
 * agents/*.md にエージェント定義を書き込む（新規作成 or 更新）
 */
export async function writeAgentFile(def: Partial<AgentDefinition> & { name: string }): Promise<string> {
	// C-1: エージェント名バリデーション（パストラバーサル防止）
	if (!isValidAgentName(def.name)) {
		throw new Error(`不正なエージェント名です: ${def.name}`);
	}

	const scope = def.scope || 'global';
	const dir = scope === 'project' ? getProjectAgentsDir() : getGlobalAgentsDir();
	if (!dir) {
		throw new Error('プロジェクトディレクトリが見つかりません');
	}

	await fs.promises.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, `${def.name}.md`);

	// パス解決後もディレクトリ外に出ていないことを確認
	const resolved = path.resolve(filePath);
	if (!resolved.startsWith(path.resolve(dir))) {
		throw new Error(`不正なファイルパスです: ${resolved}`);
	}

	// 既存ファイルがあれば本文を保持
	let existingBody = '';
	try {
		const content = await fs.promises.readFile(filePath, 'utf-8');
		const parsed = parseFrontmatterExtended(content);
		if (parsed) {
			existingBody = parsed.body;
		}
	} catch {
		// 新規作成
	}

	const body = def.body !== undefined ? def.body : existingBody;
	const frontmatter = buildFrontmatter(def);
	const content = frontmatter + '\n' + body;

	await fs.promises.writeFile(filePath, content, 'utf-8');
	invalidateCache();
	return filePath;
}

/**
 * agents/*.md ファイルを削除する
 */
export async function deleteAgentFile(name: string): Promise<boolean> {
	// C-1: エージェント名バリデーション（パストラバーサル防止）
	if (!isValidAgentName(name)) { return false; }

	const agents = await getAllAgents();
	const agent = agents.find(a => a.name === name);
	if (!agent) { return false; }

	try {
		// .trash/ に移動（rm禁止ルール準拠）
		const dir = path.dirname(agent.filePath);
		const trashDir = path.join(dir, '.trash');
		await fs.promises.mkdir(trashDir, { recursive: true });
		const trashDest = path.join(trashDir, `${name}.md.${Date.now()}`);
		await fs.promises.rename(agent.filePath, trashDest);
		invalidateCache();
		return true;
	} catch {
		return false;
	}
}

// H-4: YAMLインジェクション対策 — 文字列値をダブルクォートで安全にラップ
function quoteYamlValue(value: string): string {
	const sanitized = sanitizeForYaml(value);
	// ダブルクォート内の " と \ をエスケープ
	const escaped = sanitized.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	return `"${escaped}"`;
}

// フロントマターを構築
function buildFrontmatter(def: Partial<AgentDefinition> & { name: string }): string {
	const lines: string[] = ['---'];

	lines.push(`name: ${quoteYamlValue(def.name)}`);
	if (def.displayName) { lines.push(`displayName: ${quoteYamlValue(def.displayName)}`); }
	if (def.description) { lines.push(`description: ${quoteYamlValue(def.description)}`); }
	if (def.displayDescription) { lines.push(`displayDescription: ${quoteYamlValue(def.displayDescription)}`); }
	if (def.model) { lines.push(`model: ${def.model}`); }
	if (def.memory) { lines.push(`memory: ${def.memory}`); }
	if (def.tools && def.tools.length > 0) {
		lines.push(`tools: ${JSON.stringify(def.tools)}`);
	}
	if (def.permissionMode) { lines.push(`permissionMode: ${def.permissionMode}`); }
	if (def.isolation) { lines.push(`isolation: ${def.isolation}`); }
	if (def.parentAgent) { lines.push(`parentAgent: ${quoteYamlValue(def.parentAgent)}`); }
	if (def.status) { lines.push(`status: ${def.status}`); }
	if (def.workDir) { lines.push(`workDir: ${quoteYamlValue(def.workDir)}`); }
	if (def.role) { lines.push(`role: ${quoteYamlValue(def.role)}`); }
	if (def.displayRole) { lines.push(`displayRole: ${quoteYamlValue(def.displayRole)}`); }
	if (def.effort) { lines.push(`effort: ${def.effort}`); }
	if (def.thinkingEnabled !== undefined) {
		lines.push(`thinkingEnabled: ${def.thinkingEnabled}`);
	}
	if (def.showInOrgChart !== undefined) {
		lines.push(`showInOrgChart: ${def.showInOrgChart}`);
	}

	lines.push('---');
	return lines.join('\n');
}

/**
 * AgentConfig → agents/*.md 書き込み用変換
 */
export async function saveAgentConfig(config: AgentConfig): Promise<string> {
	// 既存ファイルがあればそれを更新
	const existing = await getAgentByName(config.name);

	const def: Partial<AgentDefinition> & { name: string } = {
		name: config.name,
		displayName: config.displayName || existing?.displayName,
		description: existing?.description || config.role || '',
		displayDescription: config.displayDescription || existing?.displayDescription,
		model: config.model,
		memory: existing?.memory || 'project',
		tools: config.allowedTools || existing?.tools,
		permissionMode: config.permissionMode || existing?.permissionMode,
		isolation: existing?.isolation,
		parentAgent: config.parentAgent,
		status: config.status,
		workDir: config.workDir,
		role: config.role,
		displayRole: config.displayRole || existing?.displayRole,
		effort: config.effort,
		thinkingEnabled: config.thinkingEnabled,
		showInOrgChart: config.showInOrgChart !== undefined ? config.showInOrgChart : (existing?.showInOrgChart ?? true),
		scope: config.scope || existing?.scope || 'global',
	};

	return writeAgentFile(def);
}

/**
 * グローバル agents ディレクトリのパスを取得（外部参照用）
 */
export function getGlobalAgentsDirPath(): string {
	return getGlobalAgentsDir();
}

/**
 * プロジェクト agents ディレクトリのパスを取得（外部参照用）
 */
export function getProjectAgentsDirPath(): string | undefined {
	return getProjectAgentsDir();
}
