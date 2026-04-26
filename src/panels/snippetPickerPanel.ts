/**
 * snippetPickerPanel.ts — v0.5.0 Sprint 3 T3.3 / T3.5 / T3.6
 * スニペット/スキル参照/ツール注記 選択 WebviewPanel
 *
 * タブ構成:
 *   0: スニペット  — snippetLibrary.ts のスニペット一覧 + 検索
 *   1: スキル参照  — ~/.claude/skills/ ディレクトリ列挙 + i18n表示名
 *   2: ツール注記  — data/i18n/ja/tools.json のツール一覧 + 複数チェックボックス選択
 *
 * 呼び出し:
 *   const text = await showSnippetPicker(context);
 *   if (text !== undefined) { // 挿入確定 }
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadAll as loadAllSnippets, Snippet, SnippetCategory } from '../services/snippetLibrary';
import { getI18n } from '../services/i18nService';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

type PickerTab = 'snippets' | 'skills' | 'tools';

interface SkillItem {
    name: string;
    displayName: string;
    displayDescription: string;
}

interface ToolItem {
    id: string;
    displayName: string;
    displayDescription: string;
}

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

const CATEGORY_LABELS: Record<SnippetCategory, string> = {
    'workflow': 'ワークフロー',
    'constraint': '制約・ルール',
    'communication': 'コミュニケーション',
    'tool-note': 'ツール注記',
    'custom': 'カスタム',
};

/** T3.6: ツール注記タブで表示するツール一覧（Spec 指定の8種 + extra） */
const TOOL_IDS = [
    'Read', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'WebFetch', 'WebSearch',
    'Write', 'TodoWrite',
];

// -------------------------------------------------------------------
// パブリック API
// -------------------------------------------------------------------

/**
 * スニペットピッカーパネルを表示し、ユーザーが選択したテキストを返す。
 * キャンセル時は undefined を返す。
 */
export async function showSnippetPicker(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    return new Promise<string | undefined>((resolve) => {
        const panel = createPanel(context, resolve);
        panel.onDidDispose(() => resolve(undefined));
    });
}

// -------------------------------------------------------------------
// 内部実装
// -------------------------------------------------------------------

function createPanel(
    context: vscode.ExtensionContext,
    resolve: (value: string | undefined) => void
): vscode.WebviewPanel {
    const nonce = crypto.randomBytes(16).toString('hex');

    const panel = vscode.window.createWebviewPanel(
        'csmSnippetPicker',
        '機能追加 — スニペット選択',
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: false,
            localResourceRoots: [context.extensionUri],
        }
    );

    const snippets = loadSnippetsForPanel();
    const skills = loadSkillItems();
    const tools = loadToolItems();

    panel.webview.html = buildHtml(nonce, snippets, skills, tools);

    panel.webview.onDidReceiveMessage((msg: { type: string; text?: string }) => {
        if (msg.type === 'insert' && msg.text !== undefined) {
            resolve(msg.text);
            panel.dispose();
        } else if (msg.type === 'cancel') {
            resolve(undefined);
            panel.dispose();
        }
    });

    return panel;
}

// -------------------------------------------------------------------
// データロード
// -------------------------------------------------------------------

function loadSnippetsForPanel(): Snippet[] {
    try {
        return loadAllSnippets();
    } catch {
        return [];
    }
}

/** T3.5: ~/.claude/skills/ 配下のディレクトリ名を列挙して i18n 表示名を付与 */
function loadSkillItems(): SkillItem[] {
    const i18n = getI18n();
    const items: SkillItem[] = [];

    if (!fs.existsSync(SKILLS_DIR)) {
        return items;
    }

    try {
        const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }
            const name = entry.name;
            const i18nEntry = i18n.skills[name];
            items.push({
                name,
                displayName: i18nEntry?.displayName ?? name,
                displayDescription: i18nEntry?.displayDescription ?? '',
            });
        }
    } catch {
        // 読み取り失敗は無視して空配列を返す
    }

    return items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'));
}

/** T3.6: tools.json から指定ツールの表示情報を取得 */
function loadToolItems(): ToolItem[] {
    const i18n = getI18n();
    return TOOL_IDS.map(id => {
        const entry = i18n.tools[id];
        return {
            id,
            displayName: entry?.displayName ?? id,
            displayDescription: entry?.displayDescription ?? '',
        };
    });
}

// -------------------------------------------------------------------
// HTML 生成
// -------------------------------------------------------------------

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildHtml(
    nonce: string,
    snippets: Snippet[],
    skills: SkillItem[],
    tools: ToolItem[]
): string {
    const snippetsJson = JSON.stringify(snippets);
    const skillsJson = JSON.stringify(skills);
    const toolsJson = JSON.stringify(tools);
    const categoryLabelsJson = JSON.stringify(CATEGORY_LABELS);

    // スニペットカテゴリ一覧（重複除去）
    const categories = Array.from(new Set(snippets.map(s => s.category)));

    const categoryOptions = categories.map(cat =>
        `<option value="${escapeHtml(cat)}">${escapeHtml(CATEGORY_LABELS[cat] ?? cat)}</option>`
    ).join('');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
    :root {
        --accent: #e27e4a;
        --bg: var(--vscode-editor-background);
        --surface: var(--vscode-textBlockQuote-background);
        --border: var(--vscode-panel-border);
        --text: var(--vscode-foreground);
        --text-dim: var(--vscode-descriptionForeground);
        --input-bg: var(--vscode-input-background);
        --input-border: var(--vscode-input-border);
        --input-fg: var(--vscode-input-foreground);
        --focus: var(--vscode-focusBorder);
        --btn-bg: var(--vscode-button-background);
        --btn-fg: var(--vscode-button-foreground);
        --btn-hover: var(--vscode-button-hoverBackground);
        --list-hover: var(--vscode-list-hoverBackground);
        --list-active: var(--vscode-list-activeSelectionBackground);
        --list-active-fg: var(--vscode-list-activeSelectionForeground);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        background: var(--bg);
        color: var(--text);
        display: flex;
        flex-direction: column;
        height: 100vh;
        overflow: hidden;
    }
    .header {
        padding: 12px 16px 8px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }
    .header h1 {
        font-size: 14px;
        font-weight: 600;
        color: var(--accent);
        margin-bottom: 8px;
    }
    .search-row {
        display: flex;
        gap: 6px;
        align-items: center;
    }
    .search-input {
        flex: 1;
        padding: 5px 8px;
        border: 1px solid var(--input-border);
        background: var(--input-bg);
        color: var(--input-fg);
        border-radius: 4px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
    }
    .search-input:focus { outline: none; border-color: var(--focus); }
    .category-select {
        padding: 5px 6px;
        border: 1px solid var(--input-border);
        background: var(--input-bg);
        color: var(--input-fg);
        border-radius: 4px;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        max-width: 130px;
    }
    .category-select:focus { outline: none; border-color: var(--focus); }
    /* タブバー */
    .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
        background: var(--bg);
    }
    .tab-btn {
        padding: 8px 16px;
        border: none;
        background: transparent;
        color: var(--text-dim);
        cursor: pointer;
        font-size: 12px;
        font-family: var(--vscode-font-family);
        border-bottom: 2px solid transparent;
        transition: all 0.15s;
    }
    .tab-btn:hover { color: var(--text); background: var(--list-hover); }
    .tab-btn.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
        font-weight: 600;
    }
    /* コンテンツエリア */
    .tab-content {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
    }
    .tab-pane {
        display: none;
        flex: 1;
        overflow-y: auto;
        padding: 8px 0;
    }
    .tab-pane.active { display: flex; flex-direction: column; }
    /* スニペットリスト */
    .snippet-item {
        padding: 8px 16px;
        cursor: pointer;
        border-bottom: 1px solid rgba(128,128,128,0.1);
        transition: background 0.1s;
    }
    .snippet-item:hover { background: var(--list-hover); }
    .snippet-item.selected { background: var(--list-active); color: var(--list-active-fg); }
    .snippet-title {
        font-size: 13px;
        font-weight: 500;
        margin-bottom: 2px;
    }
    .snippet-desc {
        font-size: 11px;
        color: var(--text-dim);
        line-height: 1.3;
    }
    .snippet-item.selected .snippet-desc { color: var(--list-active-fg); opacity: 0.8; }
    .snippet-meta {
        font-size: 10px;
        color: var(--accent);
        margin-top: 2px;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
    }
    .snippet-item.selected .snippet-meta { color: var(--list-active-fg); }
    .tag {
        padding: 1px 5px;
        background: rgba(226, 126, 74, 0.15);
        border-radius: 3px;
        font-size: 10px;
    }
    .snippet-item.selected .tag { background: rgba(255,255,255,0.2); }
    /* スキルリスト */
    .skill-item {
        padding: 8px 16px;
        cursor: pointer;
        border-bottom: 1px solid rgba(128,128,128,0.1);
        transition: background 0.1s;
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .skill-item:hover { background: var(--list-hover); }
    .skill-icon { font-size: 16px; flex-shrink: 0; }
    .skill-info { flex: 1; min-width: 0; }
    .skill-name { font-size: 13px; font-weight: 500; }
    .skill-desc { font-size: 11px; color: var(--text-dim); }
    /* ツールリスト */
    .tool-list { padding: 8px 16px; }
    .tool-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid rgba(128,128,128,0.08);
        cursor: pointer;
    }
    .tool-item:last-child { border-bottom: none; }
    .tool-checkbox {
        width: 15px;
        height: 15px;
        margin-top: 1px;
        accent-color: var(--accent);
        cursor: pointer;
        flex-shrink: 0;
    }
    .tool-info { flex: 1; min-width: 0; }
    .tool-name { font-size: 13px; font-weight: 500; }
    .tool-desc { font-size: 11px; color: var(--text-dim); margin-top: 1px; }
    .tool-select-all {
        padding: 0 0 6px;
        margin-bottom: 4px;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-dim);
        cursor: pointer;
    }
    /* 空状態 */
    .empty-state {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-dim);
        font-size: 12px;
        padding: 24px;
        text-align: center;
    }
    /* フッターボタン */
    .footer {
        padding: 10px 16px;
        border-top: 1px solid var(--border);
        display: flex;
        gap: 8px;
        align-items: center;
        flex-shrink: 0;
        background: var(--bg);
    }
    .btn-insert {
        padding: 7px 20px;
        background: var(--btn-bg);
        color: var(--btn-fg);
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        font-family: var(--vscode-font-family);
    }
    .btn-insert:hover { background: var(--btn-hover); }
    .btn-insert:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn-cancel {
        padding: 7px 14px;
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        font-family: var(--vscode-font-family);
    }
    .btn-cancel:hover { background: var(--surface); }
    .selection-hint {
        margin-left: auto;
        font-size: 11px;
        color: var(--text-dim);
    }
</style>
</head>
<body>
<div class="header">
    <h1>機能追加 — スニペット選択</h1>
    <div class="search-row" id="snippetSearch" style="display:flex">
        <input type="text" class="search-input" id="searchInput"
            placeholder="検索..." aria-label="スニペット検索">
        <select class="category-select" id="categoryFilter" aria-label="カテゴリ">
            <option value="">全カテゴリ</option>
            ${categoryOptions}
        </select>
    </div>
</div>

<div class="tab-bar" role="tablist" aria-label="選択タブ">
    <button class="tab-btn active" id="tab-snippets" role="tab"
        aria-selected="true" aria-controls="pane-snippets">スニペット</button>
    <button class="tab-btn" id="tab-skills" role="tab"
        aria-selected="false" aria-controls="pane-skills">スキル参照</button>
    <button class="tab-btn" id="tab-tools" role="tab"
        aria-selected="false" aria-controls="pane-tools">ツール注記</button>
</div>

<div class="tab-content">
    <!-- スニペットタブ -->
    <div id="pane-snippets" class="tab-pane active" role="tabpanel" aria-labelledby="tab-snippets">
        <div id="snippetList"></div>
        <div class="empty-state" id="snippetEmpty" style="display:none">
            スニペットが見つかりません
        </div>
    </div>

    <!-- スキル参照タブ -->
    <div id="pane-skills" class="tab-pane" role="tabpanel" aria-labelledby="tab-skills">
        <div id="skillList"></div>
        <div class="empty-state" id="skillEmpty" style="display:none">
            ~/.claude/skills/ にスキルが見つかりません
        </div>
    </div>

    <!-- ツール注記タブ -->
    <div id="pane-tools" class="tab-pane" role="tabpanel" aria-labelledby="tab-tools">
        <div class="tool-list">
            <div class="tool-select-all" id="toolSelectAll">
                <input type="checkbox" class="tool-checkbox" id="checkAll" aria-label="全選択">
                <label for="checkAll" style="cursor:pointer">すべて選択 / 解除</label>
            </div>
            <div id="toolList"></div>
        </div>
    </div>
</div>

<div class="footer">
    <button class="btn-insert" id="btnInsert" disabled aria-label="選択したテキストを挿入">挿入</button>
    <button class="btn-cancel" id="btnCancel" aria-label="キャンセル">キャンセル</button>
    <span class="selection-hint" id="selectionHint"></span>
</div>

<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const snippets = ${snippetsJson};
    const skills = ${skillsJson};
    const tools = ${toolsJson};
    const categoryLabels = ${categoryLabelsJson};

    // ----------------------------------------------------------------
    // 状態
    // ----------------------------------------------------------------
    let currentTab = 'snippets';
    let selectedSnippetId = null;
    let selectedSkillName = null;

    // ----------------------------------------------------------------
    // タブ切り替え
    // ----------------------------------------------------------------
    function switchTab(tab) {
        currentTab = tab;
        document.querySelectorAll('.tab-btn').forEach(btn => {
            const isActive = btn.id === 'tab-' + tab;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        document.querySelectorAll('.tab-pane').forEach(pane => {
            pane.classList.toggle('active', pane.id === 'pane-' + tab);
        });
        // 検索バーはスニペットタブのみ表示
        document.getElementById('snippetSearch').style.display = tab === 'snippets' ? 'flex' : 'none';
        // 選択状態リセット
        selectedSnippetId = null;
        selectedSkillName = null;
        updateInsertButton();
        if (tab === 'snippets') { renderSnippets(); }
        if (tab === 'skills') { renderSkills(); }
        if (tab === 'tools') { renderTools(); updateInsertButton(); }
    }

    document.getElementById('tab-snippets').addEventListener('click', () => switchTab('snippets'));
    document.getElementById('tab-skills').addEventListener('click', () => switchTab('skills'));
    document.getElementById('tab-tools').addEventListener('click', () => switchTab('tools'));

    // ----------------------------------------------------------------
    // スニペットタブ
    // ----------------------------------------------------------------
    function renderSnippets() {
        const query = document.getElementById('searchInput').value.toLowerCase();
        const catFilter = document.getElementById('categoryFilter').value;

        const filtered = snippets.filter(s => {
            if (catFilter && s.category !== catFilter) { return false; }
            if (!query) { return true; }
            return (
                s.title.toLowerCase().includes(query) ||
                s.description.toLowerCase().includes(query) ||
                (s.tags || []).some(t => t.toLowerCase().includes(query))
            );
        });

        const list = document.getElementById('snippetList');
        const empty = document.getElementById('snippetEmpty');

        if (filtered.length === 0) {
            list.innerHTML = '';
            empty.style.display = 'flex';
        } else {
            empty.style.display = 'none';
            list.innerHTML = filtered.map(s => {
                const isSelected = s.id === selectedSnippetId;
                const catLabel = categoryLabels[s.category] || s.category;
                const tags = (s.tags || []).slice(0, 3).map(t =>
                    '<span class="tag">' + escHtml(t) + '</span>'
                ).join('');
                return '<div class="snippet-item' + (isSelected ? ' selected' : '') +
                    '" data-id="' + escHtml(s.id) + '" role="option" aria-selected="' + isSelected + '" tabindex="0">' +
                    '<div class="snippet-title">' + escHtml(s.title) + '</div>' +
                    '<div class="snippet-desc">' + escHtml(s.description) + '</div>' +
                    '<div class="snippet-meta"><span>' + escHtml(catLabel) + '</span>' + tags + '</div>' +
                    '</div>';
            }).join('');

            list.querySelectorAll('.snippet-item').forEach(el => {
                el.addEventListener('click', () => selectSnippet(el.getAttribute('data-id')));
                el.addEventListener('dblclick', () => {
                    selectSnippet(el.getAttribute('data-id'));
                    doInsert();
                });
                el.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectSnippet(el.getAttribute('data-id'));
                    }
                });
            });
        }
    }

    function selectSnippet(id) {
        selectedSnippetId = id;
        renderSnippets();
        updateInsertButton();
    }

    document.getElementById('searchInput').addEventListener('input', renderSnippets);
    document.getElementById('categoryFilter').addEventListener('change', renderSnippets);

    // ----------------------------------------------------------------
    // スキルタブ (T3.5)
    // ----------------------------------------------------------------
    function renderSkills() {
        const list = document.getElementById('skillList');
        const empty = document.getElementById('skillEmpty');

        if (skills.length === 0) {
            list.innerHTML = '';
            empty.style.display = 'flex';
        } else {
            empty.style.display = 'none';
            list.innerHTML = skills.map(s => {
                const isSelected = s.name === selectedSkillName;
                return '<div class="skill-item' + (isSelected ? ' selected' : '') +
                    '" data-name="' + escHtml(s.name) + '" role="option" aria-selected="' + isSelected + '" tabindex="0">' +
                    '<span class="skill-icon" aria-hidden="true">🔧</span>' +
                    '<div class="skill-info">' +
                    '<div class="skill-name">' + escHtml(s.displayName) + '</div>' +
                    (s.displayDescription ? '<div class="skill-desc">' + escHtml(s.displayDescription) + '</div>' : '') +
                    '<div class="skill-desc" style="opacity:0.6;margin-top:1px;">' + escHtml(s.name) + '</div>' +
                    '</div></div>';
            }).join('');

            list.querySelectorAll('.skill-item').forEach(el => {
                el.addEventListener('click', () => selectSkill(el.getAttribute('data-name')));
                el.addEventListener('dblclick', () => {
                    selectSkill(el.getAttribute('data-name'));
                    doInsert();
                });
                el.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectSkill(el.getAttribute('data-name'));
                    }
                });
            });
        }
    }

    function selectSkill(name) {
        selectedSkillName = name;
        renderSkills();
        updateInsertButton();
    }

    // ----------------------------------------------------------------
    // ツールタブ (T3.6)
    // ----------------------------------------------------------------
    function renderTools() {
        const list = document.getElementById('toolList');
        list.innerHTML = tools.map(t => {
            return '<div class="tool-item" data-id="' + escHtml(t.id) + '">' +
                '<input type="checkbox" class="tool-checkbox tool-check" id="tool-' + escHtml(t.id) +
                '" aria-label="' + escHtml(t.displayName) + ' を選択">' +
                '<div class="tool-info">' +
                '<label class="tool-name" for="tool-' + escHtml(t.id) + '" style="cursor:pointer">' + escHtml(t.displayName) +
                ' <span style="font-weight:400;font-size:11px;opacity:0.7">(' + escHtml(t.id) + ')</span></label>' +
                '<div class="tool-desc">' + escHtml(t.displayDescription) + '</div>' +
                '</div></div>';
        }).join('');

        list.querySelectorAll('.tool-check').forEach(cb => {
            cb.addEventListener('change', () => { updateCheckAll(); updateInsertButton(); });
        });
    }

    function getCheckedTools() {
        return Array.from(document.querySelectorAll('.tool-check:checked'))
            .map(cb => {
                const item = cb.closest('.tool-item');
                return item ? item.getAttribute('data-id') : null;
            })
            .filter(Boolean);
    }

    function updateCheckAll() {
        const all = document.querySelectorAll('.tool-check');
        const checked = document.querySelectorAll('.tool-check:checked');
        const checkAll = document.getElementById('checkAll');
        if (checkAll) {
            checkAll.indeterminate = checked.length > 0 && checked.length < all.length;
            checkAll.checked = checked.length === all.length && all.length > 0;
        }
    }

    document.getElementById('checkAll').addEventListener('change', function() {
        const allChecks = document.querySelectorAll('.tool-check');
        allChecks.forEach(cb => { cb.checked = this.checked; });
        updateInsertButton();
    });

    // ----------------------------------------------------------------
    // 挿入ボタン制御
    // ----------------------------------------------------------------
    function updateInsertButton() {
        const btn = document.getElementById('btnInsert');
        const hint = document.getElementById('selectionHint');
        let enabled = false;
        let hintText = '';

        if (currentTab === 'snippets' && selectedSnippetId) {
            const s = snippets.find(x => x.id === selectedSnippetId);
            if (s) {
                enabled = true;
                hintText = '選択: ' + s.title;
            }
        } else if (currentTab === 'skills' && selectedSkillName) {
            const sk = skills.find(x => x.name === selectedSkillName);
            if (sk) {
                enabled = true;
                hintText = '選択: ' + sk.displayName;
            }
        } else if (currentTab === 'tools') {
            const checked = getCheckedTools();
            if (checked.length > 0) {
                enabled = true;
                hintText = checked.length + ' ツール選択中';
            }
        }

        btn.disabled = !enabled;
        hint.textContent = hintText;
    }

    // ----------------------------------------------------------------
    // 挿入テキスト生成
    // ----------------------------------------------------------------
    function buildInsertText() {
        if (currentTab === 'snippets' && selectedSnippetId) {
            const s = snippets.find(x => x.id === selectedSnippetId);
            return s ? s.body : null;
        }

        if (currentTab === 'skills' && selectedSkillName) {
            // T3.5: 「### 利用可能スキル\n- skill-name」形式
            return '### 利用可能スキル\n- ' + selectedSkillName;
        }

        if (currentTab === 'tools') {
            // T3.6: 「### 利用ツール\nTools: Read, Edit, Bash」形式
            const checked = getCheckedTools();
            if (checked.length === 0) { return null; }
            return '### 利用ツール\nTools: ' + checked.join(', ');
        }

        return null;
    }

    function doInsert() {
        const text = buildInsertText();
        if (text === null) { return; }
        vscode.postMessage({ type: 'insert', text });
    }

    document.getElementById('btnInsert').addEventListener('click', doInsert);
    document.getElementById('btnCancel').addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });

    // ----------------------------------------------------------------
    // ユーティリティ
    // ----------------------------------------------------------------
    function escHtml(str) {
        if (!str) { return ''; }
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ----------------------------------------------------------------
    // 初期レンダリング
    // ----------------------------------------------------------------
    renderSnippets();
</script>
</body>
</html>`;
}
