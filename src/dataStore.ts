import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ManagerData } from './types';

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
