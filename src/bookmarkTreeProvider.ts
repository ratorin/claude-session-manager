import * as vscode from 'vscode';
import { ParsedSession } from './types';
import * as dataStore from './dataStore';
import { SessionItem } from './sessionTreeProvider';

export class BookmarkTreeProvider implements vscode.TreeDataProvider<SessionItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<SessionItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private getSessions: () => ParsedSession[]) {}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: SessionItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: SessionItem): SessionItem[] {
		if (element) {
			return [];
		}

		const bookmarks = dataStore.getBookmarks();
		const sessions = this.getSessions();

		return bookmarks
			.map((id) => sessions.find((s) => s.id === id))
			.filter((s): s is ParsedSession => s !== undefined)
			.map((session) => {
				const tags = dataStore.getTagsForSession(session.id);
				const item = new SessionItem(session, true, tags);
				item.contextValue = 'bookmarkedSession';
				return item;
			});
	}
}
