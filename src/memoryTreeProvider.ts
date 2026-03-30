import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryFile } from './types';
import { loadMemoryFiles, getMemoryStats } from './memoryManager';

type MemoryTreeNode = MemoryGroupItem | MemoryFileItem | MemoryStatsItem | MemoryIndexItem;

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryTreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: MemoryTreeNode): vscode.TreeItem {
		return element;
	}

	getChildren(element?: MemoryTreeNode): MemoryTreeNode[] {
		if (!element) {
			// プロジェクト別グループ
			const groups = loadMemoryFiles();
			return groups.map((g) => new MemoryGroupItem(g.dir, g.project, g.files));
		}

		if (element instanceof MemoryGroupItem) {
			const items: MemoryTreeNode[] = [];

			// 容量情報（インジケーター）
			const stats = getMemoryStats(element.memoryDir);
			items.push(new MemoryStatsItem(stats));

			// MEMORY.md インデックスファイル
			if (fs.existsSync(stats.indexPath)) {
				items.push(new MemoryIndexItem(stats.indexPath));
			}

			// タイプ別アイコンでファイル一覧
			for (const file of element.files) {
				items.push(new MemoryFileItem(file));
			}

			return items;
		}

		return [];
	}
}

export class MemoryGroupItem extends vscode.TreeItem {
	constructor(
		public readonly memoryDir: string,
		public readonly project: string,
		public readonly files: MemoryFile[]
	) {
		super(project, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${files.length}件`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'memoryGroup';
	}
}

export class MemoryFileItem extends vscode.TreeItem {
	constructor(public readonly memoryFile: MemoryFile) {
		// ファイルの行数を計算（3桁右揃え）
		const lineCount = memoryFile.content.split('\n').length;
		const lineStr = String(lineCount).padStart(3, '\u2007');
		super(`${lineStr} ${memoryFile.name}`, vscode.TreeItemCollapsibleState.None);

		this.description = `[${memoryFile.type}] ${memoryFile.description.substring(0, 50)}`;
		this.tooltip = `${memoryFile.name}\n` +
			`タイプ: ${memoryFile.type}\n` +
			`説明: ${memoryFile.description}\n` +
			`サイズ: ${formatBytes(memoryFile.sizeBytes)}\n\n` +
			memoryFile.content.substring(0, 300);

		// タイプ別アイコン
		const iconMap: Record<string, string> = {
			user: 'person',
			feedback: 'feedback',
			project: 'project',
			reference: 'link-external',
		};
		this.iconPath = new vscode.ThemeIcon(iconMap[memoryFile.type] || 'file');
		this.contextValue = 'memoryFile';

		this.command = {
			command: 'claudeManager.previewMemory',
			title: 'メモリをプレビュー',
			arguments: [this],
		};
	}
}

export class MemoryStatsItem extends vscode.TreeItem {
	constructor(stats: { totalFiles: number; totalBytes: number; indexLines: number; maxIndexLines: number; indexPath: string }) {
		const pct = Math.round((stats.indexLines / stats.maxIndexLines) * 100);
		const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
		const label = `${bar} ${stats.indexLines}/${stats.maxIndexLines}行 (${pct}%) — ${stats.totalFiles}件 ${formatBytes(stats.totalBytes)}`;
		super(label, vscode.TreeItemCollapsibleState.None);

		if (pct >= 80) {
			this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
		} else {
			this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
		}

		this.tooltip = `MEMORY.md インデックス使用率: ${stats.indexLines}/${stats.maxIndexLines}行 (${pct}%)\nメモリファイル: ${stats.totalFiles}件 (${formatBytes(stats.totalBytes)})`;
		this.contextValue = 'stats';
	}
}

// MEMORY.md インデックスファイル表示用
export class MemoryIndexItem extends vscode.TreeItem {
	public readonly indexPath: string;

	constructor(indexPath: string) {
		const content = fs.readFileSync(indexPath, 'utf-8');
		const lineCount = content.split('\n').length;
		super(`📋 MEMORY.md`, vscode.TreeItemCollapsibleState.None);

		this.indexPath = indexPath;
		this.description = `インデックス (${lineCount}行)`;
		this.tooltip = `MEMORY.md — メモリインデックスファイル\n` +
			`${lineCount}行\n` +
			`クリックでエディタで開く\n\n` +
			content.substring(0, 500);
		this.iconPath = new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.yellow'));
		this.contextValue = 'memoryIndex';

		this.command = {
			command: 'vscode.open',
			title: 'MEMORY.mdを開く',
			arguments: [vscode.Uri.file(indexPath)],
		};
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
