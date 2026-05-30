import * as vscode from 'vscode';
import { AgentConfig } from '../models/types';
import { isContainedIn, normalize } from './pathUtils';

// CLI コマンドの構造体
export interface CliCommand {
	command: string;       // 完全なコマンド文字列
	parts: string[];       // コマンドの各パーツ
	env: Record<string, string>; // 環境変数
}

// モデル名からフロントマターに書き込むエイリアスへのマッピング
// 案A: 具体的なモデルIDではなくエイリアスを書き込む。
// Claude Code が起動時に最新モデルへ解決するため、リリース毎の更新が不要。
// 例: 'opus' → フロントマターに 'opus' → CC が claude-opus-4-8 等へ解決
export const modelCliMap: Record<string, string> = {
	'opus': 'opus',
	'sonnet': 'sonnet',
	'sonnet-1m': 'sonnet[1m]',
	'haiku': 'haiku',
};

// AgentConfig から CLI コマンドを組み立てる
// --agent でフロントマター（model, effort等）が自動適用されるため個別指定は不要
export function buildCommand(config: AgentConfig): CliCommand {
	const env: Record<string, string> = {};
	const parts: string[] = ['claude'];

	// --agent（agents/<name>.mdのフロントマターからmodel/effort等を自動読み込み）
	parts.push('--agent', config.name);

	// セッションID（fixed モードのみ）
	// v2.1.101+: sessionId がない場合は --resume <name> によるエージェント名でのセッション再開を試みる
	// Claude Code がエージェント名に対応するセッションを検索する
	if (config.sessionMode !== 'disposable') {
		if (config.sessionId) {
			// sessionId が既知の場合: 正確なセッションを指定（推奨）
			parts.push('--resume', config.sessionId);
		} else if (config.useNameResume && config.name) {
			// sessionId 未設定で useNameResume フラグがある場合: 名前ベース再開（Claude Code v2.1.101+）
			// CSM の sessionId 管理と独立したフォールバック
			parts.push('--resume', config.name);
		}
	}

	// allowedTools → スペース区切りで複数引数
	// spawnモードではシェルを介さないためクォート不要
	if (config.allowedTools && config.allowedTools.length > 0) {
		parts.push('--allowedTools');
		for (const tool of config.allowedTools) {
			parts.push(tool);
		}
	}

	// workDir → --add-dir（--cwd は存在しない）
	if (config.workDir) {
		parts.push('--add-dir', config.workDir);
	}

	// 非対話モード
	parts.push('--print');

	// 環境変数プレフィックス付きコマンド文字列を生成
	const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
	const command = envPrefix ? `${envPrefix} ${parts.join(' ')}` : parts.join(' ');

	return { command, parts, env };
}

// 人間可読なフォーマット済みコマンド文字列を生成（バックスラッシュ改行付き）
export function buildCommandFormatted(config: AgentConfig): string {
	const { parts, env } = buildCommand(config);
	const lines: string[] = [];

	// 環境変数プレフィックス
	for (const [k, v] of Object.entries(env)) {
		lines.push(`${k}=${v} \\`);
	}

	// --print を除外（表示用は対話前提）
	const displayParts = parts.filter(p => p !== '--print');
	lines.push(displayParts.join(' \\\n  '));

	return lines.join('\n');
}

// child_process.spawn 用のオプションを生成
export function buildSpawnOptions(config: AgentConfig): {
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
} {
	const { parts, env } = buildCommand(config);
	return {
		command: parts[0],
		args: parts.slice(1),
		env,
		cwd: config.workDir || undefined,
	};
}

// -------------------------------------------------------------------
// T3.20 — workDir 互換性チェック (F7)
// -------------------------------------------------------------------

/**
 * workDir が現在の VS Code ワークスペースと互換性があるか判定する。
 *
 * 新仕様: isContainedIn(workspace, workDir) または isContainedIn(workDir, workspace) のどちらかが真
 * （= workDir が workspace 配下 or workspace が workDir 配下）
 *
 * `claudeManager.askAgent.allowAnyWorkDir: true` の場合は常に true。
 *
 * @param workDir  チェック対象の作業ディレクトリ（展開済み絶対パス）
 * @returns { allowed: boolean; reason?: string }
 */
export function isWorkDirCompatible(workDir: string): { allowed: boolean; reason?: string } {
    const cfg = vscode.workspace.getConfiguration('claudeManager');
    if (cfg.get<boolean>('askAgent.allowAnyWorkDir', false)) {
        return { allowed: true };
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        // ワークスペースが開かれていない場合は許可（制限なし）
        return { allowed: true };
    }

    const normWorkDir = normalize(workDir);
    for (const folder of folders) {
        const normWorkspace = normalize(folder.uri.fsPath);
        if (isContainedIn(normWorkDir, normWorkspace) || isContainedIn(normWorkspace, normWorkDir)) {
            return { allowed: true };
        }
    }

    const workspacePaths = folders.map(f => f.uri.fsPath).join(', ');
    return {
        allowed: false,
        reason: `workDir(${workDir}) is outside workspace(${workspacePaths}). Set claudeManager.askAgent.allowAnyWorkDir=true to disable check.`,
    };
}
