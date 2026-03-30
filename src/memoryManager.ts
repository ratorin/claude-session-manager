import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MemoryFile } from './types';
import { buildProjectPathMap } from './sessionLoader';

// メモリディレクトリの一覧を取得
export function getMemoryDirs(): string[] {
	const claudeDir = path.join(os.homedir(), '.claude');
	const projectsDir = path.join(claudeDir, 'projects');
	const dirs: string[] = [];

	if (!fs.existsSync(projectsDir)) {
		return dirs;
	}

	const projects = fs.readdirSync(projectsDir);
	for (const project of projects) {
		const memoryDir = path.join(projectsDir, project, 'memory');
		if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
			dirs.push(memoryDir);
		}
	}

	return dirs;
}

// メモリファイルのフロントマターをパース
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) {
		return { meta: {}, body: content };
	}

	const meta: Record<string, string> = {};
	const lines = match[1].split('\n');
	for (const line of lines) {
		const colonIdx = line.indexOf(':');
		if (colonIdx > 0) {
			const key = line.substring(0, colonIdx).trim();
			const value = line.substring(colonIdx + 1).trim();
			meta[key] = value;
		}
	}

	return { meta, body: match[2] };
}

// 全メモリファイルを読み込み
export function loadMemoryFiles(): { dir: string; project: string; files: MemoryFile[] }[] {
	const dirs = getMemoryDirs();
	const pathMap = buildProjectPathMap();
	const result: { dir: string; project: string; files: MemoryFile[] }[] = [];

	for (const dir of dirs) {
		const projectDir = path.basename(path.dirname(dir));
		// セッションJSONLのcwdから実パスを取得、なければフォールバックデコード
		const project = pathMap.get(projectDir) || projectDir
			.replace(/^([a-zA-Z])--/, '$1:\\')
			.replace(/--/g, '\\')
			.replace(/-/g, ' ');

		const files: MemoryFile[] = [];
		const entries = fs.readdirSync(dir);

		for (const entry of entries) {
			if (!entry.endsWith('.md') || entry === 'MEMORY.md') {
				continue;
			}

			const filePath = path.join(dir, entry);
			const stat = fs.statSync(filePath);
			const content = fs.readFileSync(filePath, 'utf-8');
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
		}

		if (files.length > 0) {
			result.push({ dir, project, files });
		}
	}

	return result;
}

// メモリインデックス（MEMORY.md）の容量情報を取得
export function getMemoryStats(memoryDir: string): { totalFiles: number; totalBytes: number; indexLines: number; maxIndexLines: number; indexPath: string } {
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	let indexLines = 0;

	if (fs.existsSync(indexPath)) {
		const indexContent = fs.readFileSync(indexPath, 'utf-8');
		indexLines = indexContent.split('\n').length;
	}

	let totalFiles = 0;
	let totalBytes = 0;

	if (fs.existsSync(memoryDir)) {
		const entries = fs.readdirSync(memoryDir);
		for (const entry of entries) {
			if (entry.endsWith('.md') && entry !== 'MEMORY.md') {
				totalFiles++;
				totalBytes += fs.statSync(path.join(memoryDir, entry)).size;
			}
		}
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
export function deleteMemoryFile(filePath: string): void {
	const memoryDir = path.dirname(filePath);
	const fileName = path.basename(filePath);

	// ファイル削除
	fs.unlinkSync(filePath);

	// MEMORY.mdからエントリを削除
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	if (fs.existsSync(indexPath)) {
		let indexContent = fs.readFileSync(indexPath, 'utf-8');
		const lines = indexContent.split('\n');
		const filtered = lines.filter((line) => !line.includes(fileName));
		fs.writeFileSync(indexPath, filtered.join('\n'), 'utf-8');
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
export function addToIndex(memoryDir: string, fileName: string, title: string, description: string): void {
	const indexPath = path.join(memoryDir, 'MEMORY.md');
	let content = '';

	if (fs.existsSync(indexPath)) {
		content = fs.readFileSync(indexPath, 'utf-8');
	}

	const newLine = `- [${title}](${fileName}) — ${description}`;
	content = content.trimEnd() + '\n' + newLine + '\n';
	fs.writeFileSync(indexPath, content, 'utf-8');
}
