import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ManagerData, LocalManagerData, AgentConfig, TaskLog } from './types';

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
		await fs.promises.access(DATA_FILE);
		const raw = await fs.promises.readFile(DATA_FILE, 'utf-8');
		cachedData = JSON.parse(raw);
		cachedDataTimestamp = now;
		return cachedData!;
	} catch {
		// 読み込みエラー時は初期データを返す
	}
	cachedData = { bookmarks: [], tags: {}, customNames: {}, notes: {} };
	cachedDataTimestamp = now;
	return cachedData;
}

// グローバルデータの保存（保存後にキャッシュを無効化・非同期）
async function saveData(data: ManagerData): Promise<void> {
	const dir = path.dirname(DATA_FILE);
	try {
		await fs.promises.access(dir);
	} catch {
		await fs.promises.mkdir(dir, { recursive: true });
	}
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
		await fs.promises.access(filePath);
		const raw = await fs.promises.readFile(filePath, 'utf-8');
		cachedLocalData = JSON.parse(raw);
		cachedLocalDataPath = filePath;
		cachedLocalDataTimestamp = now;
		return cachedLocalData!;
	} catch {
		// 読み込みエラー時は空データを返す
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
	const dir = path.dirname(filePath);
	try {
		await fs.promises.access(dir);
	} catch {
		await fs.promises.mkdir(dir, { recursive: true });
	}
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
	if (!data.notes) { data.notes = {}; }
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

// エージェント操作（グローバル + ローカルのマージ）

// グローバルエージェント一覧を取得
export async function getGlobalAgents(): Promise<AgentConfig[]> {
	return (await loadData()).agents || [];
}

// ローカル（プロジェクト固有）エージェント一覧を取得
export async function getLocalAgents(): Promise<AgentConfig[]> {
	return (await loadLocalData()).agents || [];
}

// マージ済みエージェント一覧を取得（同名はローカル優先）
export async function getAgents(): Promise<AgentConfig[]> {
	const globalAgents = await getGlobalAgents();
	const localAgents = await getLocalAgents();
	const localNames = new Set(localAgents.map(a => a.name));
	return [
		...localAgents,
		...globalAgents.filter(a => !localNames.has(a.name)),
	];
}

// エージェント一覧を設定（後方互換: グローバルに保存）
export async function setAgents(agents: AgentConfig[]): Promise<void> {
	const data = await loadData();
	data.agents = agents;
	await saveData(data);
}

// エージェントを追加（scope でグローバル/ローカルを指定）
export async function addAgent(agent: AgentConfig, scope?: 'global' | 'local'): Promise<void> {
	const targetScope = scope || 'global';

	if (targetScope === 'local') {
		const localData = await loadLocalData();
		if (!localData.agents) { localData.agents = []; }
		const idx = localData.agents.findIndex((a) => a.name === agent.name);
		if (idx >= 0) {
			localData.agents[idx] = agent;
		} else {
			localData.agents.push(agent);
		}
		await saveLocalData(localData);
	} else {
		const data = await loadData();
		if (!data.agents) { data.agents = []; }
		const idx = data.agents.findIndex((a) => a.name === agent.name);
		if (idx >= 0) {
			data.agents[idx] = agent;
		} else {
			data.agents.push(agent);
		}
		await saveData(data);
	}
}

// エージェントを削除（ローカル優先、なければグローバルから削除）
export async function removeAgent(name: string): Promise<void> {
	const localData = await loadLocalData();
	if (localData.agents && localData.agents.some(a => a.name === name)) {
		localData.agents = localData.agents.filter((a) => a.name !== name);
		await saveLocalData(localData);
		return;
	}
	const data = await loadData();
	if (data.agents) {
		data.agents = data.agents.filter((a) => a.name !== name);
		await saveData(data);
	}
}

// エージェントをローカル⇔グローバル間で移動
export async function moveAgentScope(name: string, targetScope: 'global' | 'local'): Promise<boolean> {
	const globalData = await loadData();
	const localData = await loadLocalData();
	const globalAgents = globalData.agents || [];
	const localAgents = localData.agents || [];

	if (targetScope === 'local') {
		const idx = globalAgents.findIndex(a => a.name === name);
		if (idx < 0) { return false; }
		const agent = globalAgents[idx];
		globalData.agents = globalAgents.filter(a => a.name !== name);
		await saveData(globalData);
		if (!localData.agents) { localData.agents = []; }
		const localIdx = localData.agents.findIndex(a => a.name === name);
		if (localIdx >= 0) {
			localData.agents[localIdx] = agent;
		} else {
			localData.agents.push(agent);
		}
		await saveLocalData(localData);
		return true;
	} else {
		const idx = localAgents.findIndex(a => a.name === name);
		if (idx < 0) { return false; }
		const agent = localAgents[idx];
		localData.agents = localAgents.filter(a => a.name !== name);
		await saveLocalData(localData);
		if (!globalData.agents) { globalData.agents = []; }
		const globalIdx = globalData.agents.findIndex(a => a.name === name);
		if (globalIdx >= 0) {
			globalData.agents[globalIdx] = agent;
		} else {
			globalData.agents.push(agent);
		}
		await saveData(globalData);
		return true;
	}
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
		return path.join(os.homedir(), '.claude', 'agent-rules');
	}
	if (scope === 'project') {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			return path.join(workspaceFolders[0].uri.fsPath, '.agent-rules');
		}
	}
	const legacy = await getRuleFolder();
	if (legacy) { return legacy; }
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return path.join(workspaceFolders[0].uri.fsPath, '.agent-rules');
	}
	return path.join(os.homedir(), '.claude', 'agent-rules');
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
	if (data.agents) {
		for (const agent of data.agents) {
			if (agent.sessionId === sessionId) {
				agent.sessionId = '';
			}
		}
	}
	await saveData(data);

	const localData = await loadLocalData();
	if (localData.agents) {
		let changed = false;
		for (const agent of localData.agents) {
			if (agent.sessionId === sessionId) {
				agent.sessionId = '';
				changed = true;
			}
		}
		if (changed) {
			await saveLocalData(localData);
		}
	}
}
