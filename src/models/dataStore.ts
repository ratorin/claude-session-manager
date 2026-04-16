import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ManagerData, LocalManagerData, AgentConfig, TaskLog, AgentSessionBinding } from './types';
import * as agentFileManager from '../agents/agentFileManager';

// グローバルデータファイル（~/.claude/session-manager.json）
const DATA_FILE = path.join(os.homedir(), '.claude', 'session-manager.json');

// TTLキャッシュ: 頻繁なファイル読み込みを抑制する（2秒間有効）
const CACHE_TTL_MS = 2000;

let cachedData: ManagerData | null = null;
let cachedDataTimestamp = 0;

let cachedLocalData: LocalManagerData | null = null;
let cachedLocalDataTimestamp = 0;
let cachedLocalDataPath: string | undefined;

// ワークスペースのローカルデータファイルパスを取得
function getLocalDataFilePath(): string | undefined {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'session-manager.local.json');
	}
	return undefined;
}

// グローバルデータの読み込み（TTLキャッシュ付き・非同期）
async function loadData(): Promise<ManagerData> {
	const now = Date.now();
	if (cachedData && (now - cachedDataTimestamp) < CACHE_TTL_MS) {
		return cachedData;
	}
	try {
		const raw = await fs.promises.readFile(DATA_FILE, 'utf-8');
		cachedData = JSON.parse(raw);
		cachedDataTimestamp = now;
		return cachedData!;
	} catch (err: unknown) {
		// ENOENT 以外のエラーは無視して初期データを返す（読み込みエラー時も同様）
		void err;
	}
	cachedData = { bookmarks: [], tags: {}, customNames: {}, notes: {} };
	cachedDataTimestamp = now;
	return cachedData;
}

// グローバルデータの保存（保存後にキャッシュを無効化・非同期）
async function saveData(data: ManagerData): Promise<void> {
	await fs.promises.mkdir(path.dirname(DATA_FILE), { recursive: true });
	await fs.promises.writeFile(DATA_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
	// キャッシュを無効化（次回 loadData() で再読み込みさせる）
	cachedData = null;
	cachedDataTimestamp = 0;
}

// ローカルデータの読み込み（TTLキャッシュ付き・非同期）
async function loadLocalData(): Promise<LocalManagerData> {
	const filePath = getLocalDataFilePath();
	if (!filePath) { return {}; }
	const now = Date.now();
	if (cachedLocalData && cachedLocalDataPath === filePath && (now - cachedLocalDataTimestamp) < CACHE_TTL_MS) {
		return cachedLocalData;
	}
	try {
		const raw = await fs.promises.readFile(filePath, 'utf-8');
		cachedLocalData = JSON.parse(raw);
		cachedLocalDataPath = filePath;
		cachedLocalDataTimestamp = now;
		return cachedLocalData!;
	} catch (err: unknown) {
		// ENOENT 以外のエラーは無視して空データを返す
		void err;
	}
	cachedLocalData = {};
	cachedLocalDataPath = filePath;
	cachedLocalDataTimestamp = now;
	return cachedLocalData;
}

// ローカルデータの保存（保存後にキャッシュを無効化・非同期）
async function saveLocalData(data: LocalManagerData): Promise<void> {
	const filePath = getLocalDataFilePath();
	if (!filePath) { return; }
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, JSON.stringify(data, null, '\t'), 'utf-8');
	// キャッシュを無効化（次回 loadLocalData() で再読み込みさせる）
	cachedLocalData = null;
	cachedLocalDataTimestamp = 0;
}

// ブックマーク操作
export async function isBookmarked(sessionId: string): Promise<boolean> {
	return (await loadData()).bookmarks.includes(sessionId);
}

export async function addBookmark(sessionId: string): Promise<void> {
	const data = await loadData();
	if (!data.bookmarks.includes(sessionId)) {
		data.bookmarks.push(sessionId);
		await saveData(data);
	}
}

export async function removeBookmark(sessionId: string): Promise<void> {
	const data = await loadData();
	data.bookmarks = data.bookmarks.filter((id) => id !== sessionId);
	await saveData(data);
}

export async function getBookmarks(): Promise<string[]> {
	return (await loadData()).bookmarks;
}

// タグ操作
export async function addTag(tagName: string, sessionId: string): Promise<void> {
	const data = await loadData();
	if (!data.tags[tagName]) {
		data.tags[tagName] = [];
	}
	if (!data.tags[tagName].includes(sessionId)) {
		data.tags[tagName].push(sessionId);
		await saveData(data);
	}
}

export async function removeTagFromSession(tagName: string, sessionId: string): Promise<void> {
	const data = await loadData();
	if (data.tags[tagName]) {
		data.tags[tagName] = data.tags[tagName].filter((id) => id !== sessionId);
		if (data.tags[tagName].length === 0) {
			delete data.tags[tagName];
		}
		await saveData(data);
	}
}

export async function getAllTags(): Promise<Record<string, string[]>> {
	return (await loadData()).tags;
}

export async function getTagsForSession(sessionId: string): Promise<string[]> {
	const data = await loadData();
	const tags: string[] = [];
	for (const [tag, ids] of Object.entries(data.tags)) {
		if (ids.includes(sessionId)) {
			tags.push(tag);
		}
	}
	return tags;
}

// カスタム名操作
export async function setCustomName(sessionId: string, name: string): Promise<void> {
	const data = await loadData();
	data.customNames[sessionId] = name;
	await saveData(data);
}

export async function getCustomName(sessionId: string): Promise<string | undefined> {
	return (await loadData()).customNames[sessionId];
}

export async function getAllCustomNames(): Promise<Record<string, string>> {
	return (await loadData()).customNames;
}

// メモ操作
export async function setNote(sessionId: string, note: string): Promise<void> {
	const data = await loadData();
	if (note) {
		data.notes[sessionId] = note;
	} else {
		delete data.notes[sessionId];
	}
	await saveData(data);
}

export async function getNote(sessionId: string): Promise<string> {
	const data = await loadData();
	return data.notes?.[sessionId] || '';
}

// エージェント操作（agents/*.md が Single Source of Truth、セッション紐づけのみ session-manager.json）

// セッション紐づけ情報を取得（session-manager.json から）
async function getAgentSessionBindings(): Promise<Record<string, AgentSessionBinding>> {
	const data = await loadData();
	// 新形式（agentSessions）を優先、なければ旧形式（agents[]）から変換
	if (data.agentSessions) {
		return data.agentSessions;
	}
	// 後方互換: agents[] から agentSessions を生成
	const bindings: Record<string, AgentSessionBinding> = {};
	if (data.agents) {
		for (const a of data.agents) {
			if (a.sessionId || a.previousSessionIds) {
				bindings[a.name] = {
					sessionId: a.sessionId || '',
					previousSessionIds: a.previousSessionIds,
					sessionMode: a.sessionMode,
				};
			}
		}
	}
	return bindings;
}

// セッション紐づけ情報を保存
async function saveAgentSessionBinding(name: string, binding: AgentSessionBinding): Promise<void> {
	const data = await loadData();
	if (!data.agentSessions) { data.agentSessions = {}; }
	data.agentSessions[name] = binding;
	await saveData(data);
}

// セッション紐づけ情報を削除
async function removeAgentSessionBinding(name: string): Promise<void> {
	const data = await loadData();
	if (data.agentSessions) {
		delete data.agentSessions[name];
	}
	// 旧形式からも削除
	if (data.agents) {
		data.agents = data.agents.filter(a => a.name !== name);
	}
	await saveData(data);
}

// マージ済みエージェント一覧を取得（agents/*.md + セッション紐づけ）
export async function getAgents(): Promise<AgentConfig[]> {
	const bindings = await getAgentSessionBindings();

	// セッションID/previousSessionIds マップを構築
	const sessionIdMap = new Map<string, string>();
	const prevIdsMap = new Map<string, string[]>();
	const sessionModeMap = new Map<string, 'fixed' | 'disposable'>();
	for (const [name, b] of Object.entries(bindings)) {
		if (b.sessionId) { sessionIdMap.set(name, b.sessionId); }
		if (b.previousSessionIds) { prevIdsMap.set(name, b.previousSessionIds); }
		if (b.sessionMode) { sessionModeMap.set(name, b.sessionMode); }
	}

	const configs = await agentFileManager.getAllAgentsAsConfig(sessionIdMap, prevIdsMap);
	// sessionMode を補完
	for (const c of configs) {
		const mode = sessionModeMap.get(c.name);
		if (mode) { c.sessionMode = mode; }
	}
	return configs;
}

// エージェントを追加（agents/*.md + セッション紐づけ）
export async function addAgent(agent: AgentConfig, body?: string): Promise<void> {
	// 1. agents/*.md にエージェント定義を書き込み（bodyがあればルール本文として保存）
	try {
		await agentFileManager.saveAgentConfig(agent, body);
	} catch {
		// agents/*.md への書き込みが失敗してもセッション紐づけは保存する
	}

	// 2. セッション紐づけ情報を session-manager.json に保存
	await saveAgentSessionBinding(agent.name, {
		sessionId: agent.sessionId || '',
		previousSessionIds: agent.previousSessionIds,
		sessionMode: agent.sessionMode,
	});

	agentFileManager.invalidateCache();
}

// エージェントを削除
export async function removeAgent(name: string): Promise<void> {
	// agents/*.md から削除
	await agentFileManager.deleteAgentFile(name);
	// セッション紐づけを削除
	await removeAgentSessionBinding(name);
	agentFileManager.invalidateCache();
}

// エージェントをスコープ間で移動（agents/*.md のファイル移動）
export async function moveAgentScope(name: string, targetScope: 'global' | 'project'): Promise<boolean> {
	const existing = await agentFileManager.getAgentByName(name);
	if (!existing) { return false; }
	if (existing.scope === targetScope) { return false; }

	// 旧パスを記録
	const oldFilePath = existing.filePath;
	const oldDir = oldFilePath ? path.dirname(oldFilePath) : '';
	const oldSubFolder = oldDir ? path.join(oldDir, name) : '';

	// 新スコープにファイルを作成
	const def: Parameters<typeof agentFileManager.writeAgentFile>[0] = {
		...existing,
		scope: targetScope,
	};
	const newFilePath = await agentFileManager.writeAgentFile(def);

	// サブフォルダ（TODO.md/HISTORY.md）を移動
	const newDir = path.dirname(newFilePath);
	const newSubFolder = path.join(newDir, name);
	if (oldSubFolder) {
		try {
			await fs.promises.access(oldSubFolder);
			await fs.promises.mkdir(newSubFolder, { recursive: true });
			const files = await fs.promises.readdir(oldSubFolder);
			for (const file of files) {
				const src = path.join(oldSubFolder, file);
				const dest = path.join(newSubFolder, file);
				try {
					await fs.promises.access(dest);
					// 既に存在する場合はマージ（末尾に追記）
					const srcContent = await fs.promises.readFile(src, 'utf-8');
					await fs.promises.appendFile(dest, '\n' + srcContent, 'utf-8');
				} catch {
					await fs.promises.copyFile(src, dest);
				}
			}
			// 旧サブフォルダを.trashに移動
			const trashDir = path.join(oldDir, '.trash');
			await fs.promises.mkdir(trashDir, { recursive: true });
			await fs.promises.rename(oldSubFolder, path.join(trashDir, `${name}.${Date.now()}`));
		} catch { /* サブフォルダが存在しない場合は無視 */ }
	}

	// 旧スコープのファイルを削除
	await agentFileManager.deleteAgentFile(name);
	agentFileManager.invalidateCache();
	return true;
}

export async function getAgentBySessionId(sessionId: string): Promise<AgentConfig | undefined> {
	return (await getAgents()).find((a) => a.sessionId === sessionId);
}

// ルールフォルダ操作（優先度: session-manager.json > VS Code設定 > ハードコードデフォルト）
export async function getRuleFolder(): Promise<string> {
	const fromData = (await loadData()).ruleFolder;
	if (fromData) { return fromData; }
	const fromConfig = vscode.workspace.getConfiguration('claudeManager').get<string>('defaultRuleFolder', '');
	if (fromConfig) { return fromConfig; }
	return '';
}

// スコープ別ルールフォルダ取得
export async function getRuleFolderForScope(scope?: 'global' | 'project'): Promise<string> {
	if (scope === 'global') {
		return path.join(os.homedir(), '.claude', 'agents');
	}
	if (scope === 'project') {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'agents');
		}
	}
	const legacy = await getRuleFolder();
	if (legacy) { return legacy; }
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'agents');
	}
	return path.join(os.homedir(), '.claude', 'agents');
}

export async function setRuleFolder(folder: string): Promise<void> {
	const data = await loadData();
	data.ruleFolder = folder;
	await saveData(data);
}

// タスクログ操作
export async function getTaskLogs(): Promise<TaskLog[]> {
	return (await loadData()).taskLogs || [];
}

export async function addTaskLog(log: TaskLog): Promise<void> {
	const data = await loadData();
	if (!data.taskLogs) { data.taskLogs = []; }
	log.summary = log.summary.slice(0, 200);
	if (data.taskLogs.length >= 100) {
		const oldIdx = data.taskLogs.findIndex(t => t.status === 'completed' || t.status === 'error');
		if (oldIdx >= 0) {
			data.taskLogs.splice(oldIdx, 1);
		} else {
			data.taskLogs.shift();
		}
	}
	data.taskLogs.push(log);
	await saveData(data);
}

export async function updateTaskLog(id: string, updates: Partial<TaskLog>): Promise<void> {
	const data = await loadData();
	if (!data.taskLogs) { return; }
	const idx = data.taskLogs.findIndex(t => t.id === id);
	if (idx >= 0) {
		data.taskLogs[idx] = { ...data.taskLogs[idx], ...updates };
		await saveData(data);
	}
}

export async function removeTaskLog(id: string): Promise<void> {
	const data = await loadData();
	if (!data.taskLogs) { return; }
	data.taskLogs = data.taskLogs.filter(t => t.id !== id);
	await saveData(data);
}

export async function clearTaskLogs(): Promise<void> {
	const data = await loadData();
	data.taskLogs = [];
	await saveData(data);
}

export async function cleanupTaskLogs(): Promise<void> {
	const data = await loadData();
	if (!data.taskLogs || data.taskLogs.length === 0) { return; }
	const now = Date.now();
	const COMPLETED_TTL = 72 * 60 * 60 * 1000;
	const ACTIVE_TTL = 168 * 60 * 60 * 1000;
	const before = data.taskLogs.length;
	data.taskLogs = data.taskLogs.filter(t => {
		const age = now - t.createdAt;
		if (t.status === 'completed' || t.status === 'error') {
			return age < COMPLETED_TTL;
		}
		return age < ACTIVE_TTL;
	});
	if (data.taskLogs.length !== before) {
		await saveData(data);
	}
}

export async function batchUpdateTaskLogs(updates: {id: string; changes: Partial<TaskLog>}[]): Promise<boolean> {
	const data = await loadData();
	if (!data.taskLogs) { return false; }
	let changed = false;
	for (const { id, changes } of updates) {
		const idx = data.taskLogs.findIndex(t => t.id === id);
		if (idx >= 0) {
			data.taskLogs[idx] = { ...data.taskLogs[idx], ...changes };
			changed = true;
		}
	}
	if (changed) {
		await saveData(data);
	}
	return changed;
}

export async function cleanupSessionData(sessionId: string): Promise<void> {
	const data = await loadData();
	data.bookmarks = data.bookmarks.filter((id) => id !== sessionId);
	for (const tag of Object.keys(data.tags)) {
		data.tags[tag] = data.tags[tag].filter((id) => id !== sessionId);
		if (data.tags[tag].length === 0) {
			delete data.tags[tag];
		}
	}
	delete data.customNames[sessionId];
	if (data.notes) {
		delete data.notes[sessionId];
	}
	// agentSessions からセッション紐づけを解除
	if (data.agentSessions) {
		for (const [name, binding] of Object.entries(data.agentSessions)) {
			if (binding.sessionId === sessionId) {
				data.agentSessions[name] = { ...binding, sessionId: '' };
			}
		}
	}
	// 旧形式（agents[]）からも解除
	if (data.agents) {
		for (const agent of data.agents) {
			if (agent.sessionId === sessionId) {
				agent.sessionId = '';
			}
		}
	}
	await saveData(data);
}

/**
 * agents[] → agentSessions マイグレーション
 * activate() 時に一度だけ実行し、旧形式 agents[] を agentSessions に変換して agents[] を除去する
 */
export async function migrateAgentsToAgentSessions(): Promise<boolean> {
	const data = await loadData();

	// agentSessions が既に存在し、agents[] がない場合はマイグレーション不要
	if (!data.agents || data.agents.length === 0) {
		return false;
	}

	// agentSessions が未作成なら初期化
	if (!data.agentSessions) {
		data.agentSessions = {};
	}

	// agents[] から agentSessions に変換（既存の agentSessions を上書きしない）
	let migrated = 0;
	for (const agent of data.agents) {
		if (!data.agentSessions[agent.name] && (agent.sessionId || agent.previousSessionIds)) {
			data.agentSessions[agent.name] = {
				sessionId: agent.sessionId || '',
				previousSessionIds: agent.previousSessionIds,
				sessionMode: agent.sessionMode,
			};
			migrated++;
		}
	}

	// 旧形式を除去
	delete data.agents;

	await saveData(data);
	return migrated > 0;
}
