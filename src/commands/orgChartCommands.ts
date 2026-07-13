// orgChartCommands.ts — 組織図・ディレクター関連コマンド
// extension.ts から抽出

import * as vscode from 'vscode';
import * as os from 'os';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import { SessionTreeProvider } from '../providers/sessionTreeProvider';
import { BookmarkTreeProvider } from '../providers/bookmarkTreeProvider';
import { TagTreeProvider } from '../providers/tagTreeProvider';
import { showAgentFormPanel } from '../panels/agentFormPanel';
import { showOrgChart } from '../panels/orgChartPanel';
import { showSessionPreview } from '../panels/webviewPanel';
import { syncAllParentRuleFiles } from '../agents/parentChildSync';
import { shouldShowInOrgChart } from '../utils/agentUtils';
import { ensureSubagentHooks, writeOrgInfoToMemory } from '../services/hookService';
import { prepareDirectorRule, addAffinitySettings } from '../services/agentService';
import { getConfig } from '../utils/config';

export interface OrgChartCommandsDeps {
	sessionProvider: SessionTreeProvider;
	bookmarkProvider: BookmarkTreeProvider;
	tagProvider: TagTreeProvider;
	refreshAll: () => void;
	getExtensionOutputChannel: () => vscode.OutputChannel;
	extensionOutputChannel: vscode.OutputChannel;
}

export function registerOrgChartCommands(
	context: vscode.ExtensionContext,
	deps: OrgChartCommandsDeps
): void {
	const { sessionProvider, bookmarkProvider, tagProvider, refreshAll, getExtensionOutputChannel, extensionOutputChannel } = deps;

context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.syncAllParentRules', async () => {
		await syncAllParentRuleFiles(getExtensionOutputChannel());
		vscode.window.showInformationMessage('全ての親ルールファイルの配下エージェントセクションを再生成しました');
	})
);

// エージェント組織図を表示
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.openOrgChart', () => {
		showOrgChart(
			() => sessionProvider.getSessions(),
			(id) => sessionProvider.isLiveSession(id),
			// 履歴プレビュー
			(sessionId) => {
				const session = sessionProvider.getSessionById(sessionId);
				if (session) {
					sessionProvider.setActiveSession(session.id);
					bookmarkProvider.refresh();
					tagProvider.refresh();
					showSessionPreview(session, context, getConfig<boolean>('preview.showThinkingBlocks', false));
				}
			},
			// Claude Codeで開く
			(sessionId) => {
				const scheme = vscode.env.uriScheme;
				const uri = vscode.Uri.parse(
					`${scheme}://anthropic.claude-code/open?session=` +
					encodeURIComponent(sessionId)
				);
				vscode.env.openExternal(uri);
			},
			// v0.5.23: extensionUri は現在未使用（Cytoscape/ELK 撤去後の後方互換のため引数だけ温存）
			context.extensionUri
		);
	})
);

// 組織図表示設定を確認
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.checkOrgChartSettings', async () => {
		const agents = await dataStore.getAgents();

		// 組織図に表示/非表示を分類（B案: parentAgent 自動判定）
		const visible = agents.filter((a) => shouldShowInOrgChart(a));
		const hidden = agents.filter((a) => !shouldShowInOrgChart(a));

		// グループ化（親ごと）
		const visibleByParent = new Map<string | undefined, typeof visible>();
		for (const a of visible) {
			const parent = a.parentAgent || '(親なし)';
			if (!visibleByParent.has(parent)) {
				visibleByParent.set(parent, []);
			}
			visibleByParent.get(parent)!.push(a);
		}

		// メッセージ構築
		let message = `📊 **組織図表示設定**\n\n`;
		message += `**表示対象: ${visible.length}件**\n`;
		for (const [parent, list] of visibleByParent.entries()) {
			message += `\n${parent}\n`;
			for (const a of list) {
				const displayName = a.displayName || a.name;
				message += `  • ${displayName}\n`;
			}
		}

		if (hidden.length > 0) {
			message += `\n**非表示: ${hidden.length}件**\n`;
			for (const a of hidden) {
				const displayName = a.displayName || a.name;
				message += `  • ${displayName}\n`;
			}
		}

		const ch = getExtensionOutputChannel();
		ch.clear();
		ch.appendLine(message);
		ch.show();

		vscode.window.showInformationMessage(`組織図設定: 表示${visible.length}件 / 非表示${hidden.length}件`);
	})
);

// 取締役プリセットで登録
context.subscriptions.push(
	vscode.commands.registerCommand('claudeManager.registerDirector', () => {
		const preset: AgentConfig = {
			name: '取締役',
			sessionId: '',
			role: '全体統括・タスク分割・承認判断',
			model: 'opus',
			sessionMode: 'fixed',
		};
		showAgentFormPanel(preset, '', async (config) => {
			const [finalConfig, ruleBody] = await prepareDirectorRule(config);
			await dataStore.addAgent(finalConfig, ruleBody);
			await writeOrgInfoToMemory(finalConfig);
			await ensureSubagentHooks(extensionOutputChannel);
			await addAffinitySettings();
			refreshAll();
			vscode.window.showInformationMessage(`「${finalConfig.name}」をエージェントとして登録しました`);
		});
	})
);

}
