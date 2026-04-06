// 親子エージェント同期: 子エージェントの追加・削除・変更時に親のルールファイルを自動更新
// 仕様書: docs/parent-child-sync-spec.html

import * as fs from 'fs';
import * as vscode from 'vscode';
import { AgentConfig } from './types';
import * as dataStore from './dataStore';
import { resolveRuleFilePath } from './agentManager';

// マーカー定数
const START_MARKER = '<!-- CSM:CHILDREN:START -->';
const END_MARKER = '<!-- CSM:CHILDREN:END -->';

// 排他制御用ロック（親名ごと）
const syncLocks = new Map<string, Promise<void>>();

// Markdownテーブルのセル値をエスケープ（パイプ・改行）
function escapeTableCell(value: string): string {
	return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// 子エージェント一覧からマーカー付きMarkdownセクションを生成
function buildChildrenSection(children: AgentConfig[]): string {
	if (children.length === 0) { return ''; }

	const lines: string[] = [
		START_MARKER,
		'## 配下エージェント',
		'',
		'| 部署名 | モデル | 役割 | セッションモード |',
		'|--------|--------|------|------------------|',
	];

	const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
	for (const c of sorted) {
		const name = escapeTableCell(c.name);
		const model = escapeTableCell(c.model);
		const mode = c.sessionMode === 'disposable' ? '使い捨て' : '固定';
		const role = escapeTableCell(c.role || '未設定');
		lines.push(`| ${name} | ${model} | ${role} | ${mode} |`);
	}

	lines.push('');
	lines.push('必要に応じて上記エージェントにタスクを委任してください。');
	lines.push(END_MARKER);

	return lines.join('\n');
}

// マーカーの状態
type MarkerState = 'valid' | 'corrupted' | 'absent';

interface ReplaceResult {
	content: string;
	state: MarkerState;
}

// 既存ファイル内容のマーカーセクションを置換（破損検出含む）
function replaceChildrenSection(content: string, newSection: string): ReplaceResult {
	const startIdx = content.indexOf(START_MARKER);
	const endIdx = content.indexOf(END_MARKER);

	// マーカー破損チェック（片方のみ存在 or 逆順）
	if ((startIdx !== -1) !== (endIdx !== -1)) {
		return { content, state: 'corrupted' };
	}
	if (startIdx !== -1 && startIdx > endIdx) {
		return { content, state: 'corrupted' };
	}

	if (startIdx !== -1 && endIdx !== -1) {
		// マーカー間を置換
		const before = content.substring(0, startIdx);
		const after = content.substring(endIdx + END_MARKER.length);

		if (newSection === '') {
			// 子が0件: セクションごと削除（前後の空行を正規化）
			const trimmedBefore = before.replace(/\n{2,}$/, '\n');
			const trimmedAfter = after.replace(/^\n{2,}/, '\n');
			return {
				content: trimmedBefore + trimmedAfter,
				state: 'valid',
			};
		}
		return { content: before + newSection + after, state: 'valid' };
	}

	// マーカーなし
	if (newSection === '') { return { content, state: 'absent' }; }
	return {
		content: content.trimEnd() + '\n\n' + newSection + '\n',
		state: 'absent',
	};
}

// 指定した親エージェントのルールファイルにある子エージェントセクションを再生成
async function doSync(parentName: string, outputChannel?: vscode.OutputChannel): Promise<void> {
	// 親エージェントの設定を取得
	const agents = await dataStore.getAgents();
	const parent = agents.find(a => a.name === parentName);
	if (!parent || !parent.ruleFile) { return; }

	// ルールファイルパスを解決
	let resolvedPath: string;
	try {
		resolvedPath = await resolveRuleFilePath(parent.ruleFile);
	} catch {
		return;
	}

	// ルールファイルを読み込み
	let content: string;
	try {
		content = await fs.promises.readFile(resolvedPath, 'utf-8');
	} catch {
		if (outputChannel) {
			outputChannel.appendLine(`[INFO] ${parentName} のルールファイルが存在しません: ${resolvedPath}`);
		}
		return;
	}

	// 子エージェント一覧を取得（全スコープ統合）
	const children = agents.filter(a => a.parentAgent === parentName);
	const newSection = buildChildrenSection(children);

	// マーカーセクションを置換
	const result = replaceChildrenSection(content, newSection);
	if (result.state === 'corrupted') {
		if (outputChannel) {
			outputChannel.appendLine(
				`[WARN] ${parentName} のルールファイルでCHILDRENマーカーが破損しています。` +
				`手動で修正するか、一括再生成コマンドを実行してください。`
			);
		}
		return;
	}

	// 内容が変わっていなければ書き込みをスキップ
	if (result.content === content) { return; }

	// ファイルに書き戻し
	try {
		await fs.promises.writeFile(resolvedPath, result.content, 'utf-8');
	} catch (err) {
		if (outputChannel) {
			outputChannel.appendLine(`[ERROR] ${parentName} のルールファイル書き込みに失敗: ${err}`);
		}
	}
}

/**
 * 親エージェントのルールファイルを同期する。
 * 排他制御付き（同じ親への同時書き込み防止）。
 */
export async function syncParentRuleFile(
	parentName: string | undefined,
	outputChannel?: vscode.OutputChannel
): Promise<void> {
	if (!parentName) { return; }

	const prev = syncLocks.get(parentName) || Promise.resolve();
	const current = prev
		.then(() => doSync(parentName, outputChannel))
		.catch((err) => {
			if (outputChannel) {
				outputChannel.appendLine(`[ERROR] ${parentName} の親ルール同期に失敗: ${err}`);
			}
		})
		.finally(() => {
			// 完了後にMapから削除（メモリリーク防止）
			if (syncLocks.get(parentName) === current) {
				syncLocks.delete(parentName);
			}
		});
	syncLocks.set(parentName, current);
	await current;
}

/**
 * 全エージェントの親ルールファイルを逐次再生成（リペア用コマンド）。
 */
export async function syncAllParentRuleFiles(outputChannel?: vscode.OutputChannel): Promise<void> {
	const agents = await dataStore.getAgents();
	const parentNames = new Set(
		agents.filter(a => a.parentAgent).map(a => a.parentAgent!)
	);
	for (const parentName of parentNames) {
		await syncParentRuleFile(parentName, outputChannel);
	}
}

/**
 * 循環参照を検出する。
 * childName を parentName の子として設定する場合に、
 * parentName の祖先チェーンに childName が含まれていないか検証。
 *
 * @returns true = 循環あり（設定不可）, false = 安全（設定可能）
 */
export function hasCircularRef(
	childName: string,
	parentName: string,
	agents: AgentConfig[]
): boolean {
	const agentMap = new Map(agents.map(a => [a.name, a]));
	const visited = new Set<string>();
	let current: string | undefined = parentName;

	while (current) {
		if (current === childName) { return true; }
		if (visited.has(current)) { return true; }
		visited.add(current);
		const agent = agentMap.get(current);
		current = agent?.parentAgent || undefined;
	}
	return false;
}

/**
 * 指定エージェントの全子孫名を返す（フォームの親候補絞り込み用）。
 */
export function getDescendants(agentName: string, agents: AgentConfig[]): Set<string> {
	const result = new Set<string>();
	const queue = [agentName];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const children = agents.filter(a => a.parentAgent === current);
		for (const child of children) {
			if (!result.has(child.name)) {
				result.add(child.name);
				queue.push(child.name);
			}
		}
	}
	return result;
}
