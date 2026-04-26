/**
 * helpFeedbackProvider.ts — v0.5.0 T1.13
 * F13 Help & Feedback ボトムビュー (claudeHelp コンテナ)
 *
 * TreeDataProvider: ドキュメント / 問題報告 / 変更履歴 / バージョン情報
 * を静的なリンクリストとして提供する。
 */

import * as vscode from 'vscode';

// -------------------------------------------------------------------
// TreeItem 型定義
// -------------------------------------------------------------------

type HelpItemKind = 'link' | 'info';

interface HelpItemDef {
	label: string;
	kind: HelpItemKind;
	/** link の場合は外部URL / コマンドURI */
	uri?: string;
	command?: string;
	description?: string;
	icon?: string;
}

// -------------------------------------------------------------------
// HelpFeedbackItem — TreeItem 実装
// -------------------------------------------------------------------

class HelpFeedbackItem extends vscode.TreeItem {
	constructor(def: HelpItemDef) {
		super(def.label, vscode.TreeItemCollapsibleState.None);

		this.description = def.description;
		this.tooltip     = def.label;

		if (def.icon) {
			this.iconPath = new vscode.ThemeIcon(def.icon);
		}

		if (def.kind === 'link' && def.uri) {
			this.command = {
				command: 'vscode.open',
				title: 'Open',
				arguments: [vscode.Uri.parse(def.uri)],
			};
		} else if (def.kind === 'link' && def.command) {
			this.command = {
				command: def.command,
				title: def.label,
			};
		}
	}
}

// -------------------------------------------------------------------
// HelpFeedbackProvider — TreeDataProvider 実装
// -------------------------------------------------------------------

export class HelpFeedbackProvider implements vscode.TreeDataProvider<HelpFeedbackItem> {
	private readonly _items: HelpFeedbackItem[];

	constructor(version: string) {
		const repoUrl = 'https://github.com/ratorin/claude-session-manager';
		const issueUrl = `${repoUrl}/issues/new`;
		const changelogUrl = `${repoUrl}/blob/master/CHANGELOG.md`;
		const docsUrl = `${repoUrl}#readme`;

		const discussionsUrl = `${repoUrl}/discussions`;

		const defs: HelpItemDef[] = [
			{
				label: 'ドキュメント',
				kind: 'link',
				uri: docsUrl,
				icon: 'book',
			},
			{
				label: '問題を報告',
				kind: 'link',
				uri: issueUrl,
				icon: 'bug',
			},
			{
				label: 'ディスカッション',
				kind: 'link',
				uri: discussionsUrl,
				icon: 'comment-discussion',
			},
			{
				label: '変更履歴',
				kind: 'link',
				uri: changelogUrl,
				icon: 'history',
			},
			{
				label: `バージョン v${version}`,
				kind: 'info',
				description: 'Claude Session Manager',
				icon: 'info',
			},
		];

		this._items = defs.map(d => new HelpFeedbackItem(d));
	}

	// ----------------------------------------------------------------
	// TreeDataProvider
	// ----------------------------------------------------------------

	getTreeItem(element: HelpFeedbackItem): vscode.TreeItem {
		return element;
	}

	getChildren(_element?: HelpFeedbackItem): vscode.ProviderResult<HelpFeedbackItem[]> {
		return this._items;
	}
}
