import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig } from './types';
import * as dataStore from './dataStore';

// エージェント情報（表示用に拡張）
export interface AgentInfo extends AgentConfig {
	sessionTitle?: string;  // セッション表示名
}

// エージェント一覧を取得（session-manager.json に一本化）
export async function getAgents(): Promise<AgentInfo[]> {
	return (await dataStore.getAgents()) as AgentInfo[];
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

// ルールファイルのフルパスを解決（ファイル名のみならルールフォルダと結合）
export async function resolveRuleFilePath(ruleFilePath: string): Promise<string> {
	if (!ruleFilePath) { return ''; }
	// 既にフルパスの場合はそのまま
	if (path.isAbsolute(ruleFilePath) || ruleFilePath.includes('/') || ruleFilePath.includes('\\')) {
		return ruleFilePath;
	}
	// ファイル名のみの場合はルールフォルダと結合
	const ruleFolder = await dataStore.getRuleFolder();
	return path.join(ruleFolder, ruleFilePath);
}

// ルールファイルの行数とサイズを取得（非同期）
export async function getRuleFileInfo(ruleFilePath: string): Promise<{ lines: number; sizeKb: string } | null> {
	try {
		const resolved = await resolveRuleFilePath(ruleFilePath);
		const [stat, content] = await Promise.all([
			fs.promises.stat(resolved),
			fs.promises.readFile(resolved, 'utf-8'),
		]);
		const lines = content.split('\n').length;
		const sizeKb = (stat.size / 1024).toFixed(1);
		return { lines, sizeKb };
	} catch {
		return null;
	}
}
