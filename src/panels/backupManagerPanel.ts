// backupManagerPanel.ts — v0.5.32
//
// セッションバックアップの管理画面（Webview）。
// バックアップ一覧（sid / slug / サイズ / 日付 / 紐づけ先 / 孤立判定）を表形式で表示し、
// 選択削除・孤立一括削除・N 日以上削除・フォルダを開く等の操作を提供する。

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dataStore from '../models/dataStore';
import {
	listBackups,
	deleteBackups,
	emptyBackupTrash,
	getTrashStats,
	computeProtectedSids,
	getSessionBackupRoot,
	type BackupEntry,
} from '../services/sessionBackupService';

let panel: vscode.WebviewPanel | undefined;

/** 表示用に整形した 1 行 */
interface Row {
	sid: string;
	slug: string;
	sizeBytes: number;
	mtimeMs: number;
	protectedBy: string; // 紐づけ先の説明（空 = 孤立）
	isOrphan: boolean;
}

/** バックアップ一覧 + 保護判定 + 紐づけ先ラベルを集める */
async function gatherRows(): Promise<{ rows: Row[]; totalBytes: number }> {
	const [entries, agents, bookmarks, tags, customNames, notes] = await Promise.all([
		listBackups(),
		dataStore.getAgents(),
		dataStore.getBookmarks(),
		dataStore.getAllTags(),
		dataStore.getAllCustomNames(),
		dataStore.getAllNotes(),
	]);

	const protectedSids = computeProtectedSids({
		agentSids: agents.flatMap((a) => [a.sessionId || '', ...(a.previousSessionIds || [])]),
		bookmarks,
		tagSids: Object.values(tags).flat(),
		customNameSids: Object.keys(customNames),
		noteSids: Object.keys(notes),
	});

	// sid → 紐づけ先ラベル
	const agentBySid = new Map<string, string>();
	for (const a of agents) {
		if (a.sessionId) { agentBySid.set(a.sessionId, `🤖 ${a.displayName || a.name}`); }
		for (const p of a.previousSessionIds || []) { if (!agentBySid.has(p)) { agentBySid.set(p, `🤖 ${a.displayName || a.name}（旧）`); } }
	}
	const bookmarkSet = new Set(bookmarks);
	const customNameSet = new Set(Object.keys(customNames));
	const noteSet = new Set(Object.keys(notes));
	const taggedSet = new Set(Object.values(tags).flat());

	const rows: Row[] = entries.map((e: BackupEntry) => {
		const labels: string[] = [];
		const ag = agentBySid.get(e.sid);
		if (ag) { labels.push(ag); }
		if (bookmarkSet.has(e.sid)) { labels.push('★お気に入り'); }
		if (taggedSet.has(e.sid)) { labels.push('🏷タグ'); }
		if (customNameSet.has(e.sid)) { labels.push('✎名前'); }
		if (noteSet.has(e.sid)) { labels.push('📝メモ'); }
		return {
			sid: e.sid,
			slug: e.slug,
			sizeBytes: e.sizeBytes,
			mtimeMs: e.mtimeMs,
			protectedBy: labels.join(' '),
			isOrphan: !protectedSids.has(e.sid),
		};
	});
	// 孤立を上に、次にサイズ降順
	rows.sort((a, b) => (Number(b.isOrphan) - Number(a.isOrphan)) || (b.sizeBytes - a.sizeBytes));
	const totalBytes = entries.reduce((s, e) => s + e.sizeBytes, 0);
	return { rows, totalBytes };
}

function fmtBytes(n: number): string {
	if (n >= 1024 * 1024 * 1024) { return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`; }
	if (n >= 1024 * 1024) { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
	if (n >= 1024) { return `${(n / 1024).toFixed(0)} KB`; }
	return `${n} B`;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** バックアップ管理画面を開く */
export async function showBackupManagerPanel(context: vscode.ExtensionContext): Promise<void> {
	if (panel) {
		panel.reveal(vscode.ViewColumn.One);
		await postData();
		return;
	}
	panel = vscode.window.createWebviewPanel(
		'csmBackupManager',
		'🗄 セッションバックアップ管理',
		vscode.ViewColumn.One,
		{ enableScripts: true },
	);
	panel.onDidDispose(() => { panel = undefined; });
	panel.webview.html = renderHtml();
	await postData();

	panel.webview.onDidReceiveMessage(async (msg) => {
		try {
			if (msg.type === 'refresh') {
				await postData();
			} else if (msg.type === 'openFolder') {
				await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(getSessionBackupRoot()));
			} else if (msg.type === 'deleteSids') {
				await deleteBySids(msg.sids as string[], `選択した ${(msg.sids || []).length} 件をゴミ箱へ移動しますか？（後で復元できます）`);
			} else if (msg.type === 'deleteOrphaned') {
				const { rows } = await gatherRows();
				const orphans = rows.filter((r) => r.isOrphan).map((r) => r.sid);
				if (orphans.length === 0) { vscode.window.showInformationMessage('孤立バックアップはありません。'); return; }
				await deleteBySids(orphans, `孤立バックアップ ${orphans.length} 件をゴミ箱へ移動しますか？（紐づけ・お気に入りは対象外・復元可）`);
			} else if (msg.type === 'deleteOlderThan') {
				const days = Number(msg.days) || 0;
				if (days <= 0) { return; }
				const { rows } = await gatherRows();
				const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
				const targets = rows.filter((r) => r.mtimeMs < cutoff).map((r) => r.sid);
				if (targets.length === 0) { vscode.window.showInformationMessage(`${days} 日以上前のバックアップはありません。`); return; }
				await deleteBySids(targets, `${days} 日以上前のバックアップ ${targets.length} 件をゴミ箱へ移動しますか？（紐づけ済みも含む・復元可）`);
			} else if (msg.type === 'emptyTrash') {
				const stats = await getTrashStats();
				if (stats.count === 0) { vscode.window.showInformationMessage('ゴミ箱は空です。'); return; }
				const ok = await vscode.window.showWarningMessage(
					`ゴミ箱の ${stats.count} 件（${fmtBytes(stats.bytes)}）を完全に削除します。この操作は元に戻せません。`,
					{ modal: true }, '完全に削除する',
				);
				if (ok !== '完全に削除する') { return; }
				const r = await emptyBackupTrash();
				vscode.window.showInformationMessage(`ゴミ箱を空にしました（${r.deleted} 件 / ${fmtBytes(r.freedBytes)} 解放）。`);
				await postData();
			}
		} catch (err) {
			vscode.window.showErrorMessage(`バックアップ管理の操作に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

async function deleteBySids(sids: string[], confirmMsg: string): Promise<void> {
	if (!sids || sids.length === 0) { return; }
	const ok = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, 'ゴミ箱へ移動');
	if (ok !== 'ゴミ箱へ移動') { return; }
	const entries = (await listBackups()).filter((e) => sids.includes(e.sid));
	const { moved, bytes } = await deleteBackups(entries);
	vscode.window.showInformationMessage(`${moved} 件をゴミ箱へ移動しました（${fmtBytes(bytes)}）。「ゴミ箱を空にする」で完全削除できます。`);
	await postData();
}

async function postData(): Promise<void> {
	if (!panel) { return; }
	const { rows, totalBytes } = await gatherRows();
	const trash = await getTrashStats();
	panel.webview.postMessage({
		type: 'data',
		totalBytes,
		totalHuman: fmtBytes(totalBytes),
		count: rows.length,
		orphanCount: rows.filter((r) => r.isOrphan).length,
		trashCount: trash.count,
		trashHuman: fmtBytes(trash.bytes),
		rows: rows.map((r) => ({
			sid: r.sid,
			sid8: escapeHtml(r.sid.substring(0, 8)),
			slug: escapeHtml(r.slug),
			size: fmtBytes(r.sizeBytes),
			date: new Date(r.mtimeMs).toLocaleString('ja-JP'),
			protectedBy: escapeHtml(r.protectedBy),
			isOrphan: r.isOrphan,
		})),
	});
}

function renderHtml(): string {
	const nonce = crypto.randomBytes(16).toString('hex');
	return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
h1 { font-size: 16px; margin: 0 0 10px; }
.summary { font-size: 13px; color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; align-items: center; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.danger { background: #a1260d; color: #fff; }
input[type=number] { width: 60px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
th { position: sticky; top: 0; background: var(--vscode-editor-background); }
tr.orphan td { opacity: 0.95; }
.badge-orphan { color: #e2b13a; }
.badge-protected { color: #4ec9b0; }
.wrap { max-height: 60vh; overflow: auto; border: 1px solid var(--vscode-panel-border); border-radius: 4px; }
.empty { padding: 24px; text-align: center; color: var(--vscode-descriptionForeground); }
code { font-size: 11px; }
</style></head><body>
<h1>🗄 セッションバックアップ管理</h1>
<div class="summary" id="summary">読み込み中…</div>
<div class="toolbar">
	<button id="btnRefresh" class="secondary">🔄 更新</button>
	<button id="btnOpenFolder" class="secondary">📂 フォルダを開く</button>
	<button id="btnDelSel" class="danger">選択を削除</button>
	<button id="btnDelOrphan" class="danger">孤立をすべて削除</button>
	<span>|</span>
	<input type="number" id="days" value="180" min="1" />
	<button id="btnDelOld" class="danger">日以上前をゴミ箱へ</button>
	<span>|</span>
	<button id="btnEmptyTrash" class="danger">🗑 ゴミ箱を空にする</button>
</div>
<div class="summary" id="trashSummary"></div>
<div class="wrap">
	<table>
		<thead><tr>
			<th><input type="checkbox" id="chkAll" /></th>
			<th>状態</th><th>紐づけ先</th><th>サイズ</th><th>更新日時</th><th>セッション</th><th>プロジェクト</th>
		</tr></thead>
		<tbody id="tbody"></tbody>
	</table>
	<div class="empty" id="empty" style="display:none;">バックアップはありません。</div>
</div>
<script nonce="${nonce}">
	const vscode = acquireVsCodeApi();
	let currentRows = [];
	function selectedSids() {
		return Array.from(document.querySelectorAll('input.rowchk:checked')).map(el => el.getAttribute('data-sid'));
	}
	document.getElementById('btnRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
	document.getElementById('btnOpenFolder').addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
	document.getElementById('btnDelSel').addEventListener('click', () => {
		const sids = selectedSids();
		if (sids.length === 0) { return; }
		vscode.postMessage({ type: 'deleteSids', sids });
	});
	document.getElementById('btnDelOrphan').addEventListener('click', () => vscode.postMessage({ type: 'deleteOrphaned' }));
	document.getElementById('btnDelOld').addEventListener('click', () => {
		const days = parseInt(document.getElementById('days').value, 10);
		vscode.postMessage({ type: 'deleteOlderThan', days });
	});
	document.getElementById('btnEmptyTrash').addEventListener('click', () => vscode.postMessage({ type: 'emptyTrash' }));
	document.getElementById('chkAll').addEventListener('change', (e) => {
		document.querySelectorAll('input.rowchk').forEach(c => { c.checked = e.target.checked; });
	});
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type !== 'data') { return; }
		currentRows = msg.rows;
		document.getElementById('summary').textContent =
			'合計 ' + msg.count + ' 件 / ' + msg.totalHuman + '（うち孤立 ' + msg.orphanCount + ' 件）';
		document.getElementById('trashSummary').textContent =
			msg.trashCount > 0 ? ('🗑 ゴミ箱: ' + msg.trashCount + ' 件 / ' + msg.trashHuman + '（「ゴミ箱を空にする」で完全削除）') : '';
		const tbody = document.getElementById('tbody');
		const empty = document.getElementById('empty');
		tbody.innerHTML = '';
		empty.style.display = msg.rows.length === 0 ? 'block' : 'none';
		for (const r of msg.rows) {
			const tr = document.createElement('tr');
			if (r.isOrphan) { tr.className = 'orphan'; }
			const state = r.isOrphan ? '<span class="badge-orphan">孤立</span>' : '<span class="badge-protected">保護</span>';
			tr.innerHTML =
				'<td><input type="checkbox" class="rowchk" data-sid="' + r.sid + '"></td>' +
				'<td>' + state + '</td>' +
				'<td>' + (r.protectedBy || '<span class="badge-orphan">—</span>') + '</td>' +
				'<td>' + r.size + '</td>' +
				'<td>' + r.date + '</td>' +
				'<td><code>' + r.sid8 + '…</code></td>' +
				'<td><code>' + r.slug + '</code></td>';
			tbody.appendChild(tr);
		}
	});
</script>
</body></html>`;
}
