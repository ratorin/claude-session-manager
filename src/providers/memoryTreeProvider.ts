import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryFile } from '../models/types';
import { loadMemoryFiles, loadGlobalMemoryFiles, getMemoryStats, getSettingsFilePaths } from '../utils/memoryManager';

type MemoryTreeNode = MemoryTopGroupItem | MemoryGroupItem | MemoryFileItem | MemoryStatsItem | MemoryIndexItem | SettingsFileItem;

export class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryTreeNode>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<MemoryTreeNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	// プロジェクトフィルター: true なら現在のプロジェクトメモリのみ表示（グローバル除外）
	private projectFilterEnabled = true;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	setProjectFilter(enabled: boolean): void {
		this.projectFilterEnabled = enabled;
		this._onDidChangeTreeData.fire(undefined);
	}

	isProjectFilterEnabled(): boolean {
		return this.projectFilterEnabled;
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: MemoryTreeNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: MemoryTreeNode): Promise<MemoryTreeNode[]> {
		if (!element) {
			const topItems: MemoryTreeNode[] = [];

			// 設定ファイルグループ（フィルター関係なく常に表示）
			topItems.push(new MemoryTopGroupItem('settings', '設定ファイル', 'gear'));

			// プロジェクトフィルター OFF の場合のみグローバルメモリを表示
			if (!this.projectFilterEnabled) {
				const globalData = await loadGlobalMemoryFiles();
				if (globalData) {
					let hasIndex = false;
					try {
						await fs.promises.access(path.join(globalData.dir, 'MEMORY.md'));
						hasIndex = true;
					} catch { /* なし */ }
					if (globalData.files.length > 0 || hasIndex) {
						topItems.push(new MemoryTopGroupItem('global', 'グローバルメモリ', 'globe', globalData.dir, globalData.files));
					}
				}
			}

			// プロジェクト別グループ
			const groups = await loadMemoryFiles();
			if (this.projectFilterEnabled) {
				// プロジェクトフィルター ON: 現在のワークスペースに関連するプロジェクトのみ
				const currentProject = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath?.toLowerCase() || '';
				if (currentProject) {
					const baseName = path.basename(currentProject).toLowerCase();
					for (const g of groups) {
						if (g.project.toLowerCase().includes(baseName) ||
							currentProject.includes(g.project.toLowerCase().replace(/\\/g, '/'))) {
							topItems.push(new MemoryGroupItem(g.dir, g.project, g.files));
						}
					}
				} else {
					// ワークスペース未設定時は全プロジェクト表示
					for (const g of groups) {
						topItems.push(new MemoryGroupItem(g.dir, g.project, g.files));
					}
				}
			} else {
				for (const g of groups) {
					topItems.push(new MemoryGroupItem(g.dir, g.project, g.files));
				}
			}

			return topItems;
		}

		// 設定ファイルグループの子要素
		if (element instanceof MemoryTopGroupItem && element.groupType === 'settings') {
			const items: MemoryTreeNode[] = [];
			const { settingsPath, localSettingsPath, projectSettingsPath, projectLocalSettingsPath } = await getSettingsFilePaths();

			try {
				await fs.promises.access(settingsPath);
				items.push(new SettingsFileItem(settingsPath, 'settings.json'));
			} catch { /* なし */ }
			if (localSettingsPath) {
				items.push(new SettingsFileItem(localSettingsPath, 'settings.local.json'));
			}
			if (projectSettingsPath) {
				items.push(new SettingsFileItem(projectSettingsPath, 'settings.json (project)'));
			}
			if (projectLocalSettingsPath) {
				items.push(new SettingsFileItem(projectLocalSettingsPath, 'settings.local.json (project)'));
			}

			return items;
		}

		// グローバルメモリグループの子要素
		if (element instanceof MemoryTopGroupItem && element.groupType === 'global') {
			const items: MemoryTreeNode[] = [];

			if (element.memoryDir) {
				// 容量情報（インジケーター）
				const stats = await getMemoryStats(element.memoryDir);
				items.push(new MemoryStatsItem(stats));

				// MEMORY.md インデックスファイル
				try {
					await fs.promises.access(stats.indexPath);
					const content = await fs.promises.readFile(stats.indexPath, 'utf-8');
					items.push(new MemoryIndexItem(stats.indexPath, content));
				} catch { /* なし */ }

				// ファイル一覧
				for (const file of element.globalFiles || []) {
					items.push(new MemoryFileItem(file));
				}
			}

			return items;
		}

		// プロジェクト別グループの子要素
		if (element instanceof MemoryGroupItem) {
			const items: MemoryTreeNode[] = [];

			// 容量情報（インジケーター）
			const stats = await getMemoryStats(element.memoryDir);
			items.push(new MemoryStatsItem(stats));

			// MEMORY.md インデックスファイル
			try {
				await fs.promises.access(stats.indexPath);
				const content = await fs.promises.readFile(stats.indexPath, 'utf-8');
				items.push(new MemoryIndexItem(stats.indexPath, content));
			} catch { /* なし */ }

			// タイプ別アイコンでファイル一覧
			for (const file of element.files) {
				items.push(new MemoryFileItem(file));
			}

			return items;
		}

		return [];
	}
}

// トップレベルグループ（設定ファイル、グローバルメモリ）
export class MemoryTopGroupItem extends vscode.TreeItem {
	constructor(
		public readonly groupType: 'settings' | 'global',
		label: string,
		icon: string,
		public readonly memoryDir?: string,
		public readonly globalFiles?: MemoryFile[]
	) {
		super(label, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = new vscode.ThemeIcon(icon);

		if (groupType === 'settings') {
			this.contextValue = 'settingsGroup';
		} else {
			this.description = globalFiles ? `${globalFiles.length}件` : '';
			this.contextValue = 'globalMemoryGroup';
		}
	}
}

export class MemoryGroupItem extends vscode.TreeItem {
	// プロジェクトパス（cwdベースのデコード済みパス）
	public readonly projectPath: string;

	constructor(
		public readonly memoryDir: string,
		public readonly project: string,
		public readonly files: MemoryFile[]
	) {
		super(`プロジェクト: ${project}`, vscode.TreeItemCollapsibleState.Expanded);
		this.description = `${files.length}件`;
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'memoryProject';

		// プロジェクトパスを算出（memoryDirの2つ上がprojectsDir、1つ上がエンコードされたプロジェクトID）
		// project にはデコード済みパスが入っている
		this.projectPath = project;
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
		const barWidth = 20;
		const filledCount = Math.round((pct / 100) * barWidth);
		const emptyCount = barWidth - filledCount;
		// 塗りつぶし部分は「█」、空き部分は「─」、右端は「|」
		const bar = '[' + '█'.repeat(filledCount) + '─'.repeat(emptyCount) + '|]';
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

	constructor(indexPath: string, content: string) {
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

// 設定ファイル表示用
export class SettingsFileItem extends vscode.TreeItem {
	public readonly settingsPath: string;

	constructor(filePath: string, fileName: string) {
		super(fileName, vscode.TreeItemCollapsibleState.None);

		this.settingsPath = filePath;
		this.description = filePath;
		this.tooltip = `${fileName}\nクリックでエディタで開く\n${filePath}`;
		this.iconPath = new vscode.ThemeIcon('settings-gear');
		this.contextValue = 'settingsFile';

		// クリックでエディタで開く
		this.command = {
			command: 'claudeManager.openSettingsFile',
			title: '設定ファイルを開く',
			arguments: [filePath],
		};
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
