# 更新履歴

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
