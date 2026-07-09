/**
 * modelCatalog.ts — CSM が扱う Claude モデルの単一真実源（Single Source of Truth）
 *
 * v0.5.14 で新設。従来モデルリテラルが 13 ファイル以上に分散していた（型 union 重複、
 * tagTreeProvider は完全コピペ、色は 4 ファイルに同色直書き）ため、以下の情報を
 * 1 か所に集約する。
 *
 * - モデルの CSM 内部名（`CsmModel`）
 * - CLI（frontmatter）に書き込むエイリアス
 * - JSONL 上の Claude 公式モデル ID プレフィックス
 * - UI 表示ラベル / 頭文字（全角 1 文字）
 * - 色（HEX と VS Code テーマ色）
 * - 1M コンテキストフラグ / effort=max 許可フラグ
 *
 * 追加/削除するときは **このファイルだけ**編集すれば全 UI に反映される。
 *
 * ⚠️ Fable 5 は v0.5.6〜v0.5.13 の間「組織方針で非選択」として除外されていたが、
 *    Fable 5 が一般提供された現在は選択可能に戻す（v0.5.14 で解禁、オーナー承認 2026-07-09）。
 */

/** CSM が扱うモデル名（CSM 内部の union） */
export type CsmModel =
	| 'fable'
	| 'fable-1m'
	| 'opus'
	| 'opus-1m'
	| 'sonnet'
	| 'sonnet-1m'
	| 'haiku';

/** モデル定義（1 モデルあたりの全情報） */
export interface ModelDefinition {
	/** CLI（frontmatter）に書き込む値。Claude Code が起動時に最新モデルに解決する */
	cliValue: string;
	/** JSONL 上の Claude 公式モデル ID プレフィックス（例: 'claude-opus-'） */
	idPrefix: string;
	/** UI 表示ラベル（例: 'Opus 1M'） */
	label: string;
	/** ツリー等で使う頭文字（全角 1 文字） */
	char: string;
	/** カード等で使う HEX 色 */
	colorHex: string;
	/** VS Code TreeView 用のテーマ色 ID（例: 'charts.purple'） */
	themeColor: string;
	/** 1M コンテキストモデルか */
	is1m: boolean;
	/** effort=max を選べるか（Opus / Fable 系のみ許可） */
	allowsMaxEffort: boolean;
	/** 短い説明（フォームのラジオ下に出す） */
	description: string;
}

/**
 * モデルカタログ本体。**この定義に追記するだけで、全 UI・CLI・正規化に反映される。**
 */
export const MODEL_CATALOG: Record<CsmModel, ModelDefinition> = {
	fable: {
		cliValue: 'fable',
		idPrefix: 'claude-fable-',
		label: 'Fable',
		char: 'Ｆ',
		colorHex: '#ffd54f',
		themeColor: 'charts.yellow',
		is1m: false,
		allowsMaxEffort: true,
		description: 'Fable 5 — 最上位の判断・複雑な設計（Opus と同格）',
	},
	'fable-1m': {
		cliValue: 'fable[1m]',
		idPrefix: 'claude-fable-',
		label: 'Fable 1M',
		char: 'Ｆ',
		colorHex: '#ffd54f',
		themeColor: 'charts.yellow',
		is1m: true,
		allowsMaxEffort: true,
		description: 'Fable 5 + 1M 長文コンテキスト',
	},
	opus: {
		cliValue: 'opus',
		idPrefix: 'claude-opus-',
		label: 'Opus',
		char: 'Ｏ',
		colorHex: '#b388ff',
		themeColor: 'charts.purple',
		is1m: false,
		allowsMaxEffort: true,
		description: 'Opus 4.8 — 最高度の判断・複雑な開発（デフォルト high effort）',
	},
	'opus-1m': {
		cliValue: 'opus[1m]',
		idPrefix: 'claude-opus-',
		label: 'Opus 1M',
		char: 'Ｏ',
		colorHex: '#b388ff',
		themeColor: 'charts.purple',
		is1m: true,
		allowsMaxEffort: true,
		description: 'Opus 4.8 + 1M 長文コンテキスト（大規模調査・大量ファイル）',
	},
	sonnet: {
		cliValue: 'sonnet',
		idPrefix: 'claude-sonnet-',
		label: 'Sonnet',
		char: 'Ｓ',
		colorHex: '#64b5f6',
		themeColor: 'charts.blue',
		is1m: false,
		allowsMaxEffort: false,
		description: 'Sonnet（最新世代） — 定型作業・補助（コスト効率◎）',
	},
	'sonnet-1m': {
		cliValue: 'sonnet[1m]',
		idPrefix: 'claude-sonnet-',
		label: 'Sonnet 1M',
		char: 'Ｓ',
		colorHex: '#64b5f6',
		themeColor: 'charts.blue',
		is1m: true,
		allowsMaxEffort: false,
		description: 'Sonnet（最新世代） + 1M 長文コンテキスト・定型作業',
	},
	haiku: {
		cliValue: 'haiku',
		idPrefix: 'claude-haiku-',
		label: 'Haiku',
		char: 'Ｈ',
		colorHex: '#81c784',
		themeColor: 'charts.green',
		is1m: false,
		allowsMaxEffort: false,
		description: 'Haiku（最新世代） — 軽量タスク・高速応答',
	},
};

/** 全モデル ID を取得（型安全な列挙用） */
export const CSM_MODELS: readonly CsmModel[] = Object.freeze(
	Object.keys(MODEL_CATALOG) as CsmModel[],
);

/**
 * 判定順序: fable → [1m] → opus → haiku → sonnet（デフォルト）
 *
 * ⚠️ 重要: [1m] 判定より前に fable を判定しないと、`claude-fable-5[1m]` が
 *    sonnet-1m に化ける（v0.5.13 までのバグ C-1）。
 */
export function normalizeModel(raw: string): CsmModel {
	const lower = String(raw || '').toLowerCase();

	// 短縮名エイリアス（完全一致）
	if (lower === 'fable') { return 'fable'; }
	if (lower === 'fable-1m') { return 'fable-1m'; }
	if (lower === 'opus') { return 'opus'; }
	if (lower === 'opus-1m') { return 'opus-1m'; }
	if (lower === 'haiku') { return 'haiku'; }
	if (lower === 'sonnet-1m') { return 'sonnet-1m'; }

	// 正式 ID / CLI 値からの逆変換
	// ⚠️ [1m] 判定より fable 判定を **先に**行う（C-1 バグ対策）
	if (lower.includes('fable')) {
		return lower.includes('[1m]') ? 'fable-1m' : 'fable';
	}
	if (lower.includes('[1m]')) {
		return lower.includes('opus') ? 'opus-1m' : 'sonnet-1m';
	}
	if (lower.includes('opus')) { return 'opus'; }
	if (lower.includes('haiku')) { return 'haiku'; }
	return 'sonnet';
}

/** モデル → CLI 値マップ（frontmatter 書き込み用） */
export function getModelCliMap(): Record<CsmModel, string> {
	const out = {} as Record<CsmModel, string>;
	for (const key of CSM_MODELS) {
		out[key] = MODEL_CATALOG[key].cliValue;
	}
	return out;
}

/** モデル → 頭文字（TreeView / タブ用） */
export function getModelChar(model: CsmModel | string | undefined): string {
	if (!model) { return '　'; }
	const def = MODEL_CATALOG[model as CsmModel];
	if (def) { return def.char; }
	// 未知のモデル: 生文字列から推測（サブエージェント JSONL 由来など）
	const lower = String(model).toLowerCase();
	if (lower.includes('fable')) { return 'Ｆ'; }
	if (lower.includes('[1m]')) { return '１'; }
	if (lower.includes('opus')) { return 'Ｏ'; }
	if (lower.includes('sonnet')) { return 'Ｓ'; }
	if (lower.includes('haiku')) { return 'Ｈ'; }
	return '？';
}

/** モデル → 表示ラベル */
export function getModelLabel(model: CsmModel): string {
	return MODEL_CATALOG[model]?.label ?? String(model);
}

/** モデル → TreeView 用のアイコン + テーマ色（sessionTreeProvider の getModelIcon 相当） */
export function getModelIconAndColor(model: string | undefined): { icon: string; color: string } {
	if (!model) { return { icon: 'comment-discussion', color: 'foreground' }; }
	const lower = model.toLowerCase();
	// 判定順序は normalizeModel と同じ（fable が最優先）
	if (lower.includes('fable')) {
		return { icon: 'star-full', color: MODEL_CATALOG.fable.themeColor };
	}
	if (lower.includes('[1m]')) {
		return { icon: 'zap', color: 'charts.orange' }; // 1M は既存の橙色を維持
	}
	if (lower.includes('opus')) {
		return { icon: 'sparkle', color: MODEL_CATALOG.opus.themeColor };
	}
	if (lower.includes('sonnet')) {
		return { icon: 'zap', color: MODEL_CATALOG.sonnet.themeColor };
	}
	if (lower.includes('haiku')) {
		return { icon: 'flame', color: MODEL_CATALOG.haiku.themeColor };
	}
	return { icon: 'comment-discussion', color: 'foreground' };
}

/**
 * webview で使う CSS 断片を生成する。
 * `.badge-<model>`（agent-badge）と `.model-<model>` / `.dot-<model>`（mainTab / projectDetail）を
 * カタログから一括で吐く。
 */
export function generateModelCss(prefix: 'badge' | 'model' | 'dot'): string {
	const rules: string[] = [];
	for (const key of CSM_MODELS) {
		const def = MODEL_CATALOG[key];
		// HEX #rrggbb → rgba() に変換して背景アルファを付与
		const rgba = (hex: string, a: number): string => {
			const h = hex.replace('#', '');
			const r = parseInt(h.slice(0, 2), 16);
			const g = parseInt(h.slice(2, 4), 16);
			const b = parseInt(h.slice(4, 6), 16);
			return `rgba(${r},${g},${b},${a})`;
		};
		if (prefix === 'dot') {
			rules.push(`.dot-${key} { background: ${def.colorHex}; }`);
		} else {
			rules.push(
				`.${prefix}-${key} { background: ${rgba(def.colorHex, 0.15)}; color: ${def.colorHex}; border: 1px solid ${rgba(def.colorHex, 0.3)}; }`,
			);
		}
	}
	return rules.join('\n');
}
