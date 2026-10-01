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
import { sessionFileExists, readLaunchCwd } from '../utils/sessionLoader';
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
	 * 本ヘルパーは `~/.claude/projects/<slug>/<sid>.jsonl` から得た起動時 cwd を優先し、
	 * JSONL が見つからないときだけこの値を使う（v0.6.3）。
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

	// v0.5.32: リンク切れ（JSONL が実在しない）なら空ウィンドウを開かず明示的に通知する。
	//   sessionCwd 事前渡し（Orchestration 等、CSV 由来で JSONL 未走査）のケースは実在チェックを省く。
	if (opts.sessionCwd === undefined && !(await sessionFileExists(sid))) {
		vscode.window.showWarningMessage(
			`セッション（${sid.substring(0, 8)}...）の JSONL が見つかりません（リンク切れ）。` +
			`エージェント一覧では該当エージェントを右クリックして再紐づけ／解除できます。`,
		);
		return;
	}

	// 1) sessionCwd 解決。JSONL 先頭の cwd（= 起動時の cwd）を正とする。
	//   v0.6.3: 呼び出し側の sessionCwd はセッション中に cd した先のことがあり、そのフォルダで
	//   新ウィンドウを開くと Claude Code 側がセッションを見つけられない。
	//   JSONL が無いとき（Orchestration 等の CSV 由来）だけ渡された値を採用する。
	const sessionCwd = (await resolveSessionCwd(sid)) ?? opts.sessionCwd;

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
 * `~/.claude/projects/<slug>/<sid>.jsonl` から起動時の `cwd`（最初に cwd を持つ行の値）を取り出す。
 * v0.5.27 で `openAgentInClaude` にインラインで書かれていた処理を関数化（重複排除）。
 * v0.6.3: 先頭 16KB 固定読みをやめ、行単位で読む readLaunchCwd に委譲（先頭に巨大な行があると取りこぼしていた）。
 *
 * 見つからないケース（他プロジェクト由来 / JSONL 未生成 / IO エラー）は undefined を返す。
 */
export async function resolveSessionCwd(sessionId: string): Promise<string | undefined> {
	const projectsDir = path.join(os.homedir(), '.claude', 'projects');
	try {
		const entries = await fs.promises.readdir(projectsDir, { withFileTypes: true });
		for (const e of entries) {
			if (!e.isDirectory()) { continue; }
			// jsonl 無し・cwd 行無しは undefined → 次の projects/ サブディレクトリへ
			const cwd = await readLaunchCwd(path.join(projectsDir, e.name, `${sessionId}.jsonl`));
			if (cwd) { return cwd; }
		}
	} catch { /* projects ディレクトリなし → undefined */ }
	return undefined;
}
