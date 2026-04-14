// utilityCommands.ts — ガイド・設定・フィルター・ユーティリティ関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem } from '../providers/sessionTreeProvider';
import { BookmarkTreeProvider } from '../providers/bookmarkTreeProvider';
import { MemoryTreeProvider, MemoryFileItem, MemoryGroupItem } from '../providers/memoryTreeProvider';
import * as dataStore from '../models/dataStore';
import { moveToTrash } from '../utils/agentUtils';
import { getConfig } from '../utils/config';

export interface UtilityCommandsDeps {
	sessionProvider: SessionTreeProvider;
	bookmarkProvider: BookmarkTreeProvider;
	memoryProvider: MemoryTreeProvider;
	refreshAll: () => void;
}

export function registerUtilityCommands(
	context: vscode.ExtensionContext,
	deps: UtilityCommandsDeps
): void {
	const { sessionProvider, bookmarkProvider, memoryProvider, refreshAll } = deps;

// 使い方ガイドを開く（Webviewパネル）
let guidePanel: vscode.WebviewPanel | undefined;
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openGuide', async () => {
		const guidePath = path.join(context.extensionPath, 'guide.html');
		try {
			await fs.promises.access(guidePath);
		} catch {
			vscode.window.showErrorMessage('guide.html が見つかりません');
			return;
		}

		if (guidePanel) {
			guidePanel.reveal(vscode.ViewColumn.One);
			return;
		}

		guidePanel = vscode.window.createWebviewPanel(
			'claudeGuide',
			'📖 使い方ガイド',
			vscode.ViewColumn.One,
			{
				enableScripts: false,
				localResourceRoots: [vscode.Uri.file(context.extensionPath)],
			}
		);

		// HTMLを読み込み、画像パスをWebview URIに変換
		let html = await fs.promises.readFile(guidePath, 'utf-8');
		const imagesUri = guidePanel.webview.asWebviewUri(
			vscode.Uri.file(path.join(context.extensionPath, 'images'))
		);
		html = html.replace(/images\//g, `${imagesUri}/`);
		guidePanel.webview.html = html;
		guidePanel.onDidDispose(() => { guidePanel = undefined; });
	})
);

// セッションパスをコピー
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.copySessionPath', async (item: SessionItem) => {
		await vscode.env.clipboard.writeText(item.session.filePath);
		vscode.window.showInformationMessage(`セッションパスをコピーしました`);
	})
);

// メモリパスをコピー
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.copyMemoryPath', async (item: MemoryFileItem) => {
		await vscode.env.clipboard.writeText(item.memoryFile.filePath);
		vscode.window.showInformationMessage(`メモリパスをコピーしました`);
	})
);

// 設定ファイルをエディタで開く
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openSettingsFile', async (filePath: string) => {
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
		await vscode.window.showTextDocument(doc);
	})
);

// プロジェクトフォルダをVS Codeで開く
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openProjectInVSC', async (item: MemoryGroupItem) => {
		const projectPath = item.projectPath;
		let exists = false;
		if (projectPath) {
			try {
				await fs.promises.access(projectPath);
				exists = true;
			} catch { /* 存在しない */ }
		}
		if (exists) {
			vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectPath), { forceNewWindow: true });
		} else {
			vscode.window.showWarningMessage(`プロジェクトフォルダが見つかりません: ${projectPath}`);
		}
	})
);

// --- セッション削除 ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.deleteSession', async (item: SessionItem) => {
		const displayName = item.session.customName || item.session.claudeTitle || item.session.firstMessage.substring(0, 40);
		const linkedAgent = await dataStore.getAgentBySessionId(item.session.id);
		let warningMsg = `セッション「${displayName}」を削除しますか？`;
		if (linkedAgent) {
			warningMsg += `\n（エージェント「${linkedAgent.name}」の紐づけも解除されます）`;
		}

		const confirm = await vscode.window.showWarningMessage(
			warningMsg,
			{ modal: true },
			'削除'
		);
		if (confirm !== '削除') { return; }

		// .trash/ ディレクトリに移動（H-1共通関数）
		const configTrash = getConfig<string>('trash.folder', '');
		const trashDir = configTrash || path.join(os.homedir(), '.claude', '.trash');
		try {
			await moveToTrash(item.session.filePath, trashDir);
		} catch {
			vscode.window.showErrorMessage('セッションファイルの移動に失敗しました');
			return;
		}

		// 関連データのクリーンアップ
		await dataStore.cleanupSessionData(item.session.id);
		refreshAll();
		vscode.window.showInformationMessage(`セッション「${displayName}」を削除しました`);
	})
);

// --- ソート機能 ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.sortSessions', async () => {
		const options = [
			{ label: '更新日（新しい順）', description: 'デフォルト', value: 'updated-desc' },
			{ label: '更新日（古い順）', value: 'updated-asc' },
			{ label: '作成日（新しい順）', value: 'created-desc' },
			{ label: '作成日（古い順）', value: 'created-asc' },
			{ label: '名前', value: 'name' },
			{ label: 'メッセージ数', value: 'count' },
			{ label: 'モデル', value: 'model' },
		];
		const picked = await vscode.window.showQuickPick(options, {
			placeHolder: 'ソート基準を選択',
		});
		if (picked) {
			sessionProvider.setSortMode(picked.value as 'updated-desc' | 'updated-asc' | 'created-desc' | 'created-asc' | 'name' | 'count' | 'model');
		}
	})
);

// --- グループ化切り替え ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.groupSessions', async () => {
		const options = [
			{ label: '日付別（デフォルト）', value: 'date' },
			{ label: 'タグ別', value: 'tag' },
			{ label: 'エージェント別', value: 'agent' },
			{ label: 'フラット（グループなし）', value: 'flat' },
		];
		const picked = await vscode.window.showQuickPick(options, {
			placeHolder: 'グループ表示モードを選択',
		});
		if (picked) {
			sessionProvider.setGroupMode(picked.value as 'date' | 'tag' | 'agent' | 'flat');
		}
	})
);



// --- セッションフィルター切り替え ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.toggleSessionFilter', () => {
		const config = vscode.workspace.getConfiguration('claudeManager');
		const current = config.get<string>('sessionFilterMode', 'all');
		const next = current === 'project' ? 'all' : 'project';
		config.update('sessionFilterMode', next, vscode.ConfigurationTarget.Global);
		sessionProvider.setProjectFilter(next === 'project');
		vscode.window.showInformationMessage(`セッション表示: ${next === 'project' ? 'プロジェクトのみ' : 'すべて'}`);
	})
);

// --- ブックマークフィルター切り替え ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.toggleBookmarkFilter', () => {
		const current = bookmarkProvider.isProjectFilterEnabled();
		bookmarkProvider.setProjectFilter(!current);
		vscode.window.showInformationMessage(`ブックマーク表示: ${!current ? 'プロジェクトのみ' : 'すべて'}`);
	})
);

// --- メモリフィルター切り替え ---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.toggleMemoryFilter', () => {
		const current = memoryProvider.isProjectFilterEnabled();
		memoryProvider.setProjectFilter(!current);
		vscode.window.showInformationMessage(`メモリ表示: ${!current ? 'プロジェクトのみ' : 'すべて'}`);
	})
);

// --- 設定を開く（歯車アイコン）---
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openSettings', () => {
		vscode.commands.executeCommand('workbench.action.openSettings', 'claudeManager');
	})
);

// 検知方式比較ビュー: Phase 4 で削除済み（fswatch固定）

}
