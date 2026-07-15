// openInClaudeHelper.ts — v0.5.29
//
// 拡張 UI で「Claude で開く」（URI ハンドラ経由）を実行する際の共通ヘルパー。
//
// **背景**: v0.5.27 で `claudeManager.openAgentInClaude`（エージェント管理ツリー右クリック）
// に「対象フォルダが現ワークスペース外なら新しいウィンドウを開く」ロジックを入れたが、
// 他の入口（会話一覧の openInClaude / ライブ状態の未定義セッション / オーケストレーション /
// 組織図ノード / 会話ビューワーのヘッダ「▶ Claude で開く」ボタン等）は openExternal(uri) を
// 直接呼ぶだけで新ウィンドウ経路を通らなかった。v0.5.29 で 全経路を本ヘルパー経由に統一。
//
// **CLI 起動系（`claude --resume`）は対象外**。あちらはターミナル起動なので新ウィンドウ概念が無い。
// 本ヘルパーは「URI で拡張を開く」経路にのみ適用する。

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { translateWorkDirPath } from '../utils/agentUtils';
import {
	resolveOpenInClaudeTargetFolder,
	needsNewWindowForClaudeOpen,
	isFolderInAnyWorkspace,
} from '../utils/pathUtils';

/** 呼び出し側から渡せる文脈情報 */
export interface OpenInClaudeOptions {
	/** 開くセッション ID（必須） */
	sessionId: string;
	/**
	 * エージェント登録上の workDir（agent.workDir 等）を明示的に渡す場合に指定。
	 * 未指定 or 空文字なら sessionCwd（JSONL 先頭から取得）にフォールバック。
	 */
	workDir?: string;
	/**
	 * 事前に sessionCwd が分かっている場合の直渡し（例: OrchestrationSession.cwd）。
	 * 未指定なら本ヘルパーが `~/.claude/projects/<slug>/<sid>.jsonl` の先頭 16KB を走査して取得する。
	 */
	sessionCwd?: string;
}

/**
 * 指定セッションを Claude Code 拡張の URI ハンドラで開く。
 * 対象フォルダ（sessionCwd or workDir）が現ワークスペース群に包含されていなければ
 * 新しい VS Code ウィンドウを開いた後にセッション URI をベストエフォートで投げる。
 *
 * 挙動は v0.5.27 の openAgentInClaude と同じ:
 *   1) 対象フォルダを決定（sessionCwd 優先 → workDir フォールバック）
 *   2) `needsNewWindowForClaudeOpen` で新ウィンドウ要否を判定
 *   3) 必要なら案内メッセージ → vscode.openFolder(forceNewWindow) → 1500ms 遅延で URI 送信
 *   4) 不要なら（設定 OFF + 不一致の場合のみ）警告メッセージ → URI 送信
 */
export async function openSessionInClaudeSmart(opts: OpenInClaudeOptions): Promise<void> {
	const sid = opts.sessionId;
	if (!sid) {
		vscode.window.showWarningMessage('セッション ID がありません');
		return;
	}

	// 1) sessionCwd 解決（呼び出し側が既に渡していれば skip、なければ JSONL から取得）
	const sessionCwd = opts.sessionCwd ?? await resolveSessionCwd(sid);

	// 2) 対象フォルダ決定 + 新ウィンドウ要否判定
	const wsFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
	const targetFolder = resolveOpenInClaudeTargetFolder(sessionCwd, opts.workDir);
	const allowNewWindow = vscode.workspace
		.getConfiguration('claudeManager')
		.get<boolean>('agent.openInNewWindowWhenFolderMismatch', true);
	const needsNew = needsNewWindowForClaudeOpen(targetFolder, wsFolders, allowNewWindow);

	const scheme = vscode.env.uriScheme;
	const uri = vscode.Uri.parse(
		`${scheme}://anthropic.claude-code/open?session=` + encodeURIComponent(sid),
	);

	if (needsNew) {
		const resolved = translateWorkDirPath(targetFolder);
		vscode.window.showInformationMessage(
			`「${targetFolder}」を新しいウィンドウで開きます。開いた先で自動的にセッションが復元されない場合は、` +
			`CSM から再度「Claude で開く」を押してください。`,
		);
		try {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(resolved), { forceNewWindow: true });
		} catch (err) {
			vscode.window.showWarningMessage(
				`新しいウィンドウを開けませんでした（${String(err)}）。URI ハンドラのみで開きます。`,
			);
		}
		// URI は新ウィンドウ側の CC 拡張起動後に届くのが理想。タイミング依存のため 1500ms 遅延で送る。
		//   届かなくてもユーザーは案内メッセージにより再度「Claude で開く」を押せば復元できる。
		setTimeout(() => { void vscode.env.openExternal(uri); }, 1500);
		return;
	}

	// v0.5.28 レビュー修正 (HIGH-1) 準拠: 設定 OFF + フォルダ不一致時に警告を出す。
	//   condition: !allowNewWindow && targetFolder && wsFolders.length>0 && !isFolderInAnyWorkspace(...)
	if (!allowNewWindow
		&& targetFolder
		&& wsFolders.length > 0
		&& !isFolderInAnyWorkspace(targetFolder, wsFolders)) {
		vscode.window.showInformationMessage(
			`このセッションは別フォルダ (${targetFolder}) で作成されています。` +
			`Claude Code 拡張側で新しいウィンドウが開く場合があります。` +
			`（設定 claudeManager.agent.openInNewWindowWhenFolderMismatch を有効にすると自動で新ウィンドウを起動できます）`,
		);
	}
	void vscode.env.openExternal(uri);
}

/**
 * `~/.claude/projects/<slug>/<sid>.jsonl` の先頭 16KB を走査し、最初の `cwd` フィールドを取り出す。
 * v0.5.27 で `openAgentInClaude` にインラインで書かれていた処理を関数化（重複排除）。
 *
 * 見つからないケース（他プロジェクト由来 / JSONL 未生成 / IO エラー）は undefined を返す。
 */
export async function resolveSessionCwd(sessionId: string): Promise<string | undefined> {
	const projectsDir = path.join(os.homedir(), '.claude', 'projects');
	try {
		const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) { continue; }
			const jsonlPath = path.join(projectsDir, e.name, `${sessionId}.jsonl`);
			try {
				await fs.promises.access(jsonlPath);
				const handle = await fs.promises.open(jsonlPath, 'r');
				try {
					const buf = Buffer.alloc(16 * 1024);
					await handle.read(buf, 0, 16 * 1024, 0);
					const lines = buf.toString('utf-8').split('\n');
					for (const line of lines) {
						if (!line.trim()) { continue; }
						try {
							const entry = JSON.parse(line);
							if (entry.cwd) { return String(entry.cwd); }
						} catch { /* 壊れた行はスキップ */ }
					}
				} finally { await handle.close(); }
			} catch { /* jsonl 無し → 次の projects/ サブディレクトリへ */ }
		}
	} catch { /* projects ディレクトリなし → undefined */ }
	return undefined;
}
