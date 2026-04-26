/**
 * projectService.ts — v0.5.0 T1.7 / T1.8
 * プロジェクト検出・登録・一覧管理。
 *
 * 検出ソース（優先順）:
 *   1. vscode.workspace.workspaceFolders（現在開いているワークスペース）
 *   2. ~/.claude/projects/ ディレクトリ名の逆変換（-区切り→パス）
 *   3. data/projects.json（手動登録・永続化）
 *
 * data/projects.json スキーマ:
 *   { "projects": ProjectDef[] }
 *
 * ProjectDef:
 *   { id, name, path, addedAt, source, isCurrent? }
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { normalize } from '../utils/pathUtils';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export type ProjectSource = 'workspace' | 'claude-projects-dir' | 'manual';

export interface ProjectDef {
	/** 一意ID（normalize済みパスのSHA-like短縮ハッシュ / UUID） */
	id: string;
	/** 表示名（デフォルト: ディレクトリ名） */
	name: string;
	/** 絶対パス（normalize済み） */
	path: string;
	/** 登録日時（ISO-8601） */
	addedAt: string;
	/** 検出ソース */
	source: ProjectSource;
	/** 現在のワークスペースか */
	isCurrent?: boolean;
}

interface ProjectsFile {
	projects: ProjectDef[];
}

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// projects.json は拡張機能パッケージ同梱ではなく ~/.claude/ に保存
// （ユーザーデータはパッケージ外に永続化する）
const PROJECTS_FILE = path.join(CLAUDE_DIR, 'csm-projects.json');

// -------------------------------------------------------------------
// 内部ヘルパー
// -------------------------------------------------------------------

/** ~/.claude/projects/ディレクトリ名 → 絶対パスに逆変換 */
function reverseClaudeProjectKey(dirName: string): string {
	// 例: "-home-vus26-projects-foo" → "/home/vus26/projects/foo"
	// ルール: 先頭の "-" を "/" に変換し、残りの "-" を "/" に変換
	// ただし実際のディレクトリ名にも"-"が含まれる可能性があるため
	// 先頭の"-"を除いて残りは単純に"-" → "/"変換（Claude Codeの生成規則に合わせる）
	return '/' + dirName.replace(/^-/, '').replace(/-/g, '/');
}

/** シンプルな数値ハッシュによる短縮ID生成 */
function shortId(str: string): string {
	let h = 0;
	for (let i = 0; i < str.length; i++) {
		h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36);
}

// -------------------------------------------------------------------
// T3.22 パフォーマンス: discoverProjects キャッシュ (TTL 1500ms)
// -------------------------------------------------------------------

let _discoverCache: { result: ProjectDef[]; expireAt: number } | null = null;
const DISCOVER_CACHE_TTL_MS = 1500;

/** キャッシュを無効化する（プロジェクト登録・削除時に呼び出す） */
export function invalidateDiscoverCache(): void {
	_discoverCache = null;
}

/** projects.json を読み込む */
function loadProjectsFile(): ProjectsFile {
	try {
		const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8');
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === 'object' && 'projects' in parsed) {
			return parsed as ProjectsFile;
		}
	} catch {
		// ファイルなし or パースエラー
	}
	return { projects: [] };
}

/** projects.json を保存する */
function saveProjectsFile(data: ProjectsFile): void {
	try {
		fs.mkdirSync(path.dirname(PROJECTS_FILE), { recursive: true });
		fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, '\t'), 'utf-8');
	} catch {
		// 書き込み失敗は無視（ログ不可環境でもクラッシュさせない）
	}
}

/** 絶対パスからプロジェクトIDを生成 */
function makeProjectId(absPath: string): string {
	return shortId(normalize(absPath));
}

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/**
 * 全プロジェクトを収集して返す（重複排除済み）。
 * isCurrent フラグはワークスペース一致時に true になる。
 */
export function discoverProjects(): ProjectDef[] {
	// キャッシュヒット: 1.5s 以内の結果を再利用（プロジェクトタブ初期表示 < 1.5s 目標）
	const now = Date.now();
	if (_discoverCache && now < _discoverCache.expireAt) {
		return _discoverCache.result;
	}

	const seen = new Map<string, ProjectDef>();

	const currentWsFolders = vscode.workspace.workspaceFolders?.map(f => normalize(f.uri.fsPath)) ?? [];

	// --- ソース1: vscode.workspace.workspaceFolders ---
	for (const wsPath of currentWsFolders) {
		if (!fs.existsSync(wsPath)) { continue; }
		const id = makeProjectId(wsPath);
		seen.set(id, {
			id,
			name: path.basename(wsPath),
			path: wsPath,
			addedAt: new Date().toISOString(),
			source: 'workspace',
			isCurrent: true,
		});
	}

	// --- ソース2: ~/.claude/projects/ ディレクトリ名の逆変換 ---
	try {
		const entries = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const absPath = normalize(reverseClaudeProjectKey(entry.name));
			if (!fs.existsSync(absPath)) { continue; }
			const id = makeProjectId(absPath);
			if (!seen.has(id)) {
				seen.set(id, {
					id,
					name: path.basename(absPath),
					path: absPath,
					addedAt: new Date().toISOString(),
					source: 'claude-projects-dir',
					isCurrent: currentWsFolders.includes(absPath),
				});
			}
		}
	} catch {
		// CLAUDE_PROJECTS_DIR が存在しない場合はスキップ
	}

	// --- ソース3: data/projects.json（手動登録） ---
	const stored = loadProjectsFile();
	for (const p of stored.projects) {
		const nPath = normalize(p.path);
		const id = makeProjectId(nPath);
		if (!seen.has(id)) {
			seen.set(id, {
				...p,
				path: nPath,
				isCurrent: currentWsFolders.includes(nPath),
			});
		}
	}

	const result = Array.from(seen.values()).sort((a, b) => {
		// 現在のWSを先頭に、その後はアルファベット順
		if (a.isCurrent && !b.isCurrent) { return -1; }
		if (!a.isCurrent && b.isCurrent) { return 1; }
		return a.name.localeCompare(b.name);
	});

	// キャッシュ更新
	_discoverCache = { result, expireAt: Date.now() + DISCOVER_CACHE_TTL_MS };
	return result;
}

/**
 * プロジェクトを手動登録する（projects.json に永続化）。
 * 既に登録済みの場合は何もしない。
 * @returns 登録した ProjectDef（既存の場合は既存のもの）
 */
export function registerProject(absPath: string, displayName?: string): ProjectDef {
	const nPath = normalize(absPath);
	const id = makeProjectId(nPath);
	const stored = loadProjectsFile();

	const existing = stored.projects.find(p => makeProjectId(normalize(p.path)) === id);
	if (existing) {
		return existing;
	}

	const newProject: ProjectDef = {
		id,
		name: displayName ?? path.basename(nPath),
		path: nPath,
		addedAt: new Date().toISOString(),
		source: 'manual',
	};
	const updated: ProjectsFile = { projects: [...stored.projects, newProject] };
	saveProjectsFile(updated);
	invalidateDiscoverCache();
	return newProject;
}

/**
 * プロジェクトを削除する（手動登録分のみ削除可能）。
 * @returns 削除に成功した場合 true
 */
export function removeProject(projectId: string): boolean {
	const stored = loadProjectsFile();
	const index = stored.projects.findIndex(p => p.id === projectId);
	if (index === -1) { return false; }
	const updated: ProjectsFile = {
		projects: stored.projects.filter((_, i) => i !== index),
	};
	saveProjectsFile(updated);
	invalidateDiscoverCache();
	return true;
}

/**
 * 手動登録プロジェクト一覧を返す（projects.json の内容）。
 */
export function listManualProjects(): ProjectDef[] {
	return loadProjectsFile().projects;
}

/**
 * projects.json の初期スキーマを生成する（マイグレーション用）。
 * 既存ファイルがある場合は何もしない。
 */
export function initProjectsFile(): void {
	if (fs.existsSync(PROJECTS_FILE)) { return; }
	saveProjectsFile({ projects: [] });
}
