# QAテキストレビュー報告書 — v0.5.21 Marketplace公開前 総点検

- **対象**: `claude-session-manager` v0.5.21 の未コミット変更（文言のみ）
  - `README.md` / `guide.html` / `package.json` / `SPEC.md` / `src/panels/webviewPanel.ts`
- **突き合わせ基準**: `package.json`（`contributes`）、`CHANGELOG.md` v0.5.14〜v0.5.21、実装ソース
- **レビュー担当**: 品質管理部（qa）
- **実施日**: 2026-07-10
- **レビュー種別**: テキスト正確性・Marketplace適性・表記統一・誤字/リンク・バージョン整合

---

## 総合判定：🟡 修正後公開（Fix-then-publish）

Marketplace の商品ページに直接表示される成果物（`package.json` の `displayName`/`description`、`README.md` の冒頭〜機能一覧・設定一覧・コマンド一覧）は**公開可能な品質**に達しています。存在しない機能の記載（幻の機能）はなく、設定デフォルト値・コマンド名・バージョン表記はすべて実装と一致していました。

一方で、**今回の v0.5.21 で新規追加された `guide.html` のアンカーリンク1件が実際には別セクションへスクロールする不具合**（HIGH）と、README の一部記述が実装と乖離している箇所（MEDIUM）が残っています。いずれも小さなテキスト/HTML修正で対応可能なため、**下記 HIGH・MEDIUM を修正のうえ公開**することを推奨します。LOW は公開後のフォローアップで問題ありません。

> CRITICAL（公開ブロック）は 0 件です。差し戻しには当たりません。

### 重要度別 指摘件数

| 重要度 | 件数 | 公開への影響 |
|--------|------|-------------|
| 🔴 CRITICAL | 0 | — |
| 🟠 HIGH | 1 | 公開前修正を強く推奨 |
| 🟡 MEDIUM | 4 | 公開前修正が望ましい／一部は既知の割り切り |
| 🔵 LOW | 6 | 公開後フォローアップで可 |
| **合計** | **11** | |

---

## 🟠 HIGH（1件）

### H-1: `guide.html` の「セクション 5」内部リンクが別セクションへスクロールする

- **該当箇所**: `guide.html` L3462（v0.5.21 新設の「v0.5.14〜v0.5.21 新機能ハイライト」内）
  ```html
  <a href="#" onclick="document.querySelector('.section-title').scrollIntoView(); return false;">セクション 5「会話ビューワー」</a>
  ```
- **問題**: `document.querySelector('.section-title')` はドキュメント内で**最初に出現する** `.section-title`（L935「0 起動方法」）を返す。各セクション見出しには `id` が付与されていない（L935〜L2536 を確認）。そのため「セクション 5「会話ビューワー」」をクリックすると **セクション0 の先頭にスクロール**してしまい、リンクラベルと挙動が不一致。
- **影響**: ガイド閲覧者を誤った位置へ誘導する機能不具合。今回の v0.5.21 で**新規追加**された記述であり、本 Sprint のスコープ内。
- **修正案（いずれか）**:
  - (A) セクション5の見出しに `id` を付け、アンカー遷移させる:
    ```html
    <!-- L1675 -->
    <div class="section-title" id="sec-viewer"><span class="num">5</span>会話ビューワー（v0.5.20 で高速化）</div>
    <!-- L3462 リンク側 -->
    <a href="#sec-viewer">セクション 5「会話ビューワー」</a>
    ```
  - (B) `querySelectorAll('.section-title')[6]` のようにインデックス指定へ変更（順序変更に脆いため非推奨）。
  - → **(A) を推奨**。

---

## 🟡 MEDIUM（4件）

### M-1: README「CLI で開く」の cwd 記述が実装のフォールバックを欠く

- **該当箇所**: `README.md` L48
  > **⌨ CLI で開く** — 新規ターミナルで `claude --resume <sid>` を実行（セッション作成時の cwd で起動）
- **実装**: `src/panels/webviewPanel.ts` L291-298 — `currentFullSession.cwd` があれば `translateWorkDirPath` で解決して使用するが、**cwd 不明時はワークスペースルートへフォールバック**して起動する。tooltip（同 L766-768）および `guide.html` L1717 では「cwd が JSONL から取れない場合はワークスペースルートで試行」と明記済み。
- **問題**: README のみフォールバック挙動の記載がなく、`guide.html`・実装・tooltip と不整合。断定的に「作成時の cwd で起動」と読める。
- **修正案**: README L48 に一言補足:
  > …（原則セッション作成時の cwd で起動。cwd が特定できない場合はワークスペースルートで試行）

### M-2: README「エージェント管理サイドバー」右クリック表が現行メニューと乖離

- **該当箇所**: `README.md` L191-198（右クリックメニュー表）
- **問題**: 先頭行「**セッションを開く** | 紐づけ済みセッションを Claude Code で開く」に相当するコマンド名は現行に存在しない。`package.json` の該当メニュー（`claudeAgents` の `agentItemLinked`）は以下:
  - `previewAgent`＝「プレビュー画面を開く」（L313-316）
  - `openAgentInClaude`＝「**Claude で開く（IDE）**」（L421-424）
  - `openAgentSession`＝「**ターミナルで開く（ルール適用）**」（L427-430）
  - `renewAgentSession`＝「セッションを新しくする」（L433-436）
  - ほか `copyAgentSessionId` / `copyAgentSessionPath`
- **影響**: コマンド名の正確性（観点1）に反する。「セッションを開く」で探しても実UIに見当たらず、初見ユーザーが混乱。
- **修正案**: 表を現行の項目名（「Claude で開く（IDE）」「ターミナルで開く（ルール適用）」「プレビュー画面を開く」など）へ更新。少なくとも「セッションを開く」は実名に置換。

### M-3: SPEC.md の設定デフォルト表が旧値のまま（`enableAgentMonitor`/`enableUsageMonitor`）

- **該当箇所**: `SPEC.md` L570・L576（セクション31）、および L1075（セクション47）
  - L570: `claudeManager.enableAgentMonitor | boolean | false`
  - L576: `claudeManager.enableUsageMonitor | boolean | false`
  - L1075: `enableUsageMonitor | boolean | false`
- **実装（現行）**: `package.json` L940 `enableAgentMonitor` = **true**、L990 `enableUsageMonitor` = **true**。
- **問題**: SPEC.md の冒頭が「v0.5.21 時点」を掲げるため、当該表を現行値と誤認するおそれ。
- **補足（割り切りとの関係）**: CHANGELOG v0.5.21 は「SPEC.md の全面刷新はスコープ外」と明言しており、これは**既知の割り切り**。ただし本2箇所は明確な事実誤りのため、最小修正（デフォルト値の true への訂正、または「※デフォルトは各バージョンで変遷。現行は package.json 準拠」の注記）を推奨。
- **修正案**: 当該セルを `true` に更新、もしくはセクション31/47 冒頭に「現行デフォルトは README『設定項目』表を参照」の一文を追記。

### M-4: package.json「その他」の `locale`/`ui.defaultTab` が文言統一パスから漏れ

- **該当箇所**: `package.json` L1290・L1312
  - L1290: `"description": "UIの表示言語。変更後はVS Codeを再起動してください"`
  - L1312: `"description": "メインビューを開いた際のデフォルトタブ"`
- **問題**: v0.5.21 で実施した「です・ます統一＋全半角統一」（CHANGELOG参照）から漏れている。
  - 全半角: 「UIの」「VS Codeを」に半角スペースが無い（他項目は「UI の」「VS Code を」相当に統一済み）
  - 文体: L1290 は体言止め＋「ください」混在、L1312 は体言止め（他は「〜です」で統一）
  - 用語: 「デフォルトタブ」（他項目は「既定」に統一されている）
  - enumDescriptions（L1307-1310）も体言止め「〜を起動時に表示」で、他カテゴリの「です」調と非対称
- **修正案（例）**:
  - L1290 → 「UI の表示言語です。変更後は VS Code を再起動してください」
  - L1312 → 「メインビューを開いた際に最初に表示するタブ（既定）です」

---

## 🔵 LOW（6件）

### L-1: README 設定一覧に未掲載の設定がある
- `claudeManager.locale.autoTranslate`（`package.json` L1292）と `claudeManager.ui.defaultTab`（L1297）が README「設定項目」に未掲載。
- `claudeManager.claudeAgentsIntegration.*`（廃止予定4件）の非掲載は妥当。
- **対応**: 網羅性向上のため、experimental な2件を追記するか、明示的に「主要設定のみ掲載」と断ると親切。

### L-2: モデル版数のハードコード（`Opus 4.8` / `Fable 5`）
- `README.md` L22・L119、`guide.html` L1857・L1859 で「Opus 4.8」「Fable 5」を固定表記。一方 Sonnet/Haiku は「最新世代」と世代非依存表記。
- 拡張自身の思想（エイリアス→起動時に最新解決）と照らすと、Opus/Fable も世代非依存に寄せるか、**2026-07 時点で 4.8/5 が現行**であることの確認が望ましい（外部事実のため本レビューでは未検証）。
- 内部的な整合（README↔guide.html）は取れている。

### L-3: README クイックスタートの Get Started 起動導線
- `README.md` L140「コマンドパレット（`Ctrl+Shift+P`）で `Get Started with Claude Session Manager` を実行」。
- 実際の walkthrough タイトルは日本語「Claude Session Manager をはじめる」（`package.json` L140）。英語文字列で検索してもパレットに現れない可能性。
- **対応**: 日本語タイトルでの案内、または `viewsWelcome` の[Get Started ウォークスルー]リンク（L116）経由の導線に統一。

### L-4: package.json の半角スペース揺れが一部残存
- 例: L940「ONにすると」は OFF 側の修正（「OFF にすると」）と非対称。L992「APIへの」等、英字直後のスペース無し表記が散見。
- 商品説明（`description`）や主要 description には影響なし。細部の統一余地として記録。

### L-5: 用語「セッション/会話」の併用
- 技術文脈=「セッション」、UIラベル=「会話」（会話一覧/会話ブックマーク/会話タグ）という使い分けは概ね一貫。
- ただし README では「セッション一覧」（L33・L39）と UI 実名「会話一覧」が混在。意図的なら許容だが、統一するなら方針を明文化すると保守しやすい。

### L-6: Marketplace README にスクリーンショット/GIF が無い（任意）
- 現状は要件表→機能一覧のテキスト主体。初見ユーザーの理解・コンバージョン向上の観点で、ヒーロー画像や主要機能の GIF 追加を推奨（公開後対応で可）。

---

## 確認できた「正確性」ポイント（合格項目）

観点1〜5に沿って、以下は実装と一致していることを確認済み:

- **設定デフォルト値**: README「設定項目」表の全35項目のデフォルト値が `package.json` の `contributes.configuration` と一致（`enableAgentMonitor=true`、`taskErrorThreshold=1800`、`preview.initialMessages=200`、`preview.maxMessageBytes=4096`、`agents.expandMode=active-branches`、`usage.statusBarStyle=full` 等すべて照合済み）。
- **コマンド名**: README「コマンド一覧」記載の `searchAgents`/`groupAgents`/`toggleAgentActiveOnly`/`enableAgentMonitor`/`installCsmAskAgent` などが `package.json` の `commands` の title と一致。存在しないコマンドの記載なし。
- **ソート/グループ種別数**: 「7種ソート」「4種グループ化」が enum 値数（updated-desc/asc, created-desc/asc, name, count, model＝7／date, tag, agent, flat＝4）と一致。
- **幻の機能なし・主要機能の記載漏れなし**: セキュリティ機能の記載も実装裏付けあり。
  - 「プロンプトインジェクション検知（WebFetch/WebSearch）」→ `hookService.ts` L1067「CSM Injection Detect hook（PostToolUse, matcher: WebFetch|WebSearch）」に実在。
  - 「クロス OS パス自動修復」→ `hookService.ts` L272「クロス OS パス self-heal」に実在。
- **バージョン整合**: `package.json` `0.5.21`／README（本文・VSIX名 `claude-session-manager-0.5.21.vsix`・変更履歴）／`guide.html`（`<title>` L11・ヒーロー L917）／`SPEC.md`（L1）すべて v0.5.21。CC バージョン（2.1.113 必須／2.1.19x 推奨／2.1.141+ デスクトップ通知）と日付 2026-07 も一貫。
- **command URI**: `viewsWelcome`/`walkthroughs` の `command:...` URI（`registerDirector`/`openGuide`/`enableAgentMonitor`/`openUsageMenu`/`openOrgChart`、及び `workbench.action.openWalkthrough?...csmGettingStarted`）はいずれも実在コマンド／walkthrough id を指しており、リンク切れなし。
- **Marketplace適性**: `displayName`「Claude Session Manager — 会話履歴・エージェント運用」、`description`（ブックマーク・タグ・検索・組織図・大容量ビューワー・利用制限モニターを列挙）は商品説明として適切。README の構成（要件→機能→クイックスタート→設定→運用ガイド→インストール）も初見ユーザーに追える。
- **guide.html セクション5**: 会話ビューワー（v0.5.20 高速化）の説明は遅延読み込み・巨大メッセージ抑制・ヘッダ2ボタン・cwd フォールバック（L1717）・表示中メッセージ検索まで実装と整合。

---

## 本レビューで確認しきれなかった点（-pモードにつき明記）

1. **`git diff` の直接取得は未実施**: 本環境に Bash ツールが無いため、未コミット差分そのものではなく**各ファイルの現状**（＝未コミット変更を含む作業ツリー）を基準にレビューした。CHANGELOG v0.5.21 に記載された変更範囲と現状ファイルは整合しており、レビュー結論に影響しないと判断。
2. **`LICENSE` ファイルの同梱**: README L421 `[MIT](LICENSE)` の相対リンク先ファイルの存在・`.vscodeignore` 除外有無は未検証。パッケージに含まれているか公開前に確認推奨。
3. **モデル版数の外部事実**: 「Opus 4.8」「Fable 5」が 2026-07 時点の現行最新かはリポジトリ外の事実であり未検証（L-2 参照）。
4. **VSIX 実ファイル名**: `claude-session-manager-0.5.21.vsix` は name＋version からの推定。実ビルド成果物名との一致は公開時に確認を。

---

## 推奨アクション（優先順）

1. **[HIGH] H-1** — `guide.html` のセクション5アンカーを id 方式に修正（公開前）
2. **[MEDIUM] M-2 / M-1** — README の右クリック表とCLI cwd記述を実装に合わせる（公開前が望ましい）
3. **[MEDIUM] M-4** — package.json `locale`/`ui.defaultTab` の文言を統一（公開前が望ましい）
4. **[MEDIUM] M-3** — SPEC.md の旧デフォルト2箇所を訂正 or 注記（既知の割り切り。フォロー可）
5. **[LOW] L-1〜L-6** — 公開後フォローアップ

> 本報告書は指摘と修正案の提示に留めています。ソース・設定・ドキュメント本体の修正は担当部署にて実施してください。
