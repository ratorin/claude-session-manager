// sessionCommands.ts — セッション・ブックマーク・タグ・メモリ関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SessionTreeProvider, SessionItem } from '../providers/sessionTreeProvider';
import { BookmarkTreeProvider } from '../providers/bookmarkTreeProvider';
import { TagTreeProvider, TagSessionItem } from '../providers/tagTreeProvider';
import { MemoryTreeProvider, MemoryFileItem } from '../providers/memoryTreeProvider';
import * as dataStore from '../models/dataStore';
import { showSessionPreview, showMemoryPreview, updatePreviewTitle } from '../panels/webviewPanel';
import { loadMemoryFiles, deleteMemoryFile, mergeMemoryFiles, extractFromMemory, addToIndex } from '../utils/memoryManager';
import { getConfig } from '../utils/config';

export interface SessionCommandsDeps {
	sessionProvider: SessionTreeProvider;
	bookmarkProvider: BookmarkTreeProvider;
	tagProvider: TagTreeProvider;
	memoryProvider: MemoryTreeProvider;
	refreshAll: () => void;
}

export function registerSessionCommands(
	context: vscode.ExtensionContext,
	deps: SessionCommandsDeps
): void {
	const { sessionProvider, bookmarkProvider, tagProvider, memoryProvider, refreshAll } = deps;

	// --- 会話関連コマンド ---

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshSessions', () => {
			refreshAll();
			vscode.window.showInformationMessage('会話一覧を更新しました');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewSession', (item: SessionItem | TagSessionItem) => {
			const session = item.session;
			if (session) {
				sessionProvider.setActiveSession(session.id);
				bookmarkProvider.refresh();
				tagProvider.refresh();
				showSessionPreview(session, context, getConfig<boolean>('preview.showThinkingBlocks', false));
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.bookmarkSession', (item: SessionItem) => {
			dataStore.addBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage(`「${item.session.customName || item.session.firstMessage.substring(0, 30)}」をブックマークしました`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.unbookmarkSession', (item: SessionItem) => {
			dataStore.removeBookmark(item.session.id);
			sessionProvider.refresh();
			bookmarkProvider.refresh();
			vscode.window.showInformationMessage('ブックマークを解除しました');
		})
	);

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

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.removeTag', (item: TagSessionItem) => {
			dataStore.removeTagFromSession(item.tagName, item.session.id);
			tagProvider.refresh();
			sessionProvider.refresh();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.renameSession', async (item: SessionItem) => {
			const currentName = item.session.customName || item.session.firstMessage.substring(0, 50);
			const newName = await vscode.window.showInputBox({
				prompt: '新しい名前を入力',
				value: currentName,
			});
			if (newName) {
				dataStore.setCustomName(item.session.id, newName);
				try {
					const titleEntry = JSON.stringify({
						type: 'custom-title',
						customTitle: newName,
						sessionId: item.session.id,
					});
					await fs.promises.appendFile(item.session.filePath, '\n' + titleEntry);
				} catch {
					// 書き込み失敗は無視
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

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.refreshMemory', () => {
			memoryProvider.refresh();
			vscode.window.showInformationMessage('メモリを更新しました');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.previewMemory', (item: MemoryFileItem) => {
			showMemoryPreview(item.memoryFile);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.editMemory', async (item: MemoryFileItem) => {
			const doc = await vscode.workspace.openTextDocument(item.memoryFile.filePath);
			await vscode.window.showTextDocument(doc);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.deleteMemory', async (item: MemoryFileItem) => {
			const confirm = await vscode.window.showWarningMessage(
				`メモリ「${item.memoryFile.name}」を削除しますか？`,
				{ modal: true },
				'削除'
			);
			if (confirm === '削除') {
				await deleteMemoryFile(item.memoryFile.filePath);
				memoryProvider.refresh();
				vscode.window.showInformationMessage('メモリを削除しました');
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.mergeMemories', async (item: MemoryFileItem) => {
			const groups = await loadMemoryFiles();
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

			const newName = await vscode.window.showInputBox({ prompt: '統合後のメモリ名', value: item.memoryFile.name });
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({ prompt: '統合後の説明', value: item.memoryFile.description });
			if (!newDescription) { return; }

			const mergedContent = mergeMemoryFiles(item.memoryFile, picked.file, newName, newDescription);
			await fs.promises.writeFile(item.memoryFile.filePath, mergedContent, 'utf-8');
			await deleteMemoryFile(picked.file.filePath);
			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${item.memoryFile.name}」と「${picked.file.name}」を統合しました`);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.extractMemory', async (item: MemoryFileItem) => {
			const doc = await vscode.workspace.openTextDocument(item.memoryFile.filePath);
			await vscode.window.showTextDocument(doc);

			const extractContent = await vscode.window.showInputBox({ prompt: '抽出する内容を入力', placeHolder: '抽出する内容...' });
			if (!extractContent) { return; }

			const newFileName = await vscode.window.showInputBox({ prompt: '新しいファイル名（.md不要）' });
			if (!newFileName) { return; }

			const newName = await vscode.window.showInputBox({ prompt: '新しいメモリ名' });
			if (!newName) { return; }

			const newDescription = await vscode.window.showInputBox({ prompt: '説明' });
			if (!newDescription) { return; }

			const typeOptions = ['user', 'feedback', 'project', 'reference'];
			const newType = await vscode.window.showQuickPick(typeOptions, { placeHolder: 'メモリタイプを選択' });
			if (!newType) { return; }

			const newContent = extractFromMemory(item.memoryFile, extractContent, newFileName, newName, newDescription, newType);
			const memoryDir = path.dirname(item.memoryFile.filePath);
			const newFilePath = path.join(memoryDir, `${newFileName}.md`);
			await fs.promises.writeFile(newFilePath, newContent, 'utf-8');
			await addToIndex(memoryDir, `${newFileName}.md`, newName, newDescription);
			memoryProvider.refresh();
			vscode.window.showInformationMessage(`「${newName}」を抽出しました`);
		})
	);

	// セッションIDをクリップボードにコピー
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.copySessionId', async (item: SessionItem) => {
			await vscode.env.clipboard.writeText(item.session.id);
			vscode.window.showInformationMessage(`セッションID をコピーしました: ${item.session.id}`);
		})
	);

	// Claude Codeで開く
	context.subscriptions.push(
		vscode.commands.registerCommand('claudeManager.openInClaude', (item: SessionItem) => {
			const scheme = vscode.env.uriScheme;
			const uri = vscode.Uri.parse(
				`${scheme}://anthropic.claude-code/open?session=` +
				encodeURIComponent(item.session.id)
			);
			vscode.env.openExternal(uri);
		})
	);
}
