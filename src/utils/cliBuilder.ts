import { AgentConfig } from '../models/types';

// CLI コマンドの構造体
export interface CliCommand {
	command: string;       // 完全なコマンド文字列
	parts: string[];       // コマンドの各パーツ
	env: Record<string, string>; // 環境変数
}

// モデル名から CLI に渡す正式モデルIDへのマッピング
export const modelCliMap: Record<string, string> = {
	'opus': 'claude-opus-4-6',
	'sonnet': 'claude-sonnet-4-6',
	'sonnet-1m': 'claude-sonnet-4-6[1m]',
	'haiku': 'claude-haiku-4-5',
};

// AgentConfig から CLI コマンドを組み立てる
export function buildCommand(config: AgentConfig): CliCommand {
	const env: Record<string, string> = {};
	const parts: string[] = ['claude'];

	// セッションID（fixed モードのみ）
	if (config.sessionId && config.sessionMode !== 'disposable') {
		parts.push('--resume', config.sessionId);
	}

	// モデル（必須）。短縮名を正式モデルIDにマッピングして渡す
	parts.push('--model', modelCliMap[config.model] || config.model);

	// Effort（設定時のみ。max は Opus のみだが、バリデーションは呼び出し側）
	if (config.effort) {
		parts.push('--effort', config.effort);
	}

	// ルールファイル → --append-system-prompt-file
	if (config.ruleFile) {
		parts.push('--append-system-prompt-file', config.ruleFile);
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
