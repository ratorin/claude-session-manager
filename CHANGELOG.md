# 更新履歴

## v0.5.14 (2026-07-09) — Fable 5 解禁 + normalizeModel 判定順序修正 + フォーム保存バグ修正

Sprint A（Fable QA レポート 2026-07-09 起点）。長期未対応の Fable 5 除外方針を撤回し、Fable モデルの選択・保存経路を第一級として復活。あわせて `normalizeModel` の C-1（`fable[1m]` → `sonnet-1m` 誤変換）と C-2（fable → opus サイレント書き換え）を修正。加えて HIGH-1（description 保存されないバグ）と HIGH-2（allowedTools 固定 12 種問題）を修正した。

### ➕ Fable 5 解禁（オーナー承認 2026-07-09）

- **`fable` / `fable-1m`** を第一級モデルとして追加。表示文字 **Ｆ**、色 **金 #ffd54f**、TreeView は `star-full` + `charts.yellow`。
- effort=`max` を **Opus 系のみ** から **Opus 系 + Fable 系** に拡張（`onModelChange` のグレーアウト連動）。
- 旧「組織方針で非選択」コメント（`agentUtils.ts` / `cliBuilder.ts` / README）を撤廃。

### 🐛 C-1 修正: `normalizeModel` の判定順序

`agentUtils.ts` の判定順序が `[1m] → fable` だったため、`claude-fable-5[1m]` が `sonnet-1m` に化けていた（"opus を含まない" 分岐で誤判定）。フォームで他項目を編集して保存 or セッション紐づけ操作をすると frontmatter が恒久的に `sonnet[1m]` に書き換わっていた。

- 判定順序を **fable → [1m] → opus → haiku → sonnet** に修正（`modelCatalog.ts` に一元化）。
- `agentFormPanel.ts` の `resolveModelName` も同一ロジックに統一（コピペ実装を撤去）。

### 🐛 C-2 修正: `fable → opus` のサイレント書き換え撤廃

`normalizeModel` の `if (lower.includes('fable')) { return 'opus'; }` を削除。過去に CSM 経由で保存済みのファイルは既に opus に書き換わっており復元不能なため、**Fable 利用エージェントはモデル選択を再度おこなってください**。

### 🐛 HIGH-1 修正: description 欄の編集が保存されない

- 症状: `agentFormPanel.getFormData` が description 欄を送信せず、`saveAgentConfig` が `description: config.role || existing?.description` で上書き。翻訳ボタンを押すと英語 description が日本語 role 文に置換され、Claude Code の自動委譲判定を破壊。
- 修正: `getFormData` に `description` フィールドを追加、`AgentConfig` に `description?: string` を拡張、`saveAgentConfig` は「フォームから送られた description を尊重、未送信なら既存値保持、空文字は明示的な消去として尊重」に変更。role とは独立して扱う。

### 🐛 HIGH-2 修正: allowedTools 固定 12 種問題

- 症状: フォームのチェックボックスが固定 12 種で、`AskUserQuestion`（例: director.md）などフォームに無いツールは保存で削除されていた。
- 修正: 固定リストに `AskUserQuestion` を追加。加えて既存 frontmatter に載っているが固定リストにないツールは**動的にチェックボックスを追加**（＋バッジで既存要素を示す）。

### 🏛️ modelCatalog.ts 新設（恒久対策）

モデルリテラルが 13 ファイル以上に分散し、色は 4 ファイルに同色直書き、tagTreeProvider は sessionTreeProvider の完全コピペになっていた問題を解消。`src/models/modelCatalog.ts` を単一真実源として新設し、モデル追加は 1 か所編集で全 UI・CLI・正規化に反映される構造にした（`getModelCliMap`, `getModelChar`, `getModelLabel`, `getModelIconAndColor`, `generateModelCss`）。

### 🎨 CSS 補修（副次修正）

- `webviewPanel.ts`: `.badge-fable` / `.badge-fable-1m` 追加 + 既存欠落バグ（`.badge-opus-1m` / `.badge-sonnet-1m`）を補修。
- `guide.html`: 同上 + モデルリスト・凡例・effort 連動記述を更新。
- `orgChartPanel.ts` / `projectDetailPanel.ts` / `mainTabPanel.ts`: fable 用の色ルールを追加。

### 🧪 テスト（`test/unit/agent-hooks-qa.test.js`）

- G1 を書き換え: `n('fable') === 'fable'` / `n('fable[1m]') === 'fable-1m'` / `n('claude-fable-5[1m]') === 'fable-1m'` を追加（C-1/C-2 検証）。
- G2 を書き換え: `modelCliMap['fable'] === 'fable'` / `modelCliMap['fable-1m'] === 'fable[1m]'` を追加。
- B4 を **拡張**: `fable` / `fable-1m` / `opus-1m` を追加（往復モデル検証。旧・sonnet 系のみ → Fable 系・Opus 1M を含む網羅へ）。
- **G4 / G5 を新規追加**: fable / fable-1m の frontmatter 書き込み → 復元往復テスト。

### 🔧 テストハーネス修正（Windows 隔離バグ）

- `agent-hooks-qa.test.js` / `setAgentSession.test.js` の `loadFresh` / `runHook` が **`process.env.HOME` だけを差し替えていた**ため、Node の `os.homedir()` が Windows で優先的に見る `process.env.USERPROFILE` を経由して実 `~/.claude` を書き換えていた（A/E/G3/C1 系および G4/G5 が実ホーム汚染のリスクで環境依存的に落ちていた）。
- 修正: **`USERPROFILE` も同時に差し替え** + 失敗時に即 throw する fail-fast ガードを追加（隔離漏れを本番環境事故に発展させない）。
- 結果: **35/35 pass**（Sprint A 追加前 baseline 30 → G4/G5 + A9 追加後の baseline 35 が全通過）。

### 📚 ドキュメント

- README / SPEC / CONTRIBUTING / guide.html を更新。旧「Fable 非選択」記述を撤回し、旧フルID表記（`claude-sonnet-4-6[1m]` / `claude-opus-4-6[1m]`）をエイリアス方式（`<model>[1m]`、例: `fable[1m]` / `opus[1m]` / `sonnet[1m]`）に統一。Max effort 対応表を「Opus / Fable 系」に更新。

### 🔍 コードレビュー修正ラウンド（Sprint A レビュー時点）

Sprint A 実装後のセルフレビューで検出した以下 8 件を追い込み修正（本 v0.5.14 に含める）。

- **HIGH (1)**: `toAgentConfig` に `description` マッピング欠落 → 編集経路で `v.description` が undefined になり、フォームプレフィル式が `displayDescription || role` にフォールバックし、保存で英語 description が日本語 role 文に恒久置換されていた（HIGH-1 が編集経路で機能しない）。`description: def.description` を追加。
- **HIGH (2)**: フォーム description の `<textarea>` プレフィルが `v.description ?? v.displayDescription ?? v.role` のフォールバックだった → v.description の欠落を隠して「日本語 role が保存される」状態を成立させていた。`v.description ?? ''` に修正（正しい復元）。
- **HIGH (3)**: `saveAgentConfig` の description 処理を再設計 — 既存更新は「フォームから来た description を尊重（空文字も明示的な消去として尊重）」、**新規作成 & 空の場合のみ role をフォールバックとして書き出す**（CC の自動委譲は description 行が必須のため）。非フォーム経路は既存値を保持。
- **HIGH (4)**: 動的追加チェックボックス（extraTools）の `value` 属性のみエスケープされていた（label テキストは未エスケープ）→ frontmatter に細工されたツール名で XSS 経路になり得る。**value / label 双方に `escapeHtml` 適用**。
- **MEDIUM (5)**: extraTools の重複除去なし → 同名ツールが複数チェックボックスとして描画され得る。`[...new Set(current)].filter(...)` で dedup。
- **LOW (6)**: `guide.html` の「モデルの使い分け」Tip が旧フル ID 表記（`claude-sonnet-4-6[1m]`）だった → エイリアス表記（`<model>[1m]`、例: `fable[1m]` / `opus[1m]` / `sonnet[1m]`）に統一。Fable 5 も「最上位判断」候補として追記。
- **LOW (7)**: モデル頭文字が画面間で不整合（`agentTreeProvider` は `sonnet-1m` → `'１'` を維持していたのに対し `agentPreviewPanel` は catalog char `'Ｓ'` を使用 → 画面間で `sonnet-1m` の頭文字が食い違い）。`agentTreeProvider` / `sessionTreeProvider` / `tagTreeProvider` を **`modelCatalog.getModelChar()` 呼び出しに統一**（1M 情報はラベル / tooltip で担保）。**表示変更**: `sonnet-1m` / `opus-1m` の頭文字が `Ｓ` / `Ｏ` に統一され、以前 `'１'` を表示していた場所も母体モデル頭文字（`Ｆ` / `Ｏ` / `Ｓ` / `Ｈ`）で表示。
- **MEDIUM (8)**: `modelCatalog.ts` の未接続シンボルを配線 — `sessionTreeProvider.getModelIcon` は `getModelIconAndColor` を呼ぶだけの薄いラッパに置換、`agentWatcher.prefixMap` は `MODEL_CATALOG[m].idPrefix` から自動生成、`agentFormPanel` のモデルラジオ HTML は `CSM_MODELS.map` で `MODEL_CATALOG` から動的生成、client-side `allowsMax` 判定は `MODEL_CATALOG[m].allowsMaxEffort=true` の集合を webview に埋め込む方式へ、`webviewPanel` / `mainTabPanel` / `projectDetailPanel` の badge / model / dot CSS は `generateModelCss()` の一括出力に置換。**これで modelCatalog の "1 か所編集で全 UI に反映" が実態と一致**。

### ⚠️ 見送り事項（Sprint A 対象外）

- **§2.4 任意項目**: usageMonitor の Fable 5d 利用率枠（Anthropic ヘッダ実機確認要）、director プリセットの Fable 格上げ、フォーム既定値 `opus` の変更 — Sprint B 以降で判断。
- **MEDIUM 以下（M-4〜M-11 / L-12〜L-15）** — Sprint B 以降で対応。

### 📊 テスト状況（本 v0.5.14 最終）

- `npx tsc --noEmit` クリーン。
- `npm test`: **35 / 35 pass**（Sprint A 追加分の G4 / G5、A9 マイグレーション、B4 拡張、E1〜E4 を含む）。テストハーネス修正（USERPROFILE 差し替え + fail-fast）により Windows 上で `~/.claude` 汚染リスクなしで安定的に全通過することを確認。

## v0.5.13 (2026-06-27) — エージェントフォームに maxTurns を追加（現行 CC 追従）

現行 Claude Code(2.1.19x)のサブエージェント frontmatter に合わせ、`maxTurns` をフォームから設定可能に。

### ➕ maxTurns
- **最大ターン数（maxTurns）** — 数値入力（空=無制限）。暴走・コスト制御用。`AgentConfig`/`AgentDefinition` に追加し、parse/buildFrontmatter/toAgentConfig/saveAgentConfig を整備。
- フォーム権威セマンティクス: 0/空で**クリア**、`>0` で設定。未指定・0以下は frontmatter に書かない。
- test: E4（maxTurns 往復・クリア・未指定）追加。全 33 テスト合格。

### 注記
- モデル/effort/SubagentStart-Stop hook は既に現行 CC に整合（前 commit で README に追従状況を明記）。`initialPrompt` 等の他フィールドは CSM の初期注入と競合しうるため意図的に見送り。

## v0.5.12 (2026-06-01) — 追加分（overage）をステータスバーに別表示

- ステータスバーの利用率（使用量）表示はそのまま、**追加分（overage）を別セグメントで併記**: `… ｜ 追加 0%`。
- データ源は Anthropic API の `anthropic-ratelimit-unified-overage-utilization`（利用率%）/ `-status` / `-reset`。
- ツールチップに `追加分(overage): N% 使用 / <status>・リセットまで …` を追加。
- **ドル金額（残高）は API に存在しない**ため、利用率（%）と状態で表示。$ は claude.ai/settings/usage（Web）で確認（ツールチップに注記）。
- test: I1（formatOverageText）追加。全 32 テスト合格。

## v0.5.11 (2026-06-01) — ステータスバーの%表示を使用量に戻す（残量表示を撤去）

- v0.5.9/v0.5.10 で追加した「残量（残り%）表示」を**撤去**し、ステータスバーの%を**従来どおり使用量（利用率）表示**に戻した（設定 `usage.showRemaining`・切替メニュー・既定ONマイグレーションを削除）。
- 背景: 要望は「%は使用量のまま据え置き、別途『追加分の $ 残高』を表示」だった。残量%は意図と異なったため revert。
- **追加分の $ 残高について**: Anthropic API のレート制限ヘッダには overage（追加分）の**利用率**（`anthropic-ratelimit-unified-overage-utilization` 等）はあるが、**ドル金額のヘッダは存在しない**。$ 残高は claude.ai/settings/usage（Web）でのみ確認可能で、OAuth トークン経由の API からは取得できないことを確認。

## v0.5.10 (2026-06-01) — 残量表示を既定 ON に（更新者も ON）

- `claudeManager.usage.showRemaining` の**既定を ON に変更**（残95% のように残量表示がデフォルト）。
- **更新者向け一度きりマイグレーション** `runUsageShowRemainingMigration`:
  - 未設定ユーザー → 新 default(ON) が自動適用。
  - **明示的に OFF にしているユーザー → 一度だけ ON へ flip**（更新後も ON にする要望に対応）。
  - フラグ（globalState）で再実行を防止 → 以降ユーザーが OFF にしても尊重。
- コード側の get フォールバックも `true` に統一。

## v0.5.9 (2026-06-01) — 利用制限ステータスバーに残量（残り%）表示を追加

ステータスバーの利用制限表示を、利用率（使用%）だけでなく**残量（残り% = 100% − 利用率）**でも表示できるようにした。

### ➕ 残量表示
- 設定 `claudeManager.usage.showRemaining`（既定 false）。ON で「残95% 4.5h / S 残97% 5d20h …」のように残量表示。
- **ステータスバークリックメニューから切替可能**（「残量（残り%）表示に切替 ⇄ 利用率（使用%）表示に切替」）。
- **ツールチップは常に「使用 X% / 残 Y%（リセットまで …）」を併記**。
- 残量は 0% 未満にならないようクランプ。警告色は従来どおり利用率ベースで判定。

### 注記（残高について）
- データ源は Anthropic API のレート制限ヘッダ（5h/7d/Sonnet5d/Opus5d の**利用率**）。**絶対的なクレジット残高（トークン数・金額）のヘッダは提供されない**ため、表示できるのは「残り% + リセットまでの時間」。
- test: I1（残量モードの算出・0% クランプ）を追加。全 32 テスト合格。

## v0.5.8 (2026-06-01) — QA 修正（hook 除去/マイグレーションの取りこぼし・バックアップ世代管理）

v0.5.2〜v0.5.7 を QA（自動ヘルス + コードレビュー + 横断点検）。CRITICAL 0、HIGH 2 + MEDIUM 1 + LOW 1 を修正。
詳細は [docs/v0.5.x-qa-report.md](docs/v0.5.x-qa-report.md)。

### 🐛 修正
- **HIGH**: `removeSessionAgentInjectHook` が `command.includes` 判定で **exec-form hook を除去できなかった** → `hookMatchesMarker` に変更（exec-form 対応）。
- **HIGH**: `ensureSessionAgentInjectHook` が exec-form マイグレーション後に無条件 `return false` で**変更が保存されなかった** → 変更を追跡して `return` に反映。
- **MEDIUM**: settings.json の `.bak.*` が**無制限に蓄積** → `pruneOldSettingsBackups()`（最新 5 件保持）を新設し、`modifySettingsJson` / `removeCsmHooksFromSettings` の書き込み後に世代管理。
- **LOW**: `isForeignOsPath` の Windows 分岐の意図をコメント明記。

### 検証
- `tsc` クリーン・全 **31 テスト**合格（バックアップ世代管理テスト H1 追加）。
- 非バグ/設計許容と判定した指摘（description UI・allowedTools=[]・エラー伝播設計 等）は QA レポートに根拠を記載。

## v0.5.7 (2026-06-01) — 更新内容の整合性修正（opus-1m の取りこぼし解消・ドキュメント追従）

v0.5.2〜v0.5.6 の更新を横断監査し、`opus-1m` 追加で取りこぼしていた箇所を整合させた。

### 🔧 opus-1m 表示・判定の整合
- **モデル表示**: `agentPreviewPanel`（頭文字・ラベル）/ `agentTreeProvider`（頭文字）/ `projectDetailPanel`（バッジ class）/ `orgChartPanel`（ノード色）が opus-1m を未対応で **Sonnet として誤表示**していたのを修正（Opus 系として表示）。
- **モデル不一致検出**（`agentWatcher`）: prefix マップに `opus-1m`（`claude-opus-`）を追加し、`opus-1m ↔ claude-opus-*[1m]` の 1M 判定を追加。`-1m` 付き設定が素の包含判定で誤一致しないようガード。
- **セッションからのモデル解決**（`agentFormPanel.resolveModelName`）: `opus[1m]` を `opus`→`opus-1m` に修正。

### 📝 ドキュメント・表記整合
- README の「主な機能」に v0.5.4（フォーム項目）/ v0.5.5（cwd 修正）/ v0.5.6（Opus 1M・Fable 除外）を追記（v0.5.3 で止まっていた）。
- `AgentConfig.effort` の陳腐化コメント（「max は Opus 4.6 のみ」）を現行に修正（max は全モデル可・セッション限定、Opus 4.8 既定=high）。

### 確認
- 横断 grep でモデル分岐・列挙・コスト/色/ラベル・effort・版表記を点検。`sessionTreeProvider` は `.includes('opus')` 方式のため opus-1m も自動的に拾えることを確認（変更不要）。
- 全 30 テスト合格・`tsc` クリーン。

## v0.5.6 (2026-06-01) — モデル選択を現行 Claude Code に追従（Opus 1M 追加 / Fable 除外）

現行 Claude Code（2.1.158 世代）のモデル構成に合わせてエージェントのモデル選択を更新。

### ➕ Opus 1M を追加
- **Opus 1M（`opus-1m` → CLI `opus[1m]`）** をモデル選択肢に追加。Opus 4.8 + 1M 長文コンテキスト。
  大規模調査・大量ファイル処理向け（従来の Sonnet 1M と対）。
- `AgentConfig` / `AgentDefinition` の model union、`modelCliMap`、`normalizeModel`、フォームラジオ、
  effort `max` の有効化条件（opus ファミリ）を更新。

### 🚫 Fable は選択肢に含めない（組織で無効化）
- 現行 CC には最上位の `fable`（Fable 5）が追加されたが、**組織で無効化されているため CSM の選択肢には出さない**。
- 防御策として `normalizeModel('fable')` は `opus` にフォールバック（禁止モデルを保持・表示しない）。

### 表記更新
- モデルラベルを現行版に更新（Sonnet 4.6 / Haiku 4.5 を明記、Opus は 4.8）。
- test: G1〜G3 を追加（normalizeModel / modelCliMap / opus-1m 往復）。全 30 テスト合格。

## v0.5.5 (2026-06-01) — 新規セッション作成のクロスOS cwd バグ修正

### 🐛 紐づけ「新規セッション作成」失敗を修正
- **症状**: エージェント紐づけで「新規セッションを作成」すると「新規セッション作成に失敗しました」エラー。
- **原因**: `createSessionForAgent` が `claude --agent` を spawn する際、cwd に **エージェント定義の `workDir` を生のまま**使っていた。Windows ホストで設定された `workDir`（例 `c:/xampp/Project/claude-session-manager`）は Linux VM に実体が無く、spawn が ENOENT で即失敗していた（クロス OS で共有された設定の典型）。resume 系は既に `translateWorkDirPath` で変換していたが、新規セッション作成パスだけ未対応だった。
- **修正**: `resolveSpawnCwd()` を新設し、`workDir` を `translateWorkDirPath`（`c:/xampp/Project/… → /mnt/hgfs/Project/…` 等の HGFS マッピング）で変換 + 実在チェック。解決できなければ workspace フォルダ → home にフォールバック。
- agent 定義の `workDir` は Windows パスのまま温存（runtime 変換で両 OS で動作するため、書き換えると Windows ホスト側が壊れる）。
- test: `translateWorkDirPath` の変換マッピングテスト（F1）を追加。全 27 テスト合格。

## v0.5.4 (2026-05-31) — エージェントフォームに現行 CC の subagent 項目を追加

エージェント設定フォームに、現行 Claude Code の subagent frontmatter 項目のうち未対応だった
3 項目を追加。`/workflows`・並列/バックグラウンド運用世代の設定をフォームから編集可能にした。

### ➕ フォーム新項目
- **許可ツール（allowedTools）** — チェックボックスで選択（Read/Write/Edit/Bash/Grep/Glob/Agent/WebFetch/WebSearch/Skill 等）。全部オフ = 全ツール継承（無制限）。従来は既存値の素通しのみで編集不可だった
- **worktree 隔離（`isolation: worktree`）** — 専用ワークツリーで実行するトグル
- **バックグラウンド実行（`background: true`）** — トグル

### 設計
- 3 項目を `AgentConfig` / `AgentDefinition` に追加し、frontmatter の読み書き（parse / buildFrontmatter）・`toAgentConfig` 変換を整備
- **フォーム権威セマンティクス**: フォーム由来の値は「指定があればそれを採用」。空配列（ツール全オフ）や OFF を尊重して**解除も反映**（`config.X !== undefined ? config.X : existing` 方式）。`background: false` / `isolation` なしは frontmatter に書き出さない
- `effort` は low/medium/high/xhigh/max の全段階が既に揃っており現行どおり（`ultracode` は per-agent effort ではなくセッション専用設定のため非対象）

### テスト
- `test/unit/agent-hooks-qa.test.js` に E1〜E3 を追加（isolation/background 往復・AgentConfig 往復・フォーム権威での解除）。全 26 テスト合格

## v0.5.3 (2026-05-31) — Agent作成・紐づけ・Hook の QA + frontmatter クォートバグ修正

エージェント新規作成・セッション紐づけ・hook 周りを QA し、ユニットテストを整備。
QA でフロントマターのクォート不具合を検出し修正した。

### 🐛 frontmatter クォートバグ修正（QA 検出）
- `role` / `displayName` 等のフロントマター値に **`"` と改行**が同時に含まれると、二重引用符
  スカラーに生の改行が入り **YAML が複数行に割れて値が破損**していた（例: `say "hi"\n...` → `say "hi\`）。
- `quoteYamlValue`（agentFileManager）が改行/復帰/タブを `\n`/`\r`/`\t` にエスケープするよう修正。
- パーサ（frontmatterUtils）のダブルクォート復号を**単一パス**化し、`\\` `\"` `\n` `\r` `\t` を
  左→右に原子的に復号（旧 `\\"` 取り違えの潜在バグも解消）。

### ✅ QA テストスイート追加（`test/unit/agent-hooks-qa.test.js`, 20 ケース）
- **binding**: setAgentSession（empty→new / existing→skip / force / `unlinked` 扱い / previousSessionIds・mode 保持）、addAgent⇄getAgents 往復、removeAgent、cleanupSessionData 解除、migrateAgentsToAgentSessions
- **agentFileManager**: パストラバーサル名の拒否、日本語名許可、YAML クォート、モデル往復
- **hook スクリプト（templates 実機実行）**: session-agent-inject の紐づけ解決＋sessionTitle、check-ask-agent の deny/pass、injection-detect の検知、session-stop の historyEnabled ゲート
- **hook クリーンアップ**: filterCsmHooks の CSM 除去・非CSM 温存・旧 bash マーカー除去
- `npm test` を `node --test test/unit/*.test.js` に変更し全テスト（既存3 + 新規20 = 23）を実行。

## v0.5.2 (2026-05-31) — Hook ライフサイクル堅牢化（クロスOS自己修復・アンインストール清掃・内容是正）

VMware（Windows ホスト ⇄ Linux VM）で `~/.claude/settings.json` を共有する環境で、
hook の絶対パスがクロス OS で壊れて「SessionStart startup hook error」等が発生する問題を
中心に、hook の自己修復・内容是正・ライフサイクル整備を行った。

### 🩹 クロスOSパス self-heal + dead-hook prune
- **heal**: Windows ホストで書かれた `C:/Users/.../.claude/...` の CSM hook を、Linux VM 起動時に
  `~/.claude/...` へ自動修復（`healForeignOsHookPaths`）。再構築先が**実在する場合のみ**書き換え。
  `$HOME`/`~` の移植可能形式は温存。CSM 自身の hook 限定。
- **prune**: heal 不能な「別 OS の死んだパス」（現在 OS に実体が無く永久に解決不能な CSM hook、
  例: 旧 `c:/xampp/.../*.sh`）は settings.json から除去。空になった matcher グループ／イベントキーも削除。
- 原因: 従来の冪等判定がマーカー名のみで、登録パスが現在 OS で解決可能か検証していなかった。
- マーカー定義を `csmHookCleanup.CSM_HOOK_MARKERS` に一元化（heal / prune / migrate / removeAll 共通、旧 bash 版含む）。

### 🐛 hook 内容の是正（現行 Claude Code 2.1.158 契約に整合）
- `csm-check-ask-agent.js`: PreToolUse の `permissionDecision: "block"`（無効値でブロック不発）を
  正しい `"deny"` に修正。存在しない `continueOnBlock` フィールドを削除。
- デプロイ方式を統一: `csm-session-agent-inject.js` / `csm-governance-capture.js` を
  「無ければ作る」から「差分があれば上書き」へ（`sessionTitle` 対応などのドリフト解消）。

### 🧹 アンインストール／無効化時のクリーンアップ
- `vscode:uninstall`（`out/uninstall.js`）でアンインストール時に CSM hook を settings.json から
  全除去 + `~/.claude/hooks/csm-*.js` を `.trash/` へ退避。
- 手動コマンド **「すべての CSM フックを削除（アンインストール準備）」**（`claudeManager.removeAllHooks`）を追加。
- 共通コア `src/utils/csmHookCleanup.ts`（vscode 非依存）。ECC 所有の `scripts/csm/` 配下は除去しない。

### 🛡️ csm-injection-detect を CSM 正式所有化
- WebFetch/WebSearch のプロンプトインジェクション検知 hook をテンプレ化 + `ensureInjectionDetectHook`
  で配備・登録（PostToolUse, matcher `WebFetch|WebSearch`）。従来はオーファン（更新・再配備不能）だった。

### 実装ファイル
- `src/services/hookService.ts`（self-heal / removeAllCsmHooks / ensureInjectionDetectHook / デプロイ上書き）
- `src/utils/csmHookCleanup.ts`（新規・vscode 非依存）, `src/uninstall.ts`（新規）
- `templates/csm-check-ask-agent.js`（block→deny）, `templates/csm-injection-detect.js`（新規）
- `src/extension.ts`（配線 + コマンド登録）, `package.json`（`vscode:uninstall` + コマンド）

## v0.5.1 (2026-05-31) — オーケストレーション可視化タブ + Activity Bar 4アイコン化

### 🎼 オーケストレーション可視化 — 5番目の Activity Bar アイコン (T7.1〜T7.6)

Claude Code /workflows・バックグラウンドエージェントのライブ稼働状況を可視化する
専用ビューを Activity Bar に追加。

#### 機能
- **サマリーバー**: `🎼 N セッション / M サブエージェント` を常時表示
- **グループ化**: `🟢 インタラクティブ` / `⚙️ バックグラウンド/ワークフロー` に自動分類
  - ワークフロー判定: `kind=background` OR サブエージェント数 ≥ 3 (ヒューリスティック)
- **セッションノード**: 名前 / cwd / 経過時間 / サブエージェント数 を表示
- **サブエージェントノード**: JSONL 末尾解析で稼働中 Task/Agent を検出・表示
- **5秒ポーリング**: タブ可視時のみ更新 (非可視時停止)
- **データソース優先順**: `claude agents --json` (2.1.145+) → agentWatcher PID/JSONL
- **右クリックメニュー**: Claude で開く / セッション ID コピー

#### 実装ファイル
- `src/services/orchestrationViewModel.ts` (新規): データ収集・ビューモデル構築
- `src/providers/orchestrationTreeProvider.ts` (新規): TreeDataProvider + TreeItem 定義
- `package.json`: `claude-orchestration` Activity Bar コンテナ + `claudeOrchestration` ビュー
- `src/extension.ts`: OrchestrationTreeProvider の初期化・依存注入・コマンド登録

## v0.5.1 (2026-05-31) — Activity Bar 4アイコン化（タブバー廃止）

### UI 刷新: 1アイコン → 4独立アイコン

VS Code 標準の Activity Bar アイコン切替方式に変更。タブバー (TreeView) を廃止し、
Explorer/Git のように左縦アイコンでセクションを切り替える形になった。

#### 変更内容
- `package.json`:
  - `viewsContainers.activitybar`: `claude-manager` 1個 → 4個に分割
    - 💬 `claude-sessions` (comment-discussion)
    - 👤 `claude-agents` (organization)
    - 🧠 `claude-memory` (database)
    - 📁 `claude-projects` (folder-opened)
  - `views`: 旧 `claude-manager` セクションを廃止。4コンテナに分散配置
    - `claudeTabBar` view を削除
    - `when` 句 (`activeTab`/`useNewMainPanel` 条件) を全廃 — コンテナ分離で不要
  - `menus.view/title`: `claudeTabBar && activeTab` 依存の action entries を削除
    → プロジェクトタブ用に `claudeMain` view/title 設定ボタンを追加
- `extension.ts`:
  - `TabBarTreeProvider` インポート・登録・タブ切替ロジックを削除
  - `setContext('claudeManager.activeTab', ...)` 関連コードを削除
  - `tabBarStatusTimer` 削除（不要に）

#### 効果
- タブバー下の余白問題が構造レベルで解消
- 会話タグ (`claudeTags`) の非表示バグが `when` 句廃止で解消
- VS Code 標準ナビゲーション UX に準拠

---

## v0.5.1 (2026-05-31) — 右クリックメニュー再編 v2（重複排除・グループ統一）

### 右クリックメニュー再設計 v2 実装

`docs/v0.5.x-menu-redesign-2.md` に基づき `package.json` の `view/item/context` を再整理。
登録行数: **39 → 32**（エージェント系 18 → 11、重複7件削除）

#### 変更内容

**エージェント系の重複排除（主目的）**
- `previewAgent` / `openAgentInClaude` / `openAgentSession`: `claudeAgents` と `claudeAgentsFavorites` の2行登録を when 句の OR 結合で **1行に統合**
  ```json
  "when": "(view == claudeAgents || view == claudeAgentsFavorites) && viewItem =~ /(agentItemLinked|favoriteAgentLinked)/"
  ```
- `removeAgentFavorite` inline: `claudeAgents` / `claudeAgentsFavorites` 2行を OR 結合で1行に
- `addAgentFavorite` / `removeAgentFavorite` の `2_favorite` グループ登録を完全削除
  → inline の ★ トグルのみ残し、コンテキストメニュー本体への二重表示を解消

**グループ名・順序統一**
- セッション系: `2_agent` → `2_link`（設計書 v2 の命名規約に準拠）
- エージェント系: `0_link` → `2_link`、`2_copy` → `0_open@5/@6`（コピー操作を 0_open に統合）
- 全コマンドに `@N` インデックスを付与（同 group 内の順序を保証）

---

## v0.5.1 (2026-05-30) — modelCliMap エイリアス方式へ移行 (重大バグ修正)

### 重大バグ修正: フロントマターに古いモデルIDが固定される問題

#### 問題
`src/utils/cliBuilder.ts` の `modelCliMap` が具体的なモデルID を保持していたため、
エージェント新規作成・保存時に `model: claude-opus-4-6` 等が frontmatter に書き込まれ、
Opus 4.8 が存在しても古い 4-6 で起動していた。

#### 修正内容 (src/utils/cliBuilder.ts)
- `modelCliMap` をエイリアス方式に変更（案A）:
  - `'opus'` → `'opus'` (旧: `claude-opus-4-6`)
  - `'sonnet'` → `'sonnet'` (旧: `claude-sonnet-4-6`)
  - `'sonnet-1m'` → `'sonnet[1m]'` (旧: `claude-sonnet-4-6[1m]`)
  - `'haiku'` → `'haiku'` (旧: `claude-haiku-4-5`)
- Claude Code 起動時にエイリアスを最新モデルへ解決するため、リリース毎の更新不要

#### modelMismatch 誤検知について
- `agentWatcher.ts` は `agent.model` を `normalizeModel()` 経由で正規化してから比較するため
  `'opus'` vs `'claude-opus-4-8'` のような比較が正しく一致と判定される（修正不要）
- 既存エージェントの `.md` ファイルは変更しない（次回保存時から新方式が適用）

---

## v0.5.1 (2026-05-30) — Opus 4.8 対応・effort ラベル更新 (CC 2.1.154〜2.1.158)

### Claude Code 2.1.154〜2.1.158 対応

#### モデル選択 UI (agentFormPanel.ts)
- **Opus ラジオのサブテキスト** を「Opus 4.8 — 最高度の判断・複雑な開発（デフォルト high effort）」に更新
  - `value="opus"` はそのまま維持（Claude Code 側で opus-4-8 へ解決される）
  - `normalizeModel()` は `includes('opus')` で広くマッチするため変更不要

#### effort ラベル (agentFormPanel.ts)
- **High**: 「深い推論（Opus 4.8 デフォルト・推奨）」
- **XHigh**: 「超高深度（最難タスク向け）」 — バージョン縛り表記 (v2.1.111+) を汎用化

#### README.md
- 推奨 Claude Code バージョン: **2.1.153+** → **2.1.158+**

---

## v0.5.1 (2026-05-28) — Claude Code 2.1.145〜2.1.153 取込み

### claudeAgentsService 復活 — `claude agents --json` 公式 API 対応 (2.1.145+)

Claude Code 2.1.145 で `claude agents --json` が追加されたことを受け、
`ClaudeAgentsService` を JSON API ベースに全面切替えして再有効化。

#### 実機確認済み JSON フォーマット
```json
[
  { "pid": 535218, "cwd": "/path/to/project", "kind": "interactive",
    "startedAt": 1779937055153, "sessionId": "9148962f-24f8-4b19-bed8-e3c0b3aa9947" }
]
```

#### 変更点
- `claudeAgentsService.ts`:
  - 第1選択: `claude agents --json` (2.1.145+) を `execFile` で実行
  - 第2選択: `claude agents` テキスト出力パース（旧バージョン後方互換）
  - `ClaudeAgentEntry` に `pid`, `kind`, `startedAt`, `source` フィールドを追加
  - `source: 'json-api' | 'text-parse'` で取得元を識別
  - `elapsedSec` を `startedAt` から自動計算（JSON API 時）
  - JSON API エントリは全件 `status: 'running'` とみなす（アクティブセッションのみ返す仕様）
  - `ClaudeAgentRawJson` 型を追加（実機フォーマット定義）
- `agentLiveTreeProvider.ts`:
  - `setClaudeAgentsService()` を追加し JSON API を優先データソースに設定
  - availability `unknown` 時はローディング表示
  - `unavailable` / `disabled` 時は `agentWatcher`（PID/JSONL）に自動フォールバック
  - `LiveAgentItem` のツールチップに `pid` / `kind` / 取得元バッジを追加
  - `notifyTabVisible()` を `ClaudeAgentsService.setTabVisible()` に委譲（ポーリング制御）
- `extension.ts`:
  - `ClaudeAgentsService` のコメントアウトを解除して再有効化
  - `agentLiveProvider.setClaudeAgentsService(claudeAgentsService)` で注入
  - `claudeAgentsService.onDidChange` で running セッションを `agentWatcher` に補完（Phase 3）



### 調査・対応サマリー

| 項目 | バージョン | 結果 |
|------|-----------|------|
| /simplify → /code-review リネーム | 2.1.147 | **該当なし** (CSM 内で未使用) |
| MessageDisplay hook | 2.1.152 | hookService.ts に骨組み追加 |
| SessionStart: sessionTitle 出力 | 2.1.152 | csm-session-agent-inject.js に追加 |
| Stop hook: background_tasks / session_crons | 2.1.145 | csm-session-stop.js に追加 |
| 推奨版を 2.1.153+ に更新 | 2.1.153 | README.md 更新 |
| auto mode デフォルト ON | 2.1.152 | **該当なし** (ユーザー向け説明文なし) |

### 変更詳細

#### csm-session-agent-inject.js (SessionStart hook)
- `hookSpecificOutput.sessionTitle` に `[agentName]` を設定
- Claude Code 2.1.152+ でセッションタブのタイトルがエージェント名で自動設定される

#### csm-session-stop.js (Stop hook)
- `input.background_tasks` / `input.session_crons` を読み取り
- 継続中タスクがある場合、HISTORY.md の記録に `(background tasks N 件継続中)` を付記
- Claude Code 2.1.145+ で提供される情報

#### hookService.ts
- `isMessageDisplayHookEnabled()` スタブ関数を追加
- MessageDisplay hook (2.1.152+) の設定キー・input/output 形式をドキュメントコメントで記載
- 実装テンプレートは将来のユーザー拡張向けに予約

#### README.md
- 推奨バージョン: **2.1.144+** → **2.1.153+**

---

## v0.5.1 (2026-05-19) — タブ切り替えパフォーマンス改善

### TreeView ルートノード短期キャッシュ追加

タブを切り替えるたびに `getChildren()` が IO を実行していた問題を改善。

#### 変更内容
- `AgentTreeProvider`: ルートノード結果を 5 秒 TTL でキャッシュ
  - `refresh()` 呼び出し時に即座に無効化するため、データ鮮度は維持
  - バナー判定 4 本（`isCsmAskAgentInstalled` / `isSessionAgentInjectInstalled` / `hasOldAskAgentFiles` / `detectLegacyAgents`）を `Promise.all` で並列化
- `MemoryTreeProvider`: ルートノード結果を 5 秒 TTL でキャッシュ
  - フィルター状態変更時は即時無効化

#### 効果
- キャッシュヒット時: ファイル IO ゼロ → タブ切り替えが体感上即時
- キャッシュミス時: バナー判定が並列化され約 50〜70% 短縮

---

## v0.5.1 (2026-05-19) — Claude Code 2.1.144 取込み

### Claude Code 2.1.142〜2.1.144 対応確認・取込み

#### 項目 1: Stop hook 連続ブロック (2.1.143 仕様追加)
- **調査結果**: 影響なし
- `csm-session-stop.js` は `{}` または `{terminalSequence:...}` のみ出力。`permissionDecision: block` は PreToolUse hook のみ使用であり Stop hook には一切なし。8 回ブロック強制終了の危険なし。

#### 項目 2: 推奨バージョン更新 → 2.1.144+
- README.md の「推奨 Claude Code」を **2.1.139+** から **2.1.144+** に更新
- 旧推奨 (2.1.141+) は「旧推奨」として残置

#### 項目 3: /extra-usage → /usage-credits リネーム (2.1.144)
- **調査結果: 該当なし** — CSM 全体で `/extra-usage` 文字列の使用なし。対応不要。

#### 項目 4: subagent 完了通知 経過時間記録 (2.1.144)
- `csm-session-stop.js` に `input.elapsed_time` フィールドの取込みを追加
- HISTORY.md の自動記録エントリに経過時間を付記: `(セッション終了時自動記録 3h 2m 5s)`
- `input.elapsed_time` が未設定の場合はスキップ（後方互換）

#### 項目 5: --resume bg セッション対応 (2.1.144)
- **調査結果: 既存ロジックでカバー済**
- `buildResumeArgs()` は `--resume <sessionId>` を組み立てるのみで、セッション種別（通常/bg）を問わない
- 2.1.144 で bg セッションが `--resume` 対象に追加されても CSM 側変更不要

---

## v0.5.1 (2026-05-19) — プロジェクトタブ統一: claudeTabBar 常時表示化

### プロジェクトタブ UI 統一

全タブで `claudeTabBar` (TreeView) を常時表示するよう変更し、プロジェクトタブのみ異なる見た目になっていた問題を解消。

#### 変更内容
- `package.json`:
  - `claudeTabBar` の `when` 句から `&& claudeManager.activeTab != 'projects'` を削除
    → 全タブ選択時に `claudeTabBar` TreeView が常時上部に表示される
  - `view/title` でプロジェクトタブ選択時の設定ボタンを追加
- `mainTabPanel.ts` (claudeMain WebviewView):
  - 内部タブバー (`<nav class="tab-bar">`) を完全削除
  - アクション行 (`.tab-action-bar`) を削除
  - セッション・エージェント・メモリのペイン HTML を削除 → **プロジェクト一覧のみ**に
  - 対応するタブ切り替え JS・セッション/エージェント/メモリ JS を削除
  - メッセージハンドラを `projects-data` / `project-tree-data` のみに絞り込み
  - `_sendInitialData()` をプロジェクトデータのみ送信するよう簡略化

---

## v0.5.1 (2026-05-19) — エージェント登録フォームに HISTORY / TODO トグル追加

### エージェント登録フォーム: HISTORY / TODO トグル

エージェント新規登録・編集フォームに HISTORY と TODO の有効化トグルを追加。

#### 変更内容
- `agentFormPanel.ts`:
  - **HISTORY 有効化トグル**: ON/OFF チェックボックス。保存時に HISTORY.md が無ければ自動作成。
  - **HISTORY.md 保存先選択**: 自動（.md と同じスコープ）/ グローバル / プロジェクト。
    HISTORY が OFF のときは非表示。
  - **TODO 有効化トグル**: ON/OFF チェックボックス。保存時に TODO.md が無ければ自動作成。
  - **設定デフォルト反映**: 新規登録時は VS Code 設定
    `claudeManager.agent.defaultHistoryEnabled` / `defaultTodoEnabled` を読み込みデフォルト値に使用。
    編集時は既存エージェントの値を使用。
- `agentCommands.ts` (`claudeManager.addAgent`):
  - `addAgent()` 後に `historyEnabled=true` なら `~/.claude/agents/<name>/HISTORY.md` を作成（未存在時）。
  - `todoEnabled=true` なら `~/.claude/agents/<name>/TODO.md` を作成（未存在時）。
  - テンプレート: HISTORY は「歴代セッション記録」ヘッダ、TODO は「確認待ち / タスク」セクション。

---

## v0.5.1 (2026-05-19) — タブバー WebView → TreeView 化（余白問題解消）

### claudeTabBar: WebviewView → TreeView 置換

**問題:** 他の TreeView（会話ブックマーク・会話タグ等）を折り畳むと、
claudeTabBar の WebviewView 領域が余剰スペースを受け取り大きな空白が生じていた。

**解決策:** WebviewView を TreeView に置換。TreeView はコンテンツ行数分しか高さを取らないため、
他のビューを折り畳んでも余白ゼロを維持する。

#### 変更内容
- `tabBarPanel.ts`: `WebviewViewProvider` → `TabBarTreeProvider` (`TreeDataProvider<TabBarItem>`) に完全置換
  - タブ4行（セッション / エージェント / メモリ / プロジェクト）
  - アクティブタブ: アイコン青色 + `●` description で視覚的に識別
  - ステータス1行（稼働数 / 最終更新 / プロジェクト名）
  - `setActiveTab()` / `setStatusProvider()` / `pushStatusInfo()` API を維持
- `extension.ts`:
  - `registerWebviewViewProvider` → `createTreeView('claudeTabBar')` に変更
  - `tabBarTreeView.onDidChangeSelection` でタブ行クリックを捕捉し `claudeManager.activeTab` を更新
- `package.json`:
  - `claudeTabBar` ビューの `type: "webview"` / `initialSize: 2` を削除（ネイティブ TreeView に）
  - `view/title` にタブ別アクションボタンを追加（sessions/agents/memory/projects それぞれ `when` 句で切替）

---

## v0.5.0 (2026-05-14) — エージェント管理ラベルに [Open]/[経過時間] プレフィックス追加

### エージェント管理ラベル改善

エージェント管理セクションの各エージェント行に稼働状態プレフィックスを追加。

- **動作中かつ最近更新 (30秒以内)** → `[Open] Ｓ エージェント名` — 現在対話中と推定
- **動作中かつ古い** → `[5分] Ｓ エージェント名` — 経過時間表示 (秒/分/時間/日)
- **停止中** → `Ｓ エージェント名` — プレフィックスなし (従来通り)

実装:
- `agentTreeProvider.AgentItem`: `mtimeMs?` パラメータ追加、`formatLiveElapsed()` ヘルパー追加
- `AgentTreeProvider`: `getSessionMtimeFn` コールバック追加
- `extension.ts`: `agentWatcher.getSessionMtime` を `AgentTreeProvider` に注入
- `agentWatcher.onDidChange` → `AgentItem` ラベルも自動更新 (reload 不要)

---

## v0.5.0 (2026-05-14) — ライブ状態セクション PID/JSONL ベースに切替

### ライブ状態セクションのデータソース変更

`claude agents` コマンドが TTY 必須の対話モードコマンドであり、VS Code 拡張から `execFile()` 経由で呼ぶと「is not available in this environment」が返される制約が実機検証で判明。
既存の `agentWatcher` (PID/JSONL 監視) が同等の情報を保持しているため、データソースを切り替え。

- **`agentLiveTreeProvider`**: データ取得元を `ClaudeAgentsService` → `AgentWatcher` に変更
- **`agentWatcher`**: `getLiveSessionCwdMap()` を新規公開（セッション ID → cwd マップ）
- **`extension.ts`**: `ClaudeAgentsService` の初期化を削除。`agentLiveProvider.setAgentWatcher()` に変更
- **`claudeManager.claudeAgentsIntegration.enabled`**: デフォルトを `false` に変更（TTY 非対応の旨を Description に明記）
- エラー表示なしで稼働中エージェントを正常表示

---

## v0.5.0 (2026-05-14) — エージェントタブ 3分割 + セッションタブ並び順統一

### UI 再構成: エージェントタブを3つの独立ビューに分割

#### エージェントタブ
- **`claudeAgentsLive`** (新規): 「ライブ状態」専用ビュー — `claude agents` コマンドの結果を表示
  - 既存 `agentTreeProvider` の `LiveStatusSectionItem` / `LiveAgentItem` を `agentLiveTreeProvider.ts` に分離
  - `AgentLiveTreeProvider` が `ClaudeAgentsService` を直接注入、タブ可視性ポーリングも独立制御
- **`claudeAgentsFavorites`** (新規): 「お気に入りエージェント」専用ビュー — ブックマーク済みフラットリスト
  - 既存 `FavoriteTreeSectionItem` / `FavoriteAgentItem` を `agentFavoritesTreeProvider.ts` に分離
  - `AgentFavoritesTreeProvider` が `agentWatcher` 状態と連動してリフレッシュ
- **`claudeAgents`** (既存): エージェント一覧のみ — Live・Favorite セクションを除去してスリム化

#### セッションタブ並び順統一
- 旧: 一覧 → ブックマーク → タグ
- **新: ブックマーク → タグ → 一覧**（ブックマークを最上位に）

#### 技術的変更
- `agentTreeProvider.ts`: `ClaudeAgentsService` 依存・`getBookmarks` 依存・Live/Favorite クラス群を削除
- `agentLiveTreeProvider.ts`: 新規作成（`LiveAgentItem`, `LiveStatusMessageItem`, `buildLiveAgentViews`）
- `agentFavoritesTreeProvider.ts`: 新規作成（`FavoriteAgentItem` を `AgentItem` のサブクラスとして継承）
- `extension.ts`: 2つの新 TreeView 登録、`claudeAgentsLiveTreeView.onDidChangeVisibility` 配線
- `package.json`: 2つの新 view 定義、セッションビュー並び順変更、お気に入りビューの inline/context メニュー追加

---

## v0.5.0 (2026-05-14) — QA HIGH 修正 (H-1 + H-2)

### セキュリティ・堅牢性修正

#### H-1: `claudeAgentsService` — `exec()` → `execFile()` 置換
- シェル経由の `exec(`claude agents ...`)` を `execFile('claude', [...args])` に変更
- パスに特殊文字が含まれる場合のクォート不全を根本解消
- Windows では `.cmd` シム対応のため `shell: true` を適用
- `shellQuote()` ヘルパー削除

#### H-2: `dataStore.setAgentSession()` — `force` パラメータ + ロギング追加
- `force?: boolean` パラメータ追加: `true` 時は既存 sessionId ガードをバイパス
- `outputChannel?: vscode.OutputChannel` パラメータ追加: スキップ時のログ出力先
- スキップ時: `"[CSM] 既存 sessionId XXX を保持 (force=false)"` をログ出力
- ユニットテスト追加: `test/unit/setAgentSession.test.js` (3ケース: empty→new / existing→skip / force=true→overwrite)

---

## v0.5.0 (2026-05-14)

### ⭐ お気に入りエージェント UI 改善 — 会話風フラットリスト + ★追加ボタン

前回の階層ツリー表示を廃止し、会話ブックマークと同じ見た目のフラットリスト形式に変更。
全エージェント行にインラインの ★/☆ ボタンを追加。

#### 変更内容
- `FavoriteTreeSectionItem`: ラベルを「⭐ お気に入りエージェント (N)」に変更（件数バッジ付き）
- `FavoriteAgentItem`: `neededSet`/`isIntermediateNode` を削除 → フラット専用シンプル実装
- `_buildFavoriteList()`: ブックマーク済みエージェントをアルファベット順でフラット返却
- `AgentItem.contextValue`: `isBookmarked()` 参照で `Bookmarked` フラグを追加
  - `agentItem` / `agentItemLinked` / `agentItemBookmarked` / `agentItemLinkedBookmarked`
- `claudeManager.addAgentFavorite` コマンド追加 — ☆ ボタン (inline@20)
- `claudeManager.removeAgentFavorite` コマンド追加 — ★ ボタン (inline@20)
- 右クリックメニュー `2_favorite` グループにも追加/削除を登録

---

## v0.5.0 (2026-05-14) — claude agents 統合

### TASK-5 Phase 1+2+3: `claude agents` コマンド統合（ライブ状態セクション）

Claude Code 2.1.139+ の `claude agents` コマンドを CSM エージェントタブに統合し、
「🟢 ライブ状態」セクションをエージェントタブ最上部に追加。

#### 新機能
- **🟢 ライブ状態セクション**: `claude agents` の出力を5秒ポーリングでリアルタイム表示
- **ステータス別アイコン**: 🟢 running / 🟡 blocked / ⚪ done をアイコン色で区別
- **CSM マッチング**: sessionId または cwd でエージェント名と自動紐づけ
- **未登録セッション表示**: CSM 未登録セッションも "(未登録)" として表示（設定で非表示化可）
- **タブ可視時のみポーリング**: エージェントタブ非表示中はポーリング停止（CPU 節約）
- **バックオフリトライ**: 連続失敗時に 5s → 30s → 5min と間隔を延長
- **非対応環境検出**: `'claude agents' is not available` を検知してセクションに説明を表示
- **手動リフレッシュ**: `claudeManager.refreshLiveAgents` コマンドで即時更新可能
- **フレキシブルパーサー**: テキスト形式 (A/B/C/D の4フォーマット) + 将来の `--json` に自動対応

#### Phase 3: PID チェック補完 (TASK-5 Phase 3)
- `claude agents` の running セッションを `agentWatcher` の PID ライブセットに補完
- フォールバック: `claude agents` 利用不可時は既存 PID チェックのみで動作（既存機能維持）

#### 設定キー追加
| キー | デフォルト | 説明 |
|---|---|---|
| `claudeManager.claudeAgentsIntegration.enabled` | `true` | ライブ状態セクションを有効化 |
| `claudeManager.claudeAgentsIntegration.pollingIntervalMs` | `5000` | ポーリング間隔（ms） |
| `claudeManager.claudeAgentsIntegration.scopeToWorkspace` | `true` | --cwd でワークスペースに絞り込み |
| `claudeManager.claudeAgentsIntegration.showUnregistered` | `true` | 未登録セッションも表示 |

#### 実装ファイル
- `src/services/claudeAgentsService.ts` (新規): fetch + parse + 可用性検出 + キャッシュ + ポーリング
- `src/providers/agentTreeProvider.ts`: LiveStatusSectionItem / LiveAgentItem / LiveStatusMessageItem 追加
- `src/watchers/agentWatcher.ts`: `supplementLiveFromClaudeAgents()` 追加 (Phase 3)
- `src/commands/agentCommands.ts`: `previewAgentByName` コマンド追加
- `src/extension.ts`: ClaudeAgentsService 初期化 + TreeView 可視性監視
- `package.json`: 設定キー / コマンド追加

### TASK-4: JSONL `attributes` フィールドから agent_id 読み取り強化

OTEL / x-claude-code-agent-id ヘッダー由来の `attributes` フィールドをセッション自動紐づけの
第2手段として追加。

- `agentWatcher.ts`: `readAgentIdFromAttributes()` 追加（先頭 4KB / 10 行を検索）
- 対応キー: `attributes.x-claude-code-agent-id` / `agent_id` / `agentId` / `agent.name`
- フォールバック: `agent-setting` タイプが見つからない場合に自動切り替え
- `scanProjectsForAutoLink` も同様に拡張（バッチスキャン時）

### TASK-7: /goal コマンド連動 PoC

CSM タスクログを `/goal` コマンド用の目標テキストとしてクリップボードに出力する PoC。

- コマンド: `claudeManager.showGoals` — 実行中タスクを番号付きリストでクリップボードへコピー
- Claude Code で `/goal` を実行後に貼り付けて使用する想定

---

### TASK-2: Claude Code 2.1.136 underscore パス修正の影響確認

`--resume` / `--continue` の underscore パスバグ（2.1.136 で修正）の CSM 側影響を調査。

- `getJsonlPath` のエンコーディング `replace(/[\s/]/g, '-')` はアンダースコアを変換しない → Claude Code 2.1.136+ の動作と一致 ✓
- `decodeProjectName` はアンダースコアをそのまま通す ✓
- `scanProjectsForAutoLink` は全ディレクトリスキャン方式でパスエンコードに依存しない ✓
- **CSM 側の修正不要。既存実装で正しく動作している。**

### TASK-3: csm-check-ask-agent.js に continueOnBlock 追加 (Claude Code 2.1.139+)

`templates/csm-check-ask-agent.js` の block レスポンスに `continueOnBlock: true` を追加。

- Claude Code 2.1.139+: ブロック後もターンを継続し、ブロック理由をフィードバックとして受け取れる
- 旧バージョンは `continueOnBlock` フィールドを無視して従来通りの block 動作（後方互換）

### TASK-8: csm-session-stop.js に terminalSequence 通知追加 (Claude Code 2.1.141+)

セッション終了時にデスクトップ通知を発火する `terminalSequence` フィールドを Stop hook に追加。

- 設定キー `claudeManager.hooks.desktopNotification.enabled` (デフォルト: false、opt-in)
- extension.ts 起動時 / 設定変更時に `session-manager.json.hookSettings.desktopNotification` へ同期
- `templates/csm-session-stop.js`: `hookSettings.desktopNotification` が true のとき `terminalSequence` を出力
  - `]2;CSM: {agentName} セッション終了` (xterm window title + BEL)
- `src/models/types.ts`: `CsmHookSettings` インターフェース追加、`ManagerData.hookSettings` フィールド追加
- `src/models/dataStore.ts`: `setHookSetting()` / `getHookSettings()` 追加
- `package.json`: `claudeManager.hooks.desktopNotification.enabled` 設定項目追加

### TASK-10: README.md に推奨バージョン記載

動作要件テーブルを README 冒頭に追加:
- VS Code 1.85.0+ (必須)
- Claude Code 2.1.113+ (必須) / 2.1.139+ (推奨) / 2.1.141+ (全機能)

### ⭐ お気に入りツリー — エージェントタブにブックマーク階層表示を追加

既存のフラットな ★ブックマーク一覧に加え、親子階層を維持したツリー形式でブックマーク済みエージェントを表示するセクションを追加。

#### 動作
- ブックマーク（★）済みエージェントが1件以上あると「⭐ お気に入りツリー」セクションが表示される
- ★ ノードから `parentAgent` を遡り、必要な祖先ノードを自動収集してツリーを再構築
- ★ なしの中間ノードは `(経由)` バッジ + グレーアイコンで区別
- ★ ノードは黄色い星アイコンで強調
- ノードクリックで既存と同様にエージェントプレビューを開く

#### 実装
- `src/providers/agentTreeProvider.ts`:
  - `import { getBookmarks }` 追加
  - `FavoriteTreeSectionItem` クラス追加（折りたたみ可能セクションヘッダ）
  - `FavoriteAgentItem extends AgentItem` クラス追加（★/中間ノード）
  - `_buildFavoriteRoots()` — 祖先パス収集 + ルートノード生成
  - `_makeFavoriteItem()` — 単一ノード生成ヘルパー
  - `getChildren()` に `FavoriteTreeSectionItem` / `FavoriteAgentItem` ハンドラを追加
  - トップレベルでブックマーク1件以上の時に `FavoriteTreeSectionItem` を追加

---

## v0.5.0 (2026-04-27)

### プロジェクト UI 改善 — 詳細別タブ化 / ダイアログ廃止 / エクスプローラで開く

#### 詳細を WebView Editor タブで表示 (改善1)
- `src/panels/projectDetailPanel.ts` を新規作成 (singleton WebviewPanel)
- プロジェクト行クリック → `open-project-detail` → `showProjectDetail()` で Editor タブを開く
- サイドバー内のインライン詳細ペイン (`#project-detail-pane`) を削除
- プロジェクト一覧をコンパクトリスト形式に変更（行ごとに 詳細・エクスプローラ・削除ボタン）
- エージェント割り当て／解除後はパネルを自動更新

#### 別フォルダ確認ダイアログ廃止 (改善2)
- `src/commands/agentCommands.ts`: エージェント/プロジェクトを別ワークスペースで開く際の
  `showWarningMessage` ダイアログを削除
- 代わりに `vscode.openFolder` を `forceNewWindow: true` で即時実行

#### 📂 エクスプローラで開くボタン追加 (改善3)
- プロジェクト詳細パネル・一覧行の両方に 📂 ボタンを追加
- `revealFileInOS` コマンドで OS のファイルマネージャーを起動

### プロジェクトタブで タブバー統合 (試行)

`claudeMain` (WebView) にタブバー + アクション行を内包し、プロジェクトタブ時は
`claudeTabBar` を非表示にすることで、タブボタン → プロジェクト内容 を1枚の連続 WebView として表示。

#### 変更内容
- `mainTabPanel.ts`: タブバー CSS を `tabBarPanel.ts` と統一（高さ 36px、flexbox 整列、アイコン付き）
- `mainTabPanel.ts`: タブ切り替え時に `setContext('claudeManager.activeTab', tab)` を呼ぶ
- `mainTabPanel.ts`: `onDidChangeVisibility` でプロジェクトタブ再表示時に projects ペインにリセット
- `mainTabPanel.ts`: 各タブ別アクション行を追加（`tabBarPanel.ts` と同一ロジック・スタイル）
- `package.json`: `claudeTabBar` の `when` 句に `&& claudeManager.activeTab != 'projects'` を追加

#### 動作フロー
1. ユーザーが `claudeTabBar` でプロジェクトタブをクリック → `activeTab = 'projects'`
2. `claudeTabBar` が非表示、`claudeMain` が表示（タブバー + アクション行 + プロジェクト内容が1枚で見える）
3. `claudeMain` 内の別タブ（セッション等）をクリック → `setContext` で `activeTab` 更新
4. `claudeMain` が非表示、`claudeTabBar` が再表示

### hook を exec-form (args[]) に統一 (Claude Code 2.1.139+ クォート問題解消)

CSM が登録する全 hook を `command: "node"` + `args: [scriptPath, ...]` の exec-form に統一。
シェルを経由しない直接 spawn になるため、スペースを含むパスでのクォート問題が完全に解消される。

#### 変更内容
- `src/services/hookService.ts` に exec-form サポート用ヘルパーを追加:
  - `supportsExecForm()` — `claude --version` でバージョン判定（初回のみ実行・キャッシュ）
  - `buildHookDef(scriptPath, timeout, extraArgs?, extra?)` — 2.1.139+ なら exec-form、未満なら shell-form を返す
  - `hookMatchesMarker(hh, marker)` — shell/exec 両形式でマーカー一致判定
  - `signalHookMatches(hh, marker, action)` — subagent-signal 用 action 付き判定
  - `migrateHookToExecForm(hh)` — shell-form を exec-form に in-place 変換
- `migrateHooksToExecForm(outputChannel)` を export — 起動時に既存設定を一括変換
- 対象 hook: csm-precompact / csm-precompact-summary / csm-session-stop / csm-recap-capture /
  csm-session-agent-inject / csm-governance-capture / csm-check-ask-agent / subagent-signal
- `src/extension.ts`: 起動時に `migrateHooksToExecForm()` を呼び出して既存設定を自動変換
- Claude Code < 2.1.139 ではフォールバックとして従来の shell-form を維持

### isOtherProject クロスプラットフォームパス比較修正

`agentTreeProvider.ts` の `isOtherProject` 関数で、エージェントの `workDir`（Windows パス: `c:\GDrive\Craftwork`）を
Linux の VS Code ワークスペースパス（`/mnt/hgfs/GDrive/craftwork`）と直接比較していたため、
`workDir` 設定済みエージェントが全て「他プロジェクト」として扱われていた問題を修正。

- `agentUtils.ts` に既存の `translateWorkDirPath()` を `agentTreeProvider.ts` の `isOtherProject` でも使用するよう変更
- `workDir` をパス比較前に Linux パスへ変換（`c:/GDrive/` → `/mnt/hgfs/GDrive/`）
- `ruleFile` パスは disk から読み取った絶対 Linux パスのため変換不要（変更なし）

### プロジェクト情報パネル削除（ユーザー意図と相違のため revert）

commit ccbedcf で追加した `claudeProjectInfo` WebView パネルをリバート。
下部空白解消のためのパネル追加はユーザーの意図と異なっていたため削除。
- `src/panels/projectInfoPanel.ts` を削除
- `package.json` から `claudeProjectInfo` ビュー定義を削除
- `src/extension.ts` から import・登録コードを削除

### タブバー動的アクション行 + ステータス行

タブバーのアクション行をタブ別に動的切替し、下部空白を解消するステータス行を追加。

#### 動的アクション行（タブ別）
- **全タブ共通**: 🔄更新 / ⚙️設定
- **セッション**: 🔍検索 (`claudeManager.searchSessions`) を追加
- **エージェント**: ➕新規 / 🌐組織図 / ✅確認待ち (`claudeManager.showPendingTasks`) を追加
- **メモリ**: 🧬メモリ統合 (`claudeManager.mergeMemories`) を追加
- **プロジェクト**: 更新 + 設定のみ
- アクション行は JS 側で動的レンダリング。タブクリック時に即時切り替え。

#### ステータス行（下部空白解消）
- body を `height: 100vh` + flex column にして Webview 全体を埋める
- 最下部に固定のステータス行（22px）を追加:
  - 🟢/⚫ 動作中エージェント数
  - 最終更新時刻（相対表示: "3秒前"/"2分前"）
  - ワークスペースフォルダ名
- Extension から 10 秒ごとに `postMessage` でデータをプッシュ
- `agentWatcher.onDidChange` 時にも即時プッシュ

### タブバー下クイックアクション行 + プロジェクトツリーをデフォルト化

#### タブバー下空白をクイックアクション行で活用
- タブバー (`claudeTabBar`) の下に 4 つのクイックアクションボタンを追加
  - 🔄 **更新** — セッション一覧を即時更新 (`claudeManager.refreshSessions`)
  - ➕ **新規エージェント** — エージェント作成ダイアログを開く (`claudeManager.addAgent`)
  - 🌐 **組織図** — 組織図パネルを表示 (`claudeManager.openOrgChart`)
  - ⚙️ **設定** — 拡張設定を開く (`claudeManager.openSettings`)
- タブバー Webview の高さを 36px → 72px に拡張（タブ行 + アクション行）
- `package.json` の `initialSize` を 1 → 2 に更新

#### プロジェクトタブのデフォルト表示をツリーに変更
- 初回起動時 (`localStorage` 未設定) のデフォルトモードを `'card'` → `'tree'` に変更
- カードモードはトグルボタンで引き続き利用可能

---

### 利用率 StatusBar — クリックで QuickPick メニュー表示

StatusBar の利用率表示をクリックしたとき、再取得のみ行っていた動作を改善。
3 択の QuickPick メニューを表示し、用途に応じた操作を選択できるようにした。

- **$(browser) Claude Code を開く** — `claude-vscode.sidebar.open` を実行（失敗時は `editor.open` にフォールバック）
- **$(link-external) claude.ai/settings/usage をブラウザで開く** — ブラウザで使用量ページを表示
- **$(refresh) 利用率を再取得** — 従来どおり最新データをフェッチ

`claudeManager.refreshUsage` コマンドは既存のキーバインドや設定から引き続き利用可能。
新コマンド `claudeManager.openUsageMenu` を package.json の commands に登録。

### v0.5.0 プロジェクトツリーモード追加 — プロジェクトタブにツリー表示を追加

プロジェクトタブにカード表示とツリー表示を切り替えるモード切替機能を追加。
既存のカードモード (Sprint 2 実装) は温存し、ツリーモードを新規追加。

#### TT1: モード切替トグル UI
- アクションバー右端に [📋 カード] / [🌲 ツリー] トグルボタンを追加
- `localStorage('csm.projectTab.mode')` でモードを永続化（デフォルト: カード）
- 起動時に保存済みモードを自動復元

#### TT2: ツリー構造レンダリング
- `<details>/<summary>` ネイティブ折りたたみでプロジェクトをノード表示
- 各プロジェクトに 3 カテゴリのサブノード:
  - 👤 エージェント — 割当エージェント名一覧
  - 🧠 メモリ — プロジェクトメモリファイル一覧
  - 💬 セッション — 紐づきセッション一覧 (最大 20 件)
- 件数バッジ・▶ 開閉アニメーション・VS Code テーマカラー連動

#### TT3: `getProjectTree` postMessage プロトコル追加
- Webview → Extension: `{ type: 'getProjectTree' }`
- Extension → Webview: `{ type: 'project-tree-data', trees: [...] }`
- バックエンドで `discoverProjects` / `loadAllSessions` / `loadMemoryFiles` を並列取得
- 各プロジェクトに `{ agents, sessions, memories }` をまとめて返送

#### TT4: ノードアクション
- プロジェクトノード「詳細」ボタン → カードモードへ切替後に詳細ペインを開く
- プロジェクトノード「VS Code」ボタン → フォルダを VS Code で開く
- エージェントリーフクリック → エージェントセッション起動
- メモリリーフクリック → ファイルをサイドエディタでプレビュー (`open-memory-file`)
- セッションリーフクリック → セッションプレビューを開く

---

### v0.5.0 自動紐づけ修正 — claude --agent 起動時の sessionId 自動リンク

`claude --agent <name> -p` で子エージェントを起動した際、新規 sessionId が作成されるにもかかわらず  
`session-manager.json` の `agentSessions[<name>].sessionId` が空のままになるバグを修正。

#### TA1+TA2: dataStore.ts — `setAgentSession` 追加

- `setAgentSession(name, sessionId, mode?)` を新規 export
  - `agentSessions[name].sessionId` が空または `"unlinked"` の場合のみ更新（ユーザー操作を尊重）
  - writeQueue で直列化して並列書き込み競合を回避

#### TA2: agentWatcher.ts — リアルタイム自動紐づけ

- `processedAutoLinkSids: Set<string>` フィールドを追加（二重処理防止）
- `readFirstLine(filePath)`: JSONL 先頭 1 KB のみ読み取るユーティリティ
- `tryAutoLinkSession(sessionId, cwd)`: 新規ライブセッション検知時に JSONL 先頭行を解析し、  
  `agent-setting` エントリかつ agents/*.md が存在する場合のみ自動紐づけ
- `update()` 内: `newSessionCwdMap` 確定後に未処理セッションへ `tryAutoLinkSession` を並列実行

#### TA3: agentWatcher.ts + extension.ts — 起動時一括スキャン

- `scanProjectsForAutoLink()`: `~/.claude/projects/**/*.jsonl` を全走査
  - 未紐づけエージェントのみ対象（高速化）
  - 各エージェントの最新 JSONL（mtime 降順）を採用
  - agents/*.md 存在確認 → `setAgentSession` 呼び出し
- `extension.ts`: `agentWatcher.start()` 直後に `scanProjectsForAutoLink()` を非同期呼び出し

---

### v0.5.0 ハイブリッドタブパッチ — タブバー WebView + ネイティブ TreeView

タブバー (小さな WebView 40px) と OS ネイティブ TreeView を組み合わせたハイブリッド構成に変更。
タブ切り替えで各 TreeView の表示/非表示を制御する。

#### TH1: tabBarPanel.ts — 新規タブバー WebView
- `claudeTabBar` WebView View Provider を新規作成
- タブ (sessions / agents / memory / projects) をクリックすると `claudeManager.activeTab` コンテキストキーを更新
- VS Code テーマカラー連動 CSS、アクセシビリティ対応 (`aria-pressed`, `role="tablist"`)
- `claudeManager.ui.lastActiveTab` 設定に最後に選択したタブを永続化

#### TH2: package.json — views when 句改訂
- `claudeTabBar` を `claude-manager` viewContainer 先頭に追加
- `claudeMain` (projects WebView) は `claudeManager.activeTab == 'projects'` 時のみ表示
- `claudeSessions` / `claudeBookmarks` / `claudeTags` は `sessions` タブ時のみ表示
- `claudeAgents` は `agents` タブ時のみ表示
- `claudeMemory` は `memory` タブ時のみ表示
- `useNewMainPanel == false` 時は旧来の5ビュー全表示フォールバックを維持

#### TH3: package.json — defaultTab に "memory" を追加
- `claudeManager.ui.defaultTab` の選択肢に `memory` を追加
- enum: `["sessions", "agents", "memory", "projects"]`

#### TH4: extension.ts — TabBarPanel 登録 + 起動時 setContext
- `TabBarPanel` を import し `claudeTabBar` WebViewViewProvider として登録
- 起動時に `getConfig('ui.defaultTab')` を読んで `setContext('claudeManager.activeTab', defaultTab)` を実行
- defaultTab バリデーション (sessions/agents/memory/projects 以外は sessions にフォールバック)

---

### v0.5.0 Sprint 3 — 自律組織 + 引っ越し + 機能追加UI + 仕上げ

#### T3.1: snippetLibrary.ts — スニペットライブラリサービス

- `loadSnippets()`: `data/snippets/core.json` からスニペット一覧をロード（TTLキャッシュ付き）
- `getByCategory()`: カテゴリ別フィルタ
- `search()`: タイトル/説明/タグの全文検索
- `getById()`: ID指定取得

#### T3.2: data/snippets/core.json — 標準スニペット 10件

- **core-001** TDD ワークフロー (workflow) — RED→GREEN→IMPROVE 手順
- **core-002** セキュリティレビュー手順 (workflow) — コミット前チェックリスト
- **core-003** コードレビュー標準 (workflow) — 品質チェック + 重大度基準
- **core-004** 破壊的操作禁止 (constraint) — rm -rf / force push 等の承認必須化
- **core-005** 他フォルダ編集禁止 (constraint) — workDir スコープ外への書き込み禁止
- **core-006** 報告フォーマット (communication) — タスク完了報告の標準テンプレート
- **core-007** エラー報告手順 (communication) — エラー発生時の即時停止・報告フロー
- **core-008** Read/Edit/Bash ツール注記 (tool-note) — ファイル操作ツールの使い方と注意
- **core-009** Web検索ツール注記 (tool-note) — プロンプトインジェクション対策付き
- **core-010** 完了条件チェックリスト (workflow) — 完了前確認の汎用チェックリスト

#### T3.11: helpFeedbackProvider.ts — Discussions リンク追加

- `ディスカッション` エントリを追加 (`comment-discussion` アイコン)
- URL: `https://github.com/ratorin/claude-session-manager/discussions`

#### T3.21: Help & Feedback 実コンテンツ整備

- GitHub リポジトリ URL を実値で設定済みであることを確認
  - ドキュメント: `https://github.com/ratorin/claude-session-manager#readme`
  - 問題を報告: `https://github.com/ratorin/claude-session-manager/issues/new`
  - ディスカッション: `https://github.com/ratorin/claude-session-manager/discussions`
  - 変更履歴: `https://github.com/ratorin/claude-session-manager/blob/master/CHANGELOG.md`

#### T3.23: CHANGELOG.md Sprint 3 セクション追加

#### T3.24: README.md v0.5.0 新機能追記

---

### v0.5.0 Sprint 2 — プロジェクトタブ + エージェント強化 + 組織図

#### T2.1〜T2.9: プロジェクトタブ完全実装

- **T2.1/T2.2**: プロジェクトカードグリッド（name / パス短縮 / ソース / isCurrent バッジ）、クリックで詳細ペイン展開
- **T2.3**: 詳細ペイン概要セクション（パス / ソース / 登録日）
- **T2.4**: エージェント割当/解除 UI — `~/.claude/csm-project-agents.json` に永続化
- **T2.5**: メモリ管理統合 — タイプ別バッジ付き一覧（project / user / feedback / reference）
- **T2.6**: `progressCalculator.ts` — TODO/HISTORY/確認待ちをエージェントディレクトリから横断スキャン（5秒TTLキャッシュ）
- **T2.7**: 進捗ダッシュボード — TODO残/完了プログレスバー + 直近HISTORY 5件
- **T2.8**: クイックアクション — "VS Codeで開く" / "ターミナルで開く"
- **T2.9**: + 新規プロジェクト追加（フォルダ選択ダイアログ → `registerProject()`）

#### T2.10+T2.11: bookmarkService.ts — エージェントブックマーク + 最終使用日

- `addBookmark()` / `removeBookmark()` / `toggleBookmark()` / `getBookmarks()`
- `recordLastUsed()` / `getLastUsed()` / `getRecentlyUsed(n)` / `relativeTime(ms)`
- 永続化先: `~/.claude/csm-agent-meta.json`

#### T2.12〜T2.15: エージェントタブ強化

- **T2.12**: ★ ブックマークセクション — 行ごとの ★ ボタンでトグル
- **T2.13**: 最終使用日順 Top 5 — `relativeTime()` で相対表記
- **T2.14**: 詳細フィルタ — モデル / スコープ / 親エージェント チップ式AND条件
- **T2.15**: グローバル / プロジェクト分離 — 🌐バッジ / proj バッジ

#### T2.16: showOtherProjects 設定 + 永続化

- `claudeManager.agents.showOtherProjects` (default: true) 設定キー追加
- トグルコマンドが設定を `ConfigurationTarget.Global` に永続保存
- `claudeManager.agents.defaultExpand` 設定キー追加（bookmarks / recent / global / project）

#### T2.17: Cytoscape.js + ELK 導入

- `cytoscape.min.js`, `cytoscape-elk.js`, `elk.bundled.js` を `resources/` に配置
- webview CSP 準拠で `webview.asWebviewUri` 経由で提供

#### T2.18〜T2.20: 組織図 Cytoscape 化

- **T2.18**: `orgChartPanel.ts` を Mermaid から Cytoscape.js + ELK へ全面刷新
- **T2.19**: モード切替 — ツリー (ELK layered) / 関係 (cose force-directed) / グループ (ELK box)
- **T2.20**: フィルタ (モデル/親) + PNG/SVG エクスポート

#### T2.21: プロジェクト詳細にミニ組織図埋め込み

- `buildMiniOrgChartData()` で割当エージェントのみ抽出
- 詳細ペインにコンパクトな Cytoscape ミニ組織図を表示

#### T2.22〜T2.24: 使用率バー Sonnet/Opus 5d 列追加

- **T2.22**: `usageMonitor.ts` — 複数候補ヘッダから Sonnet/Opus 5d 使用率を解析
- **T2.23**: StatusBar 新フォーマット: `5% 4.5h / S 3% 5d20h / O 20% 5d10h`
- **T2.24**: `claudeManager.usage.show5dColumns` 設定追加 (default: true)

---

### v0.5.0 Sprint 1 — 基盤 + 3タブ骨格

#### T1.1: pathUtils.ts — クロスプラットフォームパスユーティリティ

- `expand()`: `~`, `${HOME}`, `${PROJECT_DIR}` プレースホルダー展開
- `contract()`: 絶対パス → `~/...` 短縮
- `normalize()`: スラッシュ統一・末尾スラッシュ除去・Windows大文字統一
- `isContainedIn()`: セパレータ考慮の親子パス判定

#### T1.2: data/i18n/ja/agents.json — エージェント辞書移行

- `data/global-agents-i18n.json` → `data/i18n/ja/agents.json` に移行
- `agentFileManager.ts`: 新パス優先ロード・旧パスフォールバック（後方互換）

#### T1.3–T1.5: data/i18n/ja/{skills,tools,ui}.json — 日本語辞書

- スキル30件・ツール20件・UIテキスト辞書を新設

#### T1.6: i18nService.ts — 辞書ロード + キャッシュ + 翻訳APIスタブ

- `getI18n()`: 辞書キャッシュ付き一括ロード
- `t(key)`: ドット区切りキーでUIテキスト取得
- `agentDisplayName()` / `skillDisplayName()` / `toolDisplayName()` ヘルパー
- `setLocale()` / `translateText()` 拡張スタブ

#### T1.7+T1.8: projectService.ts — プロジェクト検出・登録

- 3ソース検出: workspaceFolders / `~/.claude/projects/` 逆変換 / csm-projects.json
- `registerProject()` / `removeProject()` / `discoverProjects()` API
- `~/.claude/csm-projects.json` スキーマ定義

#### T1.9: mainTabPanel.ts — 3タブ WebviewView 骨格

- `claudeMain` WebviewViewProvider 実装
- セッション / エージェント / プロジェクト タブ切り替え
- プロジェクトタブ: 一覧表示・追加・削除・open

#### T1.10: extension.ts — claudeMain 登録

- `vscode.window.registerWebviewViewProvider('claudeMain', ...)` を追加
- `retainContextWhenHidden: true` でタブ切り替え時の状態維持

#### T1.11+T1.12: セッション/エージェントタブ移行（ポインタ実装）

- 既存 TreeView を維持しつつ、mainTabPanel から各ビューへの導線を設置

#### T1.13: helpFeedbackProvider.ts — Help & Feedback ビュー

- `claudeHelp` TreeView: ドキュメント・問題報告・変更履歴・バージョン情報

#### T1.14: migrationService — v0.5.0 マイグレーション

- `runV05Migration()`: csm-projects.json 初期化 + i18nパス確認

#### T1.15: package.json — viewsContainers/views 更新

- `claudeMain` (webview type) + `claudeHelp` (panel) を追加
- 既存 TreeView は後方互換で継続

#### T1.16: 設定キー追加

- `claudeManager.locale`: UI表示言語（ja / en）
- `claudeManager.ui.defaultTab`: 起動時デフォルトタブ（sessions / agents / projects）

---

## v0.4.7 (2026-04-25)

### CSM × Claude Code 統合強化（Phase 1 + Phase 2）

#### Phase 1-1: PreCompact Summary hook — コンパクション前文脈保持

- **新規テンプレート** `csm-precompact-summary.js` をデプロイし、PreCompact hook として全セッションに登録
- コンパクション直前に JSONL トランスクリプト末尾を走査し、CSM_SUMMARY マーカー付きサマリーを生成
- 保存先: `~/.claude/projects/<encoded_cwd>/csm-compact-summary.md`（SessionStart 時に文脈として読み込み可能）
- bash/python 不要の Node.js 実装（Windows 素環境対応）

#### Phase 1-2: csm-check-ask-agent.js — bash+python → Node.js 移行

- **旧** `check-csm-ask-agent.sh`（bash + python3 依存）を廃止
- **新** `csm-check-ask-agent.js`（Node.js）を自動デプロイ
- `registerCsmAskAgentHook`: 旧 bash エントリを自動検出して node エントリに差し替え
- `installCsmAskAgent` コマンド: `.sh` を `.trash/` に退避してから `.js` をデプロイ

#### Phase 2-1: 名前ベース `--resume <name>` サポート（Claude Code v2.1.101+）

- `AgentConfig` に `useNameResume?: boolean` フィールドを追加
- `cliBuilder.buildCommand`: `sessionId` 未設定かつ `useNameResume: true` の場合に `--resume <name>` を付与
- `agentCommands.openAgentSession`: `buildResumeArgs()` ヘルパーを導入。sessionId → 名前ベース → 新規の優先順でフォールバック
- `csm-ask-agent.command.md` Step 3 を3ケース方式（sessionId指定 / 名前ベース / 新規確認）に更新

#### Phase 2-2: `/recap` 結果自動キャプチャ → HISTORY.md 追記

- **新規テンプレート** `csm-recap-capture.js` をデプロイし、Stop hook として登録
- セッション終了時に JSONL を走査し `/recap` 呼び出しと直後のアシスタント応答を検出
- `historyEnabled: true` かつ HISTORY.md が存在するエージェントセッションのみ追記
- 重複追記防止: コンテンツ先頭50文字でフィンガープリントチェック
- `/recap <引数>` の引数があればサブタイトルとして付記
- 出力先は `csm-session-stop.js` と同じ HISTORY.md（書き込み条件・スコープ解決も同一ロジック）
- `csm-compact-summary.md` とは対象が異なる（重複なし）

---

## v0.4.6 (2026-04-25)

### 緊急パッチ（C-1 〜 C-4 + H-1, H-4）

QAレビューで指摘された Critical / High 計6件を修正。

- **C-1 修正** — `writeOrgInfoToMemory` に cwd 照合を追加。`encodeCwdToProjectDir()` で現在の workspace cwd をエンコードし、`projectsDir` 内のフォルダと照合してから書き込む。**別プロジェクトの MEMORY.md 汚染を防止**
- **C-2 修正** — `csm-precompact.sh` → `csm-precompact.js` に移行。bash / python 不要の Node.js 実装を新規作成。`ensurePreCompactHook` が旧 `.sh` を `.trash/` に退避し `.js` をデプロイ。既存の bash コマンドエントリを node コマンドに自動アップグレード。**Windows 素環境での silent fail を解消**
- **C-3 修正** — `dataStore` の並行書き込み排他を追加。モジュールレベルの writeQueue（Promise チェーン）で `saveData` / `saveLocalData` を全て直列化。**load→mutate→save 間の競合によるデータ消失を防止**
- **C-4 修正** — `getJsonlPath` のエンコードを Claude Code 実装と対称化。`toLowerCase()` でドライブレター小文字化、`/[\s/]/g` で空白も `-` に変換（例: `C:\My Project` → `c--my-project`）。**大文字小文字混在パス・スペース含むパスでのセッション解決失敗を修正**
- **H-1 修正** — dead menu エントリ削除。`package.json` から `editRuleFile/WithRule` の menu 定義を削除（`agentItem` に `WithRule` suffix を付ける実装は存在しないため永久に非表示だった）
- **H-4 修正** — `extensionOutputChannelEarly` のリーク修正。`extension.ts` で `createOutputChannel` 直後に `context.subscriptions.push`。**Extension Host 共有プロセスで拡張無効化後もチャンネルが残るリークを解消**

---

## v0.4.5 (2026-04-20)

### `/csm-ask-agent` スキル指示の刷新（HIGH バグ修正）

- **意図しない新規セッション作成の防止** — 旧指示は「出力が空なら `--resume` を外して再試行」という無条件フォールバックを持っており、workDir のcd抜けによる `No conversation found` エラーで**毎回新規セッションが作られる**問題があった
- **エラーパターンで分岐** — `No conversation found` / 0バイト空出力 / 正常出力 を判定し、workDir 再cd でリトライ。それでも失敗ならユーザーに承認確認
- **`--resume` を勝手に外す運用を明確禁止** — CSMの紐づけと実セッションが分離する原因のため
- 同期先: `~/.claude/commands/` / `<workspace>/.claude/commands/` / `templates/csm-ask-agent.command.md`

詳細: `docs/feedback/2026-04-20-csm-ask-agent-skill-outdated.md`

---

## v0.4.4 (2026-04-18)

### Claude Code v2.1.113 対応

- **ネイティブバイナリ対応** — `cli.js` から `claude.exe` への変更に追従。`resolveClaudeExec` が `bin/claude.exe` / `claude.exe` / `cmdDir/claude.exe` の3候補を順に探索（npm/yarn/pnpm レイアウトに対応、cli.jsフォールバック維持）
- **サブエージェント10分タイムアウト反映** — `taskErrorThreshold` 設定追加。stalled のまま既定30分経過で `error` 扱いに昇格（対話セッションの誤検知回避のため既定値は30分）

### UX改善

- **「Claudeで開く（IDE）」の整合性チェック** — セッション作成時の cwd と現在のVS Codeワークスペースを正規化比較（大文字小文字・区切り文字を吸収）。不一致なら「そのフォルダを開く / ワークスペースに追加 / このまま開く」を提案
- **新規エージェント登録後に紐づけ画面へ誘導** — 自動セッション作成を廃止し、既存セッション紐づけ or 新規作成を選べるピッカーを開く
- **TODO/HISTORY ON時の空メッセージ修正** — トグルONかつファイル未生成時に「OFFの状態です」と誤表示していたのを「ON状態です。まだ空です」に修正

### Stop hook 追加

- **セッション終了時のHISTORY.md追記** — PreCompactに加えてStop hookでも自動記録。テンプレート `csm-session-stop.js` を拡張起動時に自動デプロイ、settings.jsonに登録
- **動作条件**: エージェントの `historyEnabled: true` かつ HISTORY.md 存在時のみ（無関係セッションには無害）

### エラー自動収集（A案）

- **ローカルログ蓄積** — `~/.claude/csm-errors.log`（512KBローテート）に `unhandledRejection` / `uncaughtException` を自動記録
- **コマンド追加**
  - `Claude Session Manager: 不具合を報告（GitHub Issue作成）` — ログ埋め込み済みのIssue URLをブラウザで開く
  - `Claude Session Manager: エラーログを開く`
- 自動送信なし。ユーザーがIssue内容を確認してから送信

---

## v0.4.3 (2026-04-18)

### v0.4.2 レビュー指摘修正（hotfix）

- **H-1 修正** — `csm-ask-agent.py` の `workDir` 逆引きロジックを置換。プロジェクトディレクトリ名のデコード（`-`→`/`）は仕様変更に壊れやすいため、セッションJSONL先頭の `cwd` フィールドを読み取る方式に変更（スペース含むパスも正しく復元）
- **H-2 修正** — `createRenewSession` に `resolved` ガードを追加。タイムアウト後のプロセス正常終了による二重resolveレースを解消（`createSessionForAgent` と同じパターン）
- **CRITICAL 修正** — 空 sessionId または実ファイルが存在しない sessionId を起動時に自動クリーンアップするマイグレーションを追加。タイムアウトバグで保存された壊れた紐づけを v0.4.3 初回起動時に修復
- **UX改善: 新規エージェント登録後に紐づけ画面へ誘導** — 自動セッション作成をやめ、既存セッション紐づけ or 新規作成を選べるピッカーを開く

---

## v0.4.2 (2026-04-17)

### エージェント管理の全面刷新

- **エージェント定義ファイルを CLI 標準に統一** — `~/.claude/agents/<name>.md` に役割本文（body）を直接書き込み。`claude --agent <name>` で起動時に自動適用
- **プロジェクトスコープのエージェント対応** — ワークスペースの `.claude/agents/` に保存・スキャン。複数プロジェクトのエージェントを同時管理
- **追加ディレクトリスキャン** — 設定 `claudeManager.additionalAgentDirs` で任意フォルダのエージェントを読み込み
- **スコープ切り替え時のファイル自動移動** — グローバル↔プロジェクト切り替え時に `.md` と `TODO/HISTORY` フォルダを自動移動
- **ドラッグ&ドロップで親子関係変更** — エージェントツリー上でドラッグして上下関係を編集
- **他プロジェクトのエージェントを灰色表示＋フィルター** — 現在のワークスペース外のエージェントを区別して表示

### ガバナンス・セキュリティ

- **ガバナンス記録統合** — Bash/Edit/Write 操作時に秘密鍵・危険コマンドを検知して `~/.claude/governance-events.jsonl` に記録。セッションプレビューに Actions Log 表示
- **SessionStart hook でエージェント役割を自動注入** — CSM で紐づけたエージェントの役割定義をセッション開始時に自動注入。Claude が起動直後から役割を認識
  - 未有効化ユーザー向けにエージェントツリーにバナー表示
  - 旧 bash 版から Node.js 版へ自動マイグレーション

### コード品質・パフォーマンス

- **extension.ts を 9 ファイルに分割** — 2776 行 → 347 行（87% 削減）。services/・commands/ に機能別分離
- **CLI 呼び出しを `--agent` 方式に統一** — `--model`/`--effort` の個別指定を廃止。フロントマターから自動適用
- **セッション一覧をファイルサイズで表示** — 概算会話数から実サイズ（KB/MB）に変更

### UI 改善

- **メモリ管理フィルター改善** — 初期状態で自プロジェクトのみ表示。フィルター OFF 時に他プロジェクトは折りたたみ
- **エージェント役割 ON/OFF 切り替えバグ修正** — トグル後にセッション名が ID に変わる問題を修正
- **セッション表示に名前と ID を併記**
- **紐づけ画面に「新しいセッションを作成」を追加** — 既存セッション選択の末尾から新規作成可能

### アップデート対応

- **v0.3.x → v0.4.x 自動マイグレーション** — 初回起動時にバックスラッシュ増殖バグを自動修正。バージョン追跡で重複実行を防止
- **Opus 4.7 / xhigh effort 対応** — モデル不一致検知をバージョン番号非依存に改善。`xhigh` effort レベルを追加
- **PreCompact hook** — コンパクション前にセッション要約を HISTORY.md に自動記録

### セッション作成・紐づけ修正

- **Windows `.cmd` EINVAL エラー回避** — Node.js CVE-2024-27980 対応。`claude.cmd` ラッパーを経由せず `cli.js` を `node` で直接起動（`createSessionForAgent` / `createRenewSession` / 要約生成の3箇所）
- **セッション作成の早期 resolve** — `session_id` 取得時点で即完了扱い。プロセス完了待ちのタイムアウト（60秒）で空 sessionId が保存される問題を解消
- **他プロジェクトのセッションタイトル解決** — 他ワークスペースに紐づいたグローバルエージェントで sessionId 断片ではなくタイトルが表示されるよう、`~/.claude/projects/*/` を横断検索（軽量版、60秒キャッシュ）

### `/csm-ask-agent` cwd 対応

- **エージェントの `workDir` で cwd を切り替え** — `claude --resume` は作成時と同じ cwd が必要なため、`cd {workDir}` を必須化。`csm-ask-agent.py` の出力形式を `{sid}|{perm}|{workDir}` に拡張し、`workDir` 未設定時は `~/.claude/projects/` から逆引き

---

## v0.4.2 (2026-04-12)

### エージェントプレビューパネル刷新

- **Webview ベースのプレビュー** — エージェントクリック時にヘッダボタン付きの詳細パネルを表示
  - 配下エージェントツリー・連携先エージェント一覧を表示
  - TODO.md / HISTORY.md をプレビュー内に表示（トグルで ON/OFF 切替可能）
- **TODO チェックボックス切り替え → ファイル反映** — プレビュー内のチェックボックス操作が TODO.md に即時反映
- **HISTORY 下追記方式・最下部スクロール** — HISTORY.md は下追記方式で表示し、最下部に自動スクロール

### 確認待ち横断ビュー

- **チェックリストボタン** — エージェント管理ツリーのタイトルバーにボタンを追加
- **Webview で確認待ち一覧表示** — 全エージェントの未完了 TODO を横断表示
- **チェック ON/OFF → ファイル反映** — 横断ビュー内のチェック操作も各 TODO.md に即時反映

### `/csm-ask-agent` スキル（リネーム）

- **`/ask-agent` → `/csm-ask-agent` にリネーム** — 移行バナー付きで旧名からの自動案内を表示
- **`csm-ask-agent.py` ヘルパー拡張** — `--list` で全エージェント一覧、`--pending` で確認待ちタスク一覧を表示
- **`--resume` 時に `--append-system-prompt-file` 追加** — セッション再開時にルールファイルを自動注入

### Stop フック連携

- **CSM_SUMMARY → HISTORY/TODO 自動追記** — セッション終了時の `<!-- CSM_SUMMARY -->` マーカー内容を HISTORY.md / TODO.md に自動転記

### エージェントフォーム改善

- **displayRole / displayDescription 削除** — `role` / `description` に統一（CLI 標準に合わせて簡素化）
- **Extended Thinking トグル完全削除** — フォームから撤去（CLI 側制御に完全委譲）
- **紐づけ変更時の確認ダイアログ** — セッション紐づけ変更時に既存紐づけの確認を表示

### 親子同期・ルール自動生成

- **CHILDREN ブロックに連携先エージェント自動生成** — 親ルールファイルの配下セクションに連携先エージェント情報を自動追記

### ステータスバー・設定

- **ステータスバー和名表示** — エージェントの日本語名（和名）をステータスバーに表示
- **VS Code 設定追加** — `defaultHistoryEnabled` / `defaultTodoEnabled` を追加（デフォルト OFF）
- **VS Code 設定削除** — `detectionMode` / `defaultRuleFolder` を削除（不要化）

---

## v0.4.1 (2026-04-11)

### セキュリティ修正

- **[CRITICAL] C-1: パストラバーサル防止** — `agentFileManager.ts` にエージェント名バリデーション追加
  - `^[\p{L}\p{N}_\-]+$` パターンで不正な名前（`../../` 等）を拒否
  - `path.resolve()` 後のディレクトリ境界チェックも追加
- **[CRITICAL] C-2: コマンドインジェクション防止** — `extension.ts` の `spawn()` を `shell: false` に変更
  - Windows環境用に `claude.cmd` を自動選択
- **[HIGH] H-4: YAMLインジェクション防止** — `buildFrontmatter()` の全文字列フィールドをダブルクォートで囲む
  - `sanitizeForYaml()` + `quoteYamlValue()` で改行・制御文字・クォート文字をエスケープ
- **[HIGH] H-5: CSPヘッダー追加** — `agentPreviewPanel.ts` / `orgChartPanel.ts` にnonce付きCSPメタタグを追加
  - インラインイベントハンドラ(`onclick`)を `addEventListener` パターンに置換
- **[HIGH] H-6: 任意ファイル読取防止** — `webviewPanel.ts` の `openLink` ハンドラにパス検証を追加
  - ワークスペース・tmp・`~/.claude/` 配下のみファイルを開くことを許可
- **[HIGH] H-1: フロントマターパーサー統合** — `agentFileManager.ts` の重複パーサーを `frontmatterUtils.ts` に統合
  - `parseFrontmatterExtended()` を共通ユーティリティとしてエクスポート

### データマイグレーション

- **agents[] → agentSessions 自動変換** — `activate()` 時に一度だけ実行
  - 旧形式 `agents[]` を `agentSessions` キーに変換し、`agents[]` を除去
  - 既存の `agentSessions` エントリは保持（上書きしない）

### エージェントフォーム改善

- **Extended Thinking トグル削除** — フォームからExtended Thinking ON/OFFスイッチを撤去（CLI側の制御に委譲）
- **役割フィールド複数行対応** — input → textarea (rows=2) に変更し、長い役割記述を入力しやすく
- **日本語表示名フィールド追加** — `displayRole`（日本語役割）・`displayDescription`（日本語説明）を個別入力可能に
  - CLI の `description`（英語）とは別にUI表示用テキストを管理

### `/ask-agent` スキル

- **セッション継続対応** — セッションIDがあれば `--resume` で既存セッションに継続、なければ `--agent` で新規起動
- **`ask-agent.py`** — セッションID・モデル・effort・permissionMode を一括取得するヘルパースクリプト
- 完了報告の自動返却でタスク管理を簡素化

---

## v0.4.0 (2026-04-10)

### アーキテクチャ刷新（リビルド Phase 3〜6）

#### Phase 3: エージェント管理の更新
- **`agentFileManager.ts` 新規作成** — `~/.claude/agents/*.md` をSingle Source of Truthとして読み書き
  - YAML フロントマター拡張パーサー（JSON配列 `tools: ["Read", "Edit"]` 対応）
  - TTLキャッシュ（2秒間有効）でパフォーマンス最適化
  - グローバル（`~/.claude/agents/`）＋プロジェクト（`.claude/agents/`）の両スコープ対応
- **`dataStore.ts` ブリッジ化** — `getAgents()` が agentFileManager 経由に切り替え
  - session-manager.json には `agentSessions`（セッション紐づけ情報）のみ保存
  - 旧形式 `agents[]` からの自動マイグレーション（読み取り専用で後方互換）

#### Phase 4: 検知の簡素化
- **比較エンジン完全削除** — 7方式並列テスト用ウォッチャーを廃止
  - `detectionComparePanel.ts` を削除
  - agentWatcher.ts を1289行→568行に大幅削減
  - 検知モードを `fswatch` 固定に簡素化（polling/signal モード廃止）
  - package.json から `openDetectionCompare` コマンドと detectionMode 設定の選択肢を削除

#### Phase 5: ファイル分割リファクタ
- **ディレクトリ構造を刷新** — 全ソースファイルを機能別サブディレクトリに再配置
  - `models/` — types.ts, dataStore.ts
  - `providers/` — sessionTreeProvider, agentTreeProvider, tagTreeProvider, bookmarkTreeProvider, memoryTreeProvider
  - `watchers/` — agentWatcher, taskTracker
  - `panels/` — agentFormPanel, agentPreviewPanel, orgChartPanel, webviewPanel
  - `utils/` — sessionLoader, cliBuilder, frontmatterUtils, memoryManager, usageMonitor, subagentDetector
  - `agents/` — agentFileManager, agentManager, parentChildSync
  - `commands/` — （今後のコマンド抽出用）
- 全 import パスを新構造に対応

#### Phase 6: session-manager.json 縮小
- `setAgents()` を削除（デッドコード除去）
- `agents[]` を読み取り専用（後方互換マイグレーション用）に変更
- エージェント定義は `~/.claude/agents/*.md` が唯一の情報源に

#### 親子エージェント同期の刷新
- **`parentAgent` ベースの組織階層構築** — agents/*.md の frontmatter `parentAgent` フィールドから組織ツリーを動的生成
  - 旧方式（session-manager.json の agents[].parentAgent）から完全移行
  - 組織図・エージェントツリーの階層表示が agents/*.md のみから構築される
  - 子エージェント追加/削除時の親ルール自動更新も agents/*.md ベースに刷新

#### 検知方式の2方式化
- **fswatch + jsonlMtime に簡素化** — 旧7方式（polling/signal/subagentsFswatch/preToolUseHook等）を廃止
  - fswatch: sessions/ ディレクトリの変更検知（起動/停止）
  - jsonlMtime: JSONL mtime変化（活動中検知 + 子エージェント検知）

### 既知の制限
- `extension.ts` は2182行のまま（コマンド抽出は次バージョンで実施予定）

---

## v0.3.5 (2026-04-10)

### 新機能
- **検知方式比較ビュー: 7方式対応** — 既存5方式に加え、2つの新方式を追加
  - **⑥ subagentsFswatch** — `~/.claude/projects/*/subagents/` ディレクトリを定期スキャンし、サブエージェント（子タスク）の起動を検知。`.meta.json` から agentType + description を読み取りチップに表示。mtime が10秒以上更新されなければ終了と推定
  - **⑦ preToolUseHook** — Claude CLI の PreToolUse(Agent) フックが書き込んだイベントファイルを fs.watch で検知。VS Code バグ(#21736)により CLIモードでのみ動作

---

## v0.3.4 (2026-04-08)

### 新機能
- **検知方式比較ビュー** — polling / fswatch / signal の3方式を並列テストし、レイテンシと累計検知件数をリアルタイム表示
  - コマンドパレット → 「検知方式比較ビューを開く」で起動
  - エージェント検知時に各方式の応答時間（ms）を計測し、最速方式に「← 最速」バッジを表示
  - 各方式の累計検知件数を常時表示
  - レイテンシ比較バー（横棒グラフ）でビジュアル比較
  - CSP対応（nonce-based `default-src 'none'`）

### バグ修正
- タグ追加ボタンのクリックが反応しない問題を修正（CSP対応: `onclick` 属性を `addEventListener` に変更）

---

## v0.3.3 (2026-04-08)

### バグ修正
- タグ追加ボタンのクリックが反応しない問題を修正（CSP対応: `onclick` 属性を `addEventListener` に変更）

---

## v0.3.2 (2026-04-07)

### 親子ルール自動同期
- `parentChildSync.ts` 新設 — 子エージェント追加/削除/変更時に親ルールファイルの配下エージェントセクションを自動更新

### maxThinkingTokens 完全削除
- `maxThinkingTokens` フィールドを AgentConfig・フォーム・CLI Builder・frontmatter から完全削除
- 推論制御は effort に一本化

### エージェント作成時のセッション自動紐づけ
- `spawn` + `stream-json` でセッションを自動作成し、紐づけまでワンステップ完了
- Windows 環境の `spawn ENOENT` を `shell: true` で修正
- セッション初期化メッセージに役割情報を含める
- 自動作成セッションの cwd をワークスペースルートに統一

### バグ修正
- description テンプレートの「を担当する」重複を解消
- `SessionStart` フック重複登録防止（`ensureSubagentHooks` 改善）
- 稼働状態リセットバグ修正（`refreshAll` + `child.close` 時に再スキャン）
- stop シグナルで `liveSessionIds` から即除去
- ステータスバーとツリーの同期修正
- `package.json` 警告修正

### ドキュメント・公開
- agentWatcher 仕様書追加
- VS Code Marketplace + Open VSX に公開

---

## v0.3.1 (2026-04-05)

### YAML Frontmatter 移行
- ルールファイルの自動生成マーカーを `<!-- CSM:AUTO -->` から YAML Frontmatter 形式に移行
- `frontmatterUtils.ts` 新設 — パース・生成・移行ユーティリティ
- AgentConfig フィールドを frontmatter にマッピング（name, model, effort, thinking 等）
- `description` フィールドにリテラルブロックスカラー（`|`）で自動生成テキストを格納
- 旧形式（CSM:AUTO マーカー）は更新時に自動移行
- カスタム記述セクションは一切変更しない

### SubagentStart/Stop フック
- `subagent-signal.js` 新規 — SubagentStart/Stop イベントでシグナルファイル出力
- シグナルディレクトリ: `~/.claude/.csm-signals/`
- `ensureSubagentHooks()` — 取締役セットアップ時に settings.json へフック自動登録
- 5分超の古いシグナルファイルを自動クリーンアップ
- stdin パイプ切断対応 + Promise拒否防止

### マイグレーションバナー
- エージェント管理ツリービュー上部に旧形式ルールファイル検出バナーを表示
- クリックでYAMLフロントマター変換 + フォルダ構造移行を一括実行
- 移行完了後バナーは自動非表示

### SignalWatcher
- agentWatcher.ts に SignalWatcher 追加 — `~/.claude/.csm-signals/` を fs.watch で監視
- シグナルファイル（JSON）を読み取り、start/stop でライブ状態更新、処理後に即削除
- 200ms デバウンス、enableAgentMonitor OFF 時は停止

### 旧Stopエントリ除去
- ensureSubagentHooks() で旧 Stop イベントの csm-signal.js エントリを検出・除去

### renewAgentSession 修正
- 全体をtry/catchで囲み致命的エラー時にエラーメッセージ + OutputChannel表示
- 遺言生成失敗時はデフォルトメッセージで続行
- OutputChannelを起動時に即作成（遅延作成を廃止）

## v0.3.0 (2026-04-04)

### 監視アーキテクチャ刷新
- **AgentWatcher** 統合監視エンジン新設 — PIDベースのライブセッション検出 + JSONL解析によるサブエージェント検出を1モジュールに統合（EventEmitter方式）
- `agentMonitor.ts` を廃止し、`agentWatcher.ts` + `subagentDetector.ts` に分離
- 旧ポーリング方式を `fs.watch` + デバウンスに置換

### タスク管理・状態検知・通知
- **TaskTracker** 新設 — AgentWatcher イベントでタスク状態を自動評価（running / stalled / completed / error）
- タスクログをエージェントの子ノードとしてツリー表示（ステータス別アイコン・経過時間）
- VS Code通知でタスク完了・エラー・応答停止をリアルタイム通知
- 自動クリーンアップ（completed/error: 72h、running/stalled/pending: 168h）
- コマンド5件追加（タスク記録 / 完了 / 削除 / 出力ファイルを開く / 全クリア）
- 設定4件追加（通知ON/OFF / stalled閾値 / 自動削除時間 / 最大ログ数）

### Claude Code 利用制限モニター
- **UsageMonitor** 新設 — Anthropic APIから5時間/7日の利用率を取得しステータスバーに表示
- 80%超で警告色、95%超でエラー色、90%/100%到達で通知
- デフォルトOFF（有効化で軽量APIリクエストが定期発生、月額$0.01未満）

### ローカル/グローバル分離
- **session-manager.local.json** 導入 — プロジェクト固有エージェントをワークスペース内に保存
- `getAgents()` は同名ローカル優先でマージ、スコープ指定保存・移動に対応

### メモリ管理拡張
- グローバルメモリ（`~/.claude/memory/`）をツリーに表示
- 設定ファイルビューワー（`settings.json` / `settings.local.json`）をメモリツリーのトップに表示
- プロジェクトをVS Codeで開く機能追加
- メモリインジケーター改善（空き部分「─」、右端「|」表現）

### エージェントフォーム拡張
- **Effort** 4段階（Low / Medium / High / Max）、MaxはOpus専用でグレーアウト連動
- **Extended Thinking** トグルスイッチ（Haikuではグレーアウト）
- モデル選択に応じたUI連動（グレーアウト自動切替）

### CLI Builder
- `cliBuilder.ts` 新設 — AgentConfig からCLIコマンドを自動構築

### ルールファイル カスタムセクション保持
- `<!-- CSM:AUTO:START -->` / `<!-- CSM:AUTO:END -->` マーカー導入
- 自動生成部分のみ更新し、ユーザーのカスタム記述を保持

### UI改善
- **セッションフィルター** — プロジェクト内のみ / すべてを切替
- **設定を開く** — ビュータイトルバーの歯車アイコンからCSM設定画面を直接オープン
- エージェントソート改善（子を持つエージェントを上位にソート）

### パフォーマンス改善
- 全ソースファイルの同期I/Oを非同期化（`fs.promises` API）
- TTLキャッシュ導入、`fs.watch` + デバウンスでポーリング置換

### セキュリティ改善
- CSM:AUTOマーカーのプロンプトインジェクション対策（エージェント名からマーカー文字列を除去）
- WebviewにContent Security Policy（CSP）追加（nonce-basedで`default-src 'none'`）
- floating promise修正（未処理のPromise rejectを防止）

### 品質改善
- TreeView の Disposable 追跡（createTreeView の返り値を subscriptions に登録）
- 全TreeDataProviderにEventEmitter dispose実装
- dataStore.ts の全I/Oを非同期化（`fs.promises` API、TTLキャッシュ維持）

### 初期セットアップ
- Extension Host分離設定（`extensions.experimental.affinity`）を初回起動時に自動追加

### デフォルト変更
- セッションフィルターのデフォルトを「プロジェクト内のみ」→「すべて」に変更

### セッション引き継ぎ改善
- 遺言生成を2モード化: **簡易（即時）** = JSONL末尾から自動抽出、**詳細（AI要約）** = Claude CLIで要約生成
- 遺言をルールファイルの「歴代セッションの記録」セクションに自動蓄積（直近3世代保持）
- `AgentConfig.previousSessionIds` 追加 — 過去のセッションIDを直近5件保持
- 長さ上限300文字、生成後にInputBoxで編集可能
- 詳細モードのデフォルト推奨モデルをopusに変更
- JSONL読み取りを末尾読み取り（FileHandle API）に最適化（巨大ファイル対策）
- ルールファイル書き込みエラーをOutputChannelにログ出力

### フォルダ構造移行（Phase 1）
- `.agent-rules/` 配下をフラット構造からフォルダ構造に移行対応（`.agent-rules/<name>/<name>.md` + TODO.md + HISTORY.md）
- `resolveRuleFilePath()` がフラット/フォルダ両構造を自動判定（後方互換）
- 移行コマンド `claudeManager.migrateToFolderStructure` 追加（旧ファイルは `.trash/` へ移動）
- HISTORY.md 分離 — ルールファイルの「歴代セッションの記録」セクションを自動抽出

### TODO.md自動管理（Phase 2）
- Stop フックスクリプト `todo-flush.js` 新設 — TodoWrite の最終状態をエージェント別 TODO.md に自動マージ
- パスサニタイズ（パストラバーサル防止）+ ロックファイル排他制御
- 完了タスク10件超過分を HISTORY.md に自動転記

### タスクログUI削除
- 手動タスク記録コマンド5件削除（addTaskLog / completeTaskLog / deleteTaskLog / openTaskOutput / clearTaskLogs）
- 関連メニュー3件削除 — 自動検出（TaskTracker）は引き続き機能

### バグ修正
- ブックマークがプロジェクトフィルターの影響で非表示になる問題を修正
- sessionLoader の fd リーク修正、XSS対策、unsafe type cast 修正

---

## v0.2.8 (2026-04-03)
### ルールファイル管理改善（スコープ分離）
- AgentConfig に `scope: 'global' | 'project'` フィールド追加
- スコープに基づいてルールファイルの保存先フォルダを自動決定
- フォームをスコープ選択ラジオボタンに変更（手動パス入力廃止）
- 取締役ルールファイルに「エージェント操作」セクション追加
- MEMORY.md書き込みをメモリファイル＋ポインタ方式に改善

---

## v0.2.7 (2026-04-03)
### バグ修正: ステータスバー稼働表示が減らない
- JSONL mtime判定をPIDベース（`isLiveSession()`）に変更
- enableAgentMonitor OFF時にactiveAgentNamesもクリア

---

## v0.2.6 (2026-04-02)
### エージェント監視方式をJSONL解析に置換
- tasklist + PIDマッピングファイル方式を完全廃止
- JSONL mtime + sizeキャッシュ、末尾64KB読み取り方式
- 稼働中エージェントが一覧の上に自動ソート

---

## v0.2.5 (2026-04-02)
### ポーリング制御・テンプレート強化
- `enablePolling` 設定追加（デフォルト: false）
- ルールファイルテンプレートにMEMORY.md確認・報告先指示を追加
- 「セッションを新しくする」で自動遺言生成（直近やり取りからサマリー）
- エージェント起動時にruleFile未設定/不存在の場合は警告表示

---

## v0.2.4 (2026-04-02)
### 組織図の軽量化
- 子エージェントカードのライブ状態インジケーター削除
- CSS最小化、不要アニメーション削除、イベント委譲に変更

---

## v0.2.3 (2026-04-02)
### ステータスバー: PIDマッピングファイル方式に移行
- `/c/tmp/agent_*.txt` 方式廃止、`.agent-rules/tmp/.agent_pid_{PID}_{名前}` に変更
- PID生存チェックと自動クリーンアップ

---

## v0.2.2 (2026-04-02)
### バグ修正・改善
- ポーリング間隔が設定変更に追随しない問題を修正
- プレビューパネルのリスナー累積問題を修正
- ウェルカム画面がエージェント登録後も常時表示される問題を修正
- エージェント一覧の状態表示アイコン明確化（🟢/⚪/🟡）
- ステータスバーの動作中表示を背景色で強調

---

## v0.2.1 (2026-04-02)
### アイコンデザイン改善・ソート拡張
- 「Claude Codeで開く」アイコンをオレンジ角丸背景+白抜きスパークデザインに変更
- ソート基準を7種に拡張（「日付」を「作成日」と「更新日」に分割）
- ステータスバーでエージェント名を表示

---

## v0.2.0 (2026-04-02)
### エージェント管理
- サイドバー「エージェント管理」ビュー追加
- Webviewフォームで登録・編集（カード型ラジオ・フォルダ選択・ルールファイル自動生成）
- プレビュー/設定分離、セッション紐づけ、セッションを開く/新しくする
- 取締役をツリー最上位に表示、使い捨て/固定モード
### 組織図
- 取締役トップノード + 階層カード表示
- ✦カスタムアイコン（Claude Codeで開く）/ 🕐アイコン（履歴表示）
### ステータスバー
- 「🟢 N 👥 M」形式（動作中/全数）
### 会話管理
- ソート7種、グループ化4種、セッション削除（.trash/移動）
- パスコピー、プレビューヘッダにエージェントバッジ
### プレビュー
- Markdownレンダリング、リンクのクリック対応、AIの思考過程表示
### 設定画面・ウェルカム画面
- VS Code標準設定UIからCSM設定をカスタマイズ
- 初回起動時に取締役プリセットで即座に開始

---

## v0.1.9 (2026-04-01)
### ライブセッション検出の改善
- PID生存チェック + 5秒間隔フォールバックポーリング

## v0.1.8 (2026-04-01)
### エージェント管理・子エージェントツリー・プレビュー強化
- エージェント登録・役割タグ・ルールファイル編集・ステータスバー・組織図
- `subagents/` フォルダ内の子エージェントをツリー表示
- Markdownレンダリング・リンクのクリック対応・エージェントバッジ
- セッションIDコピー・VS Codeフォーク対応

## v0.1.4 (2026-03-30)
- メモリ管理のOneDrive対応

## v0.1.3 (2026-03-28)
- 両PC変更統合・MEMORY.md表示/編集対応

## v0.1.2 (2026-03-28)
- メモリ管理の各ファイルに行数表示を追加

## v0.1.1 (2026-03-28)
- displayNameに「セッション履歴管理」サブタイトルを追加
- VS Code Marketplace に初回公開

## v0.1.0 (2026-03-28)
初回リリース — 会話管理（日付別分類・ブックマーク・タグ・メモ・リネーム・検索）、ライブセッション検出、メモリ管理（タイプ別バッジ・プログレスバー・統合・抽出）
