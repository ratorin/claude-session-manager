// agentCommands.ts — エージェント管理関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionTreeProvider, SessionItem } from '../providers/sessionTreeProvider';
import { AgentTreeProvider, AgentItem } from '../providers/agentTreeProvider';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { showAgentFormPanel } from '../panels/agentFormPanel';
import { showAgentPreview } from '../panels/agentPreviewPanel';
import { resolveRuleFilePath } from '../agents/agentManager';
import { syncParentRuleFile } from '../agents/parentChildSync';
import { AgentWatcher } from '../watchers/agentWatcher';
import {
	autoCreateSessionIfNeeded, createRenewSession,
	generateSimpleTestament, generateDetailedTestament,
	appendSessionHistoryToRuleFile, SessionServiceDeps,
} from '../services/sessionService';
import { prepareAgentRule } from '../services/agentService';

export interface AgentCommandsDeps {
	sessionProvider: SessionTreeProvider;
	agentProvider: AgentTreeProvider;
	agentWatcher: AgentWatcher;
	sessionServiceDeps: SessionServiceDeps;
	refreshAll: () => void;
	getExtensionOutputChannel: () => vscode.OutputChannel;
	updateStatusBar: () => void;
	extensionOutputChannel: vscode.OutputChannel;
}

export function registerAgentCommands(
	context: vscode.ExtensionContext,
	deps: AgentCommandsDeps
): void {
	const {
		sessionProvider, agentProvider, agentWatcher,
		sessionServiceDeps, refreshAll, getExtensionOutputChannel,
		updateStatusBar, extensionOutputChannel,
	} = deps;

// エージェント保存共通ヘルパー（body生成 + 名前変更対応 + 親子同期）
async function saveAgentWithRule(
	config: AgentConfig,
	oldName: string | undefined,
	oldParent: string | undefined,
): Promise<void> {
	// ルール本文を生成
	const [ruleConfig, ruleBody] = await prepareAgentRule(config);
	// 名前変更時: 旧ファイルを削除
	if (oldName && ruleConfig.name !== oldName) {
		await dataStore.removeAgent(oldName);
	}
	// 保存（bodyをagents/<name>.mdの本文に書き込む）
	await dataStore.addAgent(ruleConfig, ruleBody);
	// 親子同期
	const ch = getExtensionOutputChannel();
	if (oldParent && oldParent !== ruleConfig.parentAgent) {
		await syncParentRuleFile(oldParent, ch);
	}
	await syncParentRuleFile(ruleConfig.parentAgent, ch);
	refreshAll();
}

// --- エージェント関連コマンド ---

// エージェントプレビュー（クリック時）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.previewAgent', (item: AgentItem) => {
		const agent = item.agent;
		const isLive = agent.sessionId ? sessionProvider.isLiveSession(agent.sessionId) : false;
		const sessions = sessionProvider.getSessions();
		const session = agent.sessionId ? sessions.find((s) => s.id === agent.sessionId) : undefined;
		const sessionTitle = session ? (session.customName || session.claudeTitle || session.firstMessage.substring(0, 40)) : undefined;

		showAgentPreview(agent, isLive, sessionTitle, {
			onEdit: (a) => {
				const oldName = a.name;
				const oldParent = a.parentAgent;
				showAgentFormPanel(a, a.sessionId, async (config) => {
					await saveAgentWithRule(config, oldName, oldParent);
					vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
				});
			},
			onEditRuleFile: async (a) => {
				if (!a.ruleFile) { return; }
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(a.ruleFile));
				await vscode.window.showTextDocument(doc);
			},
			onOpenInClaude: (sessionId) => {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(`${scheme}://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`);
				vscode.env.openExternal(uri);
			},
			onOpenInTerminal: (a) => {
				if (!a.sessionId) { return; }
				const args = ['claude', '--agent', a.name, '--resume', a.sessionId];
				if (a.permissionMode) { args.push('--permission-mode', a.permissionMode); }
				const terminal = vscode.window.createTerminal({ name: `🤖 ${a.displayName || a.name}`, cwd: a.workDir || undefined });
				terminal.show();
				terminal.sendText(args.join(' '));
			},
			onRenewSession: (a) => {
				vscode.commands.executeCommand('claudeManager.renewAgentSession', { agent: a });
			},
			onLinkSession: (a) => {
				vscode.commands.executeCommand('claudeManager.linkSession', { agent: a });
			},
		});
	})
);

// エージェントとして登録（新規 — Webviewフォーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.registerAgent', (item: SessionItem) => {
		showAgentFormPanel(undefined, item.session.id, async (config) => {
			await saveAgentWithRule(config, undefined, undefined);
			vscode.window.showInformationMessage(`「${config.name}」をエージェントとして登録しました`);
		});
	})
);

// エージェント追加（＋ボタン: セッション未紐づけで新規作成）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.addAgent', () => {
		showAgentFormPanel(undefined, '', async (config) => {
			if (!config.sessionId) { config.sessionId = ''; }
			// ルール生成 + セッション自動作成 + 保存
			const [ruleConfig, ruleBody] = await prepareAgentRule(config);
			const finalConfig = await autoCreateSessionIfNeeded(ruleConfig, sessionServiceDeps);
			await dataStore.addAgent(finalConfig, ruleBody);
			await syncParentRuleFile(finalConfig.parentAgent, getExtensionOutputChannel());
			refreshAll();
			vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
		});
	})
);

// エージェント設定を編集（Webviewフォーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editAgent', async (item: SessionItem | AgentItem) => {
		let existing: AgentConfig | undefined;
		let sessionId: string;
		if (item instanceof AgentItem) {
			existing = item.agent;
			sessionId = existing.sessionId;
		} else {
			existing = await dataStore.getAgentBySessionId(item.session.id);
			sessionId = item.session.id;
		}
		if (!existing) {
			vscode.window.showWarningMessage('エージェントが見つかりません');
			return;
		}

		const oldName = existing.name;
		const oldParent = existing.parentAgent;
		showAgentFormPanel(existing, sessionId, async (config) => {
			await saveAgentWithRule(config, oldName, oldParent);
			vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
		});
	})
);

// プレビューヘッダからの設定編集（セッションIDベース）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editAgentBySessionId', async (sessionId: string) => {
		const existing = await dataStore.getAgentBySessionId(sessionId);
		if (!existing) { return; }
		const oldName = existing.name;
		const oldParent = existing.parentAgent;
		showAgentFormPanel(existing, sessionId, async (config) => {
			await saveAgentWithRule(config, oldName, oldParent);
			refreshAll();
			vscode.window.showInformationMessage(`「${config.name}」の設定を更新しました`);
		});
	})
);

// プレビューヘッダからのルールファイル編集（セッションIDベース）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editRuleFileBySessionId', async (sessionId: string) => {
		const agent = await dataStore.getAgentBySessionId(sessionId);
		if (!agent || !agent.ruleFile) { return; }
		const resolved = await resolveRuleFilePath(agent.ruleFile);
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
		await vscode.window.showTextDocument(doc);
	})
);

// ルールファイルを編集
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.editRuleFile', async (item: SessionItem | AgentItem) => {
		let agent: AgentConfig | undefined;
		if (item instanceof AgentItem) {
			agent = item.agent;
		} else {
			agent = await dataStore.getAgentBySessionId(item.session.id);
		}
		if (!agent || !agent.ruleFile) {
			vscode.window.showWarningMessage('ルールファイルが設定されていません');
			return;
		}
		const resolved = await resolveRuleFilePath(agent.ruleFile);
		const uri = vscode.Uri.file(resolved);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc);
	})
);

// セッションを紐づけ（エージェントサイドバーから）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.linkSession', async (item: AgentItem) => {
		const sessions = sessionProvider.getSessions();
		const sessionItems: { label: string; description: string; sessionId: string; actualModel: string | undefined; alreadyLinked: boolean; linkedAgentName: string | undefined }[] = [];
		for (const s of sessions) {
			const existingAgent = await dataStore.getAgentBySessionId(s.id);
			const usedLabel = existingAgent ? ` [${existingAgent.name}に紐づけ済み]` : '';
			sessionItems.push({
				label: (s.customName || s.claudeTitle || s.firstMessage.substring(0, 50)) + usedLabel,
				description: `${s.project} — ${s.lastTimestamp.toLocaleString('ja-JP')}`,
				sessionId: s.id,
				actualModel: s.model,
				alreadyLinked: !!existingAgent,
				linkedAgentName: existingAgent?.name,
			});
		}

		if (sessionItems.length === 0) {
			vscode.window.showInformationMessage('紐づけ可能なセッションがありません');
			return;
		}

		const isAlreadyLinked = !!item.agent.sessionId;

		// 紐づけ済みの場合は確認を挟む
		if (isAlreadyLinked) {
			const confirm = await vscode.window.showWarningMessage(
				`「${item.agent.displayName || item.agent.name}」には既にセッションが紐づけされています。変更しますか？`,
				{ modal: true },
				'変更する'
			);
			if (confirm !== '変更する') { return; }
		}

		const picked = await vscode.window.showQuickPick(sessionItems, {
			placeHolder: '紐づけるセッションを選択',
			title: `「${item.agent.displayName || item.agent.name}」に${isAlreadyLinked ? 'セッションを変更' : 'セッションを紐づけ'}`,
		});
		if (!picked) { return; }

		// 他エージェントに紐づけ済みの場合は警告
		if (picked.alreadyLinked && picked.linkedAgentName !== item.agent.name) {
			const confirm = await vscode.window.showWarningMessage(
				`このセッションは「${picked.linkedAgentName}」に紐づけ済みです。上書きしますか？`,
				'上書き', 'キャンセル'
			);
			if (confirm !== '上書き') { return; }
			// 旧エージェントの紐づけを解除
			const oldAgent = await dataStore.getAgentBySessionId(picked.sessionId);
			if (oldAgent) {
				await dataStore.addAgent({ ...oldAgent, sessionId: '' });
			}
		}

		// モデル不一致チェック: 設定モデルと実際のモデルを比較
		let agentToSave = { ...item.agent, sessionId: picked.sessionId };
		if (picked.actualModel && item.agent.model) {
			const mismatch = !agentWatcher.modelsMatchPublic(item.agent.model, picked.actualModel);
			if (mismatch) {
				const answer = await vscode.window.showWarningMessage(
					`モデルが異なります。\n設定: ${item.agent.model}\n実際: ${picked.actualModel}\n設定を実際のモデルに合わせますか？`,
					{ modal: true },
					'合わせる', 'そのまま'
				);
				if (answer === '合わせる') {
					// 実際のモデルから内部モデル名に変換（日付付きID対応）
					function resolveModel(raw: string): string {
						if (raw.includes('[1m]')) {
							return raw.includes('sonnet') ? 'sonnet-1m' : 'opus';
						}
						if (raw.includes('opus')) { return 'opus'; }
						if (raw.includes('sonnet')) { return 'sonnet'; }
						if (raw.includes('haiku')) { return 'haiku'; }
						return raw;
					}
					const newModel = picked.actualModel ? resolveModel(picked.actualModel) : picked.actualModel;
					agentToSave = { ...agentToSave, model: newModel as typeof item.agent.model };
				}
			}
		}

		await dataStore.addAgent(agentToSave);
		refreshAll();
		vscode.window.showInformationMessage(`「${item.agent.name}」にセッションを紐づけました`);
	})
);

// エージェントのセッションをClaudeで開く（URIスキーム）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openAgentInClaude', async (item: AgentItem) => {
		if (!item.agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}
		const scheme = vscode.env.uriScheme;
		const uri = vscode.Uri.parse(
			`${scheme}://anthropic.claude-code/open?session=` +
			encodeURIComponent(item.agent.sessionId)
		);
		vscode.env.openExternal(uri);
	})
);

// エージェントのセッションをターミナルで開く（ルールファイル適用付き）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openAgentSession', async (item: AgentItem) => {
		if (!item.agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}
		// ルールファイルの存在チェック
		if (!item.agent.ruleFile) {
			vscode.window.showWarningMessage('ルールファイルが紐づいていません。エージェント設定から役割を設定してください');
		} else {
			try {
				await fs.promises.access(item.agent.ruleFile);
			} catch {
				vscode.window.showWarningMessage(`ルールファイルが見つかりません: ${item.agent.ruleFile}`);
			}
		}

		// ターミナルで --agent + --resume で起動（フロントマターからmodel/effort自動適用）
		const args = ['claude', '--agent', item.agent.name, '--resume', item.agent.sessionId];
		if (item.agent.permissionMode) {
			args.push('--permission-mode', item.agent.permissionMode);
		}

		const terminal = vscode.window.createTerminal({
			name: `🤖 ${item.agent.name}`,
			cwd: item.agent.workDir || undefined,
		});
		terminal.show();
		terminal.sendText(args.join(' '));
	})
);

// セッションを新しくする（自動遺言生成して新セッション作成）
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.renewAgentSession', async (item: AgentItem) => {
		const ch = getExtensionOutputChannel();
		const agent = item.agent;
		if (!agent.sessionId) {
			vscode.window.showWarningMessage('セッションが紐づけされていません');
			return;
		}

		try {
			// セッションサイズチェック（巨大セッションではAI要約不可）
			let sessionSizeMB = 0;
			const oldSession2 = sessionProvider.getSessionById(agent.sessionId);
			if (oldSession2) {
				try {
					const stat = await fs.promises.stat(oldSession2.filePath);
					sessionSizeMB = stat.size / (1024 * 1024);
				} catch { /* stat失敗 */ }
			}
			const isTooLarge = sessionSizeMB > 30;

			// 遺言生成モードを選択
			const options: { label: string; description: string; value: 'simple' | 'detailed' | 'delegate' | 'manual' }[] = [
				{ label: '簡易（即時）', description: 'JSONL末尾から自動抽出。コストゼロ', value: 'simple' },
			];
			if (!isTooLarge) {
				options.push(
					{ label: '詳細（AI要約）', description: '本人のセッションで要約生成', value: 'detailed' as const },
					{ label: 'エージェントに委任する', description: '別エージェントに要約を依頼', value: 'delegate' as const },
				);
			} else {
				options.unshift(
					{ label: '📋 手動引き継ぎ手順を表示', description: `セッション${Math.round(sessionSizeMB)}MB — 手順に従って手動で引き継ぎ`, value: 'manual' as const },
				);
				options.push(
					{ label: 'エージェントに委任する', description: '別エージェントに要約を依頼', value: 'delegate' as const },
				);
			}
			const mode = await vscode.window.showQuickPick(options,
				{ placeHolder: isTooLarge ? `⚠ セッション${Math.round(sessionSizeMB)}MB — 手動引き継ぎ推奨` : '遺言の生成方法を選択してください' }
			);
			if (!mode) { return; }

			const oldSession = sessionProvider.getSessionById(agent.sessionId);
			const oldSessionId = agent.sessionId;
			let testament = `${agent.name}の前セッションから引き継ぎ。`;

			// 手動引き継ぎ手順を表示（巨大セッション用）
			if (mode.value === 'manual') {
				const crypto = require('crypto') as typeof import('crypto');
				const nonce = crypto.randomBytes(16).toString('hex');
				const historyPath = path.join(os.homedir(), '.claude', 'agents', agent.name, 'HISTORY.md').replace(/\\/g, '/');
				const manualPanel = vscode.window.createWebviewPanel(
					'claudeManualRenew',
					`📋 手動引き継ぎ手順 — ${agent.displayName || agent.name}`,
					vscode.ViewColumn.One,
					{ enableScripts: false }
				);
				manualPanel.webview.html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 24px; max-width: 700px; margin: 0 auto; }
h1 { font-size: 18px; margin-bottom: 16px; }
.warn { background: rgba(255,200,50,0.08); border: 1px solid rgba(255,200,50,0.3); border-radius: 4px; padding: 12px; margin-bottom: 16px; font-size: 13px; }
.step { margin-bottom: 20px; }
.step-num { font-size: 24px; font-weight: 700; color: #e27e4a; float: left; margin-right: 12px; }
.step-content { overflow: hidden; }
.step-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.step-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
code { background: var(--vscode-textBlockQuote-background); padding: 8px 12px; display: block; border-radius: 4px; font-size: 12px; white-space: pre-wrap; margin: 8px 0; line-height: 1.6; }
</style></head><body>
<h1>📋 手動引き継ぎ手順</h1>
<div class="warn">⚠ セッションが ${Math.round(sessionSizeMB)}MB と巨大なため、自動AI要約は使用できません。以下の手順で手動引き継ぎしてください。</div>

<div class="step">
<div class="step-num">1</div>
<div class="step-content">
<div class="step-title">このセッションで以下を実行</div>
<div class="step-desc">エージェントに直接入力してください：</div>
<code>セッションの要約を300文字以内で書いて。
何をしたか・何が達成されたか・何が未完了か。
結果を ${historyPath} に追記して。</code>
</div></div>

<div class="step">
<div class="step-num">2</div>
<div class="step-content">
<div class="step-title">引き継ぎボタンで「簡易（即時）」を選択</div>
<div class="step-desc">HISTORYに記録が残っているので、簡易モードで十分です。新セッションが自動作成されます。</div>
</div></div>

<div class="step">
<div class="step-num">3</div>
<div class="step-content">
<div class="step-title">新セッションで確認</div>
<div class="step-desc">新セッションが起動したら、HISTORY.mdを読んで前回の文脈を把握します。</div>
</div></div>
</body></html>`;
				return; // 手順表示のみで終了
			}

			// 遺言生成（エラー時はデフォルトメッセージで続行）
			try {
				if (mode.value === 'simple') {
					testament = await generateSimpleTestament(agent, oldSession);
				} else if (mode.value === 'delegate') {
					// エージェント委任モード: 他エージェントのセッションにresumeして要約生成
					const allAgents = await dataStore.getAgents();
					const availableAgents = allAgents.filter(a => a.name !== agent.name && a.sessionId);
					if (availableAgents.length === 0) {
						vscode.window.showWarningMessage('利用可能なエージェントがありません。簡易モードにフォールバックします。');
						testament = await generateSimpleTestament(agent, oldSession);
					} else {
						const agentPick = await vscode.window.showQuickPick(
							availableAgents.map(a => ({
								label: a.name,
								description: `${a.role || ''} [${a.model}]`,
								value: a,
							})),
							{ placeHolder: '要約を依頼するエージェントを選択', title: '委任先エージェント' }
						);
						if (!agentPick) { return; }
						testament = await generateDetailedTestament(agent, oldSession, agentPick.value.sessionId);
					}
				} else {
					// 詳細モード: エージェント設定のモデルでAI要約生成
					// 本人のセッションに直接要約を依頼
					testament = await generateDetailedTestament(agent, oldSession, agent.sessionId);
				}
			} catch (testamentErr) {
				ch.appendLine(`[${new Date().toISOString()}] 遺言生成エラー: ${testamentErr instanceof Error ? testamentErr.message : String(testamentErr)}`);
				vscode.window.showWarningMessage(`遺言生成に失敗しました。デフォルトメッセージで続行します。`);
				// testament はデフォルト値のまま続行
			}

			// 300文字上限
			testament = testament.substring(0, 300);

			// 確認ダイアログ（編集可能）
			const finalTestament = await vscode.window.showInputBox({
				prompt: '引き継ぎメッセージ（編集可能・最大300文字）',
				placeHolder: '次のセッションへの引き継ぎ事項...',
				value: testament,
			});
			if (finalTestament === undefined) { return; }
			const trimmedTestament = finalTestament.substring(0, 300);

			// 旧セッションのJSONLに引き継ぎメッセージを追記
			if (oldSession) {
				try {
					const entry = JSON.stringify({
						type: 'user',
						uuid: `testament-${Date.now()}`,
						parentUuid: null,
						timestamp: new Date().toISOString(),
						sessionId: oldSessionId,
						message: {
							role: 'user',
							content: `[セッション終了] ${trimmedTestament}`,
						},
					});
					await fs.promises.appendFile(oldSession.filePath, '\n' + entry);
				} catch (writeErr) {
					ch.appendLine(`[${new Date().toISOString()}] JSONL追記エラー: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
					// 書き込み失敗でもセッション更新は続行
				}
			}

			// ルールファイルのカスタム部分に歴代セッション記録を追記
			if (agent.ruleFile) {
				try {
					await appendSessionHistoryToRuleFile(agent.ruleFile, oldSessionId, trimmedTestament, extensionOutputChannel);
				} catch (historyErr) {
					ch.appendLine(`[${new Date().toISOString()}] 歴代セッション記録追記エラー: ${historyErr instanceof Error ? historyErr.message : String(historyErr)}`);
					// 追記失敗でもセッション更新は続行
				}
			}

			// previousSessionIds を更新（直近5件保持）
			const prevIds = [...(agent.previousSessionIds || [])];
			prevIds.push(oldSessionId);
			while (prevIds.length > 5) { prevIds.shift(); }

			// セッションID紐づけを一時解除
			const updatedAgent: AgentConfig = { ...agent, sessionId: '', previousSessionIds: prevIds };
			await dataStore.addAgent(updatedAgent);

			// 新セッション自動作成 + 紐づけ
			const createNew = await vscode.window.showInformationMessage(
				`「${agent.displayName || agent.name}」の旧セッションを解除しました。新しいセッションを自動作成しますか？`,
				'自動作成', '手動で紐づけ'
			);

			if (createNew === '自動作成') {
				try {
					ch.appendLine(`[${new Date().toISOString()}] 新セッション作成中: ${agent.name}`);
					const initPrompt = `セッション引き継ぎ完了。前回の要約: ${trimmedTestament}`;
					const newSessionId = await createRenewSession(agent.name, initPrompt, sessionServiceDeps);

					const finalAgent: AgentConfig = { ...updatedAgent, sessionId: newSessionId };
					await dataStore.addAgent(finalAgent);
					ch.appendLine(`[${new Date().toISOString()}] 新セッション紐づけ完了: ${newSessionId}`);
					refreshAll();
					vscode.window.showInformationMessage(
						`「${agent.displayName || agent.name}」の新セッションを作成・紐づけしました`
					);
				} catch (createErr) {
					ch.appendLine(`[${new Date().toISOString()}] 新セッション作成エラー: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
					refreshAll();
					vscode.window.showWarningMessage(
						`新セッションの自動作成に失敗しました。手動で紐づけてください。`
					);
				}
			} else {
				refreshAll();
				vscode.window.showInformationMessage(
					`「${agent.displayName || agent.name}」のセッション紐づけを解除しました。手動で紐づけてください。`
				);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ch.appendLine(`[${new Date().toISOString()}] renewAgentSession 致命的エラー (${agent.name}): ${msg}`);
			ch.show(true);
			vscode.window.showErrorMessage(`セッション更新に失敗しました: ${msg}`);
		}
	})
);

// エージェントを削除
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.deleteAgent', async (item: AgentItem) => {
		const confirm = await vscode.window.showWarningMessage(
			`エージェント「${item.agent.name}」を削除しますか？`,
			{ modal: true },
			'削除'
		);
		if (confirm !== '削除') { return; }

		const parentName = item.agent.parentAgent;
		await dataStore.removeAgent(item.agent.name);
		await syncParentRuleFile(parentName, getExtensionOutputChannel());
		refreshAll();
		vscode.window.showInformationMessage(`「${item.agent.name}」を削除しました`);
	})
);

// 確認待ち一覧
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.showPendingTasks', async () => {
		const crypto = require('crypto') as typeof import('crypto');
		// 全エージェントの TODO.md から「確認待ち」の未チェック項目を取得
		const agentsDir = path.join(os.homedir(), '.claude', 'agents');
		const agents = await dataStore.getAgents();
		const pendingByAgent: { name: string; displayName: string; items: string[] }[] = [];
		let totalCount = 0;

		for (const agent of agents) {
			const todoPath = path.join(agentsDir, agent.name, 'TODO.md');
			try {
				const content = await fs.promises.readFile(todoPath, 'utf-8');
				const items: string[] = [];
				let inPending = false;
				for (const line of content.split('\n')) {
					const stripped = line.trim();
					if (stripped.startsWith('## 確認待ち')) { inPending = true; continue; }
					if (inPending && stripped.startsWith('## ')) { break; }
					if (inPending && stripped.startsWith('- [ ]')) {
						items.push(stripped.substring(6).trim());
					}
				}
				if (items.length > 0) {
					pendingByAgent.push({
						name: agent.name,
						displayName: agent.displayName || agent.name,
						items,
					});
					totalCount += items.length;
				}
			} catch { /* TODO.mdがない場合はスキップ */ }
		}

		if (totalCount === 0) {
			vscode.window.showInformationMessage('確認待ちタスクはありません');
			return;
		}

		// Webviewパネルで表示
		const nonce = crypto.randomBytes(16).toString('hex');
		const sectionsHtml = pendingByAgent.map(a => {
			const itemsHtml = a.items.map((item, i) =>
				`<label class="pending-item"><input type="checkbox" data-agent="${a.name}" data-task="${item.replace(/"/g,'&quot;')}"> ${item.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</label>`
			).join('');
			return `<div class="agent-section">
				<div class="agent-name">🤖 ${a.displayName.replace(/&/g,'&amp;').replace(/</g,'&lt;')}（${a.name}）</div>
				${itemsHtml}
			</div>`;
		}).join('');

		const panel = vscode.window.createWebviewPanel(
			'claudePendingTasks',
			`📋 確認待ち（${totalCount}件）`,
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		panel.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'togglePending') {
				const todoPath = path.join(os.homedir(), '.claude', 'agents', message.agent, 'TODO.md');
				try {
					const content = await fs.promises.readFile(todoPath, 'utf-8');
					const lines = content.split('\n');
					for (let i = 0; i < lines.length; i++) {
						if (message.checked && lines[i].trim() === `- [ ] ${message.task}`) {
							lines[i] = lines[i].replace('- [ ]', '- [x]');
							break;
						} else if (!message.checked && lines[i].trim() === `- [x] ${message.task}`) {
							lines[i] = lines[i].replace('- [x]', '- [ ]');
							break;
						}
					}
					await fs.promises.writeFile(todoPath, lines.join('\n'), 'utf-8');
				} catch { /* 失敗は無視 */ }
			}
		});

		panel.webview.html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 20px 24px; max-width: 720px; margin: 0 auto; }
h1 { font-size: 16px; margin-bottom: 16px; }
.agent-section { margin-bottom: 16px; border-left: 3px solid #e27e4a; padding-left: 12px; }
.agent-name { font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #e27e4a; }
.pending-item { display: block; font-size: 12px; padding: 3px 0; cursor: pointer; }
.pending-item:hover { background: rgba(255,255,255,0.03); }
.pending-item input { margin-right: 6px; cursor: pointer; }
.pending-item.done { text-decoration: line-through; opacity: 0.4; }
.summary { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 16px; }
</style></head><body>
<h1>📋 確認待ちタスク</h1>
<div class="summary">${pendingByAgent.length}エージェント・${totalCount}件</div>
${sectionsHtml}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.querySelectorAll('.pending-item input').forEach(cb => {
cb.addEventListener('change', (e) => {
	const input = e.target;
	const label = input.parentElement;
	if (input.checked) { label.classList.add('done'); } else { label.classList.remove('done'); }
	vscode.postMessage({
		type: 'togglePending',
		agent: input.dataset.agent,
		task: input.dataset.task,
		checked: input.checked
	});
});
});
</script>
</body></html>`;
	})
);

// エージェント管理を更新
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.refreshAgents', () => {
		agentProvider.refresh();
		updateStatusBar();
		vscode.window.showInformationMessage('エージェント管理を更新しました');
	})
);
}
