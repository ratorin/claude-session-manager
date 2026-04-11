# エージェント呼び出し方式の比較テスト

**日付:** 2026-04-10
**目的:** Claude Code CLIの新しい `--agent` オプションと Agent ツール `subagent_type` の動作を比較検証

---

## テスト環境

- Claude Code CLI（最新版）
- テスト用エージェント定義: `~/.claude/agents/test-agent.md`

```markdown
---
name: test-agent
description: 動作テスト用のエージェント
model: haiku
---

あなたは「テストエージェント」です。
応答は必ず「[テストエージェント] 」で始めてください。
質問には簡潔に答えてください。
```

---

## テスト結果

### 1. `--agent` オプション（CLI直接）

```bash
echo "あなたの名前と役割を教えてください" | claude --agent test-agent -p --max-turns 3
```

**結果:** Opusで動作。frontmatterの `model: haiku` が無視された。エージェントルール（`[テストエージェント]`プレフィックス）も無視。

### 2. `--agent` + `--model` 明示指定

```bash
echo "1+1は？回答の最初に[テストエージェント]をつけて" | claude --agent test-agent --model haiku -p --max-turns 3
```

**結果:** Haikuで動作。エージェントルール適用。`[テストエージェント] 1+1は2です。`

### 3. `--continue` でセッション継続

```bash
echo "さっきの計算の答え覚えてる？" | claude --agent test-agent --model haiku -p --continue --max-turns 3
```

**結果:** 前回の会話を記憶していた。`--continue` でエージェント単位のセッション継続が可能。

### 4. `claude agents list`

```bash
claude agents list
```

**結果:** `test-agent · haiku` として一覧に表示。nameが日本語だと一覧に出なかった（英数字推奨）。

### 5. Agent ツール（subagent_type）経由

```bash
echo 'Agent ツールを使って subagent_type: "test-agent" で「1+1は？」と聞いてください。' | claude -p --model haiku --max-turns 5
```

**結果:** `[テストエージェント] 1+1 は 2 です。` — エージェント定義のルール（プレフィックス）が適用された。モデルもhaiku。

---

## 比較表

| 方式 | コマンド | エージェント定義適用 | モデル指定 | セッション継続 |
|------|---------|-------------------|----------|--------------|
| `--agent` CLI | `claude --agent test-agent -p` | △（`--model`明示が必要） | frontmatterのみだと無視 | `--continue`で可能 |
| `--agent` + `--model` | `claude --agent test-agent --model haiku -p` | ○ | ○ | `--continue`で可能 |
| Agent ツール | `subagent_type: "test-agent"` | **○（ルール適用）** | **○（haiku適用）** | 親セッション内 |

---

## 重要な発見

1. **Agent ツールの `subagent_type` でカスタムエージェントを名前で呼べる** — オーケストレーションの鍵
2. **エージェント定義のルール（プロンプト）がsubagent_type経由で適用される** — 部署ごとの役割定義が機能する
3. **`--continue` で前回の会話を引き継げる** — セッションID不要で継続可能
4. **`claude agents list` で一覧管理** — session-manager.json不要でエージェント管理可能
5. **frontmatterの `model` は `--agent` 単体では無視される場合がある** — `--model` 明示またはAgent ツール経由が確実
6. **nameは英数字にすべき** — 日本語nameは `agents list` に表示されない

---

## CSMへの示唆

### 現行方式（session-manager.json + --resume）
- セッションID = エージェントのアイデンティティ
- IDが無効になると紐づけが切れる
- セッション肥大化で --resume 不安定

### 新方式（~/.claude/agents/*.md + --agent / subagent_type）
- エージェント定義ファイル = アイデンティティ（セッションIDに依存しない）
- `subagent_type` で取締役セッション内からの名前指定呼び出し可能
- `--continue` でID不要のセッション継続
- session-manager.json の役割が大幅縮小

### オーケストレーション
取締役セッション内から Agent ツールの `subagent_type` で各部署を呼び出す方式が有効:
```
Agent({
  subagent_type: "csm-dev",
  prompt: "検知方式を修正して"
})
```
これにより `claude --resume <UUID> --print` のパイプ方式が不要になる可能性がある。
ただし Agent ツール経由のサブエージェントは親セッション内で実行されるため、独立したセッション履歴は残らない。

---

## エージェント定義ファイルの作り方

### 配置場所

| 場所 | スコープ |
|------|---------|
| `~/.claude/agents/` | 全プロジェクト共通 |
| `.claude/agents/` | プロジェクト固有 |

### フロントマター（YAML）

```markdown
---
name: csm-dev
description: CSM開発を担当
tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
model: sonnet
permissionMode: acceptEdits
isolation: none
memory: project
---

あなたはCSM開発部です。
（ここにシステムプロンプト）
```

### フィールド一覧

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `name` | はい | 識別子（英数字推奨。日本語だと `agents list` に表示されない） |
| `description` | はい | Agent ツールで表示される説明 |
| `tools` | いいえ | 使えるツール制限。省略時は全ツール |
| `model` | いいえ | `opus` / `sonnet` / `haiku`（短縮名）/ `claude-sonnet-4-6[1m]` / `claude-opus-4-6[1m]`（1M）/ `inherit`（親継承）。※`sonnet[1m]` は旧版になるため使用禁止 |
| `permissionMode` | いいえ | default / acceptEdits / plan / auto / dontAsk / bypassPermissions |
| `isolation` | いいえ | none / worktree |
| `memory` | いいえ | セッション跨ぎの記憶モード: `user` / `project` / `local`。旧名 `enablePersistentMemory` は v2.1.100以降で無効 |

### ツール一覧

```
Read, Edit, Write, Bash, Grep, Glob, Agent, WebFetch, WebSearch,
TodoWrite, NotebookEdit, Monitor, EnterPlanMode, ExitPlanMode,
EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList,
RemoteTrigger, TaskOutput, TaskStop, AskUserQuestion,
ReadMcpResourceTool, ListMcpResourcesTool,
mcp__<server>__<tool>（MCPツール）
```

権限ルール構文でBashの実行範囲を制限可能:
```
"tools": ["Read", "Grep", "Bash(git *)", "Bash(npm run test)"]
```

---

## CSM UIでのわかりやすい表現

### ツール選択（エンジニア以外向け）

| UI表示 | 対応するtools |
|--------|--------------|
| ファイルを読む | Read, Grep, Glob |
| ファイルを書く/編集する | Edit, Write |
| コマンド実行（自由） | Bash |
| コマンド実行（制限付き） | Bash(git *), Bash(npm run test) 等 |
| Web検索・取得 | WebSearch, WebFetch |
| 他エージェント呼び出し | Agent |
| タスク管理 | TodoWrite |

### 作業方式（isolation）

| UI表示 | 値 | 説明 |
|--------|-----|------|
| **直接作業** | `none` | ファイルをそのまま編集します |
| **隔離作業** | `worktree` | コピーを作って安全に作業します（Git必須） |

### 作業方式の使い分け

| 場面 | 直接作業 | 隔離作業 |
|------|---------|---------|
| ちょっとした修正 | ○ | 過剰 |
| 大規模リファクタ | 怖い | ○ 安全 |
| デプロイ前の検証 | ミスると本番に影響 | ○ 安全に試せる |
| 複数エージェントが同時作業 | ファイル競合する | ○ 各自別コピー |
| あなたが同時に作業中 | 衝突する | ○ 干渉しない |

### 隔離作業のデメリット
- Gitで管理していないフォルダでは使えない
- コピーを作るのでディスク容量を使う
- マージ作業が必要（自動の場合もある）
- コミットされていない変更はコピーに含まれない

### 権限モード（permissionMode）

| UI表示 | 値 | 説明 |
|--------|-----|------|
| **通常** | `default` | 全操作に確認あり（安全） |
| **編集自動承認** | `acceptEdits` | ファイル編集は自動承認 |
| **読み取り専用** | `plan` | コード変更不可（レビュー向き） |
| **自動判断** | `auto` | AIが許可/拒否を判断 |
| **確認なし** | `dontAsk` | 全て自動承認（注意） |

---

## 再設計プラン比較

### プランA: 現行改善（1-2日）
- `--fork-session` でセッション巨大化対策
- CLAUDE.md `@` importでルール永続化
- Hooks活用（SessionStart/Stop）
- 検知方式をfswatch一本化

### プランB: 1から再設計（5-7日）
- `~/.claude/agents/*.md` でエージェント定義（session-manager.json廃止）
- `claude --agent <name>` / `subagent_type` で名前指定呼び出し
- Hooks http型 → CSMにプッシュ通知（polling廃止）
- `permissionMode` で部署ごとの権限を宣言的管理
- `isolation: worktree` でデプロイ可能に

### 推奨: プランBを段階的に実行
- Phase 1: CLAUDE.md @import + Hooks設定
- Phase 2: agents/*.md作成 + --agent起動への切替
- Phase 3: CSM Extensionリファクタ（hookServer + providers分離）
- Phase 4: session-manager.json廃止 + 旧検知方式削除
