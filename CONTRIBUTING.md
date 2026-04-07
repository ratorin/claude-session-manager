# 開発ガイド

## ビルド＆インストール

```bash
git clone https://github.com/ratorin/claude-session-manager.git
cd claude-session-manager
npm install
npm run compile
npx @vscode/vsce package
```

生成された `.vsix` ファイルをVS Codeにインストール:

```bash
code --install-extension claude-session-manager-0.3.2.vsix
```

または VS Code内で `Ctrl+Shift+P` → `Extensions: Install from VSIX...` から選択。

> **注意**: `.vsix` ファイルは `local/` フォルダに生成されます（`.gitignore` 対象）。

## 開発

```bash
npm run watch    # TypeScript自動コンパイル
```

VS Codeで `F5` → Extension Development Hostで動作確認。

## データ

### 読み取り元（Claude Code）

| データ | パス | 形式 |
|---|---|---|
| 会話履歴 | `~/.claude/projects/{プロジェクト}/{セッションID}.jsonl` | JSONL |
| リネーム名 | 各JSONL内の `custom-title` エントリ | JSON |
| メモリ | `~/.claude/projects/{プロジェクト}/memory/*.md` | Markdown |
| メモリインデックス | `~/.claude/projects/{プロジェクト}/memory/MEMORY.md` | Markdown |

### 拡張機能の永続データ

ブックマーク・タグ・カスタム名・メモ・エージェント設定は `~/.claude/session-manager.json` に保存。

```json
{
  "bookmarks": ["セッションID"],
  "tags": { "タグ名": ["セッションID"] },
  "customNames": { "セッションID": "カスタム名" },
  "notes": { "セッションID": "メモ内容" },
  "agents": {
    "エージェントID": {
      "name": "エージェント名",
      "role": "director|worker",
      "department": "部署名",
      "sessionId": "紐づけセッションID",
      "ruleFile": "ルールファイルパス",
      "previousSessionIds": ["過去セッションID"]
    }
  },
  "ruleFolder": "ルールファイル格納フォルダ",
  "taskLogs": [
    {
      "id": "タスクID",
      "agentId": "エージェントID",
      "description": "タスク内容",
      "status": "running|completed|error|stalled",
      "startedAt": "ISO日時",
      "outputFile": "出力ファイルパス"
    }
  ]
}
```

## 技術仕様

### セッションタイトルの優先順位
1. Session Managerでリネームした名前（dataStore）
2. Claude Codeのタイトル（`custom-title` > `ai-title`）
3. ユーザーの最初の発言（システムタグ除去済み）

※ リネーム・AIタイトル使用時は元のメッセージ（先頭30文字）をdescriptionに表示

### Claude Codeとの連携
- **リネーム同期**: Session Managerでリネームすると、JSONLファイルに `custom-title` を書き込み、Claude Code側にも反映
- **会話を開く**: `vscode://anthropic.claude-code/open?session={ID}` URIハンドラーを使用。既に開いているセッションはそのタブにフォーカス
- **セッション引継ぎ**: `renewAgentSession` でセッションを交代。遺言（簡易/詳細）を生成し、ルールファイルに履歴を追記、`previousSessionIds` で引継ぎチェーンを管理

### エージェント監視（AgentWatcher）
`enableAgentMonitor` 有効時、以下をリアルタイム監視:
- **fs.watch + デバウンス**: JSONLファイルの変更を検知
- **SubagentDetector**: JSONLテール解析でサブエージェントの起動・停止を検出
- **TaskTracker**: セッション更新状況からタスク状態を自動判定（running/stalled/completed/error）
- **ステータスバー**: `🟢N 👥M` 形式で稼働中エージェント数・サブエージェント数を表示

### 利用制限モニター（UsageMonitor）
`enableUsageMonitor` 有効時、Anthropic APIから利用率を取得しステータスバーに表示。

### ツール操作の表示
プレビューで空のメッセージ（ツール実行の許可・結果）を自動検出し、操作内容を表示:
- 📄 ファイル読み取り / ✏️ ファイル編集 / 💻 コマンド実行 / 🔍 コード検索 など

### CLI起動（cliBuilder）
エージェントのセッションを開く際、`claude --resume {ID}` コマンドを組み立て。Effort/Thinking/MaxTokens等のパラメータに対応。

## ファイル構成

```
claude-session-manager/
├── src/
│   ├── extension.ts            # エントリポイント・コマンド登録（46コマンド）
│   ├── types.ts                # 型定義
│   ├── sessionLoader.ts        # JSONL読み込み・パース
│   ├── dataStore.ts            # ブックマーク・タグ・エージェント等の永続化
│   ├── memoryManager.ts        # メモリファイル操作
│   ├── sessionTreeProvider.ts  # 会話一覧TreeView（日付/タグ/エージェントグループ・ライブ検出）
│   ├── bookmarkTreeProvider.ts # ブックマークTreeView
│   ├── tagTreeProvider.ts      # タグTreeView
│   ├── memoryTreeProvider.ts   # メモリ管理TreeView
│   ├── webviewPanel.ts         # 会話・メモリプレビュー（上下分割・メモ・タグ操作）
│   ├── agentManager.ts         # エージェントCRUD・セッション引継ぎ
│   ├── agentFormPanel.ts       # エージェント登録・編集フォーム（Webview）
│   ├── agentPreviewPanel.ts    # エージェントプレビュー（Webview）
│   ├── agentTreeProvider.ts    # エージェント管理TreeView
│   ├── orgChartPanel.ts        # 組織図表示（Webview）
│   ├── agentWatcher.ts         # エージェント稼働監視（fs.watch + EventEmitter）
│   ├── subagentDetector.ts     # サブエージェント検出（JSONLテール解析）
│   ├── taskTracker.ts          # タスク状態自動判定（running/stalled/completed/error）
│   ├── cliBuilder.ts           # Claude CLIコマンド組み立て
│   ├── usageMonitor.ts         # Anthropic API利用制限モニター
│   ├── frontmatterUtils.ts    # YAML Frontmatter パース・生成・移行ユーティリティ
│   └── parentChildSync.ts     # 親子ルールファイル自動同期
├── package.json                # 拡張機能マニフェスト（46コマンド・15設定）
├── tsconfig.json
├── guide.html                  # 図解ガイド（ブラウザで開く）
├── SPEC.md                     # 技術仕様書
├── CHANGELOG.md                # 変更履歴
├── README.md                   # ユーザー向けドキュメント
├── local/                      # ローカル専用（.gitignore対象）
│   ├── *.vsix                  # ビルド済みパッケージ
│   └── temp/                   # 一時ファイル
├── docs/                       # ドキュメント・図
├── images/
│   ├── icon.png                # 拡張機能アイコン
│   ├── icon.svg                # アイコン原本（SVG）
│   └── marketplace-banner.html # マーケットプレイス用イメージ
└── resources/
    ├── sparkle-light.svg       # Claude Codeで開くアイコン（ライト）
    └── sparkle-dark.svg        # Claude Codeで開くアイコン（ダーク）
```

## 設定一覧

| 設定キー | デフォルト | 説明 |
|---|---|---|
| `enableAgentMonitor` | `false` | エージェント稼働監視 |
| `agentMonitorInterval` | `5` | 監視更新間隔（秒） |
| `enableNotifications` | `true` | タスク完了・エラー通知 |
| `taskStalledThreshold` | `60` | stalled判定閾値（秒） |
| `taskAutoCleanupHours` | `72` | タスクログ自動削除（時間） |
| `taskMaxLogs` | `100` | タスクログ最大保持件数 |
| `enableUsageMonitor` | `false` | 利用制限モニター |
| `usageMonitorInterval` | `300` | 利用制限更新間隔（秒） |
| `defaultSortMode` | `updated-desc` | デフォルトソート順 |
| `defaultGroupMode` | `date` | デフォルトグループ化 |
| `maxSessionsShown` | `500` | 最大表示件数 |
| `sessionFilterMode` | `all` | フィルターモード |
| `defaultRuleFolder` | `""` | ルールファイル格納フォルダ |
| `preview.showThinkingBlocks` | `false` | 思考ブロック表示 |
| `trash.folder` | `""` | 削除先フォルダ |
