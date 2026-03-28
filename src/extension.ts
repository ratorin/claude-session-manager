import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionTreeProvider, SessionItem, SessionDecorationProvider } from './sessionTreeProvider';
import { BookmarkTreeProvider } from './bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from './tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem } from './memoryTreeProvider';
import { showSessionPreview, showMemoryPreview, updatePreviewTitle } from './webviewPanel';
import * as dataStore from './dataStore';
import { loadMemoryFiles, deleteMemoryFile, mergeMemoryFiles, extractFromMemory, addToIndex } from './memoryManager';

export function activate(context: vscode.ExtensionContext) {
	// TreeViewプロバイダーを作成
	const sessionProvider = new SessionTreeProvider();
	const bookmarkProvider = new BookmarkTreeProvider(() => sessionProvider.getSessions(), sessionProvider);
	const tagProvider = new TagTreeProvider(() => sessionProvider.getSessions());
	const memoryProvider = new MemoryTreeProvider();
	const sessionDecoProvider = new SessionDecorationProvider();

	// デコレーションプロバイダーを登録
	context.subscriptions.push(vscode.window.registerFileDecorationProvider(sessionDecoProvider));

	// TreeViewを登録
	vscode.window.createTreeView('claudeSessions', { treeDataProvider: sessionProvider });
	vscode.window.createTreeView('claudeBookmarks', { treeDataProvider: bookmarkProvider });
	vscode.window.createTreeView('claudeTags', { treeDataProvider: tagProvider });
	vscode.window.createTreeView('claudeMemory', { treeDataProvider: memoryProvider });

	// --- 会話関連コマンド ---

	// 会話一覧を更新
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshSessions', () => {
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			tagProvider.refresh();
			sessionDecoProvider.refresh();
			vscode.window.showInformationMessage('会話一覧を更新しました');
		})
	);

	// 会話をプレビュー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewSession', (item: SessionItem | TagSessionItem) => {
			const session = item.session;
			if (session) {
				sessionProvider.setActiveSession(session.id);
				bookmarkProvider.refresh();
				tagProvider.refresh();
				showSessionPreview(session, context);
			}
		})
	);

	// ブックマークに追加
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.bookmarkSession', (item: SessionItem) => {
			dataStore.addBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage(`「${item.session.customName || item.session.firstMessage.substring(0, 30)}」をブックマークしました`);
		})
	);

	// ブックマークから削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.unbookmarkSession', (item: SessionItem) => {
			dataStore.removeBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage('ブックマークを解除しました');
		})
	);

	// タグを追加
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.tagSession', async (item: SessionItem) => {
			const existingTags = Object.keys(dataStore.getAllTags());
			let tagName: string | undefined;

			if (existingTags.length > 0) {
				const NEW_TAG = '+ 新しいタグを作成...';
				const picked = await vscode.window.showQuickPick([...existingTags, NEW_TAG], {
					placeHolder: 'タグを選択',
				});
				if (!picked) { return; }
				if (picked === NEW_TAG) {
					tagName = await vscode.window.showInputBox({ prompt: '新しいタグ名を入力' });
				} else {
					tagName = picked;
				}
			} else {
				tagName = await vscode.window.showInputBox({ prompt: 'タグ名を入力' });
			}

			if (tagName) {
				dataStore.addTag(tagName, item.session.id);
				sessionProvider.refresh();
				tagProvider.refresh();
				vscode.window.showInformationMessage(`タグ「${tagName}」を追加しました`);
			}
		})
	);

	// タグを削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.removeTag', (item: TagSessionItem) => {
			dataStore.removeTagFromSession(item.tagName, item.session.id);
			tagProvider.refresh();
			sessionProvider.refresh();
		})
	);

	// 会話をリネーム
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.renameSession', async (item: SessionItem) => {
			const currentName = item.session.customName || item.session.firstMessage.substring(0, 50);
			const newName = await vscode.window.showInputBox({
				prompt: '新しい名前を入力',
				value: currentName,
			});
			if (newName) {
				dataStore.setCustomName(item.session.id, newName);
				// Claude Code側のJSONLにもcustom-titleを書き込み
				try {
					const titleEntry = JSON.stringify({
						type: 'custom-title',
						customTitle: newName,
						sessionId: item.session.id,
					});
					fs.appendFileSync(item.session.filePath, '\n' + titleEntry);
				} catch {
					// 書き込み失敗は無視（Session Manager側は反映済み）
				}
				if (sessionProvider.getActiveSessionId() === item.session.id) {
					updatePreviewTitle(newName);
				}
				sessionProvider.refresh();
				bookmarkProvider.refresh();
				tagProvider.refresh();
			}
		})
	);

	// 会話を検索
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.searchSessions', async () => {
			const keyword = await vscode.window.showInputBox({
				prompt: '検索キーワード（空で全件表示）',
				placeHolder: 'SSH, ALOrderForge, etc...',
			});
			if (keyword !== undefined) {
				sessionProvider.setFilter(keyword);
			}
		})
	);

	// --- メモリ関連コマンド ---

	// メモリを更新
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshMemory', () => {
			memoryProvider.refresh();
			vscode.window.showInformationMessage('メモリを更新しました');
		})
	);

	// メモリをプレビュー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewMemory', (item: MemoryFileItem) => {
			showMemoryPreview(item.memoryFile);
		})
	);

	// メモリを編集（VS Codeエディタで開く）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editMemory', (item: MemoryFileItem) => {
			vscode.workspace.openTextDocument(item.memoryFile.filePath).then((doc) => {
				vscode.window.showTextDocument(doc);
			});
		})
	);

	// メモリを削除
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteMemory', async (item: MemoryFileItem) => {
			const confirm = await vscode.window.showWarningMessage(
				`メモリ「${item.memoryFile.name}」を削除しますか？`,
				{ modal: true },
				'削除'
			);
			if (confirm === '削除') {
				deleteMemoryFile(item.memoryFile.filePath);
				memoryProvider.refresh();
				vscode.window.showInformationMessage('メモリを削除しました');
			}
		})
	);

	// メモリを統合（マージ）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.mergeMemories', async (item: MemoryFileItem) => {
			// 同じディレクトリの他のメモリファイルを選択肢に
			const groups = loadMemoryFiles();
			const memoryDir = path.dirname(item.memoryFile.filePath);
			const group = groups.find((g) => g.dir === memoryDir);
			if (!group) { return; }

			const otherFiles = group.files.filter((f) => f.filePath !== item.memoryFile.filePath);
			if (otherFiles.length === 0) {
				vscode.window.showInformationMessage('統合先のメモリファイルがありません');
				return;
			}

			const picked = await vscode.window.showQuickPick(
				otherFiles.map((f) => ({ label: f.name, description: `[${f.type}] ${f.description}`, file: f })),
				{ placeHolder: '統合するメモリを選択' }
			);
			if (!picked) { return; }

			const newName = await vscode.window.showInputBox({
				prompt: '統合後のメモリ名',
				value: item.memoryFile.name,
			});
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({
				prompt: '統合後の説明',
				value: item.memoryFile.description,
			});
			if (!newDescription) { return; }

			const mergedContent = mergeMemoryFiles(item.memoryFile, picked.file, newName, newDescription);

			// 統合先ファイルに書き込み
			fs.writeFileSync(item.memoryFile.filePath, mergedContent, 'utf-8');

			// 統合元を削除
			deleteMemoryFile(picked.file.filePath);

			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${item.memoryFile.name}」と「${picked.file.name}」を統合しました`);
		})
	);

	// メモリから抽出
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.extractMemory', async (item: MemoryFileItem) => {
			// エディタで開いてユーザーに抽出部分を選択させる
			const doc = await vscode.workspace.openTextDocument(item.memoryFile.filePath);
			const editor = await vscode.window.showTextDocument(doc);

			const extractContent = await vscode.window.showInputBox({
				prompt: '抽出する内容を入力（または開いたファイルから選択してコピー）',
				placeHolder: '抽出する内容...',
			});
			if (!extractContent) { return; }

			const newFileName = await vscode.window.showInputBox({
				prompt: '新しいファイル名（.md不要）',
			});
			if (!newFileName) { return; }

			const newName = await vscode.window.showInputBox({
				prompt: '新しいメモリ名',
			});
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({
				prompt: '説明',
			});
			if (!newDescription) { return; }

			const typeOptions = ['user', 'feedback', 'project', 'reference'];
			const newType = await vscode.window.showQuickPick(typeOptions, {
				placeHolder: 'メモリタイプを選択',
			});
			if (!newType) { return; }

			const newContent = extractFromMemory(
				item.memoryFile,
				extractContent,
				newFileName,
				newName,
				newDescription,
				newType
			);

			const memoryDir = path.dirname(item.memoryFile.filePath);
			const newFilePath = path.join(memoryDir, `${newFileName}.md`);
			fs.writeFileSync(newFilePath, newContent, 'utf-8');

			// インデックスに追加
			addToIndex(memoryDir, `${newFileName}.md`, newName, newDescription);

			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${newName}」を抽出しました`);
		})
	);

	// Claude Codeで開く（VS Code拡張のパネルで再開）
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openInClaude', (item: SessionItem) => {
			const uri = vscode.Uri.parse(
				'vscode://anthropic.claude-code/open?session=' +
				encodeURIComponent(item.session.id)
			);
			vscode.env.openExternal(uri);
		})
	);

	// 使い方ガイドを開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openGuide', () => {
			const guidePath = path.join(context.extensionPath, 'guide.html');
			if (fs.existsSync(guidePath)) {
				vscode.env.openExternal(vscode.Uri.file(guidePath));
			} else {
				vscode.window.showErrorMessage('guide.html が見つかりません');
			}
		})
	);

	// 初回読み込み＆ライブセッション監視開始
	sessionProvider.refresh();
	sessionProvider.startWatching();

	context.subscriptions.push({
		dispose: () => sessionProvider.stopWatching(),
	});
}

export function deactivate() {}
