import * as fs from 'fs';
import { AgentConfig } from './types';
import * as dataStore from './dataStore';

// エージェント情報（表示用に拡張）
export interface AgentInfo extends AgentConfig {
	sessionTitle?: string;  // セッション表示名
}

// エージェント一覧を読み込み（session-manager.json優先、なければMdフォールバック）
export function loadAgents(): AgentInfo[] {
	const stored = dataStore.getAgents();
	if (stored.length > 0) {
		return stored as AgentInfo[];
	}
	// フォールバック: エージェント一覧.md をパース
	return parseAgentListMd();
}

// セッション情報をマージ（sessionLoaderの結果からタイトルを補完）
export function enrichAgentsWithSessions(
	agents: AgentInfo[],
	sessionTitleMap: Map<string, string>
): AgentInfo[] {
	return agents.map((agent) => ({
		...agent,
		sessionTitle: agent.sessionId
			? sessionTitleMap.get(agent.sessionId) || undefined
			: undefined,
	}));
}

// エージェント一覧.md をパースしてAgentInfo配列に変換（フォールバック用）
function parseAgentListMd(): AgentInfo[] {
	const mdPath = 'c:/xampp/Project/agent-rules/エージェント一覧.md';
	if (!fs.existsSync(mdPath)) {
		return [];
	}

	const content = fs.readFileSync(mdPath, 'utf-8');
	const agents: AgentInfo[] = [];

	// セッション管理テーブルからID対応表を作成
	const sessionMap = new Map<string, string>();
	const sessionTableMatch = content.match(/## セッション管理[\s\S]*?\n((?:\|.*\n)+)/);
	if (sessionTableMatch) {
		const rows = sessionTableMatch[1].split('\n').filter((l) => l.startsWith('|'));
		for (const row of rows) {
			const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
			if (cells.length >= 2 && cells[0] !== '部署' && cells[0] !== '---') {
				const name = cells[0];
				const sid = cells[1];
				if (/^[0-9a-f]{8}-/.test(sid)) {
					sessionMap.set(name, sid);
				}
			}
		}
	}

	// エージェント一覧テーブルをパース
	const tableMatch = content.match(/# エージェント一覧\n\n((?:\|.*\n)+)/);
	if (!tableMatch) {
		return agents;
	}

	const rows = tableMatch[1].split('\n').filter((l) => l.startsWith('|'));
	for (const row of rows) {
		const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
		if (cells.length < 4 || cells[0] === '部署' || cells[0].startsWith('---')) {
			continue;
		}

		const name = cells[0];
		const role = cells[1];
		const ruleFile = cells[2] ? `c:/xampp/Project/agent-rules/${cells[2]}` : undefined;
		const modelRaw = cells[3].toLowerCase();
		const model = modelRaw.includes('opus') ? 'opus'
			: modelRaw.includes('haiku') ? 'haiku'
			: 'sonnet';
		const toolsRaw = cells[4] || '';
		const allowedTools = toolsRaw === '制限なし（Web検索必要）'
			? ['制限なし']
			: toolsRaw.split(',').map((t) => t.trim()).filter(Boolean);

		let parentAgent: string | undefined;
		if (name.includes('班') && name.startsWith('AL')) {
			parentAgent = 'ALOrderForge開発部';
		}

		agents.push({
			name,
			sessionId: sessionMap.get(name) || '',
			role,
			model: model as AgentInfo['model'],
			ruleFile,
			allowedTools,
			parentAgent,
			status: 'idle',
		});
	}

	return agents;
}
