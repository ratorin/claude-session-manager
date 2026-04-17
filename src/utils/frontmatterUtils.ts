// YAML フロントマターのパース・生成・移行ユーティリティ
// v0.3.1: CSM:AUTO マーカー → YAML フロントマター方式への移行

import { AgentConfig } from '../models/types';

// パース結果
export interface ParsedFrontmatter {
	data: Record<string, string | number | boolean>;
	description: string; // description フィールド（自動生成テキスト）
	body: string;        // フロントマター以降の本文（カスタム部分）
}

// フロントマターの境界を検出
function findBounds(content: string): { yamlStart: number; yamlEnd: number; bodyStart: number } | null {
	if (!content.startsWith('---')) { return null; }
	// 最初の改行の後から検索
	const firstNewline = content.indexOf('\n');
	if (firstNewline < 0) { return null; }
	// 2番目の --- を探す（行頭にあるもの）
	const rest = content.substring(firstNewline + 1);
	const lines = rest.split('\n');
	let pos = firstNewline + 1;
	for (const line of lines) {
		if (line === '---' || line === '---\r') {
			return {
				yamlStart: firstNewline + 1,
				yamlEnd: pos,
				bodyStart: pos + line.length + 1, // --- + \n
			};
		}
		pos += line.length + 1;
	}
	return null;
}

// YAML フロントマターをパース
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
	const bounds = findBounds(content);
	if (!bounds) { return null; }

	const yamlText = content.substring(bounds.yamlStart, bounds.yamlEnd);
	const body = content.substring(bounds.bodyStart);
	const data: Record<string, string | number | boolean> = {};
	let description = '';

	const lines = yamlText.split('\n');
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const match = line.match(/^([a-zA-Z_]\w*):\s*(.*)/);
		if (match) {
			const key = match[1];
			const rawValue = match[2].trimEnd();

			if (rawValue === '|' || rawValue === '|+' || rawValue === '|-') {
				// リテラルブロックスカラー
				const blockLines: string[] = [];
				i++;
				while (i < lines.length) {
					const blockLine = lines[i];
					// インデント（2スペース）が続く間、またはラインの内容がある場合
					if (blockLine.startsWith('  ')) {
						blockLines.push(blockLine.substring(2));
					} else if (blockLine.trim() === '') {
						// 空行の次がインデントなしの key: パターンならブロック終了
						if (i + 1 < lines.length && /^[a-zA-Z_]\w*:\s/.test(lines[i + 1])) {
							break;
						}
						blockLines.push('');
					} else {
						break; // インデントが戻った → ブロック終了
					}
					i++;
				}
				const blockText = blockLines.join('\n').replace(/\n+$/, '');
				if (key === 'description') {
					description = blockText;
				} else {
					data[key] = blockText;
				}
				continue; // i は既にインクリメント済み
			} else {
				// 単一行の値
				if (rawValue === 'true') {
					data[key] = true;
				} else if (rawValue === 'false') {
					data[key] = false;
				} else if (/^\d+$/.test(rawValue)) {
					data[key] = parseInt(rawValue, 10);
				} else {
					data[key] = rawValue;
				}
			}
		}
		i++;
	}

	return { data, description, body };
}

// YAML インジェクション対策: description 内の危険な文字列をサニタイズ
export function sanitizeForYaml(value: string): string {
	// フロントマター終端マーカーの偽装を防止
	return value
		.replace(/^---$/gm, '\\-\\-\\-')
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// AgentConfig + description から YAML フロントマター文字列を生成
export function generateFrontmatter(config: AgentConfig, description: string): string {
	const lines: string[] = ['---'];

	lines.push(`name: ${config.name}`);
	lines.push(`model: ${config.model}`);
	if (config.effort) { lines.push(`effort: ${config.effort}`); }
	if (config.thinkingEnabled !== undefined) {
		lines.push(`thinking: ${config.thinkingEnabled}`);
	}
	if (config.scope) { lines.push(`scope: ${config.scope}`); }
	if (config.sessionId) { lines.push(`sessionId: ${config.sessionId}`); }
	if (config.parentAgent) { lines.push(`parentAgent: ${config.parentAgent}`); }
	if (config.role) { lines.push(`role: ${config.role}`); }

	// description はリテラルブロックスカラーで出力
	if (description) {
		const safeDesc = sanitizeForYaml(description);
		lines.push('description: |');
		for (const descLine of safeDesc.split('\n')) {
			lines.push(`  ${descLine}`);
		}
	}

	lines.push('---');
	return lines.join('\n');
}

// 既存内容のフロントマターのみ更新（本文は保持）
export function updateFrontmatterInContent(
	content: string,
	config: AgentConfig,
	description: string,
): string {
	const parsed = parseFrontmatter(content);
	if (parsed) {
		// フロントマターがある → 更新（本文はそのまま保持）
		const newFm = generateFrontmatter(config, description);
		return newFm + '\n' + parsed.body;
	}
	// フロントマターがない → 先頭に追加、既存内容は本文として保持
	const newFm = generateFrontmatter(config, description);
	return newFm + '\n\n' + content;
}

// CSM:AUTO マーカー形式から YAML フロントマター形式への移行
export function migrateAutoToYaml(content: string, config: AgentConfig): string {
	const START_MARKER = '<!-- CSM:AUTO:START -->';
	const END_MARKER = '<!-- CSM:AUTO:END -->';

	const startIdx = content.indexOf(START_MARKER);
	const endIdx = content.indexOf(END_MARKER);

	if (startIdx >= 0 && endIdx > startIdx) {
		// マーカー内 → description に移動
		const description = content.substring(startIdx + START_MARKER.length, endIdx).trim();
		// マーカー外 → 本文（カスタム部分）として保持
		const before = content.substring(0, startIdx).trim();
		const after = content.substring(endIdx + END_MARKER.length).trim();
		const body = [before, after].filter(s => s).join('\n\n');

		const frontmatter = generateFrontmatter(config, description);
		return body ? frontmatter + '\n\n' + body + '\n' : frontmatter + '\n';
	}

	// マーカーなし → 既にフロントマター形式か確認
	const parsed = parseFrontmatter(content);
	if (parsed) {
		// 既にフロントマター → description を更新
		return updateFrontmatterInContent(content, config, parsed.description);
	}

	// どちらでもない → 全体を本文として扱い（マイグレーション対象外）
	return content;
}

// フロントマターから description を取得（ファイル内容から）
export function extractDescription(content: string): string {
	const parsed = parseFrontmatter(content);
	if (parsed) { return parsed.description; }

	// CSM:AUTO 形式のフォールバック
	const START_MARKER = '<!-- CSM:AUTO:START -->';
	const END_MARKER = '<!-- CSM:AUTO:END -->';
	const startIdx = content.indexOf(START_MARKER);
	const endIdx = content.indexOf(END_MARKER);
	if (startIdx >= 0 && endIdx > startIdx) {
		return content.substring(startIdx + START_MARKER.length, endIdx).trim();
	}

	return '';
}

// ファイルが旧 CSM:AUTO 形式かどうか判定
export function isLegacyAutoFormat(content: string): boolean {
	return content.includes('<!-- CSM:AUTO:START -->');
}

// ファイルが YAML フロントマター形式かどうか判定
export function hasFrontmatter(content: string): boolean {
	return findBounds(content) !== null;
}

// H-1: 配列対応版フロントマターパーサー（agentFileManager.ts から統合）
// tools: ["Read", "Edit", ...] のようなJSON配列記法をサポート
export interface ParsedFrontmatterExtended {
	data: Record<string, string | number | boolean | string[]>;
	body: string;
}

export function parseFrontmatterExtended(content: string): ParsedFrontmatterExtended | null {
	const bounds = findBounds(content);
	if (!bounds) { return null; }

	const yamlText = content.substring(bounds.yamlStart, bounds.yamlEnd);
	const body = content.substring(bounds.bodyStart);
	const data: Record<string, string | number | boolean | string[]> = {};
	const yamlLines = yamlText.split('\n');
	let i = 0;

	while (i < yamlLines.length) {
		const line = yamlLines[i];
		const match = line.match(/^([a-zA-Z_]\w*):\s*(.*)/);
		if (match) {
			const key = match[1];
			const rawValue = match[2].trimEnd();

			// JSON配列記法: tools: ["Read", "Edit", ...]
			if (rawValue.startsWith('[')) {
				try {
					const parsed = JSON.parse(rawValue);
					if (Array.isArray(parsed)) {
						data[key] = parsed.map(String);
					} else {
						data[key] = rawValue;
					}
				} catch {
					data[key] = rawValue;
				}
			} else if (rawValue === '|' || rawValue === '|+' || rawValue === '|-') {
				// リテラルブロックスカラー
				const blockLines: string[] = [];
				i++;
				while (i < yamlLines.length) {
					const blockLine = yamlLines[i];
					if (blockLine.startsWith('  ')) {
						blockLines.push(blockLine.substring(2));
					} else if (blockLine.trim() === '') {
						if (i + 1 < yamlLines.length && /^[a-zA-Z_]\w*:\s/.test(yamlLines[i + 1])) {
							break;
						}
						blockLines.push('');
					} else {
						break;
					}
					i++;
				}
				data[key] = blockLines.join('\n').replace(/\n+$/, '');
				continue;
			} else if (rawValue === 'true') {
				data[key] = true;
			} else if (rawValue === 'false') {
				data[key] = false;
			} else if (/^\d+$/.test(rawValue)) {
				data[key] = parseInt(rawValue, 10);
			} else {
				// クォート除去 + エスケープ解除
				const quoteMatch = rawValue.match(/^(["'])(.*)\1$/);
				if (quoteMatch && quoteMatch[1] === '"') {
					// ダブルクォート: \\ → \, \" → " をデコード
					data[key] = quoteMatch[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
				} else if (quoteMatch) {
					// シングルクォート: エスケープなし
					data[key] = quoteMatch[2];
				} else {
					data[key] = rawValue;
				}
			}
		}
		i++;
	}

	return { data, body };
}
