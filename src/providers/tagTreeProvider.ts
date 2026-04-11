import * as vscode from 'vscode';
import { ParsedSession } from '../models/types';
import * as dataStore from '../models/dataStore';

export class TagTreeProvider implements vscode.TreeDataProvider<TagItem | TagSessionItem>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TagItem | TagSessionItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	dispose(): void {
		this._onDidChangeTreeData.dispose();
	}

	constructor(private getSessions: () => ParsedSession[]) {}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: TagItem | TagSessionItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: TagItem | TagSessionItem): Promise<(TagItem | TagSessionItem)[]> {
		if (!element) {
			// タグ一覧
			const tags = await dataStore.getAllTags();
			return Object.keys(tags).sort().map((tag) => new TagItem(tag, tags[tag].length));
		}

		if (element instanceof TagItem) {
			// タグ内のセッション一覧
			const tags = await dataStore.getAllTags();
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
		// モデル頭文字（会話一覧・ブックマークと統一）
		const modelChar =
			session.model?.includes('[1m]') ? '１'
			: session.model?.includes('opus') ? 'Ｏ'
			: session.model?.includes('sonnet') ? 'Ｓ'
			: session.model?.includes('haiku') ? 'Ｈ'
			: session.model ? '？'
			: '\u3000';
		const displayName = session.customName || session.firstMessage;
		super(`${modelChar}\u2007${displayName}`, vscode.TreeItemCollapsibleState.None);

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
