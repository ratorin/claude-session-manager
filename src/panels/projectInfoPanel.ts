/**
 * projectInfoPanel.ts — v0.5.0 プロジェクト情報パネル
 *
 * sidebar 最下部の WebView。現在ワークスペースに関する情報を表示:
 *   - 📁 プロジェクト名 & パス
 *   - 👤 配下エージェント数（動作中数付き）、上位 5 体リスト
 *   - 💬 紐づきセッション数
 *   - 🧠 メモリ数
 *   - 🌿 git ブランチ名
 *   - ⏱ 最終 commit 時刻（相対表示）
 *
 * Extension 側が 30 秒ごとにデータを収集し postMessage でプッシュする。
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as dataStore from '../models/dataStore';
import { getSessionFileInfos } from '../utils/sessionLoader';
import { loadMemoryFiles } from '../utils/memoryManager';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export interface AgentSummary {
	name: string;
	displayName: string;
	sessionId: string;
	isRunning: boolean;
}

export interface ProjectInfoData {
	projectName: string;
	projectPath: string;
	totalAgents: number;
	runningAgents: number;
	topAgents: AgentSummary[];
	sessionCount: number;
	memoryCount: number;
	gitBranch: string;
	lastCommitRel: string;
	lastCommitMessage: string;
	fetchedAt: number;
}

type PanelMessage =
	| { type: 'refresh' }
	| { type: 'openAgent'; sessionId: string }
	| { type: 'openOrgChart' };

// -------------------------------------------------------------------
// ユーティリティ
// -------------------------------------------------------------------

function timeAgo(date: Date): string {
	const sec = Math.floor((Date.now() - date.getTime()) / 1000);
	if (sec < 60)  { return `${sec}秒前`; }
	const min = Math.floor(sec / 60);
	if (min < 60)  { return `${min}分前`; }
	const hour = Math.floor(min / 60);
	if (hour < 24) { return `${hour}時間前`; }
	return `${Math.floor(hour / 24)}日前`;
}

function execGit(cmd: string, cwd: string): Promise<string> {
	return new Promise((resolve) => {
		cp.exec(cmd, { cwd, timeout: 5000 }, (err, stdout) => {
			resolve(err ? '' : stdout.trim());
		});
	});
}

// -------------------------------------------------------------------
// ProjectInfoPanel — WebviewViewProvider 実装
// -------------------------------------------------------------------

export class ProjectInfoPanel implements vscode.WebviewViewProvider, vscode.Disposable {
	public static readonly viewType = 'claudeProjectInfo';

	private _view?: vscode.WebviewView;
	private _refreshTimer?: ReturnType<typeof setInterval>;
	private _getLiveIds: () => Set<string>;

	constructor(getLiveIds: () => Set<string>) {
		this._getLiveIds = getLiveIds;
	}

	// ----------------------------------------------------------------
	// resolveWebviewView
	// ----------------------------------------------------------------

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.resolveHtml();

		webviewView.webview.onDidReceiveMessage((msg: PanelMessage) => {
			if (msg.type === 'refresh') {
				void this._fetchAndPush();
			} else if (msg.type === 'openAgent') {
				void vscode.commands.executeCommand('claudeManager.openAgentSession', msg.sessionId);
			} else if (msg.type === 'openOrgChart') {
				void vscode.commands.executeCommand('claudeManager.openOrgChart');
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				// retainContextWhenHidden が無効の場合に備えて HTML を再設定
				if (!webviewView.webview.html) {
					webviewView.webview.html = this.resolveHtml();
				}
				void this._fetchAndPush();
			}
		});

		// 初回データ取得
		void this._fetchAndPush();

		// 30 秒ごとに定期更新
		this._refreshTimer = setInterval(() => {
			if (this._view?.visible) {
				void this._fetchAndPush();
			}
		}, 30000);
	}

	/** エージェント状態変化時に外部から呼ぶ */
	public refresh(): void {
		if (this._view?.visible) {
			void this._fetchAndPush();
		}
	}

	// ----------------------------------------------------------------
	// データ収集 & プッシュ
	// ----------------------------------------------------------------

	private async _fetchAndPush(): Promise<void> {
		try {
			const data = await this._collectData();
			if (this._view?.visible) {
				void this._view.webview.postMessage({ type: 'data', data });
			}
		} catch {
			// データ取得失敗は無視（次回リトライ）
		}
	}

	private async _collectData(): Promise<ProjectInfoData> {
		const wsFolder = vscode.workspace.workspaceFolders?.[0];
		const projectPath = wsFolder?.uri.fsPath ?? '';
		const projectName = wsFolder?.name ?? '—';

		// エージェント一覧
		const agents = await dataStore.getAgents();
		const liveIds = this._getLiveIds();
		const activeAgents = agents.filter(a => a.status !== 'archived');

		const topAgents: AgentSummary[] = activeAgents.slice(0, 5).map(a => ({
			name: a.name,
			displayName: a.displayName ?? a.name,
			sessionId: a.sessionId,
			isRunning: liveIds.has(a.sessionId),
		}));
		const runningCount = activeAgents.filter(a => liveIds.has(a.sessionId)).length;

		// セッション数（軽量取得）
		let sessionCount = 0;
		try {
			const infos = await getSessionFileInfos();
			sessionCount = infos.length;
		} catch { /* ignore */ }

		// メモリ数
		let memoryCount = 0;
		try {
			const memDirs = await loadMemoryFiles();
			memoryCount = memDirs.reduce((s, d) => s + d.files.length, 0);
		} catch { /* ignore */ }

		// git 情報
		let gitBranch = '—';
		let lastCommitRel = '—';
		let lastCommitMessage = '';
		if (projectPath) {
			const [branchOut, logOut] = await Promise.all([
				execGit('git rev-parse --abbrev-ref HEAD', projectPath),
				execGit('git log -1 --format=%ci%n%s', projectPath),
			]);
			if (branchOut) { gitBranch = branchOut; }
			if (logOut) {
				const lines = logOut.split('\n');
				if (lines[0]) {
					try {
						lastCommitRel = timeAgo(new Date(lines[0]));
					} catch { /* ignore */ }
				}
				lastCommitMessage = lines[1] ?? '';
			}
		}

		return {
			projectName,
			projectPath,
			totalAgents: activeAgents.length,
			runningAgents: runningCount,
			topAgents,
			sessionCount,
			memoryCount,
			gitBranch,
			lastCommitRel,
			lastCommitMessage,
			fetchedAt: Date.now(),
		};
	}

	// ----------------------------------------------------------------
	// HTML 生成
	// ----------------------------------------------------------------

	public resolveHtml(): string {
		return /* html */`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--vscode-sideBar-background, #252526);
    color: var(--vscode-foreground, #cccccc);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 12px);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    user-select: none;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .project-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground, #cccccc);
    display: flex;
    align-items: center;
    gap: 5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-path {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #858585);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .divider {
    height: 1px;
    background: var(--vscode-panel-border, #2d2d2d);
    opacity: 0.5;
  }
  .stat-row {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--vscode-descriptionForeground, #858585);
    font-size: 11px;
    line-height: 1.4;
  }
  .stat-row .label { flex: 1; }
  .stat-row .value {
    color: var(--vscode-foreground, #cccccc);
    font-weight: 500;
  }
  .badge-running {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    color: #4ec9b0;
    opacity: 0.9;
  }
  .agents-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-left: 16px;
    margin-top: 2px;
  }
  .agent-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #858585);
    cursor: pointer;
    padding: 1px 2px;
    border-radius: 3px;
    transition: background 0.1s;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .agent-item:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.07));
  }
  .running-dot { color: #4ec9b0; }
  .idle-dot { color: var(--vscode-descriptionForeground); opacity: 0.4; }
  .git-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .git-branch {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  .commit-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 2px;
  }
  .action-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 3px 6px;
    background: transparent;
    border: 1px solid var(--vscode-button-border, var(--vscode-panel-border, #2d2d2d));
    border-radius: 3px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 10px;
    font-family: inherit;
    transition: background 0.1s, color 0.1s;
  }
  .action-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }
  .loading { color: var(--vscode-descriptionForeground); font-size: 11px; padding: 8px 0; }
</style>
</head>
<body>
<div class="loading" id="loading">読み込み中...</div>
<div id="content" style="display:none; flex-direction:column; gap:8px;">
  <div class="section">
    <div class="project-name">📁 <span id="projectName">—</span></div>
    <div class="project-path" id="projectPath" title=""></div>
  </div>
  <div class="divider"></div>
  <div class="section">
    <div class="stat-row">
      <span class="label">👤 エージェント</span>
      <span class="value" id="agentCount">—</span>
    </div>
    <div class="agents-list" id="agentsList"></div>
  </div>
  <div class="divider"></div>
  <div class="section">
    <div class="stat-row">
      <span class="label">💬 セッション</span>
      <span class="value" id="sessionCount">—</span>
    </div>
    <div class="stat-row">
      <span class="label">🧠 メモリ</span>
      <span class="value" id="memoryCount">—</span>
    </div>
  </div>
  <div class="divider"></div>
  <div class="section git-info">
    <div class="git-branch">🌿 <span id="gitBranch">—</span></div>
    <div class="commit-time" id="commitTime"></div>
  </div>
  <div class="actions">
    <button class="action-btn" id="btnOrgChart">🌐 組織図</button>
    <button class="action-btn" id="btnRefresh">🔄 更新</button>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();

  document.getElementById('btnRefresh').addEventListener('click', function() {
    vscode.postMessage({ type: 'refresh' });
  });
  document.getElementById('btnOrgChart').addEventListener('click', function() {
    vscode.postMessage({ type: 'openOrgChart' });
  });

  window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (msg.type !== 'data') { return; }
    const d = msg.data;

    document.getElementById('loading').style.display = 'none';
    const content = document.getElementById('content');
    content.style.display = 'flex';

    document.getElementById('projectName').textContent = d.projectName || '—';
    const pathEl = document.getElementById('projectPath');
    pathEl.textContent = d.projectPath || '';
    pathEl.title = d.projectPath || '';

    // エージェント数
    const runningBadge = d.runningAgents > 0
      ? ' <span class="badge-running">🟢 ' + d.runningAgents + ' 動作中</span>'
      : '';
    document.getElementById('agentCount').innerHTML = d.totalAgents + ' 体' + runningBadge;

    // エージェント一覧
    const list = document.getElementById('agentsList');
    list.innerHTML = d.topAgents.map(function(a) {
      return '<div class="agent-item" data-session="' + escHtml(a.sessionId) + '">' +
        '<span class="' + (a.isRunning ? 'running-dot' : 'idle-dot') + '">●</span>' +
        '<span>' + escHtml(a.displayName) + '</span>' +
        '</div>';
    }).join('');
    list.querySelectorAll('.agent-item').forEach(function(el) {
      el.addEventListener('click', function() {
        vscode.postMessage({ type: 'openAgent', sessionId: el.dataset.session });
      });
    });

    document.getElementById('sessionCount').textContent = d.sessionCount + ' 件';
    document.getElementById('memoryCount').textContent = d.memoryCount + ' 件';
    document.getElementById('gitBranch').textContent = d.gitBranch || '—';

    const commitParts = [d.lastCommitRel];
    if (d.lastCommitMessage) { commitParts.push(d.lastCommitMessage.substring(0, 50)); }
    document.getElementById('commitTime').textContent = commitParts.filter(Boolean).join(' — ');
  });

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
</script>
</body>
</html>`;
	}

	// ----------------------------------------------------------------
	// Dispose
	// ----------------------------------------------------------------

	public dispose(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = undefined;
		}
	}
}
