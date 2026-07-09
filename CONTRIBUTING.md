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
code --install-extension claude-session-manager-*.vsix
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

### エージェント定義（Single Source of Truth）

エージェント定義は `~/.claude/agents/*.md` の YAML Frontmatter から読み取り・書き込み（`agentFileManager.ts`）。
CSMはこのファイルをSingle Source of Truthとして利用し、フォームUIからのフロントマター更新もサポートします。

#### agentFileManager.ts の役割

`src/agents/agentFileManager.ts` はエージェント定義の中核モジュールです:

- **読み取り**: `~/.claude/agents/*.md`（グローバル）と `.claude/agents/*.md`（プロジェクト）の両スコープを走査
- **パース**: YAML フロントマター拡張パーサー（JSON配列 `tools: ["Read", "Edit"]` 対応）
- **キャッシュ**: TTLキャッシュ（2秒間有効）でパフォーマンス最適化
- **書き込み**: フォームUIからの設定変更時、フロントマター部分のみ更新（本文は保持）
- **バリデーション**: エージェント名に `^[\p{L}\p{N}_\-]+$` パターンを適用（パストラバーサル防止）

#### agents/*.md のフロントマターフォーマット

```yaml
---
# CLI標準フィールド
name: CSM開発部                    # エージェント表示名
description: CSM拡張機能の開発      # 説明
model: sonnet                      # fable / fable-1m / opus / opus-1m / sonnet / sonnet-1m / haiku
                                   # 1M は `<model>[1m]` として書き出される (v0.5.14)
memory: project                    # user / project / local
tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
permissionMode: default            # default / acceptEdits / plan / auto
isolation: worktree                # （省略可）隔離モード

# CSM独自フィールド
parentAgent: director              # 親エージェント名（組織図構築に使用）
status: active                     # active / idle / archived
workDir: c:/xampp/Project/csm      # 作業ディレクトリ
role: CSM拡張機能の開発・保守       # 役割テキスト（プレビュー表示用）
effort: high                       # 推論努力レベル（low / medium / high / max）
thinkingEnabled: true              # Extended Thinking
---

（本文 = システムプロンプト）
```

### 拡張機能の永続データ

ブックマーク・タグ・カスタム名・メモは `~/.claude/session-manager.json` に保存。
v0.4.0でエージェント定義が `agents/*.md` に移行されたため、`session-manager.json` は大幅に縮小されました。

```json
{
  "bookmarks": ["セッションID"],
  "tags": { "タグ名": ["セッションID"] },
  "customNames": { "セッションID": "カスタム名" },
  "notes": { "セッションID": "メモ内容" }
}
```

> **注意**: 旧形式の `agents[]` / `agentSessions` / `ruleFolder` / `taskLogs` はv0.4.0で廃止済み。起動時の自動マイグレーションで `agents[]` → `agentSessions` への変換が一度だけ実行されますが、新規書き込みは行われません。

## 技術仕様

### セッションタイトルの優先順位
1. Session Managerでリネームした名前（dataStore）
2. Claude Codeのタイトル（`custom-title` > `ai-title`）
3. ユーザーの最初の発言（システムタグ除去済み）

※ リネーム・AIタイトル使用時は元のメッセージ（先頭30文字）をdescriptionに表示

### Claude Codeとの連携
- **リネーム同期**: Session Managerでリネームすると、JSONLファイルに `custom-title` を書き込み、Claude Code側にも反映
- **会話を開く**: `vscode://anthropic.claude-code/open?session={ID}` URIハンドラーを使用。既に開いているセッションはそのタブにフォーカス
- **エージェント起動**: `claude --agent {name} -p` でCLI標準の起動方式を使用（cliBuilder.ts）
- **セッション引継ぎ**: `renewAgentSession` でセッションを交代。遺言（簡易/詳細）を生成し、引継ぎチェーンを管理

### エージェント監視（AgentWatcher）
`enableAgentMonitor` 有効時、以下の2方式でリアルタイム監視:
- **fswatch方式**: `~/.claude/sessions/` の変更を fs.watch で検知（エージェントの起動・停止を検出）
- **jsonlMtime方式**: JSONLファイルのmtime変化を監視（活動中検知 + 子エージェント検知）

> v0.4.0で7方式から2方式に簡素化。比較エンジン・ポーリング方式等は廃止。

- **TaskTracker**: セッション更新状況からタスク状態を自動判定（running/stalled/completed/error）
- **ステータスバー**: `🟢N 👥M` 形式で稼働中エージェント数を表示

### 利用制限モニター（UsageMonitor）
`enableUsageMonitor` 有効時、Anthropic APIから利用率を取得しステータスバーに表示。

### ツール操作の表示
プレビューで空のメッセージ（ツール実行の許可・結果）を自動検出し、操作内容を表示:
- 📄 ファイル読み取り / ✏️ ファイル編集 / 💻 コマンド実行 / 🔍 コード検索 など

### CLI起動（cliBuilder）
エージェントのセッションを開く際、`claude --agent {name} -p` または `claude --resume {ID}` コマンドを組み立て。
v0.4.0以降は `--agent` 方式が推奨。Effort/Thinking/MaxTokens等のパラメータに対応。

## ファイル構成

```
claude-session-manager/
├── src/
│   ├── extension.ts              # エントリポイント・activate()配線・コマンド登録
│   ├── extensionTypes.ts         # 共通型定義
│   ├── models/
│   │   ├── types.ts              # エージェント・セッション等の型定義
│   │   └── dataStore.ts          # ブックマーク・タグ等の永続化（session-manager.json）
│   │                              ★ agents[] は廃止。getAgents() は agentFileManager 経由
│   ├── agents/
│   │   ├── agentFileManager.ts   # エージェント定義読み書き（~/.claude/agents/*.md）★SSoT
│   │   │                          YAML Frontmatter パース / TTLキャッシュ / バリデーション
│   │   ├── agentManager.ts       # エージェントCRUD・セッション引継ぎ
│   │   └── parentChildSync.ts    # 親子ルールファイル自動同期
│   ├── providers/
│   │   ├── sessionTreeProvider.ts  # 会話一覧TreeView
│   │   ├── agentTreeProvider.ts    # エージェント管理TreeView（agents/*.mdから構築）
│   │   ├── bookmarkTreeProvider.ts # ブックマークTreeView
│   │   ├── tagTreeProvider.ts      # タグTreeView
│   │   └── memoryTreeProvider.ts   # メモリ管理TreeView
│   ├── panels/
│   │   ├── webviewPanel.ts         # 会話・メモリプレビュー（CSP + パス検証付き）
│   │   ├── agentFormPanel.ts       # エージェント登録・編集フォーム（agents/*.md読み書き）
│   │   ├── agentPreviewPanel.ts    # エージェントプレビュー（nonce付きCSP）
│   │   └── orgChartPanel.ts        # 組織図表示（parentAgentから構築・nonce付きCSP）
│   ├── watchers/
│   │   ├── agentWatcher.ts         # エージェント稼働監視（fswatch + jsonlMtime の2方式）
│   │   └── taskTracker.ts          # タスク状態自動判定
│   └── utils/
│       ├── sessionLoader.ts        # JSONL読み込み・パース
│       ├── cliBuilder.ts           # Claude CLIコマンド組み立て（--agent対応）
│       ├── frontmatterUtils.ts     # YAML Frontmatter パース・生成・サニタイズ
│       │                            parseFrontmatter / parseFrontmatterExtended / sanitizeForYaml
│       ├── memoryManager.ts        # メモリファイル操作
│       ├── subagentDetector.ts     # サブエージェント検出（JSONL解析）
│       └── usageMonitor.ts         # 利用制限モニター
├── package.json                # 拡張機能マニフェスト
├── tsconfig.json
├── guide.html                  # 図解ガイド
├── SPEC.md                     # 技術仕様書
├── CHANGELOG.md                # 変更履歴
├── README.md                   # ユーザー向けドキュメント
├── CONTRIBUTING.md             # 開発ガイド（本ファイル）
├── local/                      # ローカル専用（.gitignore対象）
│   ├── *.vsix                  # ビルド済みパッケージ
│   └── temp/                   # 一時ファイル
├── docs/                       # ドキュメント・設計資料
│   └── rebuild-plan-20260410.md  # エージェント管理再構築プラン
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
