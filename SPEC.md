# Claude Session Manager v0.2.0 仕様書

## 概要

v0.1.9 → v0.2.0 へのメジャーアップデート。
エージェント管理の基盤を再設計し、UXを大幅に改善する。

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
| 0_open | Claude Codeで開く / セッションIDをコピー |
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
    name: string;
    sessionId: string;
    role: string;
    description?: string;
    model: 'opus' | 'sonnet' | 'haiku';
    sessionMode?: 'fixed' | 'disposable';  // 追加
    ruleFile?: string;
    parentAgent?: string;
    allowedTools?: string[];
    workDir?: string;
    status?: 'active' | 'idle' | 'archived';
    // 以下は削除（未使用）
    // effort, costLimitUsd, maxIterations
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

### 変更内容
- 「親エージェント」→「親エージェント」に用語変更
- 対象: エージェント設定フォーム、ツールチップ、プレビュー

---

## 14. ステータスバー改善（ライブセッション検出）

### 変更内容
- `~/.claude/sessions/` のJSONから全ライブセッションを検出
- 動作中のエージェント数のみ表示（例: `👥 2`）、0件なら `👥 0`
- カーソルホバーで動作中エージェント名のリストをツールチップ表示
- 登録済みエージェント → エージェント名で表示
- 未登録（使い捨て） → 「使い捨て (セッションID先頭8桁)」で表示
- 動作中は 800ms ブリンク

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

| ファイル | 操作 |
|---|---|
| `src/types.ts` | AgentConfig に sessionMode 追加、未使用フィールド削除 |
| `src/agentManager.ts` | MD パース削除、getAgents/enrichAgentsWithSessions のみ |
| `src/agentTreeProvider.ts` | ツリー構造 + 取締役トップソート + contextValue 拡張 |
| `src/agentPreviewPanel.ts` | **新規作成** — エージェントプレビュー（読み取り専用Webview） |
| `src/agentFormPanel.ts` | 「親エージェント」→「親エージェント」名称変更 |
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
| 親エージェント | セレクトボックス | |
| 作業フォルダ | テキスト + フォルダ選択ダイアログ | |
| ルールファイル | テキスト + ファイル選択ダイアログ | |

### メッセージフロー
- Webview → Extension: `save`, `cancel`, `browseFolder`, `browseRuleFile`, `generateRuleFile`
- Extension → Webview: `folderSelected`, `ruleFileSelected`

### 新規ファイル
`src/agentFormPanel.ts`

---

## 11. ステータスバー改善

### 変更内容
- アイコンを `👥` に変更
- 通常時: `👥 10`（登録エージェント総数）
- 稼働中あり: `👥 2/10`（稼働数/総数）800ms 間隔でブリンク
- ブリンク: `👥` とスペースを交互に表示

### 実装
- `setInterval` で 800ms ごとに `statusBarItem.text` をトグル
- `blinkTimer` を管理し、更新時に `clearInterval` でクリーンアップ
- dispose 時にもタイマー解放

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
- デフォルト値: `c:/xampp/Project/.agent-rules`
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
| `claudeManager.agentMonitorInterval` | number | 5 | エージェント監視間隔（秒） |
| `claudeManager.defaultSortMode` | enum | updated-desc | デフォルトのソート順 |
| `claudeManager.defaultGroupMode` | enum | date | デフォルトのグループ化 |
| `claudeManager.defaultRuleFolder` | string | "" | ルールフォルダパス |
| `claudeManager.maxSessionsShown` | number | 500 | 表示する最大セッション数 |
| `claudeManager.preview.showThinkingBlocks` | boolean | false | プレビューにAIの思考過程を表示 |
| `claudeManager.trash.folder` | string | "" | ゴミ箱フォルダパス |

### 実装箇所
- `package.json` — contributes.configuration定義
- `extension.ts` — getConfig()ヘルパー、ポーリングタイマー動的制御、設定変更リスナー
- `sessionTreeProvider.ts` — maxSessionsShown参照、agentMonitorInterval参照
- `dataStore.ts` — getRuleFolder()でVS Code設定をフォールバック参照
- `webviewPanel.ts` — showThinkingパラメータ、思考ブロックCSS
- `sessionLoader.ts` — includeThinkingフラグ、maxSessions制限

## バージョン
- **0.2.0** — エージェント管理基盤の再設計
