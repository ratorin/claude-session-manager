import * as vscode from 'vscode';
import * as path from 'path';
import { ParsedSession } from './types';
import * as dataStore from './dataStore';
import { SessionItem, SessionTreeProvider } from './sessionTreeProvider';

export class BookmarkTreeProvider implements vscode.TreeDataProvider<SessionItem>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	// プロジェクトフィルター: true ならプロジェクト関連のブックマークのみ表示
	private projectFilterEnabled = false;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	constructor(
		private getAllSessions: () => ParsedSession[],
		private sessionProvider: SessionTreeProvider
	) {}

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

	getTreeItem(element: SessionItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: SessionItem): Promise<SessionItem[]> {
		if (element) {
			return [];
		}

		const bookmarks = await dataStore.getBookmarks();
		// フィルター前の全親セッションからブックマークを検索
		let sessions = this.getAllSessions();

		// プロジェクトフィルター適用
		if (this.projectFilterEnabled) {
			const currentProject = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath?.toLowerCase() || '';
			if (currentProject) {
				const baseName = path.basename(currentProject).toLowerCase();
				sessions = sessions.filter((s) =>
					s.project.toLowerCase().includes(baseName) ||
					currentProject.includes(s.project.toLowerCase().replace(/\\/g, '/'))
				);
			}
		}

		const items: SessionItem[] = [];
		for (const id of bookmarks) {
			const session = sessions.find((s) => s.id === id);
			if (!session) { continue; }
			const tags = await dataStore.getTagsForSession(session.id);
			const isPreviewing = session.id === this.sessionProvider.getActiveSessionId();
			const isLive = this.sessionProvider.isLiveSession(session.id);
			items.push(new SessionItem(session, true, tags, isPreviewing, isLive, true));
		}
		return items;
	}
}
