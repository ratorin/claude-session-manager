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
code --install-extension claude-session-manager-0.1.0.vsix
```

または VS Code内で `Ctrl+Shift+P` → `Extensions: Install from VSIX...` から選択。

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
| アクティブセッション | `~/.claude/sessions/{PID}.json` | JSON |
| リネーム名 | 各JSONL内の `custom-title` エントリ | JSON |
| メモリ | `~/.claude/projects/{プロジェクト}/memory/*.md` | Markdown |
| メモリインデックス | `~/.claude/projects/{プロジェクト}/memory/MEMORY.md` | Markdown |

### 拡張機能の永続データ

ブックマーク・タグ・カスタム名・メモは `~/.claude/session-manager.json` に保存。

```json
{
  "bookmarks": ["セッションID"],
  "tags": { "タグ名": ["セッションID"] },
  "customNames": { "セッションID": "カスタム名" },
  "notes": { "セッションID": "メモ内容" }
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

### ツール操作の表示
プレビューで空のメッセージ（ツール実行の許可・結果）を自動検出し、操作内容を表示:
- 📄 ファイル読み取り / ✏️ ファイル編集 / 💻 コマンド実行 / 🔍 コード検索 など

## ファイル構成

```
claude-session-manager/
├── src/
│   ├── extension.ts            # エントリポイント・コマンド登録
│   ├── types.ts                # 型定義
│   ├── sessionLoader.ts        # JSONL読み込み・パース
│   ├── dataStore.ts            # ブックマーク・タグ・カスタム名・メモの永続化
│   ├── memoryManager.ts        # メモリファイル操作
│   ├── sessionTreeProvider.ts  # 会話一覧TreeView（日付グループ・ライブ検出）
│   ├── bookmarkTreeProvider.ts # ブックマークTreeView
│   ├── tagTreeProvider.ts      # タグTreeView
│   ├── memoryTreeProvider.ts   # メモリ管理TreeView
│   └── webviewPanel.ts         # 会話・メモリプレビュー（上下分割・メモ・タグ操作）
├── package.json                # 拡張機能マニフェスト
├── tsconfig.json
├── guide.html                  # 図解ガイド（ブラウザで開く）
└── images/
    ├── icon.png                # 拡張機能アイコン
    ├── icon.svg                # アイコン原本（SVG）
    └── marketplace-banner.html # マーケットプレイス用イメージ
```
