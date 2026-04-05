# CSM × Anthropic公式リソース統合プラン

- バージョン: 1.0
- 作成日: 2026-04-05
- 対象: Claude Session Manager v0.3.0
- 参照: knowledge_anthropic_academy.md, academy_claude_code_in_action.md, academy_subagents.md, academy_agent_skills.md

---

## 0. 判断サマリー

| # | 知見 | 判断 | Phase | 理由 |
|---|------|------|-------|------|
| 1 | Agent SDK セッション管理API | **部分採用** | Phase 3 | APIは有用だが現行JSONL直接読み取りが安定。SDK安定後に段階移行 |
| 2 | Chief of Staff agentパターン | **部分採用** | Phase 2 | 取締役パターンは同一思想。出力スタイル・フック設計は即取り込み可 |
| 3 | Hooks 24種の活用 | **採用** | Phase 1 | SubagentStop・SessionEnd・SessionStart(compact)は即座に活用可能 |
| 4 | サブエージェントYAMLフロントマター | **部分採用** | Phase 2 | 公式フォーマットへの段階移行。CSM:AUTOマーカーとの共存設計必要 |
| 5 | effortパラメータへの移行 | **採用** | Phase 1 | CSMは既にeffort UIを持つ。maxThinkingTokensの非推奨化を反映するのみ |
| 6 | スキルの段階的開示（L1→L2→L3） | **見送り** | — | メモリ管理には過剰設計。既にフラット構造で十分機能 |

---

## 1. Agent SDK セッション管理API

### 公式API

```
list_sessions(directory?, limit?, offset?)  → SDKSessionInfo[]
get_session_info(session_id, directory?)     → SDKSessionInfo
get_session_messages(session_id, directory?) → SessionMessage[]
rename_session(session_id, title)
tag_session(session_id, tag_or_none)
fork_session(session_id) → ForkSessionResult
delete_session(session_id)
```

### CSMの現状
- セッション管理: JSONL直接読み取り（`sessionLoader.ts`）+ FileHandle API末尾読み取り
- セッション編集: CSM独自の `dataStore.ts`（ブックマーク、タグ、リネーム、メモ）
- サブエージェント検出: `subagentDetector.ts` で JSONL パース

### 判断: **部分採用** — Phase 3

**採用する部分:**
- `fork_session()` — 「セッションを新しくする」をSDK API経由に置換。現在のJSONLコピー方式より堅牢
- `tag_session()` — タグ機能をSDK経由に統一（現在はdataStore独自管理）
- `list_sessions()` — セッション一覧取得をSDK API化（JSONLディレクトリ走査の置換）

**見送る部分:**
- `rename_session()` — CSM独自のcustomNameはClaude Codeの/renameとは別管理。統一するとCSMメタデータが失われる
- `delete_session()` — CSMは.trash/移動ポリシー。SDKの完全削除は方針と矛盾

### 実装戦略
1. **抽象レイヤー導入**: `sessionBackend.ts` インターフェース定義
2. **現行実装を第1バックエンド**: `JsonlSessionBackend`（既存ロジックをラップ）
3. **SDK実装を第2バックエンド**: `SdkSessionBackend`（Agent SDK TypeScript版）
4. 設定で切替可能（デフォルト: JSONL直接、オプション: SDK経由）

> **リスク:** Agent SDK TypeScript版はPython版の6.1K starsに比べまだ安定度が不明。Breaking changeへの追随コスト。
> **対策:** 抽象レイヤーで切替可能にし、SDK不具合時はJSONL直接にフォールバック。dynamic importで遅延ロード。

---

## 2. Chief of Staff agentパターン

### 公式パターンとCSM取締役の比較

| 要素 | 公式 | CSM取締役 | 差分 |
|------|------|-----------|------|
| 役割 | サブエージェント委任、タスク調整 | 部署エージェント管理、タスク振り分け | 同一思想。CSMが先に実装 |
| サブエージェント定義 | `.claude/agents/` | `.agent-rules/` | パス・フォーマットが異なる |
| 出力スタイル | `.claude/output-styles/` | 未実装 | 新規取り込み候補 |
| フック | PostToolUse で操作追跡 | Stop/PostToolUse 使用中 | 追加フック活用可 |
| カスタムコマンド | `.claude/commands/`（→スキル統合済み） | CSM:AUTOマーカー管理 | スキル形式への段階移行を検討 |

### 判断: **部分採用** — Phase 2

**即座に採用:**
- **出力スタイル定義** — `.claude/output-styles/` パターンを取締役ルールファイルに組み込み
- **取締役ルールファイルのベストプラクティス反映** — 公式CLAUDE.mdガイドラインに基づく整理

**段階的に採用:**
- `.agent-rules → .claude/agents/` への段階移行（Phase 2で両方式サポート後、将来的に公式パスに統一）

**見送り:**
- `.agent-rules` の即時完全廃止 — 既存ユーザーの移行コスト大。フォルダ構造移行中に二重移行は避ける

> **リスク:** `.agent-rules/` と `.claude/agents/` の二重パス問題。同名エージェント存在時の優先度が未定義。
> **対策:** `resolveRuleFilePath()` に `.claude/agents/` フォールバックを追加。優先度: `.agent-rules/` > `.claude/agents/`。名前衝突時は警告UI表示。

---

## 3. Hooks 24種の活用

### フック一覧とCSM活用度

| フック | 現在の利用 | 統合候補 | 優先度 |
|--------|-----------|----------|--------|
| `Stop` | todo-flush.js（実装済み） | — | — |
| `SessionEnd` | ECC session-end-marker | **TODO.md最終保存** — セッション本当の終了時に確実フラッシュ | Phase 1 |
| `SubagentStart` | 未使用 | **子エージェント自動追跡** — JSONL走査なしで即座に検出 | Phase 1 |
| `SubagentStop` | 未使用 | **子エージェントTODO引き継ぎ** — 子のTodoWriteを親TODO.mdにマージ | Phase 1 |
| `SessionStart(compact)` | ECC pre-compact | **TODO.md再注入** — コンパクション後に未完了タスクを再注入 | Phase 1 |
| `TaskCreated` | 未使用 | TaskTracker連携（JSONLポーリング不要化） | Phase 2 |
| `TaskCompleted` | 未使用 | タスク完了通知 | Phase 2 |
| `FileChanged` | 未使用 | TODO.md外部変更検知 | Phase 3 |
| `PreCompact` | ECC pre-compact | **TODO.md保存** — コンパクション前の緊急フラッシュ | Phase 1 |
| `ConfigChange` | 未使用 | session-manager.json変更の監査ログ | 低 |

### 判断: **採用** — Phase 1

**Phase 1 で追加するフック（4つ）:**
1. **SubagentStop** — `csm/subagent-todo-merge.js` 新設
2. **SubagentStart** — `csm/subagent-register.js` 新設
3. **SessionStart(compact)** — `csm/compact-reinject.js` 新設
4. **PreCompact** — 既存 `todo-flush.js` をPreCompactにも登録

> **リスク:** フック増加によるセッション遅延。
> **対策:** 全CSMフックは `async: true` + `timeout: 10` で実行。失敗時はstderrログのみでexit 0。

### 既存設計との整合性
- **todo-flush.js** — そのまま存続。SessionEndにも二重登録して最終保存を確実化
- **SubagentStop** — 設計書 §8 の仕様にそのまま対応
- **ECC hooksとの共存** — CSMフックは `~/.claude/scripts/csm/` に配置し、ECCの `~/.claude/scripts/hooks/` と分離

---

## 4. サブエージェントYAMLフロントマター形式

### 公式フォーマット

```yaml
---
name: code-reviewer
description: コード品質とベストプラクティスをレビューする
tools: Read, Glob, Grep
model: sonnet
effort: high
---

あなたはコードレビューアです。...
```

### CSM現行フォーマット

```
<!-- CSM:AUTO:START -->
あなたはCSM開発部所属のエンジニアです。
...
<!-- CSM:AUTO:END -->

（ユーザーカスタム記述）
```

### 判断: **部分採用** — Phase 2

**採用方針: ハイブリッドフォーマット**
- CSM:AUTOマーカーは**存続**（ユーザーカスタム記述の保護が最重要機能）
- ルールファイル先頭に**YAMLフロントマター互換メタデータ**を追加
- CSMがフロントマターを読み取り、AgentConfigとの同期を維持

**提案するハイブリッドフォーマット:**

```yaml
---
name: CSM開発部
description: Claude Session Managerの開発・改善を担当
tools: Read, Write, Edit, Bash, Grep, Glob
model: opus
effort: high
---
<!-- CSM:AUTO:START -->
あなたはCSM開発部所属のエンジニアです。
...
<!-- CSM:AUTO:END -->

## カスタム指示
（ユーザー自由記述）
```

**実装ステップ:**
1. `autoGenerateRuleFile()` でYAMLフロントマターを先頭に出力
2. `parseAgentFrontmatter()` 関数追加でメタデータ解析
3. エージェント設定変更時にフロントマターとCSM:AUTOを同時更新
4. フロントマターの `tools` と AgentConfig の `allowedTools` を双方向同期

> **リスク:** フロントマターとAgentConfigの不整合（どちらが真実か問題）。
> **対策:** AgentConfig（session-manager.json）を正とし、フロントマターは「表示用 + 公式ツール連携用」の派生データとする。

---

## 5. effortパラメータへの移行

### 公式推奨の変更

| 項目 | 旧 | 新（公式推奨） |
|------|------|----------------|
| 深度制御 | `budget_tokens` / `maxThinkingTokens` | `effort`（low/medium/high/max） |
| Extended Thinking | `thinking: {type: "enabled", budget_tokens: N}` | `thinking: {type: "adaptive"}` + `effort` |
| CLIフラグ | `MAX_THINKING_TOKENS` 環境変数 | `--effort` フラグ |

### CSMの現状
- `AgentConfig` に `effort` (4段階) + `thinkingEnabled` + `maxThinkingTokens` の3フィールドが存在
- `cliBuilder.ts` は `--effort` と `MAX_THINKING_TOKENS` の両方を出力
- フォームUIは effort 4段階 + thinking トグル + maxThinkingTokens 数値入力

### 判断: **採用** — Phase 1

**変更内容:**
1. `maxThinkingTokens` フォームフィールドに**「非推奨」ラベル**を追加
2. `thinkingEnabled` トグルをeffortと連動: effort設定時はthinkingを自動でadaptiveに
3. `cliBuilder.ts`: effort設定時は `MAX_THINKING_TOKENS` 環境変数を出力しない
4. 将来（Phase 3）で `thinkingEnabled` と `maxThinkingTokens` を AgentConfig から削除予定

> **リスク:** 既存ユーザーがmaxThinkingTokensを精密設定している場合の移行。
> **対策:** 非推奨化のみで削除はしない。effort未設定時は従来通り使用。CHANGELOGに移行ガイド記載。

---

## 6. スキルの段階的開示（L1→L2→L3）

### 判断: **見送り**

**理由:**
- CSMのメモリ管理は既に「MEMORY.md インデックス + 個別ファイル」で段階的開示を実現している
- L3（リンクファイル群）はスキルのような大規模参照資料向けであり、メモリ管理には過剰
- メモリファイルは典型的に200行未満で、段階的開示の恩恵が小さい
- CSM管理のスキル機能を実装する際に改めて検討

---

## 7. 実装ロードマップ

### Phase 1: v0.3.1 — フック活用 + effort移行

| 作業 | 影響ファイル |
|------|-------------|
| SubagentStop/Start フックスクリプト作成 | `~/.claude/scripts/csm/` (3ファイル新規) |
| SessionStart(compact) TODO再注入 | `settings.json` (4フック追加) |
| PreCompact に todo-flush 二重登録 | |
| effort UI非推奨表示 | `agentFormPanel.ts` |
| cliBuilder effort優先ロジック | `cliBuilder.ts` |

### Phase 2: v0.4.0 — 公式フォーマット統合

| 作業 | 影響ファイル |
|------|-------------|
| YAMLフロントマター出力 | `extension.ts`, `agentManager.ts` |
| .claude/agents/ フォールバック読み取り | `agentFormPanel.ts` |
| 出力スタイル定義サポート | `types.ts` |
| TaskCreated/TaskCompleted フック | |

### Phase 3: v0.5.0 — SDK API移行

| 作業 | 影響ファイル |
|------|-------------|
| sessionBackend.ts 抽象レイヤー | `sessionBackend.ts` (新規) |
| SdkSessionBackend 実装 | `sessionLoader.ts` |
| fork_session / tag_session SDK化 | `types.ts` |
| maxThinkingTokens / thinkingEnabled 非推奨完了 | |

---

## 8. 既存設計との整合性マトリクス

| 既存設計 | 統合知見 | 整合性 | 対応方針 |
|----------|----------|--------|----------|
| SubagentStopフック設計（§8） | Hooks #3 SubagentStop | **完全一致** | 設計書の仕様をそのまま実装。公式入力JSONスキーマに合わせる |
| TODO.md自動管理（todo-flush.js） | Hooks #3 SessionEnd/PreCompact | **補完関係** | 既存Stopに加え、SessionEnd/PreCompactにも同スクリプト登録 |
| フォルダ構造（.agent-rules/\<name\>/） | 公式 .claude/agents/ パス | **並行運用** | CSM管理は.agent-rules/を正、.claude/agents/はフォールバック |
| CSM:AUTOマーカー | YAMLフロントマター | **共存可能** | フロントマター → CSM:AUTO → ユーザーカスタム の3層構造 |
| effortフォームUI | effort公式推奨 | **完全一致** | 既存UI維持。maxThinkingTokensに非推奨ラベル追加のみ |
| TaskTracker（JSONL走査） | TaskCreated/Completed フック | **段階移行** | Phase 2でフックベースに移行。JSONL走査はフォールバック保持 |

---

## 9. リスクと対策

| # | リスク | 影響度 | 確率 | 対策 |
|---|--------|--------|------|------|
| R1 | Agent SDK TypeScript版のAPI変更・非互換 | 高 | 中 | 抽象レイヤーで切替可能に。JSONL直接をデフォルト維持 |
| R2 | フック増加によるセッション遅延 | 中 | 低 | 全CSMフック async:true + timeout:10。累積影響を計測 |
| R3 | .agent-rules と .claude/agents の二重管理混乱 | 高 | 中 | CSM管理を正とする明確な優先度ルール。名前衝突警告UI |
| R4 | YAMLフロントマターとAgentConfigの不整合 | 中 | 中 | AgentConfigをSingle Source of Truth。フロントマターは派生データ |
| R5 | maxThinkingTokens非推奨化でユーザー混乱 | 低 | 低 | 非推奨ラベルのみ。削除はPhase 3。CHANGELOGに移行ガイド |
| R6 | 公式フック仕様の変更 | 中 | 低 | 各フックスクリプトは独立。不要時はsettings.jsonから除外 |
