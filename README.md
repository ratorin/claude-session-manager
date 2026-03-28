# Claude Session Manager

[Claude Code](https://claude.com/claude-code)の会話履歴・メモリを管理するVS Code拡張機能。

ブックマーク、タグ付け、メモ、検索、プレビューなど、Claude Code本体にない会話管理機能を提供します。

## 主な機能

### 会話管理
- **会話一覧** — 全プロジェクトの会話を日付別（今日/昨日/今週/今月/それ以前）に自動分類
- **プレビュー** — チャット形式で会話内容を表示。上部にヘッダ情報＋メモ欄、下部に会話（最新メッセージに自動スクロール）
- **ブックマーク** — 大事な会話をお気に入り登録。専用セクションに一覧表示
- **タグ** — 自由なカテゴリで分類。タグ別グループ表示。プレビュー画面から直接追加/削除
- **メモ** — 各会話に役割や目的のメモを記入可能。自動保存
- **リネーム** — 会話にわかりやすい名前を設定。Claude Code側と双方向同期
- **検索** — タイトル・プロジェクト・ブランチ名でフィルタ
- **会話内検索** — プレビュー内のメッセージをキーワードで絞り込み
- **Claude Codeで開く** — 右クリックからVS CodeのClaude Codeパネルで会話を再開

### ライブセッション検出
- `~/.claude/sessions/` を監視し、Claude Codeで現在使用中のセッションをリアルタイム検出
- 使用中の会話は緑の丸アイコンで表示

### メモリ管理
- **メモリ一覧** — タイプ別バッジ（user/feedback/project/reference）付きで表示
- **容量表示** — ファイル数・サイズ・MEMORY.mdインデックス使用率（最大200行）
- **プレビュー** — メモリ内容をWebviewで表示
- **編集** — VS Codeエディタで直接開く
- **統合（マージ）** — 2つのメモリを1つにまとめる
- **抽出** — 1つのメモリから一部を切り出して新ファイル化
- **削除** — ファイル削除＋MEMORY.mdインデックスの自動更新

## アイコン凡例

| アイコン | 色 | 意味 |
|---|---|---|
| ✨ sparkle | 紫 | Opusモデルの会話 |
| ⚡ zap | 青 | Sonnetモデルの会話 |
| 🔥 flame | 緑 | Haikuモデルの会話 |
| ★ star | 黄 | ブックマーク済み |
| ● circle-filled | 緑 | Claude Codeで利用中（自動検出） |
| ▶ play | 白 | Session Managerでプレビュー中 |
| ▶ play | 緑 | プレビュー中 かつ 利用中 |

## インストール

### ビルドしてインストール

```bash
git clone https://github.com/<your-username>/claude-session-manager.git
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

### 使い方

1. VS Code左のアクティビティバーに 💬 アイコンが表示される
2. クリックするとサイドバーに4セクション（会話一覧・ブックマーク・タグ・メモリ管理）が表示
3. 会話をクリックでプレビュー、右クリックでブックマーク・タグ・リネーム・Claude Codeで開く

詳しい使い方は同梱の `guide.html` をブラウザで開いて確認できます。

## 動作要件

- VS Code 1.85 以上
- [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) がインストール済み

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
1. Session Managerでリネームした名前
2. Claude Codeの `/rename` で設定した名前（`custom-title`）
3. ユーザーの最初の発言（システムタグ除去済み）

### Claude Codeとの連携
- **リネーム同期**: Session Managerでリネームすると、JONLファイルに `custom-title` を書き込み、Claude Code側にも反映
- **会話を開く**: `vscode://anthropic.claude-code/open?session={ID}` URIハンドラーを使用。既に開いているセッションはそのタブにフォーカス

### ツール操作の表示
プレビューで空のメッセージ（ツール実行の許可・結果）を自動検出し、操作内容を表示:
- 📄 ファイル読み取り / ✏️ ファイル編集 / 💻 コマンド実行 / 🔍 コード検索 など

## 開発

```bash
npm run watch    # TypeScript自動コンパイル
```

VS Codeで `F5` → Extension Development Hostで動作確認。

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
├── mockup.html                 # UIモックアップ
└── images/
    ├── icon.svg                # 拡張機能アイコン
    └── marketplace-banner.html # マーケットプレイス用イメージ
```

## ライセンス

[MIT](LICENSE)
