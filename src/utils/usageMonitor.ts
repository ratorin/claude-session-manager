import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as vscode from 'vscode';

// 利用率データ
export interface UsageData {
	usage5h: number;    // 5時間利用率（%）
	usage7d: number;    // 7日利用率（%）
	reset5h: number;    // 5時間リセット時刻（Unix秒）
	reset7d: number;    // 7日リセット時刻（Unix秒）
	// T2.22: Sonnet 5d / Opus 5d（取得できない場合は -1）
	usageSonnet5d: number;  // Sonnet 5日間利用率（%）
	resetSonnet5d: number;  // Sonnet 5日リセット時刻（Unix秒）
	usageOpus5d: number;    // Opus 5日間利用率（%）
	resetOpus5d: number;    // Opus 5日リセット時刻（Unix秒）
	// 追加分（overage）。取得できない場合は overageUtilization = -1
	overageUtilization: number;  // 追加分の利用率（%）
	overageStatus: string;       // 追加分の状態（allowed 等）
	overageReset: number;        // 追加分リセット時刻（Unix秒）
	fetchedAt: number;  // 取得時刻（ms）
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

				// T2.22: Sonnet 5d / Opus 5d — 複数の候補ヘッダを試みる
				const pickHeader = (keys: string[]): number => {
					for (const k of keys) {
						const v = parseFloat(headers[k] as string);
						if (!isNaN(v)) { return v; }
					}
					return NaN;
				};
				const rawSonnet5d  = pickHeader(['anthropic-ratelimit-claude-sonnet-5d-utilization', 'anthropic-ratelimit-sonnet-5d-utilization', 'anthropic-ratelimit-unified-sonnet-5d-utilization']);
				const rawOpus5d    = pickHeader(['anthropic-ratelimit-claude-opus-5d-utilization',   'anthropic-ratelimit-opus-5d-utilization',   'anthropic-ratelimit-unified-opus-5d-utilization']);
				const resetSonnet5d = pickHeader(['anthropic-ratelimit-claude-sonnet-5d-reset',       'anthropic-ratelimit-sonnet-5d-reset',       'anthropic-ratelimit-unified-sonnet-5d-reset']);
				const resetOpus5d   = pickHeader(['anthropic-ratelimit-claude-opus-5d-reset',         'anthropic-ratelimit-opus-5d-reset',         'anthropic-ratelimit-unified-opus-5d-reset']);

				// 追加分（overage）: 利用率 / 状態 / リセット
				const rawOverage   = pickHeader(['anthropic-ratelimit-unified-overage-utilization']);
				const resetOverage = pickHeader(['anthropic-ratelimit-unified-overage-reset']);
				const overageStatus = (headers['anthropic-ratelimit-unified-overage-status'] as string) || '';

				// 全rate-limitヘッダをデバッグログ出力（ヘッダ名発見用）
				const allHeaders = Object.keys(headers).filter(h => h.includes('ratelimit'));
				log.appendLine(`  ratelimit headers: ${allHeaders.join(', ')}`);
				log.appendLine(`  5h raw: ${usage5h}, 7d raw: ${usage7d}, sonnet5d: ${rawSonnet5d}, opus5d: ${rawOpus5d}`);

				if (isNaN(usage5h) && isNaN(usage7d)) {
					resolve({ data: null, statusCode, errorDetail: 'レスポンスヘッダーに利用率情報なし' });
					return;
				}

				// APIは0〜1の小数を返す（例: 0.91 = 91%）→ 100倍してパーセントに変換
				const pct5h = isNaN(usage5h) ? 0 : Math.round(usage5h * 1000) / 10;
				const pct7d = isNaN(usage7d) ? 0 : Math.round(usage7d * 1000) / 10;
				const pctSonnet5d = isNaN(rawSonnet5d) ? -1 : Math.round(rawSonnet5d * 1000) / 10;
				const pctOpus5d   = isNaN(rawOpus5d)   ? -1 : Math.round(rawOpus5d * 1000) / 10;
				const pctOverage  = isNaN(rawOverage)  ? -1 : Math.round(rawOverage * 1000) / 10;
				log.appendLine(`  5h: ${pct5h}%, 7d: ${pct7d}%, S5d: ${pctSonnet5d}%, O5d: ${pctOpus5d}%, 追加: ${pctOverage}% (${overageStatus})`);

				resolve({
					data: {
						usage5h: pct5h,
						usage7d: pct7d,
						reset5h: isNaN(reset5h) ? 0 : reset5h,
						reset7d: isNaN(reset7d) ? 0 : reset7d,
						usageSonnet5d: pctSonnet5d,
						resetSonnet5d: isNaN(resetSonnet5d) ? 0 : resetSonnet5d,
						usageOpus5d: pctOpus5d,
						resetOpus5d: isNaN(resetOpus5d) ? 0 : resetOpus5d,
						overageUtilization: pctOverage,
						overageStatus,
						overageReset: isNaN(resetOverage) ? 0 : resetOverage,
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

// パーセント値をフォーマット（整数なら小数点なし、小数なら1桁）
function fmtPct(v: number): string {
	return v % 1 === 0 ? `${v}` : v.toFixed(1);
}

// v0.5.17 §4-2: 5d 列を配列駆動化（Fable 5d 枠が将来追加される場合、この配列に 1 行足すだけで済む）。
// 各列は `getUsage(data)` / `getReset(data)` / `label`（表示上の 1 文字）で自己完結する。
interface UsageMultiDayColumn {
	key: 'sonnet-5d' | 'opus-5d';
	label: string;                     // ステータスバー用の 1 文字（S/O 等）
	longLabel: string;                 // tooltip 用の日本語ラベル
	getUsage(data: UsageData): number; // <0 なら「データなし」
	getReset(data: UsageData): number; // Unix 秒
}
export const USAGE_MULTIDAY_COLUMNS: readonly UsageMultiDayColumn[] = [
	{ key: 'sonnet-5d', label: 'S', longLabel: 'Sonnet 5日',
		getUsage: (d) => d.usageSonnet5d, getReset: (d) => d.resetSonnet5d },
	{ key: 'opus-5d', label: 'O', longLabel: 'Opus 5日',
		getUsage: (d) => d.usageOpus5d,   getReset: (d) => d.resetOpus5d },
];

export type StatusBarStyle = 'full' | 'compact' | 'max-only';

/**
 * 利用率の表示テキストを生成（T2.23 / v0.5.17 §4-2）
 * show5d=true:  "5% 4.5h / S 3% 5d20h / O 20% 5d10h"
 * show5d=false: "5% 4.5h / 7% 7d"
 * style:
 *   - 'full'     : 現状維持（%表記 + リセット時刻）
 *   - 'compact'  : リセット時刻を省略し % のみ  例: "5% / 7% / S 3% / O 20%"
 *   - 'max-only' : 最も逼迫している1枠のみ表示 例: "O 20% 5d10h"
 */
export function formatUsageText(data: UsageData, show5d = true, style: StatusBarStyle = 'full'): string {
	// 内部型: 1 セグメントぶんの情報
	interface Seg { label: string; usage: number; reset: number; }
	const segs: Seg[] = [
		{ label: '', usage: data.usage5h, reset: data.reset5h }, // 5h は無ラベル（base）
	];
	// 5d 有無で残りセグメントを追加
	const activeCols = show5d
		? USAGE_MULTIDAY_COLUMNS.filter((c) => c.getUsage(data) >= 0)
		: [];
	if (activeCols.length === 0) {
		// 従来フォーマット: 5h / 7d
		segs.push({ label: '', usage: data.usage7d, reset: data.reset7d });
	} else {
		for (const c of activeCols) {
			segs.push({ label: c.label, usage: c.getUsage(data), reset: c.getReset(data) });
		}
	}

	function fmtSeg(s: Seg): string {
		const labelPrefix = s.label ? `${s.label} ` : '';
		if (style === 'compact') {
			return `${labelPrefix}${fmtPct(s.usage)}%`;
		}
		return `${labelPrefix}${fmtPct(s.usage)}% ${formatTimeRemaining(s.reset)}`;
	}

	if (style === 'max-only') {
		// 最逼迫の 1 枠のみ（同率のときは配列順で先勝ち）
		let top = segs[0];
		for (const s of segs) { if (s.usage > top.usage) { top = s; } }
		return fmtSeg(top);
	}

	return segs.map(fmtSeg).join(' / ');
}

/**
 * 追加分（overage）のステータスバー用テキスト。データが無ければ '' を返す。
 * 例: "追加 0%"（API は利用率%のみ提供、ドル金額は無し）
 */
export function formatOverageText(data: UsageData): string {
	if (typeof data.overageUtilization !== 'number' || data.overageUtilization < 0) { return ''; }
	return `追加 ${fmtPct(data.overageUtilization)}%`;
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
	// v0.5.16 L-13: Sonnet/Opus 5日枠の通知フラグ（旧: 100%到達しても通知なしで沈黙）
	private notifiedSonnet5d90 = false;
	private notifiedSonnet5d100 = false;
	private notifiedOpus5d90 = false;
	private notifiedOpus5d100 = false;

	constructor() {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
		this.statusBarItem.command = 'claudeManager.openUsageMenu';
	}

	// 監視を開始/再起動
	start(intervalSec: number): void {
		this.stop();
		this.statusBarItem.text = '$(loading~spin) 利用率取得中...';
		this.statusBarItem.tooltip = 'Claude Code 利用制限（クリックでメニュー表示）';
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
		// v0.5.16 L-13
		this.notifiedSonnet5d90 = false;
		this.notifiedSonnet5d100 = false;
		this.notifiedOpus5d90 = false;
		this.notifiedOpus5d100 = false;
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
			// T2.23: show5dColumns 設定を読んで表示フォーマットを切り替え
			const cfg = vscode.workspace.getConfiguration('claudeManager');
			const show5d = cfg.get<boolean>('usage.show5dColumns', true);
			// v0.5.17 §4-2: 表示スタイル（full/compact/max-only）
			const style = cfg.get<StatusBarStyle>('usage.statusBarStyle', 'full');
			// 追加分（overage）は使用量とは別セグメントで併記
			const overageText = formatOverageText(data);
			this.statusBarItem.text = `$(dashboard) ${formatUsageText(data, show5d, style)}${overageText ? ` ｜ ${overageText}` : ''}`;

			// 警告色の判定（5h / Sonnet5d / Opus5d の最大値で判定）
			// v0.5.17 §4-2: 5d 列を USAGE_MULTIDAY_COLUMNS 経由に統一
			const candidates = [data.usage5h, data.usage7d];
			if (show5d) {
				for (const c of USAGE_MULTIDAY_COLUMNS) {
					const u = c.getUsage(data);
					if (u >= 0) { candidates.push(u); }
				}
			}
			const maxUsage = Math.max(...candidates);
			if (maxUsage >= 95) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
			} else if (maxUsage >= 80) {
				this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			} else {
				this.statusBarItem.backgroundColor = undefined;
			}

			const r5h = formatTimeRemaining(data.reset5h);
			const r7d = formatTimeRemaining(data.reset7d);
			const tooltipLines = [
				'Claude Code 利用制限（クリックでメニュー表示）',
				'',
				`5時間: ${fmtPct(data.usage5h)}%（リセットまで ${r5h}）`,
				`7日間: ${fmtPct(data.usage7d)}%（リセットまで ${r7d}）`,
			];
			// v0.5.17 §4-2: 5d 列を USAGE_MULTIDAY_COLUMNS 経由に統一（Fable 5d 等が追加された際も自動対応）
			if (show5d) {
				for (const c of USAGE_MULTIDAY_COLUMNS) {
					const u = c.getUsage(data);
					if (u >= 0) {
						tooltipLines.push(`${c.longLabel}: ${fmtPct(u)}%（リセットまで ${formatTimeRemaining(c.getReset(data))}）`);
					}
				}
			}
			if (data.overageUtilization >= 0) {
				const ro = data.overageReset ? `・リセットまで ${formatTimeRemaining(data.overageReset)}` : '';
				tooltipLines.push('');
				tooltipLines.push(`追加分(overage): ${fmtPct(data.overageUtilization)}% 使用 / ${data.overageStatus || '不明'}${ro}`);
				tooltipLines.push('※ ドル残高は claude.ai/settings/usage で確認（APIは%のみ提供）');
			}
			this.statusBarItem.tooltip = tooltipLines.join('\n');

			// 閾値通知（90% / 100%）
			this.checkAndNotify(data.usage5h, r5h, '5時間',
				() => this.notified5h90, (v) => { this.notified5h90 = v; },
				() => this.notified5h100, (v) => { this.notified5h100 = v; });
			this.checkAndNotify(data.usage7d, r7d, '7日間',
				() => this.notified7d90, (v) => { this.notified7d90 = v; },
				() => this.notified7d100, (v) => { this.notified7d100 = v; });
			// v0.5.16 L-13: Sonnet/Opus 5日枠も通知（>=0 のときのみ = ヘッダ提供時のみ）。
			//   show5d 設定に関わらず 100% 到達は通知する（沈黙リスク回避）。
			if (data.usageSonnet5d >= 0) {
				this.checkAndNotify(data.usageSonnet5d, formatTimeRemaining(data.resetSonnet5d), 'Sonnet 5日',
					() => this.notifiedSonnet5d90, (v) => { this.notifiedSonnet5d90 = v; },
					() => this.notifiedSonnet5d100, (v) => { this.notifiedSonnet5d100 = v; });
			}
			if (data.usageOpus5d >= 0) {
				this.checkAndNotify(data.usageOpus5d, formatTimeRemaining(data.resetOpus5d), 'Opus 5日',
					() => this.notifiedOpus5d90, (v) => { this.notifiedOpus5d90 = v; },
					() => this.notifiedOpus5d100, (v) => { this.notifiedOpus5d100 = v; });
			}
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
				vscode.window.showErrorMessage(`利用制限に達しました（${label}: ${fmtPct(usage)}%）。リセットまで ${resetStr}`);
			}
		} else if (usage >= 90) {
			if (!get90()) {
				set90(true);
				vscode.window.showWarningMessage(`利用制限90%に達しました（${label}: ${fmtPct(usage)}%）。リセットまで ${resetStr}`);
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
