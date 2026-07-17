// agentFileManager.ts — ~/.claude/agents/*.md の読み書きを担う Single Source of Truth
// CLI標準フィールド + CSM独自フィールドの YAML フロントマター解析
// Phase 3: session-manager.json の agents[] を置き換える

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { AgentConfig } from '../models/types';
import { CsmModel } from '../models/modelCatalog';
import { sanitizeForYaml, parseFrontmatterExtended } from '../utils/frontmatterUtils';
import { modelCliMap } from '../utils/cliBuilder';
import { normalizeModel, normalizeStatus, moveToTrash } from '../utils/agentUtils';

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
	/** CLI標準: モデル（v0.5.14: fable / fable-1m を追加） */
	model: CsmModel;
	/** CLI標準: メモリモード */
	memory?: string;
	/** CLI標準: 利用可能ツール */
	tools?: string[];
	/** CLI標準: 権限モード */
	permissionMode?: string;
	/** CLI標準: 隔離モード（worktree） */
	isolation?: string;
	/** CLI標準: バックグラウンド実行 */
	background?: boolean;
	/** CLI標準: 最大ターン数 */
	maxTurns?: number;
	/** CSM独自: HISTORY自動追記 */
	historyEnabled?: boolean;
	/** CSM独自: HISTORY.md 保存先スコープ上書き（未指定=.md実在スコープ） */
	historyScope?: 'global' | 'project';
	/** CSM独自: TODO管理 */
	todoEnabled?: boolean;
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
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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

// M-4: agents i18n 辞書のモジュールスコープキャッシュ（起動時1回だけ読み込み）
// v0.5.0 T1.2: data/i18n/ja/agents.json へ移行（旧 data/global-agents-i18n.json との後方互換あり）
let _i18nCache: Record<string, { displayName?: string; displayDescription?: string; displayRole?: string }> | null = null;
function getI18nData(): Record<string, { displayName?: string; displayDescription?: string; displayRole?: string }> {
	if (_i18nCache !== null) { return _i18nCache; }
	const dataDir = path.join(path.dirname(__dirname), 'data');
	// 新パスを優先し、なければ旧パスにフォールバック（マイグレーション前の互換性）
	const newPath = path.join(dataDir, 'i18n', 'ja', 'agents.json');
	const oldPath = path.join(dataDir, 'global-agents-i18n.json');
	const i18nPath = fs.existsSync(newPath) ? newPath : oldPath;
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
			background: d.background === true || d.background === 'true',
			maxTurns: (() => { const n = Number(d.maxTurns); return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined; })(),
			historyEnabled: d.historyEnabled === true || d.historyEnabled === 'true',
			historyScope: (d.historyScope === 'global' || d.historyScope === 'project') ? d.historyScope : undefined,
			todoEnabled: d.todoEnabled === true || d.todoEnabled === 'true',
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
	if (s === 'low' || s === 'medium' || s === 'high' || s === 'xhigh' || s === 'max') { return s; }
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
// v0.5.30: 2s → 10s に延長（エージェント一覧の起動時に .md を何度も読み直すコストを削減）。
//   ユーザー操作（追加/削除/編集）は dataStore 経由で invalidateCache() が呼ばれ即座に無効化される
//   （dataStore.addAgent / removeAgent / moveAgentScope の 3 か所）ので、
//   拡張内での変更は即反映される。エディタから直接 ~/.claude/agents/*.md を手編集した場合のみ
//   最大 10 秒待つことになるが、これは元々明示的な refresh コマンド運用でも許容範囲。
const CACHE_TTL_MS = 10_000;
let cachedAgents: AgentDefinition[] | null = null;
let cachedTimestamp = 0;

/** キャッシュを無効化する */
export function invalidateCache(): void {
	cachedAgents = null;
	cachedTimestamp = 0;
}

/**
 * 全エージェント定義を取得（グローバル + プロジェクト、プロジェクト優先）
 * TTLキャッシュ付き（v0.5.30 以降は 10 秒間有効）
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

	// 追加ディレクトリのスキャン: VS Codeの追加作業ディレクトリの .claude/agents/ も読む
	const additionalAgents: AgentDefinition[] = [];
	const scannedDirs = new Set([globalDir.toLowerCase(), (projectDir || '').toLowerCase()].filter(Boolean));
	const workspaceFolders = vscode.workspace.workspaceFolders || [];
	for (const folder of workspaceFolders) {
		const dir = path.join(folder.uri.fsPath, '.claude', 'agents');
		if (scannedDirs.has(dir.toLowerCase())) { continue; }
		scannedDirs.add(dir.toLowerCase());
		const agents = await scanAgentsDir(dir, 'project');
		additionalAgents.push(...agents);
	}
	// 設定で指定された追加プロジェクトフォルダの .claude/agents/ をスキャン
	const additionalDirs: string[] = vscode.workspace.getConfiguration('claudeManager').get<string[]>('additionalAgentDirs', []);
	for (const baseDir of additionalDirs) {
		if (!baseDir) { continue; }
		const dir = path.join(baseDir, '.claude', 'agents');
		if (scannedDirs.has(dir.toLowerCase())) { continue; }
		scannedDirs.add(dir.toLowerCase());
		const agents = await scanAgentsDir(dir, 'project');
		additionalAgents.push(...agents);
	}
	// workDirが設定されたグローバルエージェントのworkDir/.claude/agents/ もスキャン
	for (const agent of globalAgents) {
		if (!agent.workDir) { continue; }
		const dir = path.join(agent.workDir, '.claude', 'agents');
		if (scannedDirs.has(dir.toLowerCase())) { continue; }
		scannedDirs.add(dir.toLowerCase());
		const agents = await scanAgentsDir(dir, 'project');
		additionalAgents.push(...agents);
	}

	// マージ: プロジェクト > 追加ディレクトリ > グローバル（同名は先勝ち）
	const seenNames = new Set<string>();
	const merged: AgentDefinition[] = [];
	for (const a of [...projectAgents, ...additionalAgents, ...globalAgents]) {
		if (seenNames.has(a.name)) { continue; }
		seenNames.add(a.name);
		merged.push(a);
	}

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
		// v0.5.14 レビュー修正 (1): description を独立に渡す。
		//   旧: マッピング欠落 → フォーム表示時に v.description が undefined
		//        → プレフィル式 (v.displayDescription || v.role) にフォールバックし、
		//          保存で英語descriptionが日本語role文に恒久置換される（HIGH-1 が編集経路で機能しない）。
		//   orgBuilder の reassign（remove→add）で description が消えるのも同根。
		description: def.description,
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
		historyEnabled: def.historyEnabled,
		historyScope: def.historyScope,
		todoEnabled: def.todoEnabled,
		showInOrgChart: def.showInOrgChart,
		isolation: def.isolation,
		background: def.background,
		maxTurns: def.maxTurns,
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
	let existingRaw: string | undefined;
	let parseFailed = false;
	try {
		existingRaw = await fs.promises.readFile(filePath, 'utf-8');
		const parsed = parseFrontmatterExtended(existingRaw);
		if (parsed) {
			existingBody = parsed.body;
		} else {
			// v0.5.16 L-15: parse 失敗（frontmatter 破損など） → 上書き前に .trash/ 退避
			parseFailed = true;
		}
	} catch {
		// 新規作成
	}

	// v0.5.16 L-15: 既存ファイルの上書きが「意図しない全上書き」になるケースを防ぐため、
	//   下記いずれかの場合は上書き前に元ファイルを .trash/ へ退避する。
	//     (a) parse に失敗した（frontmatter 破損）
	//     (b) 同名の別エージェント登録（body 空指定で新規作成しようとしている）→ 既存本文が消える
	//   (b) の判定: body 未指定 かつ existingBody あり かつ frontmatter に既存の name フィールドが
	//                異なる意図で書かれていた… は困難なので、シンプルに「新規作成扱い（def.body 明示的な undefined）
	//                なのに既存 body が存在」を「疑わしい上書き」として退避対象にする。
	//   ただし通常の更新（body が undefined で existingBody を継承）は上書きしても既存の本文は保持されるため
	//   実質的な情報損失はなく、退避不要。誤爆を防ぐため (b) は既存 body が空でない かつ def の他のフィールドが
	//   ほぼ空（少なくとも role/description 両方欠落）のケースに限定。
	const suspiciousOverwrite = !parseFailed && existingRaw !== undefined && def.body === undefined
		&& !!existingBody && !def.role && !def.description;
	if ((parseFailed || suspiciousOverwrite) && existingRaw !== undefined) {
		try {
			const trashDir = path.join(dir, '.trash');
			await moveToTrash(filePath, trashDir);
		} catch { /* 退避失敗時も後続で上書きは進む。ここでは blocking しない */ }
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
	// ダブルクォート内を 1 行に収まる形でエスケープ:
	//   \ → \\ (最初に), " → \", 改行/復帰/タブ → \n/\r/\t
	// （生の改行が入ると frontmatter が複数行に割れてパースが壊れるため必須）
	const escaped = sanitized
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t');
	return `"${escaped}"`;
}

// フロントマターを構築
function buildFrontmatter(def: Partial<AgentDefinition> & { name: string }): string {
	const lines: string[] = ['---'];

	lines.push(`name: ${quoteYamlValue(def.name)}`);
	if (def.displayName) { lines.push(`displayName: ${quoteYamlValue(def.displayName)}`); }
	if (def.description) { lines.push(`description: ${quoteYamlValue(def.description)}`); }
	if (def.displayDescription) { lines.push(`displayDescription: ${quoteYamlValue(def.displayDescription)}`); }
	if (def.model) { lines.push(`model: ${modelCliMap[def.model] || def.model}`); }
	if (def.memory) { lines.push(`memory: ${def.memory}`); }
	if (def.tools && def.tools.length > 0) {
		lines.push(`tools: ${JSON.stringify(def.tools)}`);
	}
	if (def.permissionMode) { lines.push(`permissionMode: ${def.permissionMode}`); }
	if (def.historyEnabled !== undefined) { lines.push(`historyEnabled: ${def.historyEnabled}`); }
	if (def.historyScope) { lines.push(`historyScope: "${def.historyScope}"`); }
	if (def.todoEnabled !== undefined) { lines.push(`todoEnabled: ${def.todoEnabled}`); }
	if (def.isolation) { lines.push(`isolation: ${def.isolation}`); }
	if (def.background) { lines.push(`background: true`); }
	if (def.maxTurns && def.maxTurns > 0) { lines.push(`maxTurns: ${Math.floor(def.maxTurns)}`); }
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
export async function saveAgentConfig(config: AgentConfig, body?: string): Promise<string> {
	// 既存ファイルがあればそれを更新
	const existing = await getAgentByName(config.name);

	// v0.5.14 HIGH-1 fix + レビュー修正 (3):
	//   旧: `description: config.role || existing?.description || ''`
	//     → role を description に上書き。フォームで description 編集不能。
	//       role 翻訳（日本語化）で英語 description が消え CC の自動委譲判定が壊れる。
	//   新:
	//     - 既存エージェント更新: フォームから送られた description を尊重。空文字は明示的な消去として尊重。
	//     - 新規作成 & description 空: role をフォールバックとして frontmatter に書き出す
	//       （CC の自動委譲は description 行が必須。空だと sub-agent 選択で無視される）。
	//     - 非フォーム経路（description 未指定）: 既存値を保持。
	const explicitDescription = typeof config.description === 'string';
	const descriptionValue = (() => {
		if (explicitDescription) {
			const trimmed = (config.description ?? '').trim();
			// 新規作成 (existing なし) & 空 → role にフォールバックして必ず 1 行埋める
			if (!existing && trimmed === '') {
				return (config.role || '').trim();
			}
			return trimmed;
		}
		return existing?.description || '';
	})();

	const def: Partial<AgentDefinition> & { name: string } = {
		name: config.name,
		displayName: config.displayName || existing?.displayName,
		description: descriptionValue,
		displayDescription: config.displayDescription || existing?.displayDescription,
		model: config.model,
		// v0.5.16 M-11: memory はデフォルト注入（'project'）を撤廃。既存値のみを尊重（無ければ書かない）。
		//   旧: `existing?.memory || 'project'` → 新規保存で常に memory:project が黙って追加され、
		//        グローバル・全体メモリを期待するエージェントを暗黙にプロジェクトメモリ運用に切り替えていた。
		memory: existing?.memory,
		// フォーム由来フィールドは「指定があればそれを権威」とする（空配列=制限なし/解除を尊重）
		tools: config.allowedTools !== undefined ? config.allowedTools : existing?.tools,
		isolation: config.isolation !== undefined ? (config.isolation || undefined) : existing?.isolation,
		background: config.background !== undefined ? config.background : existing?.background,
		maxTurns: config.maxTurns !== undefined ? (config.maxTurns || undefined) : existing?.maxTurns,
		// v0.5.16 M-10: permissionMode / effort は「未指定なら既存値を継承」に統一。
		//   旧: `config.permissionMode || existing?.permissionMode` — フォームが常に既定値
		//       (acceptEdits/high) を送るため existing の意図が上書きされていた。
		//   新: フォームは inherit で undefined を送るようになったので、undefined 時は existing を維持。
		permissionMode: config.permissionMode !== undefined ? config.permissionMode : existing?.permissionMode,
		historyEnabled: config.historyEnabled !== undefined ? config.historyEnabled : existing?.historyEnabled,
		historyScope: config.historyScope !== undefined ? config.historyScope : existing?.historyScope,
		todoEnabled: config.todoEnabled !== undefined ? config.todoEnabled : existing?.todoEnabled,
		parentAgent: config.parentAgent,
		status: config.status,
		workDir: config.workDir,
		role: config.role,
		displayRole: config.displayRole || existing?.displayRole,
		effort: config.effort !== undefined ? config.effort : existing?.effort,
		// v0.5.16 M-11: thinkingEnabled も既存値フォールバックを追加（旧: 常に config.thinkingEnabled=undefined で消失）
		thinkingEnabled: config.thinkingEnabled !== undefined ? config.thinkingEnabled : existing?.thinkingEnabled,
		showInOrgChart: config.showInOrgChart !== undefined ? config.showInOrgChart : existing?.showInOrgChart,
		scope: config.scope || existing?.scope || 'global',
		body: body,
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
