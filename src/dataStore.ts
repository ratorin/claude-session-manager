import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ManagerData, AgentConfig } from './types';

// 拡張機能の永続データを管理
const DATA_FILE = path.join(os.homedir(), '.claude', 'session-manager.json');

function loadData(): ManagerData {
	try {
		if (fs.existsSync(DATA_FILE)) {
			return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
		}
	} catch {
		// 読み込みエラー時は初期データを返す
	}
	return { bookmarks: [], tags: {}, customNames: {}, notes: {} };
}

function saveData(data: ManagerData): void {
	const dir = path.dirname(DATA_FILE);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
}

// ブックマーク操作
export function isBookmarked(sessionId: string): boolean {
	return loadData().bookmarks.includes(sessionId);
}

export function addBookmark(sessionId: string): void {
	const data = loadData();
	if (!data.bookmarks.includes(sessionId)) {
		data.bookmarks.push(sessionId);
		saveData(data);
	}
}

export function removeBookmark(sessionId: string): void {
	const data = loadData();
	data.bookmarks = data.bookmarks.filter((id) => id !== sessionId);
	saveData(data);
}

export function getBookmarks(): string[] {
	return loadData().bookmarks;
}

// タグ操作
export function addTag(tagName: string, sessionId: string): void {
	const data = loadData();
	if (!data.tags[tagName]) {
		data.tags[tagName] = [];
	}
	if (!data.tags[tagName].includes(sessionId)) {
		data.tags[tagName].push(sessionId);
		saveData(data);
	}
}

export function removeTagFromSession(tagName: string, sessionId: string): void {
	const data = loadData();
	if (data.tags[tagName]) {
		data.tags[tagName] = data.tags[tagName].filter((id) => id !== sessionId);
		if (data.tags[tagName].length === 0) {
			delete data.tags[tagName];
		}
		saveData(data);
	}
}

export function getAllTags(): Record<string, string[]> {
	return loadData().tags;
}

export function getTagsForSession(sessionId: string): string[] {
	const data = loadData();
	const tags: string[] = [];
	for (const [tag, ids] of Object.entries(data.tags)) {
		if (ids.includes(sessionId)) {
			tags.push(tag);
		}
	}
	return tags;
}

// カスタム名操作
export function setCustomName(sessionId: string, name: string): void {
	const data = loadData();
	data.customNames[sessionId] = name;
	saveData(data);
}

export function getCustomName(sessionId: string): string | undefined {
	return loadData().customNames[sessionId];
}

export function getAllCustomNames(): Record<string, string> {
	return loadData().customNames;
}

// メモ操作
export function setNote(sessionId: string, note: string): void {
	const data = loadData();
	if (!data.notes) { data.notes = {}; }
	if (note) {
		data.notes[sessionId] = note;
	} else {
		delete data.notes[sessionId];
	}
	saveData(data);
}

export function getNote(sessionId: string): string {
	const data = loadData();
	return data.notes?.[sessionId] || '';
}

// エージェント操作
export function getAgents(): AgentConfig[] {
	return loadData().agents || [];
}

export function setAgents(agents: AgentConfig[]): void {
	const data = loadData();
	data.agents = agents;
	saveData(data);
}

export function addAgent(agent: AgentConfig): void {
	const data = loadData();
	if (!data.agents) { data.agents = []; }
	// 同名エージェントがあれば更新
	const idx = data.agents.findIndex((a) => a.name === agent.name);
	if (idx >= 0) {
		data.agents[idx] = agent;
	} else {
		data.agents.push(agent);
	}
	saveData(data);
}

export function removeAgent(name: string): void {
	const data = loadData();
	if (data.agents) {
		data.agents = data.agents.filter((a) => a.name !== name);
		saveData(data);
	}
}

export function getAgentBySessionId(sessionId: string): AgentConfig | undefined {
	return getAgents().find((a) => a.sessionId === sessionId);
}

// ルールフォルダ操作（優先度: session-manager.json > VS Code設定 > ハードコードデフォルト）
export function getRuleFolder(): string {
	const fromData = loadData().ruleFolder;
	if (fromData) { return fromData; }
	const fromConfig = vscode.workspace.getConfiguration('claudeManager').get<string>('defaultRuleFolder', '');
	if (fromConfig) { return fromConfig; }
	return '';
}

export function setRuleFolder(folder: string): void {
	const data = loadData();
	data.ruleFolder = folder;
	saveData(data);
}

// セッション削除時の関連データクリーンアップ
export function cleanupSessionData(sessionId: string): void {
	const data = loadData();
	// ブックマーク削除
	data.bookmarks = data.bookmarks.filter((id) => id !== sessionId);
	// タグから削除
	for (const tag of Object.keys(data.tags)) {
		data.tags[tag] = data.tags[tag].filter((id) => id !== sessionId);
		if (data.tags[tag].length === 0) {
			delete data.tags[tag];
		}
	}
	// カスタム名削除
	delete data.customNames[sessionId];
	// メモ削除
	if (data.notes) {
		delete data.notes[sessionId];
	}
	// エージェント紐づけ解除
	if (data.agents) {
		for (const agent of data.agents) {
			if (agent.sessionId === sessionId) {
				agent.sessionId = '';
			}
		}
	}
	saveData(data);
}
