// 既存agents/*.mdファイルのバックスラッシュ増殖を正規化
// 1回限りの実行スクリプト
//
// 例: "c:\\\\\\\\workspace" → "c:\\workspace"

const fs = require('fs');
const path = require('path');
const os = require('os');

// スキャン対象ディレクトリ
const targets = [
	path.join(os.homedir(), '.claude', 'agents'),
	'c:/workspace/CMS/.claude/agents',
	'c:/GDrive/.claude/agents',
];

let fixed = 0;
let scanned = 0;

function normalizeBackslashes(str) {
	// ダブルクォート内の \\ を再帰的に \ にデコードする
	// 正しい状態（エスケープ1重）で止まる必要があるので、対称的にデコードする
	// 例: \\\\\\\\ (8個) → 4 → 2 → 1 （正しい状態）
	// 例: \\\\ (4個) → 2 → 1
	// 例: \\ (2個・正常) → 1 → そのまま
	// YAMLの正しい状態はエスケープ前の文字列なので、バックスラッシュ1個に揃える
	// 偶数個のバックスラッシュは2個ずつペアにして半分にする
	while (str.match(/\\\\\\\\/)) {
		str = str.replace(/\\\\\\\\/g, '\\\\');
	}
	return str;
}

function processFile(filePath) {
	scanned++;
	let content;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch {
		return;
	}

	// YAMLフロントマター内のダブルクォート文字列のバックスラッシュを正規化
	const lines = content.split('\n');
	let inFrontmatter = false;
	let changed = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === '---') {
			if (!inFrontmatter) {
				inFrontmatter = true;
				continue;
			} else {
				break; // フロントマター終了
			}
		}
		if (!inFrontmatter) { continue; }

		// key: "value" のパターン
		const m = line.match(/^([a-zA-Z_]\w*):\s*"(.*)"$/);
		if (!m) { continue; }

		const key = m[1];
		const value = m[2];
		if (!value.includes('\\\\\\\\')) { continue; } // \\\\ 以上含まない → スキップ

		const normalized = normalizeBackslashes(value);
		if (normalized !== value) {
			lines[i] = `${key}: "${normalized}"`;
			changed = true;
			console.log(`  ${path.basename(filePath)}: ${key}: ${value.length}文字 → ${normalized.length}文字`);
		}
	}

	if (changed) {
		fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
		fixed++;
	}
}

for (const dir of targets) {
	if (!fs.existsSync(dir)) {
		console.log(`SKIP (存在しない): ${dir}`);
		continue;
	}
	console.log(`\n[${dir}]`);
	const entries = fs.readdirSync(dir);
	for (const entry of entries) {
		if (!entry.endsWith('.md')) { continue; }
		processFile(path.join(dir, entry));
	}
}

console.log(`\n完了: ${fixed}件修正 / ${scanned}件スキャン`);
