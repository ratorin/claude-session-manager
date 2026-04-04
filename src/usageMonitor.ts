import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as vscode from 'vscode';

// 利用率データ
export interface UsageData {
	usage5h: number;   // 5時間利用率（%）
	usage7d: number;   // 7日利用率（%）
	reset5h: number;   // 5時間リセット時刻（Unix秒）
	reset7d: number;   // 7日リセット時刻（Unix秒）
	fetchedAt: number; // 取得時刻（ms）
}

// credentials.json からアクセストークンを取得
async function getAccessToken(): Promise<string | null> {
	const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
	try {
		const raw = await fs.promises.readFile(credPath, 'utf-8');
		const data = JSON.parse(raw);
		return data?.claudeAiOauth?.accessToken || null;
	} catch {
		return null;
	}
}

// APIレスポンスの詳細（デバッグ用）
interface FetchResult {
	data: UsageData | null;
	statusCode?: number;
	errorDetail?: string;
}

// OutputChannel（デバッグ情報出力用）
let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('CSM Usage Monitor');
	}
	return outputChannel;
}

// APIリクエストで利用率ヘッダを取得
function fetchUsageHeaders(accessToken: string): Promise<FetchResult> {
	return new Promise((resolve) => {
		const body = JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: 1,
			messages: [{ role: 'user', content: '.' }],
		});

		const options: https.RequestOptions = {
			hostname: 'api.anthropic.com',
			port: 443,
			path: '/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
				'anthropic-beta': 'oauth-2025-04-20',
				'Authorization': `Bearer ${accessToken}`,
				'Content-Length': Buffer.byteLength(body),
			},
			timeout: 15000,
		};

		const log = getOutputChannel();

		const req = https.request(options, (res) => {
			const chunks: string[] = [];
			res.on('data', (chunk) => { chunks.push(chunk.toString()); });
			res.on('end', () => {
				const statusCode = res.statusCode || 0;
				log.appendLine(`[${new Date().toISOString()}] HTTP ${statusCode}`);

				// レスポンスヘッダーのキー一覧をログ出力（ratelimitヘッダー有無の確認用）
				const ratelimitHeaders = Object.keys(res.headers).filter(h => h.includes('ratelimit'));
				log.appendLine(`  ratelimit headers: ${ratelimitHeaders.length > 0 ? ratelimitHeaders.join(', ') : '(none)'}`);

				// ステータスコードが200以外はエラー
				if (statusCode !== 200) {
					const responseBody = chunks.join('').substring(0, 500);
					log.appendLine(`  error body: ${responseBody}`);

					let errorDetail = `HTTP ${statusCode}`;
					if (statusCode === 401) {
						errorDetail = 'HTTP 401: トークン期限切れの可能性。Claude Codeを一度起動してOAuth再認証してください';
					} else if (statusCode === 403) {
						errorDetail = 'HTTP 403: アクセス拒否';
					} else if (statusCode === 429) {
						errorDetail = 'HTTP 429: レート制限';
					}

					resolve({ data: null, statusCode, errorDetail });
					return;
				}

				const headers = res.headers;
				const usage5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization'] as string);
				const usage7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization'] as string);
				const reset5h = parseFloat(headers['anthropic-ratelimit-unified-5h-reset'] as string);
				const reset7d = parseFloat(headers['anthropic-ratelimit-unified-7d-reset'] as string);

				log.appendLine(`  5h: ${usage5h}%, 7d: ${usage7d}%`);

				if (isNaN(usage5h) && isNaN(usage7d)) {
					resolve({ data: null, statusCode, errorDetail: 'レスポンスヘッダーに利用率情報なし' });
					return;
				}

				resolve({
					data: {
						usage5h: isNaN(usage5h) ? 0 : usage5h,
						usage7d: isNaN(usage7d) ? 0 : usage7d,
						reset5h: isNaN(reset5h) ? 0 : reset5h,
						reset7d: isNaN(reset7d) ? 0 : reset7d,
						fetchedAt: Date.now(),
					},
					statusCode,
				});
			});
		});

		req.on('error', (err) => {
			log.appendLine(`[${new Date().toISOString()}] Network error: ${err.message}`);
			resolve({ data: null, errorDetail: `ネットワークエラー: ${err.message}` });
		});
		req.on('timeout', () => {
			log.appendLine(`[${new Date().toISOString()}] Request timeout`);
			req.destroy();
			resolve({ data: null, errorDetail: 'タイムアウト (15秒)' });
		});
		req.write(body);
		req.end();
	});
}

// リセットまでの残り時間を人間が読める形式に変換
function formatTimeRemaining(resetUnixSec: number): string {
	if (!resetUnixSec) { return '?'; }
	const nowSec = Date.now() / 1000;
	const diffSec = Math.max(0, resetUnixSec - nowSec);
	const days = Math.floor(diffSec / 86400);
	const hours = Math.floor((diffSec % 86400) / 3600);
	const minutes = Math.floor((diffSec % 3600) / 60);

	if (days > 0) {
		return `${days}d${hours}h`;
	}
	if (hours > 0) {
		const m = minutes > 0 ? `.${Math.floor(minutes / 6)}` : '';
		return `${hours}${m}h`;
	}
	return `${minutes}m`;
}

// 利用率の表示テキストを生成
export function formatUsageText(data: UsageData): string {
	const r5h = formatTimeRemaining(data.reset5h);
	const r7d = formatTimeRemaining(data.reset7d);
	return `${data.usage5h}% ${r5h} / ${data.usage7d}% ${r7d}`;
}

// 利用率監視クラス
export class UsageMonitor implements vscode.Disposable {
	private timer: ReturnType<typeof setInterval> | undefined;
	private statusBarItem: vscode.StatusBarItem;
	private lastData: UsageData | null = null;
	private fetching = false;

	// 通知済みフラグ（閾値ごと・リセットされるまで再通知しない）
	private notified5h90 = false;
	private notified5h100 = false;
	private notified7d90 = false;
	private notified7d100 = false;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
		this.statusBarItem.command = 'claudeManager.refreshUsage';
	}

	// 監視を開始/再起動
	start(intervalSec: number): void {
		this.stop();
		this.statusBarItem.text = '$(loading~spin) 利用率取得中...';
		this.statusBarItem.tooltip = 'Claude Code 利用制限（クリックで更新）';
		this.statusBarItem.show();
		// 初回即時取得
		this.fetchAndUpdate();
		this.timer = setInterval(() => this.fetchAndUpdate(), intervalSec * 1000);
	}

	// 監視を停止
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.statusBarItem.hide();
		this.lastData = null;
		this.resetNotificationFlags();
	}

	// 通知フラグをリセット
	private resetNotificationFlags(): void {
		this.notified5h90 = false;
		this.notified5h100 = false;
		this.notified7d90 = false;
		this.notified7d100 = false;
	}

	// 手動リフレッシュ
	async refresh(): Promise<void> {
		await this.fetchAndUpdate();
	}

	// 最新データを取得
	getLastData(): UsageData | null {
		return this.lastData;
	}

	private async fetchAndUpdate(): Promise<void> {
		if (this.fetching) { return; }
		this.fetching = true;
		try {
			const token = await getAccessToken();
			if (!token) {
				this.statusBarItem.text = '$(warning) 認証なし';
				this.statusBarItem.tooltip = '~/.claude/.credentials.json が見つかりません';
				this.statusBarItem.backgroundColor = undefined;
				return;
			}

			const result = await fetchUsageHeaders(token);
			if (!result.data) {
				const detail = result.errorDetail || '不明なエラー';
				const statusInfo = result.statusCode ? ` (${result.statusCode})` : '';
				this.statusBarItem.text = `$(warning) 取得失敗${statusInfo}`;
				this.statusBarItem.tooltip = `API利用率の取得に失敗: ${detail}\n次の更新で再試行します\n\n※ Output パネル「CSM Usage Monitor」で詳細確認可能`;
				this.statusBarItem.backgroundColor = undefined;
				return;
			}

			const data = result.data;
			this.lastData = data;
			this.statusBarItem.text = `$(dashboard) ${formatUsageText(data)}`;

			// 警告色の判定（5hと7dの高い方で判定）
			const maxUsage = Math.max(data.usage5h, data.usage7d);
			if (maxUsage >= 95) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			} else if (maxUsage >= 80) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			} else {
				this.statusBarItem.backgroundColor = undefined;
			}

			const r5h = formatTimeRemaining(data.reset5h);
			const r7d = formatTimeRemaining(data.reset7d);
			this.statusBarItem.tooltip = [
				'Claude Code 利用制限（クリックで更新）',
				'',
				`5時間: ${data.usage5h}%（リセットまで ${r5h}）`,
				`7日間: ${data.usage7d}%（リセットまで ${r7d}）`,
			].join('\n');

			// 閾値通知（90% / 100%）
			this.checkAndNotify(data.usage5h, r5h, '5時間',
				() => this.notified5h90, (v) => { this.notified5h90 = v; },
				() => this.notified5h100, (v) => { this.notified5h100 = v; });
			this.checkAndNotify(data.usage7d, r7d, '7日間',
				() => this.notified7d90, (v) => { this.notified7d90 = v; },
				() => this.notified7d100, (v) => { this.notified7d100 = v; });
		} finally {
			this.fetching = false;
		}
	}

	// 閾値チェック＆通知（90%と100%、リセットされるまで再通知しない）
	private checkAndNotify(
		usage: number,
		resetStr: string,
		label: string,
		get90: () => boolean, set90: (v: boolean) => void,
		get100: () => boolean, set100: (v: boolean) => void,
	): void {
		if (usage >= 100) {
			if (!get100()) {
				set100(true);
				vscode.window.showErrorMessage(`利用制限に達しました（${label}: ${usage}%）。リセットまで ${resetStr}`);
			}
		} else if (usage >= 90) {
			if (!get90()) {
				set90(true);
				vscode.window.showWarningMessage(`利用制限90%に達しました（${label}: ${usage}%）。リセットまで ${resetStr}`);
			}
		} else {
			// 90%未満に下がったらフラグをリセット（次回の90%到達で再通知可能に）
			set90(false);
			set100(false);
		}
	}

	dispose(): void {
		this.stop();
		this.statusBarItem.dispose();
		if (outputChannel) {
			outputChannel.dispose();
			outputChannel = undefined;
		}
	}
}
