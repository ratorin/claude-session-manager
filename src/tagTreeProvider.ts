import * as vscode from 'vscode';
import { ParsedSession } from './types';
import * as dataStore from './dataStore';

export class TagTreeProvider implements vscode.TreeDataProvider<TagItem | TagSessionItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TagItem | TagSessionItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private getSessions: () => ParsedSession[]) {}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TagItem | TagSessionItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TagItem | TagSessionItem): (TagItem | TagSessionItem)[] {
		if (!element) {
			// タグ一覧
			const tags = dataStore.getAllTags();
			return Object.keys(tags).sort().map((tag) => new TagItem(tag, tags[tag].length));
		}

		if (element instanceof TagItem) {
			// タグ内のセッション一覧
			const tags = dataStore.getAllTags();
			const sessionIds = tags[element.tagName] || [];
			const sessions = this.getSessions();

			return sessionIds
				.map((id) => sessions.find((s) => s.id === id))
				.filter((s): s is ParsedSession => s !== undefined)
				.map((session) => new TagSessionItem(session, element.tagName));
		}

		return [];
	}
}

export class TagItem extends vscode.TreeItem {
	constructor(
		public readonly tagName: string,
		public readonly count: number
	) {
		super(tagName, vscode.TreeItemCollapsibleState.Collapsed);
		this.description = `${count}件`;
		this.iconPath = new vscode.ThemeIcon('tag');
		this.contextValue = 'tag';
	}
}

export class TagSessionItem extends vscode.TreeItem {
	constructor(
		public readonly session: ParsedSession,
		public readonly tagName: string
	) {
		const displayName = session.customName || session.firstMessage;
		super(displayName, vscode.TreeItemCollapsibleState.None);

		const date = session.lastTimestamp;
		const dateStr = `${date.getFullYear()}/${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}`;
		this.description = dateStr;
		this.iconPath = new vscode.ThemeIcon('comment-discussion');
		this.contextValue = 'taggedSession';

		this.command = {
			command: 'claudeManager.previewSession',
			title: '会話をプレビュー',
			arguments: [this],
		};
	}
}
