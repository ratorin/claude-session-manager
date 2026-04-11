import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryFile } from '../models/types';
import { buildProjectPathMap } from './sessionLoader';
import { parseFrontmatter as parseFrontmatterYaml } from './frontmatterUtils';

// メモリディレクトリの一覧を取得（非同期）
export async function getMemoryDirs(): Promise<string[]> {
	const claudeDir = path.join(os.homedir(), '.claude');
	const projectsDir = path.join(claudeDir, 'projects');
	const dirs: string[] = [];

	try {
		await fs.promises.access(projectsDir);
	} catch {
		return dirs;
	}

	let projects: string[];
	try {
		projects = await fs.promises.readdir(projectsDir);
	} catch {
		return dirs;
	}

	for (const project of projects) {
		const memoryDir = path.join(projectsDir, project, 'memory');
		try {
			const stat = await fs.promises.stat(memoryDir);
			if (stat.isDirectory()) {
				dirs.push(memoryDir);
			}
		} catch {
			// 存在しないまたはアクセスエラー
		}
	}

	return dirs;
}

// メモリファイルのフロントマターをパース（frontmatterUtils に委譲）
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	const parsed = parseFrontmatterYaml(content);
	if (!parsed) {
		return { meta: {}, body: content };
	}
	// ParsedFrontmatter.data は Record<string, string|number|boolean> なので string に変換
	const meta: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed.data)) {
		meta[k] = String(v);
	}
	// description フィールドは data には含まれず parsed.description に格納されている
	if (parsed.description) {
		meta.description = parsed.description;
	}
	return { meta, body: parsed.body };
}

// グローバルメモリファイル（~/.claude/memory/）を読み込み
export async function loadGlobalMemoryFiles(): Promise<{ dir: string; files: MemoryFile[] } | null> {
	const claudeDir = path.join(os.homedir(), '.claude');
	const globalMemoryDir = path.join(claudeDir, 'memory');

	try {
		const stat = await fs.promises.stat(globalMemoryDir);
		if (!stat.isDirectory()) { return null; }
	} catch {
		return null;
	}

	const files: MemoryFile[] = [];
	let entries: string[];
	try {
		entries = await fs.promises.readdir(globalMemoryDir);
	} catch {
		return null;
	}

	for (const entry of entries) {
		if (!entry.endsWith('.md') || entry === 'MEMORY.md') {
			continue;
		}

		const filePath = path.join(globalMemoryDir, entry);
		try {
			const [stat, content] = await Promise.all([
				fs.promises.stat(filePath),
				fs.promises.readFile(filePath, 'utf-8'),
			]);
			const { meta, body } = parseFrontmatter(content);

			files.push({
				filePath,
				fileName: entry,
				name: meta.name || entry.replace('.md', ''),
				description: meta.description || '',
				type: (meta.type as MemoryFile['type']) || 'project',
				content: body.trim(),
				sizeBytes: stat.size,
			});
		} catch {
			// 読み取りエラーはスキップ
		}
	}

	return { dir: globalMemoryDir, files };
}

// settings.json / settings.local.json のパスを取得
export async function getSettingsFilePaths(): Promise<{ settingsPath: string; localSettingsPath: string | null; projectSettingsPath: string | null; projectLocalSettingsPath: string | null }> {
	const claudeDir = path.join(os.homedir(), '.claude');
	const settingsPath = path.join(claudeDir, 'settings.json');
	const localSettingsPath = path.join(claudeDir, 'settings.local.json');

	let localExists = false;
	try {
		await fs.promises.access(localSettingsPath);
		localExists = true;
	} catch {
		// 存在しない
	}

	// プロジェクトの settings.json / settings.local.json
	let projectSettingsPath: string | null = null;
	let projectLocalSettingsPath: string | null = null;
	const workspaceFolders = (await import('vscode')).workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		const claudeProjectDir = path.join(workspaceFolders[0].uri.fsPath, '.claude');
		const pSettingsPath = path.join(claudeProjectDir, 'settings.json');
		const pLocalPath = path.join(claudeProjectDir, 'settings.local.json');
		try {
			await fs.promises.access(pSettingsPath);
			projectSettingsPath = pSettingsPath;
		} catch {
			// 存在しない
		}
		try {
			await fs.promises.access(pLocalPath);
			projectLocalSettingsPath = pLocalPath;
		} catch {
			// 存在しない
		}
	}

	return {
		settingsPath,
		localSettingsPath: localExists ? localSettingsPath : null,
		projectSettingsPath,
		projectLocalSettingsPath,
	};
}

// 全メモリファイルを読み込み（非同期）
export async function loadMemoryFiles(): Promise<{ dir: string; project: string; files: MemoryFile[] }[]> {
	const [dirs, pathMap] = await Promise.all([
		getMemoryDirs(),
		buildProjectPathMap(),
	]);
	const result: { dir: string; project: string; files: MemoryFile[] }[] = [];

	for (const dir of dirs) {
		const projectDir = path.basename(path.dirname(dir));
		// セッションJSONLのcwdから実パスを取得、なければフォールバックデコード
		const project = pathMap.get(projectDir) || projectDir
			.replace(/^([a-zA-Z])--/, '$1:\\')
			.replace(/--/g, '\\')
			.replace(/-/g, ' ');

		const files: MemoryFile[] = [];
		let entries: string[];
		try {
			entries = await fs.promises.readdir(dir);
		} catch { continue; }

		for (const entry of entries) {
			if (!entry.endsWith('.md') || entry === 'MEMORY.md') {
				continue;
			}

			const filePath = path.join(dir, entry);
			try {
				const [stat, content] = await Promise.all([
					fs.promises.stat(filePath),
					fs.promises.readFile(filePath, 'utf-8'),
				]);
				const { meta, body } = parseFrontmatter(content);

				files.push({
					filePath,
					fileName: entry,
					name: meta.name || entry.replace('.md', ''),
					description: meta.description || '',
					type: (meta.type as MemoryFile['type']) || 'project',
					content: body.trim(),
					sizeBytes: stat.size,
				});
			} catch {
				// 読み取りエラーはスキップ
			}
		}

		if (files.length > 0) {
			result.push({ dir, project, files });
		}
	}

	return result;
}

// メモリインデックス（MEMORY.md）の容量情報を取得
export async function getMemoryStats(memoryDir: string): Promise<{ totalFiles: number; totalBytes: number; indexLines: number; maxIndexLines: number; indexPath: string }> {
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	let indexLines = 0;

	try {
		const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
		indexLines = indexContent.split('\n').length;
	} catch {
		// 存在しないまたは読み取りエラー
	}

	let totalFiles = 0;
	let totalBytes = 0;

	try {
		const entries = await fs.promises.readdir(memoryDir);
		for (const entry of entries) {
			if (entry.endsWith('.md') && entry !== 'MEMORY.md') {
				totalFiles++;
				try {
					const stat = await fs.promises.stat(path.join(memoryDir, entry));
					totalBytes += stat.size;
				} catch {
					// stat失敗はスキップ
				}
			}
		}
	} catch {
		// ディレクトリ読み取り失敗
	}

	return {
		totalFiles,
		totalBytes,
		indexLines,
		maxIndexLines: 200, // MEMORY.mdの最大行数
		indexPath,
	};
}

// メモリファイルを削除してインデックスも更新
// rm禁止ルール準拠: 削除ではなく .trash/ ディレクトリへ移動する
export async function deleteMemoryFile(filePath: string): Promise<void> {
	const memoryDir = path.dirname(filePath);
	const fileName = path.basename(filePath);

	// .trash/ ディレクトリへ移動（rm禁止ルール準拠）
	const trashDir = path.join(os.homedir(), '.claude', '.trash');
	await fs.promises.mkdir(trashDir, { recursive: true });
	await fs.promises.rename(filePath, path.join(trashDir, `${Date.now()}_${fileName}`));

	// MEMORY.mdからエントリを削除（完全一致: "(fileName)" 形式で判定）
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	try {
		const indexContent = await fs.promises.readFile(indexPath, 'utf-8');
		const lines = indexContent.split('\n');
		const fileNamePattern = new RegExp(`\\(${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`);
		const filtered = lines.filter((line) => !fileNamePattern.test(line));
		await fs.promises.writeFile(indexPath, filtered.join('\n'), 'utf-8');
	} catch {
		// MEMORY.md が存在しないまたは読み書きエラー
	}
}

// 2つのメモリファイルを統合
export function mergeMemoryFiles(file1: MemoryFile, file2: MemoryFile, newName: string, newDescription: string): string {
	const mergedContent = `---
name: ${newName}
description: ${newDescription}
type: ${file1.type}
---

${file1.content}

---
（以下 ${file2.fileName} から統合）

${file2.content}
`;
	return mergedContent;
}

// メモリファイルから一部を抽出して新ファイルを作成
export function extractFromMemory(
	source: MemoryFile,
	extractedContent: string,
	newFileName: string,
	newName: string,
	newDescription: string,
	newType: string
): string {
	const newContent = `---
name: ${newName}
description: ${newDescription}
type: ${newType}
---

${extractedContent}
`;
	return newContent;
}

// MEMORY.mdにエントリを追加
export async function addToIndex(memoryDir: string, fileName: string, title: string, description: string): Promise<void> {
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	let content = '';

	try {
		content = await fs.promises.readFile(indexPath, 'utf-8');
	} catch {
		// 存在しない場合は空
	}

	const newLine = `- [${title}](${fileName}) — ${description}`;
	content = content.trimEnd() + '\n' + newLine + '\n';
	await fs.promises.writeFile(indexPath, content, 'utf-8');
}
