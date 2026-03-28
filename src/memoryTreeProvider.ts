import * as vscode from 'vscode';
import { MemoryFile } from './types';
import { loadMemoryFiles, getMemoryStats } from './memoryManager';

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryGroupItem | MemoryFileItem | MemoryStatsItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<MemoryGroupItem | MemoryFileItem | MemoryStatsItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: MemoryGroupItem | MemoryFileItem | MemoryStatsItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: MemoryGroupItem | MemoryFileItem | MemoryStatsItem): (MemoryGroupItem | MemoryFileItem | MemoryStatsItem)[] {
		if (!element) {
			// プロジェクト別グループ
			const groups = loadMemoryFiles();
			return groups.map((g) => new MemoryGroupItem(g.dir, g.project, g.files));
		}

		if (element instanceof MemoryGroupItem) {
			const items: (MemoryStatsItem | MemoryFileItem)[] = [];

			// 容量情報
			const stats = getMemoryStats(element.memoryDir);
			items.push(new MemoryStatsItem(stats));

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
		super(memoryFile.name, vscode.TreeItemCollapsibleState.None);

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
	constructor(stats: { totalFiles: number; totalBytes: number; indexLines: number; maxIndexLines: number }) {
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

function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
