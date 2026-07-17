# QAテキストレビュー報告書 — v0.5.31 Marketplace公開前 総点検（ドキュメントそぎ落とし後）

- **対象**: `claude-session-manager` v0.5.31 の未コミット変更
  - `README.md` / `CHANGELOG.md` / `guide.html` / `package.json` / `docs/`（archive 退避含む）
- **背景**: v0.5.22〜v0.5.31 の機能追加後、ドキュメントを大幅スリム化（CHANGELOG 2963→129 行、README のバージョン言及 41→9 箇所、guide.html 3596→3489 行、docs/ 現行 → archive 退避）した直後の状態
- **突き合わせ基準**: `package.json`（`contributes`）、`CHANGELOG.md`、実装ソース（`src/`）
- **レビュー担当**: 品質管理部（qa）
- **実施日**: 2026-07-17
- **前回**: [qa-text-review-v0.5.21.md](archive/qa-text-review-v0.5.21.md)（HIGH1/MEDIUM4/LOW6 → 後述のとおり主要 2 件は解消済み）

---

## 総合判定：🟡 修正後公開（Fix-then-publish）

**Marketplace の商品ページに直接表示される成果物（`package.json` の `displayName`/`description`、`README.md`）は公開可能な品質**です。設定 42 項目すべてが `package.json` の `contributes.configuration` と名称・型・既定値まで一致し、v0.5.22〜v0.5.31 の新機能はすべて README にユーザー向けに記載され、存在しない機能（幻の機能）の記載もなく、バージョン表記（0.5.31）は全ファイルで一貫していました。前回 v0.5.21 の指摘（アンカー破損・右クリック表の乖離）も解消済みです。

一方、**副次的な使い方ガイド `guide.html` に、そぎ落とし後も残った陳腐化テキストが 3 件**あります。特に **effort=max の記載が v0.5.22 の「全モデル選択可」緩和に追従しておらず、実装・README・CHANGELOG と矛盾**（HIGH）。また内部ロードマップ `docs/v0.6.0-roadmap.md` に **archive 退避に伴うリンク切れ**（MEDIUM）があります。

いずれも小さなテキスト修正で対応可能で、CRITICAL（公開ブロック）は 0 件のため差し戻しには当たりません。**下記 HIGH と guide.html の MEDIUM を修正のうえ公開**を推奨します（README のみで判断すれば公開可の水準）。

### 重要度別 指摘件数

| 重要度 | 件数 | 公開への影響 |
|--------|------|-------------|
| 🔴 CRITICAL | 0 | — |
| 🟠 HIGH | 1 | 公開前修正を推奨（guide.html の事実誤り） |
| 🟡 MEDIUM | 3 | guide.html 2 件は公開前が望ましい／roadmap 1 件は内部 |
| 🔵 LOW | 4 | 公開後フォローアップで可 |
| **合計** | **8** | |

### 前回 v0.5.21 指摘の解消状況（確認済み）

- ✅ **H-1（旧）**: guide.html「セクション5」アンカー破損 → L1675 に `id="sec-viewer"` 付与済み、リンクも `#sec-viewer` に修正済み。
- ✅ **M-2（旧）**: README エージェント右クリック表の「セッションを開く」乖離 → 実メニュー名（プレビュー画面を開く / Claude で開く（IDE）/ ターミナルで開く（ルール適用）等）に更新済み。
- ✅ **M-4（旧）**: `locale`/`ui.defaultTab` の文言 → 「です」調・全半角・「既定」表記に統一済み（package.json L1303/L1325）。
- ✅ **L-2（旧）**: Opus 版数ハードコード → README モデル表は「（最新世代）」表記に改善（※ guide.html には旧「Opus 4.8」が残存。後述 L-1）。

---

## 🟠 HIGH（1件）

### H-1: guide.html の effort=max 記載が「Opus/Fable 系専用」のまま（v0.5.22 の緩和に未追従）

- **該当箇所**: `guide.html`
  - L3187: 「Max は **Opus / Fable 系専用**（他モデルではグレーアウト）。」
  - L3222: 「Fable / Opus: 全項目有効（Effort Max を含む） / **Sonnet: Effort Max のみ無効 / Haiku: Effort Max が無効**。」
- **現状の正しい挙動（v0.5.22 で緩和）**:
  - `CHANGELOG.md` L68: 「`effort=max` を全モデル選択可に緩和。」
  - `README.md` L23: 「`max` は全モデル選択可（コスト大につき Opus / Fable 系推奨）。」
  - 実装 `src/panels/agentFormPanel.ts` L651: Max オプションのサブラベルは「最大（コスト大 — **上位モデル推奨**）」＝**専用ではなく推奨**。モデル別グレーアウトの記述は撤去済み。
- **問題**: guide.html §14 のみ旧仕様（Max は Opus/Fable 専用・Sonnet/Haiku でグレーアウト）を記載しており、**実装・README・CHANGELOG のいずれとも矛盾する事実誤り**。ガイド読者は「Sonnet/Haiku では Max を使えない」と誤認する（実際は選択可能）。
- **修正案**:
  - L3187 → 「Low / Medium / High / XHigh / Max の 5 段階。**Max は全モデルで選択可能**（コスト大のため Opus / Fable 系推奨）。」
  - L3222 → 「モデルを変更しても Effort は全モデルで選択可能です（Max はコスト大のため上位モデル推奨）。」等、グレーアウト記述を削除。

---

## 🟡 MEDIUM（3件）

### M-1: guide.html §7 の操作 Tip が旧 Cytoscape カード組織図由来で陳腐化

- **該当箇所**: `guide.html` L2203（tip）
  > 各カードの📋でセッションIDコピー、▶で会話履歴プレビュー、⚡でClaude Codeで直接開く。
- **問題**: v0.5.23 で組織図は Canvas 自前実装のグラフ + 縦型ツリー/グループへ全面刷新され、Cytoscape/ELK を撤去（CHANGELOG L62）。現行 `src/panels/orgChartPanel.ts` には旧カードの `renderSessionActions` / `SVG_CLAUDE` / 📋・⚡ アクションが見当たらず、ソース内コメントも「旧: カード階層 → ファイルツリー風に差し替え」（L970）。この Tip は**削除済みの旧 UI の操作を説明**しており、新グラフのノード操作（クリック/ドラッグ、ダブルクリックでフィット等）と不一致。
- **影響**: 実在しない操作の案内 ＝ 実質的な「幻の機能」記載。
- **修正案**: 現行の操作（ノードのドラッグ再配置、ホバー減光、ダブルクリック/⤢ で全体フィット、ノードクリックからの各アクション）に書き換え。旧 📋/▶/⚡ カード操作の記述は削除。

### M-2: guide.html §0.5「新機能ハイライト」が v0.4.x 止まりで陳腐化

- **該当箇所**: `guide.html` L1041（見出し）/ L1045（リード文）
  > ★ v0.4.2〜v0.4.4 新機能ハイライト
  > CSM を v0.4.1 以前から更新した方向けに、**この1年の主要な変更点**を先にまとめます。
- **問題**: v0.5.31 時点のガイドで、冒頭（セクション 0.5）に置かれた「新機能ハイライト」が **v0.4.4 までしかカバーしていない**。「この1年の主要な変更点」と称しながら、直近 1 年で最も大きい v0.5 系（組織図リデザイン・ビューワー高速化・ライブ状態ツリー化・新ウィンドウ起動 等）に触れていない。前バージョンに存在した「v0.5.14〜v0.5.21 新機能ハイライト」節がスリム化で削除され、**古い方だけが残置**した状態。
- **影響**: 最新版へ更新したユーザーが冒頭で古い情報に誘導され、Marketplace ガイドとしての鮮度感を損なう。
- **修正案（いずれか）**: (A) §0.5 を削除し各機能セクション本文に集約する／(B) v0.5.22〜v0.5.31 のハイライト（CC 追従・Obsidian 風組織図・ズーム/パン・ライブ状態ツリー・新ウィンドウ起動・一覧高速化）に更新する。README 冒頭「主な機能」と粒度を合わせるのが簡便。

### M-3: docs/v0.6.0-roadmap.md — archive 退避に伴うリンク切れ + 組織図の陳腐化記述（内部）

- **該当箇所**: `docs/v0.6.0-roadmap.md`
  - L8-10・L113・L115: `./v0.5.x-cc-compat-qa.md` / `./v0.5.x-feature-audit.md` / `./v0.5.x-workflows-integration.md` / `./v0.5.x-menu-redesign-2.md` への相対リンク。**いずれも今回 `docs/archive/` へ退避済み**のため、`docs/` 直下からの相対パスは**リンク切れ**。
  - L53・L134: 現行組織図を「`orgChartPanel`（Cytoscape）」「組織図 (Cytoscape + ELK)」と記述。v0.5.23 で Canvas 化・Cytoscape 撤去済みのため**陳腐化**。
- **影響**: `v0.6.0-roadmap.md` は**内部の前向き計画文書**であり、README / Marketplace からはリンクされていない（ユーザー影響なし）。ただし本レビュー観点 (5)「他ドキュメントからのリンク切れ」の具体例。
- **修正案**: リンク先を `./archive/v0.5.x-*.md` に更新（または archive 前提の注記）。Cytoscape 記述は「Canvas 自前実装（v0.5.23〜）」に更新。ロードマップは時点スナップショットのため優先度は低いが、参照追跡性の維持のため軽微修正を推奨。
- **良い点**: `docs/archive/README.md` が退避物の索引 + 「現行 docs/（archive 対象外）」の明示を備えており、退避判断の追跡性は確保されている。README/guide.html 側には archive 済みファイルへの参照は検出されず（＝ユーザー向けリンク切れなし）。

---

## 🔵 LOW（4件）

### L-1: guide.html にモデル版数のハードコード「Opus 4.8」が残存（README は「最新世代」表記）
- `guide.html` L643「深い推論（**Opus 4.8** デフォルト・推奨）」ほか、モデル選択リストに「Claude Opus 4.8」表記が残る。README モデル表（L138-141）は「Opus（最新世代）」へ改善済みのため、README↔guide で版数表現が不揃い。エイリアス→最新解決という思想に合わせ、guide 側も「最新世代」または版数注記の統一を推奨。

### L-2: guide.html にライブ状態ビュー（v0.5.24）の独立説明が乏しい
- README には「🟢 ライブ状態ビュー」節（L73-77）でエージェント別 2 階層ツリー・未定義グループ・経過時間が明記されているが、guide.html には §7 で「ライブ状態未定義」に一度触れるのみで、ツリー化の独立解説がない。エージェント一覧の 2 段レンダリング高速化（v0.5.30）も guide 未記載（perf 改善のため許容範囲）。README がカバーしているため公開ブロックではないが、guide 追補が望ましい。

### L-3: README「直近の主な変更」リストが v0.5.22（CC 追従）を省略
- `README.md` L439-447 の変更履歴ハイライトは v0.5.31/30/29/27/26/25/24/23/20 を列挙し、**v0.5.22（公式メタ活用・`claude agents --json` 非依存）を省略**。curated リストとして許容範囲であり、要点は「Claude Code への追従」節（L26-27）で補完されているが、ユーザー価値のある変更のため 1 行追加を検討。

### L-4: guide.html 全体にバージョン注記が多く、スリム化のトーンと不揃い
- 各セクション本文に「v0.4.0 で移行」「v0.4.2〜」等の版数注記が多数残存。事実としては正しいが、README/CHANGELOG のそぎ落としトーンと比べ guide は「v0.4.x 中心」の古い印象。任意の整理対象（機能説明としては版数を落としても成立する箇所が多い）。

---

## 確認できた「正確性・網羅性」ポイント（合格項目）

観点 (1)〜(6) に沿って、以下は問題なしを確認:

- **【観点1 最重要】新機能の記載漏れなし**: v0.5.22〜v0.5.31 の主要機能はすべて README に記載。
  - CC 追従・公式メタ（`kind`/`entrypoint`/`version`/`name`/`nameSource`）活用・`claude agents --json` 非依存 → README L26-27 ✓
  - 組織図 Obsidian 風グラフ / ズーム・パン / ルート絞り込み / 折りたたみ階層 → README L96-108・guide §7 ✓
  - ライブ状態ツリー化 + 未定義グループ → README L73-77 ✓
  - エージェント基本情報のフォルダパス / 「Claude で開く」新ウィンドウ起動（全 7 経路） → README L68-69・guide L2113-2119 ✓
  - エージェント一覧 2 段レンダリング高速化 → README L67 ✓
- **【観点1】幻の機能なし**: README 記載機能はすべて実装／CHANGELOG に裏付け（唯一 guide §7 tip が旧 UI 記述 ＝ M-1 で指摘）。
- **【観点2】設定の完全一致**: README「設定項目」表の 42 キーすべてが `package.json` の `contributes.configuration` と名称・型・既定値まで一致。新設定も網羅:
  - `orgChart.defaultMode`(graph) / `orgChart.hideOtherProjects`(false) / `orgChart.showGlobal`(false) / `orgChart.defaultRoot`("") ✓
  - `agent.openInNewWindowWhenFolderMismatch`(true) ✓
  - `agents.showUnregisteredLive`(true) ✓
  - `preview.*` / `agents.*` / `usage.*` 系すべて一致 ✓
  - 記載漏れ・幻の設定・既定値の誤りなし。
- **【観点2】コマンド名の一致**: README コマンド一覧・右クリック表が `contributes.commands` の title と一致。README L215「ターミナルで開く（ルール適用）＝ `claude --agent` 起動」も実装（`agentCommands.ts` L49 `['claude','--agent',agent.name]`）と一致。
- **【観点3】Marketplace 適性**: `displayName`/`description` は適切。README に開発経緯の残骸（「v0.5.23 でリデザイン」等）は機能説明本文には無く、版数言及は末尾「変更履歴」節に限定（適切）。組織図見出しから旧「（Cytoscape.js）」表記も除去済み。README/guide.html に Cytoscape 等の撤去済み技術への言及なし（クリーン）。
- **【観点4】CHANGELOG 圧縮の妥当性**: 冒頭に「ユーザー向けの主な変更点のみ／内部作業ログは Git 参照」と方針明記。v0.5.14〜v0.5.31 は各 1 段落、v0.5.0〜v0.5.13 はマイルストーン要約に集約。ユーザーが知るべき変更（設定名・既定値・挙動変更）は保持され、レビュー修正の詳細等の内部情報は適切に除去。過剰な内部残骸なし。
- **【観点5】archive 退避**: `docs/archive/README.md` の索引で追跡性を確保。README/guide からのユーザー向けリンク切れなし（内部 roadmap の 1 件のみ M-3 で指摘）。
- **【観点6】バージョン整合**: `package.json`(0.5.31) / README（本文・VSIX 名 `claude-session-manager-0.5.31.vsix`・変更履歴） / `guide.html`（`<title>` L11・ヒーロー L917） / `CHANGELOG`（v0.5.31）すべて 0.5.31 で一貫。CC バージョン（2.1.113 必須 / 2.1.19x 推奨 / 2.1.141+ デスクトップ通知）も一貫。

---

## 本レビューで確認しきれなかった点（-p モードにつき明記）

1. **`git diff` は未取得**: 本セッションに Bash ツールが無いため、差分そのものではなく**各ファイルの現状**（未コミット変更を含む作業ツリー）を基準にレビュー。CHANGELOG v0.5.31 記載のスリム化範囲と現状は整合しており、結論に影響しないと判断。
2. **docs/ の「22→2 ファイル」の実数**: 現状 `docs/` 直下には仕様 HTML 6 本・`csm-governance-integration.md`・`v0.6.0-roadmap.md`・`session-flow.drawio` + `qiita/`/`mockups/`/`feedback/` が残存。指示の「2 ファイル」と一致しないが、`docs/archive/README.md` が「現行 docs/（archive 対象外）」として明示しており、意図的な残置と解釈（現行仕様書 HTML 群を archive せず残す判断）。仕様 HTML 群を現行とみなすかは担当部署の意図確認を推奨。
3. **guide.html §7 tip / 組織図ノード操作の厳密な現行仕様**: orgChartPanel のソースから旧カードアクション不在は確認したが、新グラフノードのクリック時アクション一覧までは精査していない。M-1 の書き換え時に現行ノード操作を実機確認のうえ反映を。
4. **`LICENSE` 同梱**: README L453 `[MIT](LICENSE)` の相対リンク先ファイルの存在・`.vscodeignore` 除外有無は未検証。公開前に確認推奨。

---

## 推奨アクション（優先順）

1. **[HIGH] H-1** — guide.html §14 の effort=max 記載を「全モデル選択可（上位モデル推奨）」に修正（公開前）
2. **[MEDIUM] M-1 / M-2** — guide.html §7 の旧カード操作 Tip、§0.5 の陳腐化ハイライトを更新／削除（公開前が望ましい）
3. **[MEDIUM] M-3** — `docs/v0.6.0-roadmap.md` の archive リンク切れ・Cytoscape 記述を修正（内部・フォロー可）
4. **[LOW] L-1〜L-4** — guide の版数表記統一・ライブ状態ビュー追補等（公開後フォローアップ）

> 本報告書は指摘と修正案の提示に留めています。ソース・設定・ドキュメント本体の修正は担当部署にて実施してください。
