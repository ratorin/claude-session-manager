# Claude Session Manager

[Claude Code](https://claude.com/claude-code) の会話履歴・メモリ・エージェントを管理する VS Code 拡張機能。

ブックマーク、タグ付け、メモ、Markdown プレビュー、マルチエージェント運用、組織図、大容量セッションの高速ビューワー、利用制限モニターなど、Claude Code 本体にない管理機能を提供します。

---

## 動作要件

| 必須 / 推奨 | ソフトウェア | バージョン |
|-------------|------------|-----------|
| 必須 | VS Code | 1.85.0 以降（Antigravity など VS Code フォークでも動作） |
| 必須 | Claude Code | 2.1.113 以降 |
| 推奨 | Claude Code | 2.1.2xx 以降（動作確認 2.1.220） |

> Claude Code のバージョン確認: `claude --version`
> アップデート: `npm install -g @anthropic-ai/claude-code`

### Claude Code への追従

- **モデル**: `fable` / `fable-1m` / `opus` / `opus-1m` / `sonnet` / `sonnet-1m` / `haiku` を選択可能。frontmatter にはエイリアス（例: `fable`, `opus[1m]`）を書き、Claude Code が起動時に最新モデルへ解決します。
- **effort**: `low` / `medium` / `high` / `xhigh` / `max` の 5 段階。`max` は全モデル選択可（コスト大につき Opus / Fable 系推奨）。
- **hook**: `SubagentStart` / `SubagentStop` を利用（サブエージェント可視化）。
- **subagent frontmatter**: `model` / `effort` / `permissionMode` / `allowedTools` / `isolation` / `background` / `maxTurns` をフォームから編集可能。
- **sessions/*.json**: `kind` / `entrypoint` / `version` / `name` / `nameSource` を読み取り、`interactive` / `background` 判定とセッション表示名に公式値を優先。
- **ライブデータ源**: PID + `sessions/<pid>.json` 監視で完結（`claude agents --json` 非依存）。

---

## 主な機能

> 📖 **用語**: Claude Code の JSONL 1 本を **「セッション」**（技術文脈）、UI 上での対話履歴を **「会話」**（UI ラベル）として使い分けます。

### 💬 会話管理

- **セッション一覧** — Claude Code の全会話をツリー表示。ソート順・グループ化・表示件数を設定可能
- **ブックマーク・タグ・メモ・リネーム** — お気に入り、タグ分類、任意メモ、わかりやすい名前
- **プロジェクトフィルタ** — 現在のワークスペースのセッションのみ表示するトグル
- **ソート・グループ化** — 更新日 / 作成日 / 名前 / 会話件数 / モデル の 7 種ソート、日付 / タグ / エージェント / フラット の 4 種グループ化
- **日付グループの初期展開制御** — 既定で「今日・昨日」のみ展開、それ以前は折り畳み
- **description 構成のカスタマイズ** — セッション行の右側表示（ライブマーク・エージェント・元メッセージ・時刻・タグ）の順序と要素を配列で指定可能
- **セッション一覧の検索** — キーワードフィルタでタイトル・プロジェクト・ブランチ名を絞り込み

### 📜 会話ビューワー

- **末尾遅延読み込み** — 起動時は末尾 N 件（既定 200 件、`preview.initialMessages`）のみ描画。数百 MB の JSONL でも体感 1 秒以内で開きます
- **『▲ 以前のメッセージを読み込む』ボタン** — ヘッダから追加取得。先頭に差し込むだけで DOM 全体は再構築しません
- **巨大メッセージの抑制** — 1 メッセージ 4 KB（既定、`preview.maxMessageBytes`）を超える content は切り詰めて『全文を表示』ボタンに置換
- **ヘッダのアクションボタン**
  - **▶ Claude で開く** — Claude Code 拡張の UI で会話を再開
  - **⌨ CLI で開く** — 新規ターミナルで `claude --resume <sid>` を実行
- **表示中のメッセージから検索** — 検索ボックスは読み込み済みメッセージが対象
- **thinking 表示切替** — `preview.showThinkingBlocks` で Claude の思考過程を表示

### 👤 エージェント管理

- **マルチエージェント運用** — 取締役 → 部長 → 実装者 のような親子関係でエージェントを組織化
- **エージェント登録フォーム** — 部署名・役割・モデル・効力（effort）・許可ツール・isolation・background・maxTurns・parentAgent 等を編集
- **エージェント検索** — コマンド `Claude: エージェントを検索` で name / displayName / role / model / parentAgent をあいまい検索、選択でツリーにジャンプ + プレビュー
- **グループ表示切替** — コマンド `Claude: エージェントのグループ表示を切替` で **組織図 / モデル別 / 状態別 / フラット** の 4 モードを切替（`agents.defaultGroupMode` で永続化）
- **『稼働中のみ表示』フィルタ** — ツールバーの $(filter) トグルまたはコマンドで切替（`agents.activeOnly` で永続化）
- **エージェント数バッジ** — TreeView.badge で「エージェント管理」「ライブ状態」ビューアイコンに稼働数を表示
- **『対話中』プレフィックス** — `[対話中]` / `[5分]` などライブ状態を即視認
- **展開状態の制御** — `agents.expandMode`（`all` / `active-branches`（既定）/ `top-level`）
- **★ お気に入りエージェント** — ★ ボタンで追加 / 解除、専用ビューにフラットリスト表示
- **一覧の即時表示** — 起動時は在メモリの情報だけで一覧を即描画。他プロジェクトのセッションタイトルなど重い解決は非同期で追いつきます
- **エージェント基本情報にフォルダパス** — プレビューの「フォルダ」行クリックで OS のファイルエクスプローラを起動
- **「Claude で開く」で新ウィンドウ起動** — セッション作成時 `cwd` がワークスペース外なら自動で新しい VS Code ウィンドウを開いてから復元（設定 `agent.openInNewWindowWhenFolderMismatch`、既定 ON、7 経路すべてで統一動作）
- **モデル不一致検知** — セッション中の `/model` 切替が発生すると ⚠️ で警告
- **セッションの引き継ぎ** — 遺言（引き継ぎメッセージ）を残して新セッションに切替

### 🟢 ライブ状態ビュー

- **エージェント別 2 階層ツリー** — ルートに各エージェント（本物 `sessionId` 紐付けあり）、直下に稼働中の複数セッション（別窓・別ワークツリー等）
- **未定義グループ** — 本物紐付けの無いセッションを「未定義（N）」に集約（`agents.showUnregisteredLive` で ON/OFF）
- **経過時間** — `sessions/*.json` の `startedAt` から算出

### 🎼 オーケストレーション

- **オーケストレーションビュー** — ライブセッション / バックグラウンドエージェント / サブエージェントの稼働状況をツリー表示（可視時のみポーリング）
- **アクティビティバー 4 アイコン構成** — 💬 セッション / 👤 エージェント / 🧠 メモリ / 📁 プロジェクト。オーケストレーションはエージェントコンテナ内に移設

### 🧠 メモリ管理

- **メモリファイルツリー** — `~/.claude/CLAUDE.md` / `<workspace>/.claude/CLAUDE.md` / `agents/*/memory/*.md` などを一覧
- **プレビュー・編集・統合・抽出** — 右クリックメニューから即実行

### 📁 プロジェクト管理

- **プロジェクトカード + 詳細ペイン** — カードグリッドで一覧、詳細ペインで進捗ダッシュボード・エージェント割当・メモリファイル一覧
- **プロジェクト詳細を別エディタタブに表示** — サイドバー幅に縛られない広いペインで詳細編集

### 🌳 組織図

- **Obsidian 風力学グラフ**（メイン、Canvas ダーク UI） — ノード大きさ = 部下数 + 稼働ボーナス、色 = モデル、稼働中はパルス。ドラッグで再配置、ホバーで隣接以外を減光、`prefers-reduced-motion` で物理アニメ抑制
- **ズーム / パン** — ホイールでカーソル基点ズーム（0.2〜4.0x）、背景ドラッグでパン、ダブルクリック or ⤢ ボタンで全体フィット。ツールバーに ± / ⤢ ボタン、右下に倍率バッジ。ラベル読みやすさをズームに反比例して自動補正
- **サブモード**（ツールバーのセグメント）
  - **階層** — ファイルツリー風の縦積み + インデント + ▶/▼ 折りたたみ（VS Code テーマ追従）
  - **グループ** — 部署別 / モデル別 / 稼働状態別のチップ切替で再クラスタリング
- **ルート絞り込み** — ツールバーの「ルート」セレクタで最上位エージェント配下だけを表示（`orgChart.defaultRoot` で永続化）
- **グローバル除外** — `parentAgent` 未設定のグローバル汎用エージェントは既定で組織図から除外。「グローバルも表示」トグル or `orgChart.showGlobal` で ON
- **検索ボックス** — 名前・役割で絞り込み、グラフモードでは一致ノードをセンタリング
- **凡例チップ** — Fable / Opus / Sonnet / Haiku / 稼働中 をクリックで該当以外を半透明化
- **連携トグル** — `/csm-ask-agent` の送信履歴（直近 7 日）を金色点線で重ね描き
- **ワークスペース減光** — 現ワークスペース外のエージェントは既定で減光。「他プロジェクトを隠す」トグルで非表示化
- **親→子矢印** — 親子エッジの子側に小さな三角矢印。指揮系統の方向が一目で分かる
- **設定**: `orgChart.defaultMode`（`graph`（既定） / `tree` / `group`）、`orgChart.hideOtherProjects`、`orgChart.showGlobal`、`orgChart.defaultRoot`

### 📊 利用制限モニター

- **ステータスバー表示** — セッション（5 時間）/ 全モデル（週）の利用率をリアルタイム表示
- **表示スタイル切替** — `usage.statusBarStyle`（`full` / `compact` / `max-only`）
- **追加分（overage）表示** — `… ｜ 追加 0%` で API 由来の利用率を併記
- **90% / 100% 通知** — セッション（5h）/ 全モデル（週）それぞれで閾値通知

### 🎨 UI カスタマイズ

- **タブバー非表示化** — `ui.showTabBar` でアクティビティバーと重複するタブ行を OFF に
- **モデル頭文字統一** — Ｆ / Ｏ / Ｓ / Ｈ を会話一覧・エージェント一覧・組織図で共通表示
- **テーマ追従** — VS Code の `charts.*` テーマ変数へ寄せ、Light / High Contrast にも追従

### 🧭 オンボーディング

- **Get Started ウォークスルー** — 「① Claude Code 確認 → ② 取締役を登録 → ③ /csm-ask-agent → ④ 監視を有効化 → ⑤ 組織図を開く」の 5 ステップ。各ステップの完了は自動チェック
- **空ビューへの案内** — セッション / メモリ / オーケストレーションの空状態から次アクションへ誘導

### 🔒 セキュリティ

- **hook ライフサイクル管理** — Claude Code の hook を安全に登録・除去、旧 bash 版 → Node 版への自動マイグレーション
- **プロンプトインジェクション検知** — `WebFetch` / `WebSearch` の結果を検査して疑わしい記述を `additionalContext` で警告
- **Windows / Linux 相互運用** — 共有 `settings.json` のクロス OS パスを起動時に自動修復

### モデル頭文字（会話一覧・エージェント一覧）

| 頭文字 | モデル | 色 |
|---|---|---|
| **Ｆ** | Fable（最新世代）/ Fable 1M | 金 #ffd54f |
| Ｏ | Opus（最新世代）/ Opus 1M | 紫 #b388ff |
| Ｓ | Sonnet（最新世代） | 青 #64b5f6 |
| Ｈ | Haiku（最新世代） | 緑 #81c784 |

> 1M コンテキストは母体モデルの頭文字（Ｏ / Ｓ / Ｆ）で表示され、`[1M]` 付き情報はラベル・ツールチップで担保します。

---

## クイックスタート

### 1. インストール後

VS Code 左のアクティビティバーに 💬 / 👤 / 🧠 / 📁 の 4 アイコンが表示されます。それぞれのコンテナ内で以下のビューが利用可能です:

- **💬 セッション** — 会話一覧 / ブックマーク / タグ
- **👤 エージェント** — ライブ状態 / お気に入り / エージェント管理 / オーケストレーション
- **🧠 メモリ** — メモリファイル一覧
- **📁 プロジェクト** — プロジェクト詳細（WebView）

### 2. Get Started ウォークスルー（推奨）

コマンドパレット（`Ctrl+Shift+P`）で `Welcome: Open Walkthrough` → 「Claude Session Manager をはじめる」を選択するか、エージェント管理ビューの空状態から「Get Started ウォークスルー」リンクをクリックすると、5 ステップの初期セットアップが起動します。

### 3. 取締役エージェントを登録する

1. コマンドパレット → `Claude: 取締役を登録` を実行
2. 部署名・役割・モデル（Opus / Fable 推奨）などを入力
3. 登録後、右クリック → 「セッションを紐づけ」で会話を開始

### 4. 部署（子エージェント）の追加

1. 会話一覧から対象セッションを右クリック → `エージェントとして登録`
2. **親エージェント** に「取締役」を選ぶ（組織図にツリー表示されます）
3. 部署への指示は `/csm-ask-agent` スキルから:
   ```
   /csm-ask-agent csm-impl "TreeView にセッション数バッジを追加して"
   ```

### 5. 組織図で確認

コマンド `Claude: 組織図を開く` またはエージェント管理ビューの $(organization) アイコンから組織図を開けます。

---

## 右クリックメニュー

### 会話一覧（全セッション共通）

| メニュー | 説明 |
|---|---|
| 会話をプレビュー | チャット形式でプレビュー表示 |
| ブックマークに追加 / 解除 | お気に入りに登録・解除 |
| Claude Code で開く | Claude Code 拡張の UI で会話を再開 |
| セッション ID をコピー | ID をクリップボードにコピー |
| 会話をリネーム | わかりやすい名前を設定 |
| タグを追加 | タグを付与 |

### 未登録セッション

| メニュー | 説明 |
|---|---|
| エージェントとして登録 | エージェント登録フォームを開く |

### 登録済セッション

| メニュー | 説明 |
|---|---|
| エージェント設定を編集 | 登録情報を編集 |
| ルールファイルを編集 | ルールファイルをエディタで開く |

### エージェント管理サイドバー（紐づけ済みエージェント）

| メニュー | 説明 |
|---|---|
| プレビュー画面を開く | エージェントの読み取り専用プレビューを表示 |
| Claude で開く（IDE） | 紐づけ済みセッションを Claude Code 拡張の UI で再開 |
| ターミナルで開く（ルール適用） | 新規ターミナルでルール適用ずみの `claude --agent` を起動 |
| セッションを新しくする | 引き継ぎメッセージを残して新セッションに切替 |
| セッション ID をコピー | 紐づけ中のセッション ID をクリップボードにコピー |
| セッションパスをコピー | 紐づけ中のセッション JSONL のパスをコピー |
| エージェント設定を編集 | 登録情報を編集 |
| セッションを紐づけ | セッションを選択して紐づけを付け替え |
| エージェントを削除 | エージェント登録を削除（`.trash/` へ退避） |

---

## コマンド一覧

### セッション

| コマンド | 説明 |
|---|---|
| `Claude: 会話一覧を更新` | セッション一覧を再読み込み |
| `Claude: 会話を検索` | キーワードフィルタを設定 |
| `Claude: セッション ID をコピー` | ID をクリップボードにコピー |
| `Claude: セッションパスをコピー` | JSONL ファイルパスをコピー |
| `Claude Code で開く` | 選択した会話を Claude Code 拡張の UI で再開 |
| `Claude: ブックマークに追加 / 解除` | ブックマーク操作 |
| `Claude: タグを追加` | タグを付与 |
| `Claude: 会話をリネーム` | 会話名を変更 |
| `Claude: ソート順を切替` | ソート基準を切替（7 種） |
| `Claude: グループ表示を切替` | グループ表示モードを切替（日付 / タグ / エージェント / フラット） |
| `Claude: セッションを削除` | セッションを `.trash/` に移動 |

### エージェント

| コマンド | 説明 |
|---|---|
| `Claude: エージェントとして登録` | セッションにエージェント設定を紐づけ |
| `Claude: エージェント設定を編集` | 登録済みエージェントの設定を編集 |
| `Claude: ルールファイルを編集` | エージェントのルールファイルを開く |
| `Claude: セッションを紐づけ` | エージェントにセッションを紐づけ |
| `Claude: エージェントを削除` | エージェント登録を削除 |
| `Claude: エージェント管理を更新` | エージェント一覧を再読み込み |
| `Claude: エージェントを検索` | 名前 / 表示名 / 役割 / モデル / 親部署をあいまい検索し、選択でツリーへジャンプ + プレビュー起動 |
| `Claude: エージェントのグループ表示を切替` | 組織図 / モデル別 / 状態別 / フラット の 4 モード切替 |
| `Claude: 稼働中のみ表示を切替` | エージェント一覧の稼働中フィルタトグル |
| `Claude: エージェント監視を有効化` | `claudeManager.enableAgentMonitor` を ON にします |
| `Claude: /csm-ask-agent をインストール` | `/csm-ask-agent` スキルとフックをホームに配置 |
| `Claude: 取締役を登録` | 取締役プリセットでエージェント登録 |
| `Claude: 組織図を開く` | 組織図 WebView を表示 |

### メモリ・プロジェクト・利用制限

| コマンド | 説明 |
|---|---|
| `Claude: メモリパスをコピー` | メモリファイルパスをコピー |
| `Claude: 利用制限を更新` | 利用制限モニターを手動更新 |
| `Claude: プロジェクト内 / すべて を切替` | 一覧のプロジェクトフィルタ切替 |
| `Claude: 使い方ガイドを開く` | `guide.html` を WebView で表示 |
| `Claude: 設定を開く` | CSM 設定画面を開く |
| `Claude: すべての CSM フックを削除` | アンインストール前の手動クリーンアップ |

---

## 設定項目

VS Code の設定画面（`Ctrl+,`）から `claudeManager` で検索して変更できます。網羅性の高い一覧は設定画面を参照してください。ここでは主要設定のみを掲載します。

### エージェント監視 / 利用制限

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `enableAgentMonitor` | boolean | true | エージェント監視（PID + JSONL 監視によるライブ状態検知）を有効化 |
| `agentMonitorInterval` | number | 5 | エージェント監視の更新間隔（秒） |
| `enableNotifications` | boolean | true | タスク完了・エラー・停止時の通知 |
| `taskStalledThreshold` | number | 60 | 応答停止判定の閾値（秒） |
| `taskErrorThreshold` | number | 1800 | エラー判定の閾値（秒） |
| `taskAutoCleanupHours` | number | 72 | 完了 / エラーのタスクログを自動削除するまでの時間 |
| `taskMaxLogs` | number | 100 | 保持するタスクログの最大件数 |
| `enableUsageMonitor` | boolean | true | Claude Code 利用制限をステータスバーに表示 |
| `usageMonitorInterval` | number | 300 | 利用制限モニターの更新間隔（秒） |
| `usage.show5dColumns` | boolean | true | 週間の追加枠（API 提供時のみ）の利用率列も表示（旧 Sonnet/Opus 5 日枠は廃止） |
| `usage.statusBarStyle` | enum | full | ステータスバーの表示スタイル（`full` / `compact` / `max-only`） |
| `hooks.desktopNotification.enabled` | boolean | false | セッション終了時のデスクトップ通知（要 Claude Code 2.1.141+） |

### セッション表示

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `defaultSortMode` | enum | updated-desc | 既定のソート順 |
| `defaultGroupMode` | enum | date | 既定のグループ化 |
| `maxSessionsShown` | number | 500 | 表示する最大セッション数 |
| `sessionFilterMode` | enum | all | プロジェクト内 / すべて |
| `sessions.descriptionFields` | string[] | `["live","agent","originalMsg","time","tags"]` | セッション行の description 構成要素と順序 |
| `sessions.expandRecentDateGroupsOnly` | boolean | true | 日付グループを『今日・昨日』のみ初期展開 |
| `sessions.showFileSize` | enum | count-sort-only | ファイルサイズ列の表示条件 |

### 会話ビューワー

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `preview.initialMessages` | number | 200 | 初期表示するメッセージの件数（末尾から） |
| `preview.maxMessageBytes` | number | 4096 | 1 メッセージの初期描画の最大バイト数 |
| `preview.showThinkingBlocks` | boolean | false | Claude の思考過程を表示 |

### エージェント一覧・組織図

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `agents.showOtherProjects` | boolean | true | 他プロジェクトのエージェントを灰色表示 |
| `agents.expandMode` | enum | active-branches | 起動時の展開状態（`all` / `active-branches` / `top-level`） |
| `agents.activeOnly` | boolean | false | 稼働中のみ表示 |
| `agents.defaultGroupMode` | enum | org | グルーピング方式（`org` / `model` / `status` / `flat`） |
| `agents.defaultExpand` | string[] | `["bookmarks","recent"]` | エージェントタブで起動時に展開するセクション |
| `agents.showUnregisteredLive` | boolean | true | ライブ状態ビューに未定義グループを表示 |
| `additionalAgentDirs` | string[] | `[]` | 追加でスキャンするプロジェクトフォルダ |
| `agent.openInNewWindowWhenFolderMismatch` | boolean | true | 「Claude で開く」の対象フォルダがワークスペース外なら新ウィンドウ起動 |
| `orgChart.defaultMode` | enum | graph | 組織図の起動時サブモード（`graph` / `tree` / `group`） |
| `orgChart.hideOtherProjects` | boolean | false | 他プロジェクトのエージェントを組織図で非表示 |
| `orgChart.showGlobal` | boolean | false | グローバルエージェントを組織図に含める |
| `orgChart.defaultRoot` | string | `""` | 組織図の起動時ルート絞り込み（空＝すべて） |

### UI

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `ui.showTabBar` | boolean | true | サイドバー上部のタブ行を表示 |
| `ui.defaultTab` | enum | sessions | メインビューを開いた際に最初に表示するタブ |
| `useNewMainPanel` | boolean | true | 新しいプロジェクトタブ UI を使用（変更後は VS Code 再起動） |
| `locale` | enum | ja | 言語（`ja` / `en`） |
| `locale.autoTranslate` | boolean | false | エージェント定義の未翻訳テキストを自動翻訳（要 API キー・experimental） |

### その他

| キー | 型 | 既定値 | 説明 |
|---|---|---|---|
| `trash.folder` | string | `""` | ゴミ箱フォルダパス（未設定なら `~/.claude/.trash/`） |
| `agent.defaultHistoryEnabled` | boolean | false | 新規エージェント作成時に HISTORY.md を自動生成 |
| `agent.defaultTodoEnabled` | boolean | false | 新規エージェント作成時に TODO.md を自動生成 |

---

## エージェント運用ガイド

### 1. 取締役の登録

マルチエージェント運用の第一歩は、全体を統括する「取締役」エージェントを登録することです。

- コマンド `Claude: 取締役を登録` またはエージェント管理のウェルカム画面から
- **モデル**: Opus / Fable（最上位モデル）
- **セッション運用**: 固定（長期的な文脈を保持するため）
- **役割**: 全体統括・タスクの分割・指示出し・承認判断
- 取締役のルールファイルで「行動規範」「禁止事項」「判断基準」を定義すると効果的です

### 2. 部署（子エージェント）の追加

取締役の下に、業務内容に応じた部署（子エージェント）を追加します。

- 会話一覧から対象セッションを右クリック → `エージェントとして登録`
- **親エージェント**: 「取締役」を設定（組織図にツリー表示されます）
- 部署への指示は `/csm-ask-agent` スキルが推奨:
  ```
  /csm-ask-agent csm-impl "TreeView にセッション数バッジを追加して"
  ```
- **モデルの使い分け**:
  - 重要な判断・設計タスク → Opus / Fable
  - 通常の開発・実装タスク → Sonnet
  - 定型作業・軽量タスク → Haiku（コスト効率が高い）

| 部署名 | モデル | 役割 |
|--------|--------|------|
| CSM 開発部 | Opus / Sonnet | 機能実装・コードレビュー |
| テスト部 | Sonnet | テスト設計・自動化 |
| 調査部 | Sonnet | 技術調査・情報収集 |
| 雑務部 | Haiku | ドキュメント生成・定型作業 |

### 3. エージェント定義ファイルの育成

各エージェントの `agents/*.md` を育てて、役割・行動規範・ノウハウを蓄積します。

- エージェントを右クリック → `ルールファイルを編集` で直接エディタで開く
- 初期は CSM のフォームからひな形を自動生成し、運用しながら育てる
- フィードバックやノウハウを本文に追記して成長させる
- `memory: project` を設定すると、セッションをまたいでエージェントが記憶を保持（Claude Code 本体機能）
- ルールファイル本文はセッションに依存しない **長期記憶** として機能します

### 4. セッションの引き継ぎ

コンテキストウィンドウの上限に達したらセッションを更新します。

- エージェントを右クリック → `セッションを新しくする`
- 遺言（引き継ぎメッセージ）の生成方法を選択: **簡易（即時）** または **詳細（AI 要約）**
- 生成された遺言を InputBox で確認・編集
- 遺言はルールファイルの「歴代セッションの記録」に自動蓄積（直近 3 世代）

### 5. おすすめ構成例

**取締役 → 部署 → 班** の三階層構造:

```
取締役（Opus・固定）— 全体統括・タスク分割・最終判断
  ├── 開発部（Opus・固定）— 実装・レビュー・設計
  │     ├── 実装班 A（Sonnet・固定）
  │     └── 実装班 B（Sonnet・固定）
  ├── テスト部（Sonnet・使い捨て）— テスト設計・自動化
  ├── 調査部（Sonnet・使い捨て）— 技術調査・情報収集
  └── 雑務部（Haiku・使い捨て）— ドキュメント・定型作業
```

---

## インストール

### Marketplace から（推奨）

VS Code Marketplace または Open VSX Registry で「Claude Session Manager」を検索してインストール。

### VSIX から

```bash
code --install-extension claude-session-manager-0.5.31.vsix
```

---

## 変更履歴

詳細な変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。直近の主な変更:

- **v0.5.31** — ドキュメント整理（Marketplace 公開前の CHANGELOG / README / guide.html スリム化）
- **v0.5.30** — エージェント一覧の起動高速化（2 段レンダリング）
- **v0.5.29** — 「Claude で開く」の新ウィンドウ挙動を全 7 経路で統一
- **v0.5.27** — エージェント基本情報にフォルダパス + Claude で開くで新ウィンドウ自動起動
- **v0.5.26** — 組織図の整理（グローバル除外復活・ルート絞り込み・階層モード再設計・線視認性）
- **v0.5.25** — 組織図グラフのズーム/パン対応
- **v0.5.24** — ライブ状態ツリー化 + cwd 推測マッチング撤去
- **v0.5.23** — 組織図リデザイン（Obsidian 風力学グラフに全面刷新）
- **v0.5.22** — Claude Code 追従（`sessions/*.json` 公式メタ活用、`claude agents --json` 非依存、`effort=max` 全モデル選択可）
- **v0.5.20** — 会話ビューワーの起動高速化（末尾遅延読み込み + tail リーダー）

---

## ライセンス

[MIT](LICENSE)
