# Claude Session Manager v0.3.1 仕様書

## 概要

v0.2.0 でエージェント管理の基盤を再設計し、v0.3.0 で監視アーキテクチャ刷新・タスク管理・利用制限モニター・メモリ拡張・フォーム拡張を追加。v0.3.1 で YAML Frontmatter 移行・SubagentStart/Stop フック・マイグレーションバナー・セッション引き継ぎ改善を実施。

---

## 1. データソース統一

### 目的
組織図とステータスバーで参照するデータソースが異なる問題を解消する。

### 変更内容
- **`session-manager.json` の `agents[]` 配列に一本化**
- `agentManager.ts` の `parseAgentListMd()` と MD パース処理を完全削除
- `loadAgents()` → `dataStore.getAgents()` に置き換え
- `enrichAgentsWithSessions()` はセッションタイトル付与用に維持

### 影響範囲
| ファイル | 変更 |
|---|---|
| `agentManager.ts` | MD パース削除、`getAgents()` は dataStore 直結 |
| `orgChartPanel.ts` | `loadAgents()` → `dataStore.getAgents()` |
| `extension.ts` | `updateStatusBar()` は変更なし（既に dataStore 使用） |

---

## 2. 右クリックメニュー整理

### 削除
- `setAgentRole`（エージェント役割を設定）コマンドを完全削除

### セッション一覧の右クリックメニュー

**全セッション共通（`viewItem =~ /^session/`）:**

| グループ | コマンド |
|---|---|
| inline | 会話をプレビュー / ブックマークに追加 |
| 0_open | Claude Codeで開く / セッションIDをコピー / セッションパスをコピー |
| 1_edit | 会話をリネーム / タグを追加 |

**未登録セッション（`viewItem == session` or `sessionBookmarked`）:**

| グループ | コマンド |
|---|---|
| 2_agent | エージェントとして登録 |

**登録済みセッション（`viewItem == sessionRegistered` or `sessionRegisteredBookmarked`）:**

| グループ | コマンド |
|---|---|
| 2_agent | エージェント設定を編集 / ルールファイルを編集 |

### contextValue 一覧
| contextValue | 条件 |
|---|---|
| `session` | 未登録・未ブックマーク |
| `sessionBookmarked` | 未登録・ブックマーク済 |
| `sessionRegistered` | 登録済・未ブックマーク |
| `sessionRegisteredBookmarked` | 登録済・ブックマーク済 |
| `subagentSession` | 子エージェント（変更なし） |

---

## 3. エージェント登録フォーム

### 入力項目

| 項目 | 種別 | 必須 | 説明 |
|---|---|---|---|
| 部署名 | InputBox | ✅ | エージェントの名前（例: CSM開発部） |
| 役割の説明 | InputBox | | 担当業務（例: デバッグ・品質確認） |
| モデル選択 | QuickPick | ✅ | opus / sonnet / haiku |
| セッション運用 | QuickPick | ✅ | 固定 / 使い捨て |
| 親エージェント | QuickPick | | 既存エージェントから選択 / なし |
| 作業フォルダ | FolderPicker | | フォルダ選択ダイアログ / なし |
| 推論努力（Effort） | カードラジオ | | Low / Medium / High / Max（v0.3.0追加） |
| Extended Thinking | トグル | | ON/OFF（v0.3.0追加） |
| Max Thinking Tokens | 数値入力 | | 1024〜128000（v0.3.0追加） |

### 共通フォーム関数
`showAgentForm(existing?: AgentConfig): Promise<AgentConfig | undefined>`

- 新規登録: 空フォーム
- 設定編集: 既存値をデフォルト表示

### 使い捨てエージェント
- `AgentConfig.sessionMode` = `'disposable'`
- UIに「使い捨て」ラベルを表示
- セッション紐づけ変更が容易

---

## 4. サイドバー「エージェント管理」

### ビュー定義
- ID: `claudeAgents`
- 表示名: 「エージェント管理」
- `views` の `claude-manager` セクションに追加

### 表示形式
```
🤖 エージェント管理
├── 🟢 CSM開発部 [opus]        📄120行 (3.2KB)
│     CSM拡張機能の開発
├── ⚪ テスト部 [sonnet]        📄85行 (2.1KB)
│     未紐づけ
├── 🟢 調査部 [haiku] 使い捨て  📄45行 (1.0KB)
│     ライブラリ調査
```

### 各項目の表示内容
- ライブインジケーター（🟢/⚪）
- エージェント名
- モデルバッジ
- 「使い捨て」ラベル（sessionMode === 'disposable' の場合）
- ルールファイル行数・サイズ
- セッションタイトル or 「未紐づけ」

### コンテキストメニュー
| コマンド | 条件 |
|---|---|
| セッションを紐づけ | 常時 |
| エージェント設定を編集 | 常時 |
| ルールファイルを編集 | ruleFile が設定済み |
| エージェントを削除 | 常時 |

### 新規ファイル
`src/agentTreeProvider.ts`

---

## 5. エージェント一覧インジケーター

### ルールファイル情報
- 行数とファイルサイズを description に表示
- ルールファイル未設定の場合は「ルール未設定」と表示
- ファイルが存在しない場合は「ファイル未検出」と表示

### 取得関数
```typescript
function getRuleFileInfo(ruleFilePath: string): { lines: number; sizeKb: string } | null
```

---

## 6. ルールファイル自動生成

### トリガー
- エージェント登録時にルールファイルが未指定

### フロー
1. 登録フォーム完了後、「ルールファイルのひな形を自動生成しますか？」と確認
2. 「はい」→ ファイル保存ダイアログ（`vscode.window.showSaveDialog`）
3. テンプレートからファイル生成
4. 生成したパスを `AgentConfig.ruleFile` に保存

### テンプレート
```markdown
あなたは{name}所属のエンジニアです。
- {role}を担当する
- 変更前に既存コードを確認し、既存の設計方針を尊重する
```

---

## 7. 用語統一（日本語）

| 箇所 | 旧 | 新 |
|---|---|---|
| サイドバー views | — | エージェント管理 |
| ステータスバー | `${n} エージェント` | `${n} エージェント稼働状況` → ※短縮: `${live}/${total} 稼働中` |
| 組織図タイトル | エージェント組織図 | 組織図 |
| コマンド文言 | 英語混在 | 全て日本語 |

---

## 型定義変更

### AgentConfig（types.ts）
```typescript
export interface AgentConfig {
    name: string;                // 部署名（例: CSM開発部）
    sessionId: string;           // 紐づけセッションID
    role: string;                // 役割（例: デバッグ・品質確認）
    model: 'opus' | 'sonnet' | 'haiku';
    sessionMode?: 'fixed' | 'disposable';
    ruleFile?: string;           // ルールファイルパス
    parentAgent?: string;        // 親エージェント名
    allowedTools?: string[];     // 許可ツール一覧
    workDir?: string;            // 作業ディレクトリ
    scope?: 'global' | 'project'; // ルールファイルのスコープ（v0.2.8追加）
    status?: 'active' | 'idle' | 'archived';
    // v0.3.0 追加: モデル制御
    effort?: 'low' | 'medium' | 'high' | 'max'; // 推論努力レベル（max は Opus のみ）
    thinkingEnabled?: boolean;   // Extended Thinking 有効/無効
    maxThinkingTokens?: number;  // Thinking最大トークン数（MAX_THINKING_TOKENS 環境変数で反映）
}
```

---

## 12. エージェントプレビュー/設定分離

### 変更内容
- エージェント一覧でクリック → Webview で読み取り専用プレビュー表示
- 表示内容: 名前・モデル・状態（動作中/停止中）・役割・親エージェント・セッション運用・子エージェント一覧・ルールファイル内容
- 「設定」ボタンで編集フォーム（agentFormPanel）に切り替え
- セッション名クリックでセッション履歴プレビューへ遷移
- ルールファイル「編集」リンクでエディタに開く

### 新規ファイル
`src/agentPreviewPanel.ts`

---

## 13. 親エージェント（parentAgent）フィールドの名称統一

> 完了済み: UI上の表記を「親エージェント」に統一。現在は全箇所で統一されている。

---

## 14. ステータスバー改善（ライブセッション検出）

### 変更内容
- `~/.claude/sessions/` のJSONから全ライブセッションを検出
- 動作中のエージェント数のみ表示（例: `👥 2`）、0件なら `👥 0`
- カーソルホバーで動作中エージェント名のリストをツールチップ表示
- 登録済みエージェント → エージェント名で表示
- 未登録（使い捨て） → 「使い捨て (セッションID先頭8桁)」で表示
- ~~動作中は 800ms ブリンク~~ → v0.3.0 で廃止（セクション21参照）

---

## 15. セッションを開くコマンド

### 変更内容
- エージェント管理の右クリックに「セッションを開く」を追加
- セッション紐づけ済み（`agentItemLinked*`）のみ表示
- Claude Code の URI スキーム経由でセッションを開く

---

## 16. セッションを新しくするコマンド

### 変更内容
- エージェント管理の右クリックに「セッションを新しくする」を追加
- フロー:
  1. 引き継ぎメッセージ（遺言）を入力
  2. 旧セッションの JSONL に `[セッション終了]` メッセージを追記
  3. エージェントの sessionId を空にして紐づけ解除
  4. ユーザーが新セッションを紐づけ
- セッション紐づけ済み（`agentItemLinked*`）のみ表示

---

## 17. 取締役をツリートップに表示

### 変更内容
- エージェント名が「取締役」のものをトップレベルの最上位にソート
- 他の parentAgent 未設定エージェントはその下に並ぶ

---

## ファイル変更一覧

> この一覧はv0.2.0時点のもの。v0.3.0での変更はセクション45を参照。

| ファイル | 操作 |
|---|---|
| `src/types.ts` | AgentConfig に sessionMode 追加、未使用フィールド削除 |
| `src/agentManager.ts` | MD パース削除、getAgents/enrichAgentsWithSessions のみ |
| `src/agentTreeProvider.ts` | ツリー構造 + 取締役トップソート + contextValue 拡張 |
| `src/agentPreviewPanel.ts` | **新規作成** — エージェントプレビュー（読み取り専用Webview） |
| `src/agentFormPanel.ts` | 名称統一 |
| `src/extension.ts` | previewAgent/openAgentSession/renewAgentSession 追加、ステータスバー改善 |
| `src/sessionTreeProvider.ts` | contextValue を4種に拡張 |
| `src/orgChartPanel.ts` | loadAgents → dataStore.getAgents に変更 |
| `src/webviewPanel.ts` | プレビューヘッダにリンク付きバッジ追加 |
| `package.json` | views/commands/menus 大幅更新 |
| `CHANGELOG.md` | v0.2.0 記載 |
| `README.md` | 全面改訂（チュートリアル追加） |

---

## 8. 右クリックメニューにエージェント名表示

### 変更内容
- 登録済みセッションの description に `🤖部署名` を表示
- 例: `Ｏ 🤖CSM開発部 今日の作業は...`

### 影響範囲
| ファイル | 変更 |
|---|---|
| `sessionTreeProvider.ts` | agentConfig 取得 → description にエージェント名を付加 |

---

## 9. 会話プレビューヘッダにエージェント情報

### 変更内容
- 登録済みエージェントのセッションプレビュー上部にバッジ表示
- モデル名・部署名・役割を表示
- 「設定編集」「ルールファイル」リンクを配置

### 影響範囲
| ファイル | 変更 |
|---|---|
| `webviewPanel.ts` | agent-badge にリンク追加、editAgent/editRuleFile メッセージハンドラ追加 |
| `extension.ts` | `editAgentBySessionId` / `editRuleFileBySessionId` コマンド追加 |

---

## 10. エージェント設定 Webview フォーム

### 変更内容
- QuickPick/InputBox ステップ式 → **Webview パネル**に置換
- 全項目を1画面に表示し、直感的に入力可能

### フォーム項目
| 項目 | UI | 必須 |
|---|---|---|
| 部署名 | テキスト入力 | ✅ |
| 役割の説明 | テキスト入力 | |
| モデル選択 | ラジオボタン（カード型） | ✅ |
| セッション運用 | ラジオボタン（固定/使い捨て） | ✅ |
| スコープ | ラジオボタン（プロジェクト/グローバル） | ✅ |
| 親エージェント | セレクトボックス | |
| 作業フォルダ | テキスト + フォルダ選択ダイアログ | |
| 推論努力（Effort） | カードラジオ（Low/Medium/High/Max） | |
| Extended Thinking | トグルスイッチ | |
| Max Thinking Tokens | 数値入力（1024〜128000） | |

### メッセージフロー
- Webview → Extension: `save`, `cancel`, `browseFolder`
- Extension → Webview: `folderSelected`

### モデル別UI連動
- **Opus**: 全項目有効
- **Sonnet**: Effort Max がグレーアウト
- **Haiku**: Effort Max + Thinking + MaxTokens がグレーアウト

### 新規ファイル
`src/agentFormPanel.ts`

---

## 11. ステータスバー改善

### 変更内容

> **v0.3.0で更新**: 表示形式はセクション21で `🟢 N 👥 M` 形式に変更済み。ブリンクもv0.3.0で廃止。以下は旧仕様。

- ~~アイコンを `👥` に変更~~
- ~~通常時: `👥 10`（登録エージェント総数）~~
- ~~稼働中あり: `👥 2/10`（稼働数/総数）~~
- 現行: `🟢 N 👥 M`（🟢=動作中数、👥=登録総数）。動作中0なら `👥 M` のみ表示

---

## ファイル変更一覧（追加分）

| ファイル | 操作 |
|---|---|
| `src/agentFormPanel.ts` | **新規作成** — Webview エージェント設定フォーム |
| `src/sessionTreeProvider.ts` | description にエージェント名追加 |
| `src/webviewPanel.ts` | プレビューヘッダにリンク付きバッジ追加 |
| `src/extension.ts` | Webview フォーム統合、ステータスバー改善、新コマンド追加 |

---

## 18. guide.html の Webview 表示

### 変更内容
- `openGuide` コマンドをブラウザ表示から Webview パネル表示に変更
- `localResourceRoots` で拡張機能フォルダ内の画像を参照可能に
- `webview.asWebviewUri()` で画像パスを Webview セーフ URI に変換
- guide.html の内容を v0.2.0 の全機能に対応するよう全面改訂

---

## 19. 組織図からセッションを開く

### 変更内容
- 組織図の各エージェントカードに ⚡ ボタンを追加
- ⚡ クリックで Claude Code URI スキーム経由でセッションを開く
- 既存の ▶ ボタン（会話履歴プレビュー）はそのまま維持
- 凡例に「▶ 履歴表示」「⚡ Claude Codeで開く」を追加

### 影響範囲
| ファイル | 変更 |
|---|---|
| `orgChartPanel.ts` | `openInClaude` コールバック追加、⚡ ボタンHTML/CSS/JS追加 |
| `extension.ts` | `showOrgChart` に `openInClaude` コールバック追加 |

---

## 20. 右クリックメニューにパスコピーコマンド追加

### 変更内容
- **セッションパスをコピー** — JSONL ファイルのフルパスをクリップボードにコピー
- **メモリパスをコピー** — メモリファイルのフルパスをクリップボードにコピー
- 他のエージェントにファイルを読ませる際に便利

### 影響範囲
| ファイル | 変更 |
|---|---|
| `extension.ts` | `copySessionPath` / `copyMemoryPath` コマンド追加 |
| `package.json` | コマンド定義 + メニュー追加 |

---

## 21. ステータスバー表示改善

### 変更内容
- 点滅（ブリンク）表示を廃止
- `🟢 N 👥 M` 形式に変更（🟢=動作中数、👥=登録総数）
- 動作中が 0 の場合は `👥 M` のみ表示
- `blinkTimer` / `setInterval` を完全削除

---

## 22. アイコン変更

### 変更内容
- 組織図の▶ボタンを時計アイコン（SVG）に変更
- 組織図の⚡ボタンをClaudeカラー（#D97706）の稲妻SVGに変更
- `images/lightning.svg` を新規追加
- 凡例もSVGアイコンに更新

---

## 23. セッション紐づけメニュー改善

### 変更内容
- QuickPickリストで既に他エージェントに紐づけ済みセッションに `[○○に紐づけ済み]` ラベルを表示
- 紐づけ済みセッションを選択した場合、上書き確認ダイアログを表示
- 上書き時は旧エージェントの紐づけを自動解除
- タイトルを「セッションを変更」/「セッションを紐づけ」で動的切替

---

## 24. ルールフォルダ設定

### 変更内容
- `ManagerData`に`ruleFolder`フィールドを追加
- デフォルト値: `""`（空文字。VS Code設定またはsession-manager.jsonのruleFolderを参照）
- `agentManager.resolveRuleFilePath()`: ファイル名のみの場合はルールフォルダと結合
- エージェント登録フォームでルールフォルダ設定済みの場合はプレースホルダーを「例: CSM開発部.md」に変更
- ルールファイル編集・表示で`resolveRuleFilePath()`を経由

---

## 25. 作業フォルダの注意書き

### 変更内容
- エージェント登録フォームの作業フォルダ入力欄下に注釈テキストを追加
- 「※ エージェントのcwd（作業ディレクトリ）になります。ルールファイルの編集対象フォルダ制限にも使用されます。」

---

## 26. ソート機能

### 変更内容
- ビュータイトルバーに `$(arrow-swap)` ソートボタンを追加
- ソート基準: 日付（新しい順/古い順）、名前、メッセージ数、モデル
- `sessionTreeProvider.setSortMode()` で状態管理
- QuickPickで基準を選択

---

## 27. グループ化切り替え

### 変更内容
- ビュータイトルバーに `$(list-tree)` グループ切替ボタンを追加
- グループモード: 日付別（デフォルト）、タグ別、エージェント別、フラット
- `sessionTreeProvider.setGroupMode()` で状態管理
- タグ別: `dataStore.getAllTags()` で分類、タグなしグループも表示
- エージェント別: `dataStore.getAgentBySessionId()` で分類

---

## 28. セッション削除

### 変更内容
- `claudeManager.deleteSession` コマンドを追加
- 右クリックメニュー `3_danger` グループに配置
- `~/.claude/.trash/` にタイムスタンプ付きファイル名で移動（rm禁止ルール準拠）
- `dataStore.cleanupSessionData()` で関連データ一括クリーンアップ（ブックマーク・タグ・メモ・カスタム名・エージェント紐づけ）
- 紐づき済みエージェントがある場合は確認ダイアログで通知

---

## 29. ウェルカム画面

### 変更内容
- `package.json` の `viewsWelcome` でエージェント管理ビューにウェルカムメッセージを追加
- 「取締役を登録」ボタン: 取締役プリセット（Opus・固定・全体統括）でフォームを開く
- 「使い方ガイドを開く」リンク

---

## 30. エージェント運用ガイド

### 変更内容
- guide.html にセクション11「エージェント運用ガイド」を追加
- README.md に「エージェント運用ガイド」セクションを追加
- 内容: 取締役登録→部署追加→ルール育成→引き継ぎ運用→おすすめ構成例

---

## 31. 拡張機能設定画面（contributes.configuration）

VS Code標準の設定UIからCSMの動作をカスタマイズ可能に。

### 設定項目

| キー | 型 | デフォルト | 説明 |
|------|-----|-----------|------|
| `claudeManager.enableAgentMonitor` | boolean | false | エージェント監視を有効化 |
| `claudeManager.agentMonitorInterval` | number | 5 | エージェント監視間隔（秒） |
| `claudeManager.enableNotifications` | boolean | true | タスク通知を有効化 |
| `claudeManager.taskStalledThreshold` | number | 60 | stalled判定閾値（秒） |
| `claudeManager.taskAutoCleanupHours` | number | 72 | タスクログ自動削除（時間） |
| `claudeManager.taskMaxLogs` | number | 100 | 最大タスクログ数 |
| `claudeManager.enableUsageMonitor` | boolean | false | 利用制限モニターを有効化 |
| `claudeManager.usageMonitorInterval` | number | 300 | 利用制限モニター更新間隔（秒） |
| `claudeManager.defaultSortMode` | enum | updated-desc | デフォルトのソート順 |
| `claudeManager.defaultGroupMode` | enum | date | デフォルトのグループ化 |
| `claudeManager.maxSessionsShown` | number | 500 | 表示する最大セッション数 |
| `claudeManager.sessionFilterMode` | enum | all | セッションフィルターモード |
| `claudeManager.defaultRuleFolder` | string | "" | ルールフォルダパス |
| `claudeManager.preview.showThinkingBlocks` | boolean | false | プレビューにAIの思考過程を表示 |
| `claudeManager.trash.folder` | string | "" | ゴミ箱フォルダパス |

### 実装箇所
- `package.json` — contributes.configuration定義
- `extension.ts` — getConfig()ヘルパー、ポーリングタイマー動的制御、設定変更リスナー
- `sessionTreeProvider.ts` — maxSessionsShown参照、agentMonitorInterval参照
- `dataStore.ts` — getRuleFolder()でVS Code設定をフォールバック参照
- `webviewPanel.ts` — showThinkingパラメータ、思考ブロックCSS
- `sessionLoader.ts` — includeThinkingフラグ、maxSessions制限

---

## 32. v0.2.1 変更内容

### アイコンデザイン改善
- 組織図の✦アイコン（Claude Codeで開く）をオレンジ角丸背景+白抜きスパークデザインに変更
- `resources/sparkle-dark.svg` / `resources/sparkle-light.svg` を更新
- 組織図カード・凡例のインラインSVGも同デザインに統一

### ソート機能拡張
- ソート基準を5種→7種に拡張（「日付」を「作成日」と「更新日」に分割）

### ステータスバー改善（v0.3.0で廃止）

> **廃止済み**: このファイル監視方式はv0.2.3以降順次置換され、v0.3.0でAgentWatcherに完全移行。現行はセクション45参照。

- ~~`/c/tmp/agent_{エージェント名}_{タスク}.txt` ファイル監視でエージェント名を特定~~
- ~~直近の監視間隔×2（最低5秒）以内に更新されたファイルを「動作中」と判定~~
- ~~ファイルベースの検出がない場合はPID表示にフォールバック~~

---

## 33. v0.2.2 変更内容

### バグ修正

#### ポーリング間隔の設定追随
- `sessionTreeProvider.ts` の `pollTimer` が起動時の値で固定されていた問題を修正
- `restartPolling()` メソッドを追加し、設定変更時にタイマーを再起動
- `extension.ts` の `onDidChangeConfiguration` リスナーから `sessionProvider.restartPolling()` を呼び出し

#### プレビューパネルのリスナー累積
- `agentPreviewPanel.ts` の `rebindMessages()` で `onDidReceiveMessage` が累積する問題を修正
- `messageListenerDisposable` でリスナーを管理し、再バインド時に古いリスナーを `dispose()` で解除
- パネル破棄時にもリスナーをクリーンアップ

#### ウェルカム画面の常時表示
- `package.json` の `viewsWelcome` の `when` を `"true"` から `"!claudeManager.hasAgents"` に変更
- `extension.ts` に `updateHasAgentsContext()` を追加し、`setContext` でコンテキストキーを更新
- `refreshAll()` と初回起動時にコンテキストキーを設定

### 新機能

#### エージェント一覧の状態表示アイコン
- `agentTreeProvider.ts` の `AgentItem` アイコンロジックを `agentStatus` で明確に分岐:
  - `running`: `circle-filled` + `terminal.ansiGreen`（🟢 動作中）
  - `idle`: `circle-outline` + `foreground`（⚪ 停止中・紐づけあり）
  - `unlinked`: `circle-outline` + `disabledForeground`（⚪ 停止中・未紐づけ）
  - `pending`: `circle-filled` + `terminal.ansiYellow`（🟡 応答待ち — 将来拡張用スタブ）

#### ステータスバーの動作中表示強調
- 動作中エージェントがいるとき `statusBarItem.backgroundColor` を `statusBarItem.warningBackground` に設定
- 動作中0のときは `backgroundColor = undefined` で通常表示に戻す

---

## 34. v0.2.3 変更内容

> **廃止（v0.3.0）**: PIDマッピングファイル方式は v0.2.3 で導入、v0.2.6 で JSONL mtime 方式に置換、v0.3.0 で AgentWatcher に完全移行し廃止。以下は履歴として残す。

### ステータスバー: PIDマッピングファイル方式に移行（廃止済み）

#### 背景
- 旧方式（`/c/tmp/agent_*.txt` の更新時刻監視）は、ファイルが完了時に一括書き込みされるため実行中に検出できない問題があった
- `/c/tmp` を散らかす問題もあった

#### 新方式（v0.3.0で廃止）
- 取締役が子エージェントを起動するとき、`.agent-rules/tmp/.agent_pid_{PID}_{エージェント名}` ファイルを作成
- 完了時にファイルを削除する（取締役側の責任）
- CSMは `.agent-rules/tmp/` を監視し、PIDマッピングファイルを検出

#### 実装詳細（v0.3.0で廃止）

| 関数 | 変更 |
|------|------|
| `getActiveAgentNames()` | **削除** — `/c/tmp/agent_*.txt` 方式廃止 |
| `getActiveAgentFromPidFiles()` | **新規** — PIDマッピングファイル方式 |
| `getAgentTmpDir()` | **新規** — `getRuleFolder() + '/tmp/'` を返す |
| `getSessionPids()` | **削除** — 不要化 |
| `updateStatusBar()` | PIDマッピング方式のみ使用するよう簡素化 |

#### PIDマッピングファイル仕様（v0.3.0で廃止）
- パス: `{ルールフォルダ}/tmp/.agent_pid_{PID}_{エージェント名}`
- 例: `c:/xampp/Project/.agent-rules/tmp/.agent_pid_12345_CSM開発部`
- PID生存チェック: `getClaudeProcessPids()` で `tasklist` の結果と照合
- PIDが死んでいるファイルは `unlinkSync` で自動クリーンアップ

---

## 35. v0.2.4 変更内容

### 組織図の表示速度改善・子エージェントライブ状態削除

#### 子エージェントライブ状態インジケーター削除
- `renderAgentCard()` で `isSub === true` の場合は `liveDot` を出力しない
- `showOrgChart()` 内の `liveIds` 計算をトップレベル＋取締役に限定
- CSS `.live-dot` は取締役・トップレベル用としてのみ残存

#### HTML/CSS軽量化
- CSSを全てminify（whitespace圧縮）
- `transition: border-color 0.2s, box-shadow 0.2s` を `.node:hover { border-color }` のみに簡素化
- `@keyframes pulse` アニメーションを削除
- `box-shadow` の hover 効果を削除

#### JavaScript最適化
- `querySelectorAll('.session-id').forEach` × 3 → `document.body.addEventListener('click', ...)` のイベント委譲に変更
- SVGインライン文字列を `SVG_HISTORY`/`SVG_CLAUDE` 定数化して重複を排除
- `renderSessionActions()` ヘルパー関数を抽出して重複HTML生成コードを統合

---

## 36. ポーリングON/OFF設定（v0.2.5）

### 変更内容
- `claudeManager.enablePolling` 設定を追加（boolean、デフォルト: false）
- ポーリング無効時はtasklistを実行せず、静的なエージェント数のみ表示
- 設定変更時にリアルタイムで反映（`onDidChangeConfiguration`で監視）

### 影響範囲
| ファイル | 変更 |
|---|---|
| `package.json` | `enablePolling` 設定追加 |
| `extension.ts` | `startAgentPolling()` でenablePollingチェック、設定変更ハンドラに追加 |

---

## 37. ルールファイルテンプレート強化（v0.2.5）

### 変更内容
- MEMORY.md（自動メモリ）確認指示を追加
- session-manager.json agents一覧から自己位置把握指示を追加
- 親エージェント設定時は報告先を明記

### 影響範囲
| ファイル | 変更 |
|---|---|
| `agentFormPanel.ts` | `generateRuleFile` テンプレートを複数行に拡張 |

---

## 38. エージェント起動時の役割チェック（v0.2.5）

### 変更内容
- `openAgentSession` コマンドでruleFile未設定・ファイル不存在を警告表示
- 起動自体はブロックしない（警告のみ）

### 影響範囲
| ファイル | 変更 |
|---|---|
| `extension.ts` | `openAgentSession` にruleFileチェック追加 |

---

## 39. 自動遺言生成（v0.2.5）

### 変更内容
- 「セッションを新しくする」で手動入力→自動生成に変更
- 旧セッションJSONLの直近50行から最後の2往復分を抽出してサマリー生成
- 自動生成結果はInputBoxに表示され、ユーザーが編集可能

### 影響範囲
| ファイル | 変更 |
|---|---|
| `extension.ts` | `renewAgentSession` を自動遺言生成方式にリライト |

---

## 40. 組織図表記修正（v0.2.5）

### 変更内容
- 「IDをコピー」→「セッションIDをコピー」に変更

### 影響範囲
| ファイル | 変更 |
|---|---|
| `orgChartPanel.ts` | title属性テキスト変更 |

---

## 41. エージェント監視方式をJSONL解析に置換（v0.2.6）

> **廃止（v0.3.0）**: agentMonitor.ts（JSONL mtime 方式）は v0.2.6 で導入、v0.3.0 で AgentWatcher（fs.watch + デバウンス方式）に完全置換し削除済み。以下は履歴として残す。

### 目的（v0.3.0で廃止）
tasklist + PIDマッピングファイル方式を廃止し、セッションJSONLファイルのmtimeベースで稼働判定する方式に移行。
Windows固有のtasklist依存を排除し、PC負荷を軽減する。

### 変更内容（v0.3.0で廃止）
- **`agentMonitor.ts`** を新規作成（v0.3.0で削除済み）
  - ファイル末尾64KBを `fs.openSync` + `fs.readSync` で効率的に読み取り
  - mtime + size でキャッシュし、変更時のみ再解析
  - tool_use(name==="Task"/"Agent") → サブエージェント開始検出
  - tool_result(tool_use_id) → サブエージェント完了検出
- **`extension.ts`** から以下を削除:
  - `getClaudeProcessPids()` — taslistコマンド実行
  - `getAgentTmpDir()` — PIDマッピングファイル用tmpディレクトリ
  - `getActiveAgentFromPidFiles()` — PIDマッピングファイル解析
  - `import { execSync }` — 不要になった外部プロセス呼び出し
- **`updateStatusBar()`** をJSONL解析ベースに書き換え
  - 各エージェントのセッションJSONLファイルのmtimeで稼働判定
  - 閾値: ポーリング間隔 × 3以内に更新されていれば稼働中

### 影響範囲
| ファイル | 変更 |
|---|---|
| `agentMonitor.ts` | 新規作成（v0.3.0で削除済み） |
| `extension.ts` | tasklist関連削除、JSONL解析に置換 |

---

## 42. エージェント一覧の稼働中ソート（v0.2.6）

### 変更内容
- `AgentTreeProvider` に `activeAgentNamesFn` コールバックを追加
- isLive判定にJSONL解析結果を統合（sessionProviderのライブ検出 OR JSONL稼働検出）
- ソート順: 取締役最上位 → 稼働中を上 → 名前昇順（子エージェントも同様）

### 影響範囲
| ファイル | 変更 |
|---|---|
| `agentTreeProvider.ts` | コンストラクタ拡張、ソートロジック変更 |
| `extension.ts` | AgentTreeProviderに `activeAgentNames` を注入 |

---

## 43. ステータスバー稼働判定をPIDベースに修正（v0.2.7）

### バグ内容
エージェント終了後も「🟢 3」が減らない。

### 原因
`updateStatusBar()` がJSONLファイルのmtime（最終書き込み時刻）のみで稼働判定していた。
- エージェントCLIが終了してもJSONLファイルのmtimeは最後の書き込み時刻のまま
- Claude Codeの終了処理で最後にデータを書くとmtimeが更新され、閾値(interval×3)内に収まり続ける
- 閾値超え後も、mtime単独では「終了した」vs「しばらく入力がない」を区別できない

### 修正内容
- **プライマリ判定**: `sessionProvider.isLiveSession(sessionId)` に変更
  - `.sessions/*.json` ファイルのPID生存チェック（`process.kill(pid, 0)`相当）で判定
  - CLIプロセス終了時にPIDが消えるため、即座にinactive判定される
- **JSONL mtime判定を廃止**: `analyzeSession()` のimportを削除
- **初回呼び出しの修正**: `updateStatusBar()` の独立初回呼び出しを廃止し、`startAgentPolling()` 内で有効時のみ呼ぶ
- **エラーハンドリング追加**: `updateStatusBar()` をtry-catchで囲み、タイマー停止を防止
- **enableAgentMonitor OFF時**: `activeAgentNames` をクリアしてagentTreeProviderのソートも正しく反映

### 影響範囲
| ファイル | 変更 |
|---|---|
| `extension.ts` | updateStatusBar() をPIDベース判定に書き換え、初回呼び出し修正 |

## 44. ルールファイル管理改善 — スコープ分離（v0.2.8）

### AgentConfigにscopeフィールド追加
- `scope?: 'global' | 'project'` を `AgentConfig` に追加
- `global`: `~/.claude/agent-rules/` に保存
- `project`: `{workspace}/.agent-rules/` に保存
- 未設定（レガシー）: 従来の `getRuleFolder()` にフォールバック

### dataStore.ts: getRuleFolderForScope()
- `getRuleFolderForScope(scope)` を新規追加
- スコープに応じたルールフォルダパスを返す
- レガシー（scope未設定）は `getRuleFolder()` → プロジェクト → グローバルの順でフォールバック

### autoGenerateRuleFile() 改善
- `getRuleFolderForScope(config.scope)` を使用してフォルダを決定
- 他スコープに同名ファイル存在時は警告ダイアログ
- 子エージェントに「取締役セクション無視」指示を自動追加
- 作業フォルダ設定時に編集対象フォルダ制限を自動追加

### generateDirectorRuleFile() 改善
- 「エージェント操作」セクションを追加
  - `claude --resume {sessionId} --append-system-prompt-file {ruleFile} --print` コマンド
  - `session-manager.json` のパスと構造説明
- 禁止事項に「MEMORY.mdに部署一覧を直接書き込まない」を追加

### writeOrgInfoToMemory() 改善
- メモリファイル＋ポインタ方式に変更
- `project_agent_architecture.md` を自動生成（session-manager.jsonが唯一の情報源であることを記載）
- `project_director_rules.md` を自動生成（取締役名・役割を記載）
- MEMORY.mdにはセクションポインタのみ追記
- `addToIndex()` でMEMORY.mdインデックスにも登録

### フォーム改善（agentFormPanel.ts）
- ルールファイル手動入力（テキスト＋参照ボタン＋ひな形ボタン）を廃止
- スコープ選択ラジオボタン（プロジェクト/グローバル）に置換
- 部署名・スコープ変更でルールファイルパスをリアルタイムプレビュー
- 既存エージェント編集時は現在のルールファイルパスも表示
- `browseRuleFile` / `generateRuleFile` メッセージハンドラを削除

### 影響範囲
| ファイル | 変更 |
|---|---|
| `types.ts` | AgentConfig に `scope` フィールド追加 |
| `dataStore.ts` | `getRuleFolderForScope()` 新規追加 |
| `extension.ts` | autoGenerateRuleFile / generateDirectorRuleFile / writeOrgInfoToMemory 改善 |
| `agentFormPanel.ts` | スコープ選択UI、ルールファイル手動入力廃止 |
| `package.json` | バージョン 0.2.8 |

---

## 45. v0.3.0 — 監視アーキテクチャ刷新 + メモリ拡張 + フォーム拡張

### Phase 1: 監視リデザイン
- `agentMonitor.ts` 削除 → `subagentDetector.ts` + `agentWatcher.ts` に分離
- AgentWatcher: PIDベース監視 + サブエージェント検出をEventEmitter方式で統合
- extension.ts: 旧ポーリング（updateStatusBar + startAgentPolling + activeAgentNames）を AgentWatcher イベント駆動に置換
- agentTreeProvider.ts: ハードコード「取締役」ソートを廃止、子を持つエージェント優先ソートに変更

### Phase 2: ローカル/グローバル分離
- `session-manager.local.json` をワークスペース `.claude/` 配下に導入
- dataStore.ts: loadLocalData/saveLocalData、getAgents()マージ、addAgent(scope)、moveAgentScope()

### Phase 3: メモリ管理拡張
- `memoryManager.ts` 新設: getMemoryDirs、loadGlobalMemoryFiles、getSettingsFilePaths、getMemoryStats、deleteMemoryFile、mergeMemoryFiles、extractFromMemory、addToIndex
- `memoryTreeProvider.ts` 新設: 設定ファイルグループ、グローバルメモリグループ、プロジェクトメモリグループ
- メモリインジケーター: 空き部分「─」、右端「|」
- プロジェクトをVS Codeで開く: openProjectInVSC コマンド

### Phase 4: フォーム拡張
- Effort 4段階（low/medium/high/max）、max=Opus専用グレーアウト
- Thinkingトグル、Haiku時グレーアウト
- maxThinkingTokens数値入力、環境変数MAX_THINKING_TOKENS
- モデル変更時のUI連動（onModelChange）

### Phase 5: CLI Builder
- `cliBuilder.ts` 新設: buildCommand、buildCommandFormatted、buildSpawnOptions
- --allowedTools スペース区切り、MAX_THINKING_TOKENS環境変数、--add-dir

### UI改善
- セッションフィルター（project/all切替）: toggleSessionFilter コマンド、sessionFilterMode 設定
- 設定を開く（歯車アイコン）: openSettings コマンド

### ファイル変更一覧
| ファイル | 操作 |
|---|---|
| `src/subagentDetector.ts` | **新規作成** |
| `src/agentWatcher.ts` | **新規作成** |
| `src/cliBuilder.ts` | **新規作成** |
| `src/memoryManager.ts` | **新規作成** |
| `src/memoryTreeProvider.ts` | **新規作成** |
| `src/agentMonitor.ts` | **削除** |
| `src/types.ts` | AgentWatcherState, SubagentInfo, LocalManagerData 追加、AgentConfig に effort/thinkingEnabled/maxThinkingTokens 追加 |
| `src/dataStore.ts` | ローカル/グローバルデュアルファイル方式にリライト |
| `src/agentFormPanel.ts` | Effort 4段階、Thinkingトグル、maxThinkingTokens、モデル別グレーアウト |
| `src/agentTreeProvider.ts` | ハードコードソート廃止 → 子持ちエージェント優先 |
| `src/sessionTreeProvider.ts` | プロジェクトフィルター機能追加 |
| `src/extension.ts` | AgentWatcher統合、新コマンド3件追加、旧監視コード削除 |
| `package.json` | v0.3.0、新コマンド・設定・メニュー追加 |

---

## 46. v0.3.0 追加 — エージェントタスク管理・状態検知・通知

### 概要
AgentWatcher のイベントに便乗してタスクの状態を自動検知し、VS Code通知で結果を報告する。

### 新規ファイル
| ファイル | 内容 |
|---|---|
| `src/taskTracker.ts` | TaskTracker クラス — evaluate(), notify(), resetOnMonitorDisabled() |

### 型定義追加（types.ts）
- `TaskStatus`: `'pending' | 'running' | 'stalled' | 'completed' | 'error'`
- `TaskLog`: id, agentName, sessionId, summary(max200), outputFile, status, createdAt, completedAt, toolUseId, notifiedStatus, lastNotifiedAt
- `ManagerData.taskLogs?: TaskLog[]`

### dataStore.ts 追加関数
| 関数 | 説明 |
|---|---|
| `getTaskLogs()` | 全タスクログ取得 |
| `addTaskLog(log)` | 追加（summary 200文字制限、最大100件） |
| `updateTaskLog(id, updates)` | 部分更新 |
| `removeTaskLog(id)` | 削除 |
| `clearTaskLogs()` | 全クリア |
| `cleanupTaskLogs()` | 自動クリーンアップ（completed/error: 72h、running/stalled/pending: 168h） |
| `batchUpdateTaskLogs(updates)` | バッチ更新（evaluate()からの1回保存） |

### TaskTracker（taskTracker.ts）
- AgentWatcher.onDidChange → evaluate() で状態を評価
- PID生存 + sessions/*.json mtime で running/stalled/completed を判定
- stalled閾値: 60秒（設定変更可能、Extended Thinking対応）
- 通知: 60秒間隔制限（フラッピング防止）、notifiedStatus + lastNotifiedAt で管理
- 監視OFF時リセット: running/stalled → pending（H-4対応）
- agentTaskIndex Map でエージェント別インデックス（getChildren高速化）

### agentTreeProvider.ts 拡張
- `TaskLogItem` クラス追加: ステータスアイコン（sync~spin/warning/check/error/clock）、経過時間、contextValue
- `setTaskProvider()` で TaskTracker 連携
- getChildren() がエージェントの子としてタスクログを表示

### extension.ts 追加
| 項目 | 内容 |
|---|---|
| `validateOutputFile()` | パストラバーサル対策（ワークスペース/tmp/.claude配下のみ許可） |
| TaskTracker初期化 | AgentWatcher.onDidChange → evaluate() + notify() |
| 監視OFF リセット | onDidChangeConfiguration で wasEnabled → !isEnabled 検知時に resetOnMonitorDisabled() |
| 自動クリーンアップ | activate() 時に cleanupTaskLogs() 実行 |
| L-2修正 | `undefined as unknown as string` → `''` |

### コマンド追加（5件）
| コマンド | 説明 |
|---|---|
| `addTaskLog` | QuickPickでエージェント選択→タスク概要入力→追加 |
| `completeTaskLog` | タスクを手動で完了にする |
| `deleteTaskLog` | タスクを削除 |
| `openTaskOutput` | タスクの出力ファイルを開く |
| `clearTaskLogs` | 全タスクログを削除（確認ダイアログ付き） |

### 設定追加（4件）
| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `enableNotifications` | boolean | true | タスク通知を有効化 |
| `taskStalledThreshold` | number | 60 | stalled判定閾値（秒） |
| `taskAutoCleanupHours` | number | 72 | completed/error自動削除（時間） |
| `taskMaxLogs` | number | 100 | 最大タスクログ数 |

### QA対応（品質管理部レビュー全件反映）
- H-1: agentWatcher に sessionMtimes Map 追加（update()冒頭でclear+再構築）
- H-2: validateOutputFile() でパストラバーサル防止
- H-3: batchUpdateTaskLogs() でevaluate()後に1回のみ保存
- H-4: 監視OFF時にrunning/stalledをpendingにリセット + 168時間自動クリーンアップ
- M-1: stalled閾値 60秒
- M-2: outputFile内容解析を廃止（PID終了コードのみ）
- M-3: sessionMtimes を update()冒頭でclear+再構築
- M-4: crypto.randomUUID() → Date.now().toString(36) 代替
- M-5: agentTaskIndex Map でgetChildren()高速化
- L-1: 未使用 import 削除（agentWatcher.ts）
- L-2: unsafe type cast 修正（extension.ts）
- L-3: errorHint フィールド廃止

### ルールファイル カスタムセクション保持
- `<!-- CSM:AUTO:START -->` / `<!-- CSM:AUTO:END -->` 境界マーカー
- `buildAutoSection()`: エージェント設定からマーカー内の自動セクションを構築
- `updateAutoSection()`: 既存ファイルのマーカー内のみ更新、カスタム部分は保持
- マーカーがないファイルには先頭に追加

---

## 47. v0.3.0 Claude Code利用制限モニター + ブックマーク修正 + メモリ画面改善

### 概要
Anthropic APIのレスポンスヘッダから5時間/7日の利用率・リセット時刻を取得しステータスバーに表示

### 閾値通知
- 90%到達: `showWarningMessage`（5h/7d独立判定）
- 100%到達: `showErrorMessage`（5h/7d独立判定）
- リセットされるまで同じ閾値では再通知しない（フラグ管理）
- 90%未満に下がったらフラグリセット（次回の到達で再通知可能）

### ブックマーク表示修正
- **原因**: `BookmarkTreeProvider` が `sessionProvider.getSessions()`（プロジェクトフィルター済み）を使用していたため、他プロジェクトのブックマークが非表示に
- **修正**: `getAllParentSessions()`（フィルター前の全親セッション）を使用
- **追加**: `SessionTreeProvider.onDidRefresh` イベントで、セッションロード完了時にブックマーク・タグを自動リフレッシュ

### メモリ管理画面改善
- 設定ファイルグループにプロジェクトの `{workspace}/.claude/settings.local.json` を追加表示
- `memoryManager.getSettingsFilePaths()` の返り値に `projectLocalSettingsPath` フィールド追加

### 新規ファイル
- `src/usageMonitor.ts` — UsageMonitorクラス（取得・表示・色切替・タイマー管理）

### 表示形式
`$(dashboard) 15% 3.5h / 5% 3d25h`
- 左: 5時間利用率 + リセットまでの残り時間
- 右: 7日利用率 + リセットまでの残り時間

### 色切替
| 利用率 | 色 |
|---|---|
| < 80% | 標準 |
| >= 80% | `statusBarItem.warningBackground` |
| >= 95% | `statusBarItem.errorBackground` |

### 取得方法
1. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`
2. POST `https://api.anthropic.com/v1/messages`（Haiku, max_tokens: 1）
3. レスポンスヘッダ: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`

### 設定
| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `enableUsageMonitor` | boolean | false | 有効化（APIリクエスト発生の警告付き） |
| `usageMonitorInterval` | number | 300 | 更新間隔（秒、60〜3600） |

### コマンド
- `claudeManager.refreshUsage` — 手動更新

### エラーハンドリング
- credentials.json 未存在: エラーなしで無効表示
- APIエラー/タイムアウト: リトライせず次の更新まで待機
- 二重リクエスト防止（`fetching`フラグ）

---

## 48. v0.3.0 タスク管理UIメニュー追加・取締役ルールマーカー対応

### タスクログのコンテキストメニュー（package.json追加）
- `openTaskOutput` — `taskLogItem.*WithOutput` 条件でインライン表示
- `completeTaskLog` — `taskLogItemActive` 条件で完了操作
- `deleteTaskLog` — 全 `taskLogItem` 条件で削除操作
- `addTaskLog` — `view/title` に `claudeAgents` ビュータイトルバーボタンとして追加

### 取締役ルールファイル CSM:AUTO マーカー対応
- `generateDirectorRuleFile()` を `buildDirectorAutoSection()` + `updateDirectorAutoSection()` に分離
- 新規作成時: `<!-- CSM:AUTO:START -->` 〜 `<!-- CSM:AUTO:END -->` マーカー付き
- 既存ファイル更新時: マーカー内のみ更新、カスタム部分（マーカー外）は保持
- マーカーがないファイル: 先頭にマーカー付き自動セクションを追加し、既存内容は後ろに保持
- 「以下にカスタムルールを自由に追記してください」コメント付き

---

## 49. v0.3.0 パフォーマンス改善（Extension Host ブロッキング解消）

### 原則
- **readFileSync は全廃止**。例外なし、dataStore.ts を含む全ファイルで async 化済み
- すべてのファイル操作を `fs.promises` API に置換

### 変更ファイルと内容

| ファイル | 変更内容 |
|---|---|
| `agentWatcher.ts` | `setInterval` ポーリング → `fs.watch` + 300ms デバウンス。二重実行防止フラグ。全I/O非同期化 |
| `sessionLoader.ts` | 全関数async化。TTLキャッシュ（fileInfos: 7秒、pathMap: 30秒）。`Promise.allSettled` 並列解析。FileHandle APIでfd安全 |
| `subagentDetector.ts` | `readFileTail()` を FileHandle API で非同期化、fdリーク対策 |
| `memoryManager.ts` | 全関数async化。`Promise.all` で並列stat+readFile |
| `memoryTreeProvider.ts` | `getChildren()` を `Promise<MemoryTreeNode[]>` に変更 |
| `agentTreeProvider.ts` | `getChildren()` async化。ルールファイル行数を `Promise.allSettled` で一括非同期取得 |
| `agentManager.ts` | `getRuleFileInfo()` async化 |
| `agentPreviewPanel.ts` | `showAgentPreview()` / `getPreviewHtml()` async化 |
| `sessionTreeProvider.ts` | `refresh()` で `.then()` パターン使用（メソッドシグネチャ維持しつつ内部非同期） |
| `webviewPanel.ts` | `showSessionPreview()` async化 |
| `extension.ts` | 15+箇所の同期I/Oを全て非同期化。`generateDirectorRuleFile()` / `writeOrgInfoToMemory()` async化 |

### dataStore.ts の全面async化
- 全exported関数がPromiseを返すasync関数に変更
- `loadData()` / `saveData()` を `fs.promises.readFile` / `fs.promises.writeFile` に置換
- TTLキャッシュ（2秒）は維持 — キャッシュヒット時はI/O発生しない
- 呼び出し元11ファイルに`await`を追加（agentManager, agentTreeProvider, bookmarkTreeProvider, tagTreeProvider, webviewPanel, orgChartPanel, extension.ts 等）

---

## 50. v0.3.0 セキュリティ・品質改善（品質管理部レビュー対応）

### H-1: CSM:AUTOマーカーのインジェクション対策
- `sanitizeForAutoSection()` 関数を追加
- エージェント名・役割からマーカー文字列（`<!-- CSM:AUTO:START/END -->`）を除去
- `buildAutoSection()` / `buildDirectorAutoSection()` の入力値に適用

### H-2/H-3: TreeView Disposable 追跡 + EventEmitter dispose
- `vscode.window.createTreeView()` の返り値を `context.subscriptions.push()` で管理
- 全TreeDataProvider（Session, Bookmark, Tag, Memory, Agent）に `vscode.Disposable` インターフェースと `dispose()` メソッドを追加
- `_onDidChangeTreeData` EventEmitter を確実にdispose

### H-4: dataStore.ts 全面async化
- セクション49の「dataStore.ts の全面async化」参照

### H-5: Webview CSP（Content Security Policy）
- `webviewPanel.ts` のセッションプレビュー・メモリプレビューに nonce-based CSP メタタグを追加
- `default-src 'none'; style-src 'nonce-{nonce}'; script-src 'nonce-{nonce}'`
- `crypto.randomBytes(16).toString('hex')` でnonce生成

### H-6: floating promise 修正
- `agentFormPanel.ts` の `getFormHtml().then()` に `.catch()` 追加（2箇所）
- `extension.ts` の `copyMemoryPath` を async/await に変換

---

## 51. v0.3.0 初期セットアップ・フィルター改善

### Extension Host 分離設定の自動追加（#6）
- `addAffinitySettings()` 関数を新設
- `registerDirector` コールバック内で呼び出し
- VS Code settings.json の `extensions.experimental.affinity` が未設定の場合のみ追加:
  - `ratorin.claude-session-manager`: 1
  - `anthropic.claude-code`: 2
- 既設定時は上書きしない、書き込み失敗時は無視

### セッションフィルターのデフォルト変更（#7）
- `sessionFilterMode` のデフォルト値を `"project"` → `"all"` に変更
- 変更箇所: package.json（設定定義）、extension.ts（フォールバック値2箇所）

---

## 52. v0.3.0 セッション引き継ぎ改善（遺言2モード・ルールファイル蓄積・旧ID保持）

### 遺言生成の2モード

| モード | 説明 | コスト |
|--------|------|--------|
| 簡易（即時） | JSONL末尾50行から直近2往復を抽出 | ゼロ |
| 詳細（AI要約） | Claude CLIでJSONL末尾を要約生成（モデル選択可: opus/sonnet/haiku、デフォルト推奨opus） | トークンコストあり |

- QuickPickでモード選択後、詳細モードではモデル選択QuickPick表示
- 生成結果をInputBoxで編集可能
- 両モードとも長さ上限300文字
- 詳細モード失敗時は簡易モードにフォールバック
- JSONL読み取りはFileHandle APIによる末尾読み取り（簡易: 128KB、詳細: 256KB）
- ルールファイル書き込みエラーはOutputChannel「CSM Session Manager」にログ出力

### ルールファイルへの歴代セッション記録

遺言をルールファイルのカスタム部分（CSM:AUTOマーカー外）に蓄積:

```markdown
## 歴代セッションの記録

### 2026-04-05 (旧ID: abc-123)
前セッションでの作業内容サマリー...

### 2026-04-04 (旧ID: xyz-789)
その前のセッションサマリー...
```

- CSM:AUTO:END マーカーの直後に「歴代セッションの記録」セクションを配置
- 直近3世代まで保持、4世代目以降は古いものから削除
- 新セッションは `--append-system-prompt-file` でルールファイルを読むため自動的に経緯を把握

### AgentConfig.previousSessionIds

```typescript
previousSessionIds?: string[];  // 過去のセッションID（直近5件）
```

- セッション更新時に旧IDを配列末尾に追加
- 5件を超えたら古いものから削除
- 将来的に過去セッションの履歴参照に利用

### 影響範囲
| ファイル | 変更 |
|---|---|
| `types.ts` | AgentConfig に `previousSessionIds` フィールド追加 |
| `extension.ts` | `renewAgentSession` 全面改修、ヘルパー3関数追加（generateSimpleTestament / generateDetailedTestament / appendSessionHistoryToRuleFile） |

## 53. フォルダ構造移行 + TODO.md自動管理 + タスクログUI削除

### フォルダ構造（Phase 1）

`.agent-rules/` 配下をフラット構造からフォルダ構造に移行:

```
.agent-rules/
├── CSM開発部/
│   ├── CSM開発部.md    ← ルールファイル（従来通り）
│   ├── TODO.md          ← エージェント別タスク管理
│   └── HISTORY.md       ← 歴代セッション記録（ルールファイルから分離）
```

- `autoGenerateRuleFile()` がフォルダ構造を自動作成
- `resolveRuleFilePath()` がフラット/フォルダ両構造を自動判定
- 移行コマンド `claudeManager.migrateToFolderStructure` で一括移行（旧ファイルは `.trash/` へ）
- HISTORY.md はルールファイルの `## 歴代セッションの記録` セクションから自動分離

### Stop フック — todo-flush.js（Phase 2）

`~/.claude/scripts/csm/todo-flush.js` — Stop フック発火時に TodoWrite 最終状態を TODO.md にマージ:

| ステップ | 処理 |
|----------|------|
| 0 | パスサニタイズ（パストラバーサル防止） |
| 1 | セッションID取得（stdin主系 / 環境変数副系） |
| 2 | session-manager.json からエージェント特定 |
| 3 | JSONL末尾64KBからTodoWrite最終呼び出し抽出 |
| 4 | TODO.md マージ（id重複検出 + 先頭40文字フォールバック） |
| 5 | 完了タスク10件超過分をHISTORY.mdに転記 |

- ロックファイル排他制御、非同期実行（async: true）

### タスクログUI削除

手動タスク記録UI（5コマンド + 3メニュー）を削除。自動検出（TaskTracker）は存続。

### 影響範囲

| ファイル | 変更 |
|---|---|
| `extension.ts` | フォルダ構造対応、`ensureAgentFolderFiles()` 追加、`migrateToFolderStructure` コマンド追加、タスクログ5コマンド削除 |
| `agentManager.ts` | `resolveRuleFilePath()` フラット/フォルダ両対応 |
| `package.json` | `migrateToFolderStructure` コマンド追加、タスクログ5コマンド+3メニュー削除 |
| `~/.claude/scripts/csm/todo-flush.js` | 新規（Stop フックスクリプト） |
| `~/.claude/settings.json` | Stop フックにtodo-flush.js追加 |

---

## 54. v0.3.1 — YAML Frontmatter 移行 + SubagentStart/Stop フック

### YAML Frontmatter 移行

ルールファイルの自動生成マーカーを `<!-- CSM:AUTO:START/END -->` から YAML Frontmatter 形式に移行:

**旧形式（v0.3.0）:**
```markdown
<!-- CSM:AUTO:START -->
自動生成テキスト
<!-- CSM:AUTO:END -->
カスタム記述
```

**新形式（v0.3.1）:**
```yaml
---
name: CSM開発部
model: sonnet
effort: high
description: |
  自動生成テキスト
---

カスタム記述
```

- `frontmatterUtils.ts` 新設 — `parseFrontmatter()` / `generateFrontmatter()` / `updateFrontmatterInContent()` / `migrateAutoToYaml()`
- AgentConfig のフィールドを frontmatter にマッピング: name, model, effort, thinking, maxThinkingTokens, scope, sessionId, parentAgent, role
- `description` フィールドにリテラルブロックスカラー（`|`）で自動生成テキストを格納
- `---` 以下のカスタム記述は一切変更しない
- 旧形式（CSM:AUTO マーカー）は `updateRuleFrontmatter()` 呼び出し時に自動移行

### SubagentStart/Stop フック

シグナルファイル方式でサブエージェントのライフサイクルを捕捉:

| 項目 | 内容 |
|------|------|
| スクリプト | `~/.claude/scripts/csm/subagent-signal.js` |
| シグナルディレクトリ | `~/.claude/.csm-signals/` |
| イベント | `SubagentStart` / `SubagentStop` |
| 出力 | `{start\|stop}-{timestamp}.json`（type, timestamp, pid, cwd, sessionId, agentType, description, parentSessionId） |
| クリーンアップ | 5分超のシグナルファイルを自動削除 |
| 設定 | `async: true`, `timeout: 10` |

- `ensureSubagentHooks()` — 取締役セットアップ時に `settings.json` へフック自動登録（既存チェック + バックアップ作成）
- stdin パイプ切断対応（try/catch）、`main().catch(() => {})` でPromise拒否防止

### 影響範囲

| ファイル | 変更 |
|---|---|
| `frontmatterUtils.ts` | 新規（YAML frontmatter パース・生成・移行ユーティリティ） |
| `extension.ts` | CSM:AUTO関数5件削除 → frontmatter関数4件新設、`ensureSubagentHooks()` 追加 |
| `package.json` | バージョン 0.3.0 → 0.3.1 |
| `~/.claude/scripts/csm/subagent-signal.js` | 新規（SubagentStart/Stop フックスクリプト） |
| `~/.claude/settings.json` | SubagentStart/Stop フック自動登録 |

---

## 55. v0.3.1 追加 — マイグレーションバナー + renewAgentSession 修正

### マイグレーションバナー

エージェント管理ツリービュー上部に旧形式ルールファイルの移行バナーを表示:

- `MigrationBannerItem` — 旧形式ルールファイル検出時に⚠バナー表示
- `detectLegacyAgents()` — 全エージェントのルールファイルを走査、以下を旧形式と判定:
  - CSM:AUTO マーカーあり（`isLegacyAutoFormat`）
  - YAML フロントマターなし（`!hasFrontmatter`）
  - フラット構造（親ディレクトリ名 ≠ エージェント名）
- クリックで `claudeManager.migrateRuleFiles` コマンド実行
- 移行完了後、バナーは自動非表示

### 一括マイグレーションコマンド（`migrateRuleFiles`）

| フェーズ | 処理 |
|----------|------|
| A: YAML変換 | CSM:AUTO → migrateAutoToYaml() / フロントマターなし → generateFrontmatter() |
| B: フォルダ移行 | フラット → 部署フォルダ構造、HISTORY.md分離、旧ファイル→.trash/ |

- プログレスバー表示（Notification）
- OutputChannel にログ出力
- エラー発生時は OutputChannel を自動表示

### renewAgentSession 修正

- 全体を try/catch で囲み、致命的エラー時に showErrorMessage + OutputChannel.show
- 遺言生成失敗時はデフォルトメッセージで続行（内側 try/catch）
- JSONL追記・歴代記録追記にも個別 try/catch
- OutputChannel を起動時に即作成（遅延作成を廃止）

### 影響範囲

| ファイル | 変更 |
|---|---|
| `agentTreeProvider.ts` | `MigrationBannerItem` 追加、`detectLegacyAgents()` 追加、`getChildren()` にバナー表示ロジック |
| `extension.ts` | `migrateRuleFiles` コマンド追加、`renewAgentSession` エラーハンドリング強化、OutputChannel即作成 |
| `package.json` | `migrateRuleFiles` コマンド登録 |

---

## バージョン
- **0.3.1** — YAML Frontmatter 移行 + SubagentStart/Stop フック + マイグレーションバナー
- **0.3.0** — 監視アーキテクチャ刷新 + メモリ拡張 + フォーム拡張 + CLI Builder + タスク管理 + パフォーマンス改善
- **0.2.8** — ルールファイル管理改善（スコープ分離・自動生成強化・MEMORY.mdポインタ方式）
- **0.2.7** — ステータスバー稼働判定バグ修正（PIDベースに変更）
- **0.2.6** — JSONL解析ベースのエージェント監視・稼働中ソート
- **0.2.5** — ポーリングON/OFF設定・テンプレート強化・自動遺言生成
- **0.2.4** — 組織図軽量化・子エージェントライブ状態削除
- **0.2.3** — PIDマッピングファイル方式に移行
- **0.2.2** — バグ修正3件 + 状態表示改善
- **0.2.1** — アイコンデザイン改善 + ソート拡張 + ステータスバー改善
- **0.2.0** — エージェント管理基盤の再設計
