# Claude Session Manager

Claude Codeの会話履歴・メモリを管理するVS Code拡張機能。

## 機能一覧

### 会話管理

| 機能 | 説明 |
|---|---|
| 会話一覧 | 全プロジェクトの会話を日付別（今日/昨日/今週/今月/それ以前）に表示 |
| プレビュー | チャット形式で会話内容を表示（1タブで切り替え） |
| 会話内検索 | プレビュー上部の検索バーでメッセージを絞り込み |
| 一覧検索 | タイトル・プロジェクト・ブランチ名でフィルタ |
| ブックマーク | お気に入り登録、専用セクションに一覧表示 |
| タグ | 自由なカテゴリで分類、タグ別グループ表示 |
| リネーム | 会話にわかりやすい名前を設定 |
| Claude Codeで開く | VS CodeのClaude Codeパネルで会話を再開 |

### メモリ管理

| 機能 | 説明 |
|---|---|
| メモリ一覧 | タイプ別バッジ（user/feedback/project/reference）付きで表示 |
| 容量表示 | ファイル数・サイズ・インデックス使用率（最大200行） |
| プレビュー | メモリ内容をWebviewで表示 |
| 編集 | VS Codeエディタで直接開く |
| 統合（マージ） | 2つのメモリを1つにまとめる |
| 抽出 | 1つのメモリから一部を切り出して新ファイル化 |
| 削除 | ファイル削除＋MEMORY.mdインデックスの自動更新 |

### アイコン

| アイコン | 色 | 意味 |
|---|---|---|
| ✨ sparkle | 紫 | Opusモデルの会話 |
| ⚡ zap | 青 | Sonnetモデルの会話 |
| 🔥 flame | 緑 | Haikuモデルの会話 |
| ★ star | 黄 | ブックマーク済み |
| ● circle-filled | 緑 | Claude Codeで利用中（自動検出） |
| ▶ play | 白 | Session Managerでプレビュー中 |
| ▶ play | 緑 | プレビュー中 かつ 利用中 |

### 右クリックメニュー

**会話アイテム:**
- Claude Codeで開く
- 会話をリネーム
- タグを追加
- ブックマークに追加/解除

**メモリアイテム:**
- プレビュー
- 編集
- メモリを統合
- メモリから抽出
- メモリを削除

## データ構造

### 読み取り元（Claude Code）

| データ | パス | 形式 |
|---|---|---|
| 会話履歴 | `~/.claude/projects/{プロジェクト}/{セッションID}.jsonl` | JSONL |
| アクティブセッション | `~/.claude/sessions/{PID}.json` | JSON |
| メモリ | `~/.claude/projects/{プロジェクト}/memory/*.md` | Markdown（frontmatter付き） |
| メモリインデックス | `~/.claude/projects/{プロジェクト}/memory/MEMORY.md` | Markdown |

### 拡張機能の永続データ

| データ | パス |
|---|---|
| ブックマーク・タグ・カスタム名 | `~/.claude/session-manager.json` |

```json
{
	"bookmarks": ["セッションID", ...],
	"tags": {
		"タグ名": ["セッションID", ...]
	},
	"customNames": {
		"セッションID": "カスタム名"
	}
}
```

## ライブセッション検出

`~/.claude/sessions/` ディレクトリをファイルシステム監視（`fs.watch`）し、Claude Codeで現在使用中のセッションをリアルタイムで検出する。セッションファイルが追加/削除されるとアイコンが自動更新される。

## セッションタイトルの生成

会話のタイトルにはユーザーの最初の発言を使用する。以下のシステムタグは除去して実際の発言を抽出する:

- `<ide_opened_file>`
- `<ide_selection>`
- `<system-reminder>`
- `<task-notification>`

タグのみのメッセージはスキップし、次のユーザー発言をタイトルに使用する。

## Claude Codeで開く

VS Code拡張のURIハンドラーを使用:

```
vscode://anthropic.claude-code/open?session={セッションID}
```

既に開いているセッションはそのタブにフォーカスする。

## インストール

```bash
cd c:\xampp\Project\claude-session-manager
npm install
npm run compile
npx @vscode/vsce package
```

VS Codeで `Ctrl+Shift+P` → 「Extensions: Install from VSIX...」→ `claude-session-manager-0.1.0.vsix` を選択。

または:

```bash
code --install-extension claude-session-manager-0.1.0.vsix
```

## 開発

```bash
npm run watch    # TypeScript自動コンパイル
```

VS Codeで `F5` → Extension Development Hostで動作確認。

## ファイル構成

```
claude-session-manager/
├── src/
│   ├── extension.ts           # エントリポイント・コマンド登録
│   ├── types.ts               # 型定義
│   ├── sessionLoader.ts       # JSONL読み込み・パース
│   ├── dataStore.ts           # ブックマーク・タグ・カスタム名の永続化
│   ├── memoryManager.ts       # メモリファイル操作
│   ├── sessionTreeProvider.ts # 会話一覧TreeView
│   ├── bookmarkTreeProvider.ts # ブックマークTreeView
│   ├── tagTreeProvider.ts     # タグTreeView
│   ├── memoryTreeProvider.ts  # メモリ管理TreeView
│   └── webviewPanel.ts        # 会話・メモリプレビュー
├── package.json               # 拡張機能マニフェスト
├── tsconfig.json
├── guide.html                 # 図解ガイド
└── mockup.html                # UIモックアップ
```
