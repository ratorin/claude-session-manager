// agentService.ts — エージェント設定・ルール生成ロジック
// extension.ts から抽出

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentConfig } from '../models/types';
import * as dataStore from '../models/dataStore';
import {
	generateFrontmatter, updateFrontmatterInContent,
	migrateAutoToYaml, isLegacyAutoFormat, sanitizeForYaml,
} from '../utils/frontmatterUtils';

// 子エージェント用 description テキストを構築
export function buildDescription(config: AgentConfig): string {
	const safeName = sanitizeForYaml(config.name);
	const safeRole = sanitizeForYaml(config.role || '（役割未設定）');
	const lines: string[] = [
		`あなたは${safeName}所属のエンジニアです。`,
		`- ${safeRole}`,
		`- 変更前に既存コードを確認し、既存の設計方針を尊重する`,
		`- セッション開始時にMEMORY.md（自動メモリ）を確認し、組織図・行動規範・プロジェクト情報を把握すること`,
		`- session-manager.json の agents 一覧から自分の位置づけ・他エージェントとの関係を把握すること`,
		`- 「※子エージェントはこのセクションを無視すること」とマークされたセクションは読み飛ばすこと`,
	];
	if (config.parentAgent) {
		const safeParent = sanitizeForYaml(config.parentAgent);
		lines.push(`- 報告先: ${safeParent}（親エージェント）。作業完了時は結果を報告すること`);
	}
	if (config.workDir) {
		const safeWorkDir = sanitizeForYaml(config.workDir);
		lines.push(`- 編集対象は \`${safeWorkDir}\` 内のみ。それ以外のフォルダは絶対に変更しない`);
	}
	return lines.join('\n');
}

// 既存ファイルのフロントマター（description含む）を更新（本文は保持）
export async function updateRuleFrontmatter(filePath: string, config: AgentConfig, description: string): Promise<void> {
	try {
		const content = await fs.promises.readFile(filePath, 'utf-8');

		// 旧 CSM:AUTO 形式 → YAML フロントマターに自動移行
		if (isLegacyAutoFormat(content)) {
			const migrated = migrateAutoToYaml(content, config);
			// 移行後に description を最新化
			const newContent = updateFrontmatterInContent(migrated, config, description);
			await fs.promises.writeFile(filePath, newContent, 'utf-8');
			return;
		}

		// YAML フロントマター形式 → フロントマターのみ更新
		const newContent = updateFrontmatterInContent(content, config, description);
		await fs.promises.writeFile(filePath, newContent, 'utf-8');
	} catch {
		// ファイル読み書きエラーは無視
	}
}

// エージェント作成・更新時にルール本文を生成し、agents/<name>/ にTODO/HISTORYを配置
// 戻り値: [更新されたconfig, ルール本文]
export async function prepareAgentRule(config: AgentConfig, isNewAgent: boolean = false): Promise<[AgentConfig, string]> {
	const description = buildDescription(config);
	const agentsDir = getAgentsDir(config.scope);
	if (!agentsDir) { return [config, description]; }

	// 名前重複チェック: 新規作成時のみ、他スコープに同名エージェントが存在する場合はエラー
	if (isNewAgent) {
		const otherScope = config.scope === 'global' ? 'project' : 'global';
		const otherDir = getAgentsDir(otherScope);
		if (otherDir) {
			const otherFile = path.join(otherDir, `${config.name}.md`);
			try {
				await fs.promises.access(otherFile);
				throw new Error(`同名のエージェントが${otherScope === 'global' ? 'グローバル' : 'プロジェクト'}スコープに既に存在します: ${config.name}`);
			} catch (err) {
				if (err instanceof Error && err.message.includes('同名')) { throw err; }
			}
		}
	}

	// agents/<name>/ フォルダに TODO.md / HISTORY.md を作成
	const agentFolder = path.join(agentsDir, config.name);
	await ensureAgentFolderFiles(agentFolder, config.name);

	// ruleFile は agents/<name>.md を指す（CLIが読む場所）
	const ruleFilePath = path.join(agentsDir, `${config.name}.md`);
	return [{ ...config, ruleFile: ruleFilePath }, description];
}

// スコープに応じた agents ディレクトリパスを取得
function getAgentsDir(scope?: 'global' | 'project'): string | undefined {
	if (scope === 'project') {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			return path.join(workspaceFolders[0].uri.fsPath, '.claude', 'agents');
		}
		return undefined;
	}
	return path.join(os.homedir(), '.claude', 'agents');
}

// 部署フォルダに TODO.md / HISTORY.md が存在しなければテンプレートを作成
export async function ensureAgentFolderFiles(agentFolder: string, agentName: string): Promise<void> {
	const todoPath = path.join(agentFolder, 'TODO.md');
	const historyPath = path.join(agentFolder, 'HISTORY.md');
	try {
		await fs.promises.access(todoPath);
	} catch {
		const todoTemplate = `# ${agentName} — TODO\n\n> 最終更新: ${new Date().toISOString()}\n\n## 未完了\n\n## 完了（直近10件）\n\n## 保留\n`;
		await fs.promises.writeFile(todoPath, todoTemplate, 'utf-8');
	}
	try {
		await fs.promises.access(historyPath);
	} catch {
		const historyTemplate = `# ${agentName} — 歴代セッション記録\n\n`;
		await fs.promises.writeFile(historyPath, historyTemplate, 'utf-8');
	}
}

// Extension Host分離設定追加
export async function addAffinitySettings(): Promise<void> {
	try {
		const settingsPath = path.join(
			process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
			'Code', 'User', 'settings.json'
		);
		let settings: Record<string, unknown> = {};
		try {
			const raw = await fs.promises.readFile(settingsPath, 'utf-8');
			settings = JSON.parse(raw);
		} catch {
			return;
		}
		const affinityKey = 'extensions.experimental.affinity';
		if (settings[affinityKey]) {
			return;
		}
		settings[affinityKey] = {
			'ratorin.claude-session-manager': 1,
			'anthropic.claude-code': 2,
		};
		await fs.promises.writeFile(settingsPath, JSON.stringify(settings, null, '\t'), 'utf-8');
		vscode.window.showInformationMessage(
			'Extension Host分離設定を追加しました。VS Code再起動後に反映されます。'
		);
	} catch {
		// settings.json書き込み失敗は無視（権限不足等）
	}
}

// 取締役専用ルール生成（prepareAgentRuleと同方式）
// 戻り値: [更新されたconfig, ルール本文]
export async function prepareDirectorRule(config: AgentConfig): Promise<[AgentConfig, string]> {
	const description = buildDirectorDescription(config);
	const agentsDir = getAgentsDir(config.scope);
	if (!agentsDir) { return [config, description]; }

	// agents/<name>/ フォルダに TODO.md / HISTORY.md を作成
	const agentFolder = path.join(agentsDir, config.name);
	await ensureAgentFolderFiles(agentFolder, config.name);

	const ruleFilePath = path.join(agentsDir, `${config.name}.md`);
	return [{ ...config, ruleFile: ruleFilePath }, description];
}

// 取締役用 description テキストを構築
export function buildDirectorDescription(config: AgentConfig): string {
	const safeName = sanitizeForYaml(config.name);
	const lines: string[] = [
		`あなたは${safeName}です。プロジェクト全体を統括する最上位のエージェントです。`,
		``,
		`## 行動規範`,
		`1. **方針決定** — ユーザーの指示を受けて実行方針を決定する`,
		`2. **指示起案** — 各部署（エージェント）への指示案を作成する`,
		`3. **承認取得** — 指示案をユーザーに提示し、承認を得てから実行する`,
		`4. **実行委任** — 実装作業は各部署のエージェントに委任する。自分ではコードを書かない`,
		`5. **結果確認** — 各部署からの報告を確認し、ユーザーに最終報告する`,
		``,
		`## 初期行動`,
		`- セッション開始時にMEMORY.md（自動メモリ）を読み込み、組織図・行動規範・プロジェクト情報を把握すること`,
		`- session-manager.json の agents 一覧を読み込み、配下のエージェント体制を把握すること`,
		`- 不明な情報はユーザーに確認してから行動すること`,
		``,
		`## エージェント操作`,
		`- 子エージェントの起動: \`claude --resume {sessionId} --append-system-prompt-file {ruleFile} --print\``,
		`- session-manager.json を読み込んで各エージェントの sessionId, ruleFile を取得すること`,
		`- session-manager.json のパス: \`~/.claude/session-manager.json\``,
		`- agents[] 配列に全エージェントの情報が格納されている`,
		``,
		`## 禁止事項`,
		`- 実装作業を自分で行わない（必ず担当部署に委任する）`,
		`- ユーザーの承認なく指示を出さない`,
		`- MEMORY.mdに部署一覧やエージェント情報を直接書き込まない（session-manager.jsonが唯一の情報源）`,
	];
	return lines.join('\n');
}
