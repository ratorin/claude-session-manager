import * as vscode from 'vscode';
import { AgentInfo, loadAgents, enrichAgentsWithSessions } from './agentManager';
import { ParsedSession } from './types';

// パネルを使い回すための参照
let orgPanel: vscode.WebviewPanel | undefined;

// セッションを開くコールバック
let onOpenSession: ((sessionId: string) => void) | undefined;

// 組織図パネルを開く
export function showOrgChart(
	getSessions: () => ParsedSession[],
	isLive: (id: string) => boolean,
	openSession?: (sessionId: string) => void
): void {
	onOpenSession = openSession;
	// エージェント情報を読み込み
	const agents = loadAgents();

	// セッションタイトル対応表を作成
	const sessions = getSessions();
	const titleMap = new Map<string, string>();
	for (const s of sessions) {
		titleMap.set(s.id, s.customName || s.claudeTitle || s.firstMessage.substring(0, 40));
	}
	const enriched = enrichAgentsWithSessions(agents, titleMap);

	// ライブ状態を付与
	const liveIds = new Set<string>();
	for (const a of enriched) {
		if (a.sessionId && isLive(a.sessionId)) {
			liveIds.add(a.sessionId);
		}
	}

	const title = '🏢 エージェント組織図';
	const html = getOrgChartHtml(enriched, liveIds);

	if (orgPanel) {
		orgPanel.webview.html = html;
		orgPanel.reveal(vscode.ViewColumn.One);
	} else {
		orgPanel = vscode.window.createWebviewPanel(
			'claudeOrgChart',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);
		orgPanel.webview.html = html;
		orgPanel.onDidDispose(() => { orgPanel = undefined; });

		// Webviewからのメッセージ受信
		orgPanel.webview.onDidReceiveMessage((message) => {
			if (message.type === 'copyId') {
				vscode.env.clipboard.writeText(message.id).then(() => {
					vscode.window.showInformationMessage(`コピー: ${message.id}`);
				});
			} else if (message.type === 'openSession' && onOpenSession) {
				onOpenSession(message.sessionId);
			}
		});
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// エージェントカードのHTML生成
function renderAgentCard(agent: AgentInfo, liveIds: Set<string>, isSub: boolean = false): string {
	const nodeClass = isSub ? 'node node-sub' : 'node';
	const badgeClass = agent.model === 'opus' ? 'badge-opus'
		: agent.model === 'haiku' ? 'badge-haiku'
		: 'badge-sonnet';
	const isLive = agent.sessionId ? liveIds.has(agent.sessionId) : false;
	const liveDot = isLive ? '<span class="live-dot" title="使用中"></span>' : '';

	// セッション情報
	let sessionHtml = '';
	if (agent.sessionId) {
		const shortId = agent.sessionId.substring(0, 8) + '...' + agent.sessionId.slice(-4);
		const titleHtml = agent.sessionTitle
			? `<div class="session-title">${escapeHtml(agent.sessionTitle)}</div>`
			: '';
		sessionHtml = `
			${titleHtml}
			<div class="session-actions">
				<span class="session-id" data-id="${escapeHtml(agent.sessionId)}" title="IDをコピー">📋 ${shortId}</span>
				<span class="session-open" data-sid="${escapeHtml(agent.sessionId)}" title="会話を開く">▶</span>
			</div>`;
	} else {
		sessionHtml = '<div class="session-unset">セッション未設定</div>';
	}

	// ツールタグ
	const tools = agent.allowedTools || [];
	const toolsHtml = tools.length > 0
		? `<div class="tools">${tools.map((t: string) => `<span class="tool-tag">${escapeHtml(t)}</span>`).join('')}</div>`
		: '';

	return `
		<div class="${nodeClass}">
			<div class="node-header">
				<span class="badge ${badgeClass}">${agent.model}</span>
				<span class="node-name">${escapeHtml(agent.name)}</span>
				${liveDot}
			</div>
			<div class="node-role">${escapeHtml(agent.role)}</div>
			${toolsHtml}
			${sessionHtml}
		</div>`;
}

// 組織図全体のHTML
function getOrgChartHtml(agents: AgentInfo[], liveIds: Set<string>): string {
	// 親部署（parent未設定）と子部署を分離
	const topLevel = agents.filter((a) => !a.parentAgent);
	const children = agents.filter((a) => a.parentAgent);

	// 部署ごとのカードHTML生成
	const deptCards = topLevel.map((agent) => {
		const subAgents = children.filter((c) => c.parentAgent === agent.name);
		const subHtml = subAgents.map((sub) => `
			<div class="sub-dept">
				<div class="connector-v"></div>
				${renderAgentCard(sub, liveIds, true)}
			</div>`).join('');

		// 動的増設案内
		const expandHtml = agent.name === 'ALOrderForge開発部'
			? `<div class="sub-dept">
				<div class="connector-v" style="height: 8px;"></div>
				<div class="expandable">＋ 班長が必要に応じて<br>AL●●班を増設</div>
			</div>`
			: '';

		return `
			<div class="dept-col">
				${renderAgentCard(agent, liveIds)}
				${subHtml}
				${expandHtml}
			</div>`;
	}).join('');

	return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
	:root {
		--bg: var(--vscode-editor-background);
		--surface: var(--vscode-textBlockQuote-background);
		--border: var(--vscode-panel-border);
		--text: var(--vscode-foreground);
		--text-dim: var(--vscode-descriptionForeground);
		--accent: #e27e4a;
		--opus: #b388ff;
		--sonnet: #64b5f6;
		--haiku: #81c784;
		--line: var(--vscode-editorIndentGuide-background);
		--live-green: #4ec94e;
	}
	* { margin: 0; padding: 0; box-sizing: border-box; }
	body {
		font-family: var(--vscode-font-family);
		background: var(--bg);
		color: var(--text);
		padding: 24px;
		min-height: 100vh;
	}
	h1 {
		text-align: center;
		font-size: 18px;
		color: var(--accent);
		margin-bottom: 6px;
		font-weight: 500;
	}
	.subtitle {
		text-align: center;
		font-size: 11px;
		color: var(--text-dim);
		margin-bottom: 28px;
	}

	/* 組織図レイアウト */
	.org-chart {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	/* ノード共通 */
	.node {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 10px 14px;
		min-width: 200px;
		max-width: 240px;
		transition: border-color 0.2s, box-shadow 0.2s;
	}
	.node:hover {
		border-color: var(--accent);
		box-shadow: 0 0 12px rgba(226, 126, 74, 0.15);
	}
	.node-header {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-bottom: 3px;
	}
	.node-name { font-size: 13px; font-weight: 600; }
	.node-role { font-size: 11px; color: var(--text-dim); line-height: 1.3; }

	/* セッション情報 */
	.session-title {
		font-size: 10px;
		color: var(--text-dim);
		margin-top: 6px;
		line-height: 1.3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.session-id {
		font-size: 10px;
		color: var(--text-dim);
		margin-top: 2px;
		font-family: 'Cascadia Code', 'Consolas', monospace;
		opacity: 0.7;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.session-id:hover { opacity: 1; color: var(--accent); }
	.session-actions { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
	.session-open {
		font-size: 10px;
		cursor: pointer;
		opacity: 0.5;
		padding: 1px 4px;
		border-radius: 3px;
		transition: all 0.2s;
	}
	.session-open:hover { opacity: 1; background: var(--accent); color: #fff; }
	.session-unset {
		font-size: 10px;
		color: var(--text-dim);
		margin-top: 6px;
		opacity: 0.5;
		font-style: italic;
	}

	/* モデルバッジ */
	.badge {
		font-size: 9px;
		padding: 1px 5px;
		border-radius: 3px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
	}
	.badge-opus {
		background: rgba(179, 136, 255, 0.15);
		color: var(--opus);
		border: 1px solid rgba(179, 136, 255, 0.3);
	}
	.badge-sonnet {
		background: rgba(100, 181, 246, 0.15);
		color: var(--sonnet);
		border: 1px solid rgba(100, 181, 246, 0.3);
	}
	.badge-haiku {
		background: rgba(129, 199, 132, 0.15);
		color: var(--haiku);
		border: 1px solid rgba(129, 199, 132, 0.3);
	}

	/* ライブインジケーター */
	.live-dot {
		width: 7px; height: 7px;
		background: var(--live-green);
		border-radius: 50%;
		display: inline-block;
		animation: pulse 2s infinite;
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* 取締役 */
	.node-director {
		border-color: var(--accent);
		border-width: 2px;
		min-width: 260px;
		max-width: 300px;
		text-align: center;
	}
	.node-director .node-name { color: var(--accent); font-size: 15px; }

	/* 接続線 */
	.connector-v { width: 2px; height: 20px; background: var(--line); margin: 0 auto; }
	.h-line { height: 2px; background: var(--line); width: 100%; max-width: 1100px; }

	/* 部署グリッド */
	.dept-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 14px;
		max-width: 1100px;
		width: 100%;
	}
	.dept-col {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.dept-col::before {
		content: '';
		display: block;
		width: 2px;
		height: 14px;
		background: var(--line);
	}

	/* 子部署 */
	.sub-dept { display: flex; flex-direction: column; align-items: center; }
	.sub-dept .connector-v { height: 14px; }
	.node-sub {
		min-width: 180px;
		border-style: dashed;
	}
	.node-sub .node-name { font-size: 12px; }

	/* ツールタグ */
	.tools { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
	.tool-tag {
		font-size: 9px;
		padding: 1px 4px;
		border-radius: 2px;
		background: rgba(255, 255, 255, 0.06);
		color: var(--text-dim);
		border: 1px solid rgba(255, 255, 255, 0.08);
	}

	/* 増設案内 */
	.expandable {
		font-size: 10px;
		color: var(--text-dim);
		text-align: center;
		padding: 6px;
		border: 1px dashed var(--border);
		border-radius: 6px;
		min-width: 180px;
	}

	/* 凡例 */
	.legend {
		display: flex;
		gap: 20px;
		justify-content: center;
		margin-top: 28px;
		font-size: 11px;
		color: var(--text-dim);
	}
	.legend-item { display: flex; align-items: center; gap: 5px; }
</style>
</head>
<body>

<h1>エージェント組織図</h1>
<p class="subtitle">Claude Code マルチエージェント運用体制</p>

<div class="org-chart">
	<!-- 取締役 -->
	<div class="node node-director">
		<div class="node-header" style="justify-content: center;">
			<span class="node-name">取締役（メインセッション）</span>
		</div>
		<div class="node-role">全体統括・指示出し・承認</div>
	</div>

	<div class="connector-v"></div>
	<div class="h-line"></div>

	<!-- 部署グリッド -->
	<div class="dept-grid">
		${deptCards}
	</div>
</div>

<!-- 凡例 -->
<div class="legend">
	<div class="legend-item"><span class="badge badge-opus">opus</span> 高度な判断・開発</div>
	<div class="legend-item"><span class="badge badge-sonnet">sonnet</span> 定型作業・補助</div>
	<div class="legend-item"><span class="live-dot"></span> 使用中</div>
	<div class="legend-item">📋 クリックでIDコピー</div>
</div>

<script>
	const vscode = acquireVsCodeApi();

	// セッションIDクリックでコピー
	document.querySelectorAll('.session-id').forEach(el => {
		el.addEventListener('click', (e) => {
			e.stopPropagation();
			const id = el.getAttribute('data-id');
			if (id) {
				vscode.postMessage({ type: 'copyId', id: id });
			}
		});
	});

	// ▶ クリックでセッションを開く
	document.querySelectorAll('.session-open').forEach(el => {
		el.addEventListener('click', (e) => {
			e.stopPropagation();
			const sid = el.getAttribute('data-sid');
			if (sid) {
				vscode.postMessage({ type: 'openSession', sessionId: sid });
			}
		});
	});
</script>

</body>
</html>`;
}
