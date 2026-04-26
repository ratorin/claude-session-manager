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
