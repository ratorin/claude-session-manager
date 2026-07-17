# CSM エージェント管理 再構築プラン

**日付:** 2026-04-10
**ステータス:** Phase 2 完了・Phase 1 一部完了

---

## 背景

Claude Code CLIの大幅アップデートにより、エージェント管理の標準機能が追加された。
CSM独自で構築してきた仕組みの多くがCLI本体に取り込まれたため、CSMの役割を再定義する。

### CLIの新機能（調査部調査結果）
- `~/.claude/agents/*.md` — エージェント定義ファイル（CLI標準）
- `claude --agent <name>` — 名前でエージェント起動
- `memory: project` — セッション跨ぎの記憶保持
- `--continue` — 最新セッションを自動再開（ID不要）
- `--fork-session` — セッション分岐
- Hooks 17種類 + http/command/prompt/agent ハンドラ
- `permissionMode` — 部署ごとの権限を宣言的管理
- `isolation: worktree` — 隔離作業モード

### 実テストで判明したこと

| 方式 | 記憶保持 | 履歴保存 | CSM検知 | 用途 |
|------|---------|---------|---------|------|
| Agent ツール（subagent_type） | ✗ | ✗ | ✗ | 使い捨て調査のみ |
| `claude --agent <name> -p` | ○ | ○ | ○ | **部署への指示（本命）** |
| `claude --agent <name> --continue -p` | ○ | ○ | ○ | 前回の続き |
| `claude --resume <ID> -p` | ○ | ○ | ○ | 従来方式（廃止予定） |

### Agent ツールの注意点（調査部調査結果）
- `enablePersistentMemory` は旧フィールド名。正式名は `memory`（値: user/project/local）
- バックグラウンドサブエージェントのトランスクリプト漏洩バグ（Issue #14118、OPEN）
- 親コンテキストの94%を占有した実例あり → 並行タスクにはCLI起動を使う
- OSSプロジェクトは全てCLI起動を採用

---

## 現在の進捗

### ✅ 完了済み
- [x] エージェント定義移行（17部署 → `~/.claude/agents/*.md`）
- [x] 取締役ルール（director.md）新形式で作成
- [x] 移行スクリプト作成（`c:/xampp/.agent-rules/temp/migrate_agents.py`）
- [x] `memory: project` 動作確認（セッション跨ぎで記憶保持を確認）
- [x] MEMORY.md 整理（取締役固有セクションを director.md に統合）
- [x] `/deploy-al` スキル作成
- [x] 検知方式比較ビュー 7方式実装（テスト用）
- [x] 調査部による Claude Code 取扱説明書作成（`c:/xampp/Project/claude-code-manual/`）
- [x] 調査部による Agent ツール vs CLI起動 比較レポート

### 🔲 未着手
- [ ] CLAUDE.md にエージェント運用ルール追記
- [ ] `/dispatch` スキル作成
- [ ] Hook でバリデーション追加
- [ ] csm-dev.md 本文の旧形式情報整理
- [ ] CSM Extension の agents/*.md 対応

---

## 新アーキテクチャ

### ファイル構成

```
~/.claude/agents/           ← エージェント定義（CLI標準・Single Source of Truth）
├── director.md             ← 取締役（Opus, tools制限, memory:project）
├── csm-dev.md              ← CSM開発部
├── al-dev.md               ← ALOrderForge開発部
├── qa.md                   ← 品質管理部（plan権限=読み取り専用）
├── researcher.md           ← 調査部（plan権限+WebSearch）
├── ...                     ← 計17エージェント定義済み
│
c:/xampp/.agent-rules/      ← 部署ごとの補足データ（CSM管理）
├── {name}/
│   ├── todo.md
│   └── history.md
├── tmp/                    ← エージェント出力先
│
c:/xampp/CLAUDE.md          ← 圧縮で消えない核心ルール（@import対応）
│
c:/xampp/.claude/commands/  ← プロジェクトスキル
├── deploy-al.md            ← ALデプロイ
└── dispatch.md             ← 部署への指示（作成予定）
```

### エージェント定義の標準フォーマット

```yaml
---
name: {英語名}              # CLI識別子（英数字必須）
description: {役割}          # Agent ツール表示用
model: opus/sonnet/haiku    # モデル
memory: project             # セッション跨ぎ記憶（user/project/local）
tools: [...]                # 利用可能ツール
permissionMode: ...         # default/acceptEdits/plan/auto
parentAgent: director       # 組織階層（CSM独自フィールド）
status: active/idle         # 稼働状態（CSM独自フィールド）
workDir: ...                # 作業ディレクトリ（CSM独自フィールド）
---

（本文 = システムプロンプト）
```

### 起動方式

```bash
# 部署に指示を投げる（標準）
echo "指示内容" | claude --agent csm-dev -p > .agent-rules/tmp/agent_csm-dev_{タスク}.txt 2>&1

# 前回の続きから
echo "続きをお願い" | claude --agent csm-dev --continue -p

# 同じ部署に並行タスク（フォーク）
echo "タスクA" | claude --agent csm-dev -p &
echo "タスクB" | claude --agent csm-dev -p &
```

### 禁止事項
- `claude -p` 単体（`--agent` なし）は禁止
- Agent ツール（subagent_type）は使い捨て調査のみ。並行タスクには使わない（Issue #14118）
- 取締役は Edit/Write でコードを直接変更しない

---

## CSM Extension の変更方針

### CSMの新しい役割
CLIがエージェント実行基盤を担い、CSMは以下に特化:
1. **GUI管理** — agents/*.md の作成・編集・削除をフォームUIで
2. **組織図** — parentAgent フィールドから組織ツリーを構築
3. **状態検知** — fswatch + jsonlMtime で稼働状況表示
4. **会話一覧** — セッション閲覧・ブックマーク・タグ（既存機能維持）
5. **ルール移行** — 旧形式（.agent-rules/）→ 新形式（agents/*.md）の変換UI

### session-manager.json → 縮小

| 現在の役割 | 移行先 |
|-----------|--------|
| agents[].name, role, model | agents/*.md frontmatter |
| agents[].sessionId | 不要（--continue で自動再開） |
| agents[].ruleFile | 不要（md本文がルール） |
| agents[].parentAgent | agents/*.md 独自フィールド |
| agents[].status | agents/*.md 独自フィールド |
| agents[].workDir | agents/*.md 独自フィールド |
| bookmarks, tags, customNames, notes | **維持**（CSM独自機能） |

### エージェント設定フォーム

agents/*.md を読み書きする形に変更:

| 設定項目 | UI表現 |
|---------|--------|
| tools | チェックボックス（ファイル読む/書く/コマンド実行/Web検索/エージェント呼出） |
| permissionMode | 通常 / 編集自動承認 / 読み取り専用 / 自動判断 / 確認なし |
| isolation | 直接作業 / 隔離作業（Git必須） |
| memory | プロジェクト / グローバル |
| parentAgent | ドロップダウン（他エージェントから選択） |

### agentWatcher の簡素化

7方式 → 2方式:
- **fswatch**: sessions/ 変更検知（起動/停止）
- **jsonlMtime**: JSONL mtime変化（活動中検知 + 子エージェント検知）

### ファイル分割（品質管理部プラン準拠）

```
src/
├── extension.ts              (200行) ← activate()配線のみ
├── extensionTypes.ts         (30行)  ← 共通型
├── agents/
│   ├── agentFileManager.ts   ← agents/*.md の読み書き
│   └── launcher.ts           ← --agent 起動ヘルパー
├── providers/
│   ├── sessionTree.ts
│   ├── agentTree.ts
│   ├── bookmarkTree.ts
│   └── memoryTree.ts
├── watchers/
│   ├── fswatchWatcher.ts
│   └── jsonlMtimeWatcher.ts
├── commands/
│   ├── sessionCommands.ts
│   ├── agentCommands.ts
│   └── memoryCommands.ts
├── panels/
│   ├── agentFormPanel.ts
│   ├── orgChartPanel.ts
│   └── detectionComparePanel.ts
├── models/
│   ├── dataStore.ts
│   └── types.ts
└── utils/
    ├── cliBuilder.ts
    └── frontmatterUtils.ts
```

---

## 移行フェーズ

### Phase 1: 基盤整備（1日）
- [x] `/deploy-al` スキル作成
- [ ] CLAUDE.md にエージェント運用ルール追記（@import活用）
- [ ] `/dispatch` スキル作成（部署に --agent で投げる）
- [ ] Hook でバリデーション追加（`claude -p` 単体をブロック）
- 効果: 取締役のミスを構造的に防止

### Phase 2: エージェント定義移行（半日）✅ 完了
- [x] 移行スクリプト作成（migrate_agents.py）
- [x] 全17部署を `~/.claude/agents/*.md` に移行
- [x] frontmatter に独自フィールド追加（parentAgent, status, workDir）
- [x] `memory: project` 動作確認
- [x] director.md 新形式で作成
- [ ] csm-dev.md 等の本文から旧形式情報を整理
- 効果: `--agent` 方式で起動可能に

### Phase 3: CSM エージェント管理の更新（1-2日）
- [ ] agentFileManager.ts 新規作成（agents/*.md の読み書き）
- [ ] agentFormPanel.ts が agents/*.md を読み書きするよう変更
- [ ] agentTreeProvider.ts が agents/*.md からツリー構築
- [ ] orgChartPanel.ts が parentAgent から組織図構築
- [ ] ルール移行UI（旧→新の変換ボタン）
- [ ] 子を持つ親エージェントのルールに `/dispatch` の使い方を自動注入
- [ ] 子エージェント追加時に親のルール（部下一覧・dispatch方法）を自動更新
- [ ] 「エージェント機能を有効にする」初期セットアップ機能
  - director.md テンプレート配置
  - CLAUDE.md にルール追記
  - /dispatch スキルをcommands/にコピー
  - 確認ダイアログ表示
- 効果: CSMのGUIで新方式のエージェント管理

### Phase 4: 検知の簡素化（半日）
- [ ] agentWatcher.ts から不要な5方式を削除（fswatch + jsonlMtime のみ残す）
- [ ] detectionComparePanel.ts を2方式に更新（テスト完了後）
- 効果: コード量大幅削減

### Phase 5: ファイル分割リファクタ（2日）
- [ ] extension.ts → 分割（品質管理部プラン準拠）
- [ ] agentWatcher.ts → watchers/ に分離
- [ ] 各ファイル800行以下を確認
- 効果: 保守性向上

### Phase 6: session-manager.json 縮小（半日）
- [ ] agents[] を削除（agents/*.md に完全移行）
- [ ] bookmarks, tags, customNames, notes のみ残す
- [ ] 移行ツール作成（旧→新の自動変換）
- 効果: Single Source of Truth の確立

---

## リスクと対策

| リスク | 対策 |
|--------|------|
| `memory: project` の挙動が不完全 | テスト済みで基本動作は確認。長期運用で監視 |
| `--agent` の未知のバグ | 問題あれば `--resume` にフォールバック可能 |
| 独自フィールドが将来のCLI更新で衝突 | プレフィックス付与（csm-parentAgent 等）を検討 |
| 既存セッション履歴の断絶 | 旧セッションは会話一覧に残る。紐づけが切れるだけ |
| Agent ツールのトランスクリプト漏洩（#14118） | CLI起動をデフォルトとし、Agent ツールは使い捨てのみ |
| バックグラウンドサブエージェント孤児化（#20369） | CLI起動なら別プロセスなので影響なし |

---

## 完了条件

- [x] エージェント定義が `~/.claude/agents/*.md` に移行されている
- [x] `memory: project` でセッション跨ぎの記憶が機能する
- [ ] 取締役が `/dispatch 部署名 "指示"` で部署に投げられる
- [ ] CLAUDE.md に運用ルールが @import で組み込まれている
- [ ] CSMのエージェントパネルで agents/*.md を管理できる
- [ ] 組織図が agents/*.md の parentAgent から構築される
- [ ] 検知方式が2つに簡素化されている
- [ ] 全ソースファイルが800行以下
- [ ] session-manager.json から agents[] が削除されている

---

## 関連ドキュメント

- [エージェント呼び出し比較テスト](agent-invocation-test-20260410.md)
- [Claude Code 取扱説明書](../../claude-code-manual/)
- [Agent ツール調査レポート](../../.agent-rules/tmp/agent_調査部_agent_tool_guide.txt)
- [品質管理部リファクタリング設計書](../../.agent-rules/tmp/agent_品質管理部_refactor_plan.txt)
- [取締役振り返り](../../.agent-rules/tmp/取締役_振り返り_20260410.md)
