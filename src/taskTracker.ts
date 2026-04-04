// タスク状態管理 — AgentWatcher のイベントに便乗して状態を評価する
import * as vscode from 'vscode';
import { TaskLog, TaskStatus } from './types';
import * as dataStore from './dataStore';
import { AgentWatcher } from './agentWatcher';

export class TaskTracker implements vscode.Disposable {
	// 状態変更イベント（UIリフレッシュ用）
	private _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	// エージェント名 → タスクログのインデックス（getChildren高速化）
	private agentTaskIndex = new Map<string, TaskLog[]>();

	private agentWatcher: AgentWatcher;

	constructor(agentWatcher: AgentWatcher) {
		this.agentWatcher = agentWatcher;
	}

	// AgentWatcher.onDidChange から呼ばれるメイン評価ロジック
	async evaluate(): Promise<void> {
		const logs = await dataStore.getTaskLogs();
		if (logs.length === 0) { return; }

		const config = vscode.workspace.getConfiguration('claudeManager');
		const stalledThreshold = Math.max(10, config.get<number>('taskStalledThreshold', 60)) * 1000;

		// 変更があったログのバッチ更新用リスト
		const batchUpdates: { id: string; changes: Partial<TaskLog> }[] = [];

		for (const log of logs) {
			if (log.status === 'completed' || log.status === 'error') { continue; }

			const prevStatus = log.status;
			const isLive = this.agentWatcher.isLive(log.sessionId);
			const mtime = this.agentWatcher.getSessionMtime(log.sessionId);

			let newStatus: TaskStatus = log.status;
			let completedAt: number | undefined = log.completedAt;

			if (isLive) {
				// PID生存
				if (mtime !== undefined) {
					const elapsed = Date.now() - mtime;
					newStatus = elapsed > stalledThreshold ? 'stalled' : 'running';
				} else {
					newStatus = 'running';
				}
			} else if (log.status === 'running' || log.status === 'stalled') {
				// PID消失 → 完了
				newStatus = 'completed';
				completedAt = Date.now();
			}
			// pending のままPIDがない → そのままpending

			if (newStatus !== prevStatus) {
				log.status = newStatus;
				log.completedAt = completedAt;
				batchUpdates.push({
					id: log.id,
					changes: { status: newStatus, completedAt },
				});
			}
		}

		// バッチ保存（1回のみ）
		if (batchUpdates.length > 0) {
			await dataStore.batchUpdateTaskLogs(batchUpdates);
			this._onDidChange.fire();
		}

		// インデックス再構築
		this.rebuildIndex(logs);
	}

	// エージェント名でタスクログを取得（getChildren用）
	getTasksForAgent(agentName: string): TaskLog[] {
		return this.agentTaskIndex.get(agentName) || [];
	}

	// 表示対象のタスクログを取得（pending/running/stalled + 直近1時間の completed/error）
	getVisibleTasksForAgent(agentName: string): TaskLog[] {
		const tasks = this.getTasksForAgent(agentName);
		const oneHourAgo = Date.now() - 60 * 60 * 1000;
		return tasks.filter(t => {
			if (t.status === 'pending' || t.status === 'running' || t.status === 'stalled') {
				return true;
			}
			// completed/error は1時間以内のみ表示
			return (t.completedAt || t.createdAt) > oneHourAgo;
		});
	}

	// 通知処理
	notify(logs: TaskLog[]): void {
		const config = vscode.workspace.getConfiguration('claudeManager');
		if (!config.get<boolean>('enableNotifications', true)) { return; }

		const now = Date.now();
		const NOTIFY_INTERVAL = 60_000; // 60秒間隔制限（フラッピング防止）

		for (const log of logs) {
			// 既に同じ状態で通知済み + 60秒以内ならスキップ
			if (
				log.notifiedStatus === log.status &&
				log.lastNotifiedAt !== undefined &&
				(now - log.lastNotifiedAt) < NOTIFY_INTERVAL
			) {
				continue;
			}

			let message: string | undefined;
			let isWarning = false;

			if (log.status === 'completed' && log.notifiedStatus !== 'completed') {
				message = `${log.agentName}: タスク完了 — ${log.summary}`;
			} else if (log.status === 'error' && log.notifiedStatus !== 'error') {
				message = `${log.agentName}: エラー検出 — PID異常終了`;
				isWarning = true;
			} else if (log.status === 'stalled' && log.notifiedStatus !== 'stalled') {
				message = `${log.agentName}: 応答停止 — ${log.summary}`;
				isWarning = true;
			}

			if (message) {
				if (isWarning) {
					vscode.window.showWarningMessage(message, 'セッションを開く').then(action => {
						if (action === 'セッションを開く') {
							vscode.commands.executeCommand('claudeManager.openAgentSession', log);
						}
					});
				} else {
					vscode.window.showInformationMessage(message, '出力を開く', 'セッションを開く').then(action => {
						if (action === '出力を開く' && log.outputFile) {
							vscode.workspace.openTextDocument(log.outputFile).then(doc => {
								vscode.window.showTextDocument(doc);
							});
						} else if (action === 'セッションを開く') {
							vscode.commands.executeCommand('claudeManager.openAgentSession', log);
						}
					});
				}

				// 通知状態を更新
				dataStore.updateTaskLog(log.id, {
					notifiedStatus: log.status,
					lastNotifiedAt: now,
				});
			}
		}
	}

	// 監視OFF切替時のリセット（H-4対応）
	async resetOnMonitorDisabled(): Promise<void> {
		const logs = await dataStore.getTaskLogs();
		let changed = false;
		for (const log of logs) {
			if (log.status === 'running' || log.status === 'stalled') {
				await dataStore.updateTaskLog(log.id, { status: 'pending' });
				changed = true;
			}
		}
		if (changed) {
			vscode.window.showInformationMessage(
				'エージェント監視がOFFになりました。進行中のタスクは手動で完了にしてください。'
			);
			this._onDidChange.fire();
		}
	}

	private rebuildIndex(logs: TaskLog[]): void {
		this.agentTaskIndex.clear();
		for (const log of logs) {
			const existing = this.agentTaskIndex.get(log.agentName) || [];
			existing.push(log);
			this.agentTaskIndex.set(log.agentName, existing);
		}
	}

	dispose(): void {
		this._onDidChange.dispose();
	}
}
