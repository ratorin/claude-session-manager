# CSM × Anthropic公式リソース統合プラン

- バージョン: 1.0
- 作成日: 2026-04-05
- 対象: Claude Session Manager v0.3.0
- 参照: knowledge_anthropic_academy.md, academy_claude_code_in_action.md, academy_subagents.md, academy_agent_skills.md

---

## 0. 判断サマリー

| # | 知見 | 判断 | Phase | 理由 |
|---|------|------|-------|------|
| 1 | Agent SDK セッション管理API | **採用** | Phase 3 | SDK直接呼び出しをメインに。CLIは削除等の危険な操作のみ |
| 2 | Chief of Staff agentパターン | **部分採用** | Phase 2 | 取締役パターンは同一思想。出力スタイル・フック設計は即取り込み可 |
| 3 | Hooks 24種の活用 | **採用** | Phase 1 | SubagentStop・SessionEnd・SessionStart(compact)は即座に活用可能 |
| 4 | サブエージェントYAMLフロントマター | **採用** | Phase 2 | CSM:AUTOマーカーを廃止しdescriptionフィールドに統合。テスト済み |
| 5 | effortパラメータ | **対応済み** | — | CSMは初版からeffortに対応。追加作業なし |
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

### 判断: **採用** — Phase 3

**方針: SDK主、CLIは危険な操作のみ**

| 操作 | 方式 | 理由 |
|------|------|------|
| `list_sessions()` | SDK直接 | 一覧取得は頻度が高い。CLIのオーバーヘッド（settings.json/CLAUDE.md読み込み）を回避 |
| `fork_session()` | SDK直接 | セッション引継ぎは高頻度。トークン効率を優先 |
| `tag_session()` | SDK直接 | 軽量操作。SDK経由で十分 |
| `rename_session()` | SDK直接（同期） | CSMリネーム時にSDKも同時実行。customNameはCSM独自メタデータとして残す |
| `get_session_messages()` | SDK直接 | プレビュー等のメッセージ取得。JSONL直接読み取りの置換 |
| `delete_session()` | **CLI経由** | 危険な操作。ユーザー確認を挟むためCLI経由で実行 |

**トークン効率の根拠:**
- CLI起動は毎回 settings.json、CLAUDE.md、rules等を読み込む（12部署×複数回でちりつも）
- SDK直接なら必要なプロンプトだけ渡せる
- 切り替え機能は不要。SDKを一本化

### 実装戦略
1. **SDK直接呼び出しをメイン**: Agent SDK TypeScript版で全操作を実装
2. **CLI経由は削除操作のみ**: `delete_session()` はCLI経由でユーザー確認を挟む
3. **JSONL直接読み取りはフォールバック**: SDK未導入環境・SDK障害時の読み取り用に `sessionLoader.ts` を保持

### rename_session() 同期方式
CSMのリネームコマンド実行時、以下の2つを同時に行う:
1. `dataStore.setCustomName(sessionId, name)` — CSM独自メタデータに保存（既存動作）
2. `sdk.rename_session(sessionId, name)` — Claude Code側のタイトルを同期更新

**表示優先度:**
1. customName（CSM独自）が設定されていればそれを表示
2. Claude Codeのタイトル（`custom-title` > `ai-title`）
3. ユーザーの最初の発言

SDK呼び出しが失敗してもcustomName設定は成功扱いとする（SDK非依存の堅牢性を維持）。

> **リスク:** Agent SDK TypeScript版はPython版の6.1K starsに比べまだ安定度が不明。Breaking changeへの追随コスト。
> **対策:** SDK障害時はJSONL直接読み取り（sessionLoader.ts）にフォールバック。SDK import は dynamic import で遅延ロード。

---

## 2. Chief of Staff agentパターン

### 公式パターンとCSM取締役の比較

| 要素 | 公式 | CSM取締役 | 差分 |
|------|------|-----------|------|
| 役割 | サブエージェント委任、タスク調整 | 部署エージェント管理、タスク振り分け | 同一思想。CSMが先に実装 |
| サブエージェント定義 | `.claude/agents/` | `.agent-rules/` | 役割分担で共存（下記参照） |
| 出力スタイル | `.claude/output-styles/` | 未実装 | 新規取り込み候補 |
| フック | PostToolUse で操作追跡 | Stop/PostToolUse 使用中 | 追加フック活用可 |
| カスタムコマンド | `.claude/commands/`（→スキル統合済み） | YAMLフロントマターdescription管理 | 公式準拠済み |

### 判断: **部分採用** — Phase 2

**即座に採用:**
- **出力スタイル定義** — `.claude/output-styles/` パターンを取締役ルールファイルに組み込み
- **取締役ルールファイルのベストプラクティス反映** — 公式CLAUDE.mdガイドラインに基づく整理

**段階的に採用: ルールとデータの分離方針**

`.agent-rules/` と `.claude/agents/` を完全統一するのではなく、**役割で分離**する:

| 種別 | 保存先 | 形式 | 理由 |
|------|--------|------|------|
| **ルールファイル（行動規範）** | `.agent-rules/<部署名>/` | Markdown | `--append-system-prompt-file` で直接使える。人間も読める |
| **設定データ（組織・モデル）** | `.claude/agents/` | YAML/JSON | Agent SDKが読める公式形式。CSMなしでも機能する |

**ルールファイル（.agent-rules/に残す）:**
- 部署の行動規範（.md）
- HISTORY.md（セッション引継ぎ履歴）
- TODO.md（タスク管理）
- ユーザーカスタム記述

**設定データ（.claude/agents/に移行）:**
- 組織情報（name, role, department, parentId）
- セッションID（sessionId, previousSessionIds）
- モデル設定（model, effort, thinking等）
- ルールファイルへの参照パス

**見送り:**
- `.agent-rules` の完全廃止 — ルールファイルはmd形式でCLI/人間の両方から使えるメリットが大きい

> **理由:** CSMを使わない場面でもエージェント機能が活きるよう、設定データは公式SDKと互換性のある `.claude/agents/` に置く。一方、ルールファイルは `--append-system-prompt-file` で直接参照でき、人間が読み書きしやすいmdのまま `.agent-rules/` に維持する。
>
> **リスク:** ルールと設定が2箇所に分散し、参照パスの不整合が起きうる。
> **対策:** `.claude/agents/<name>.yml` に `ruleFile: .agent-rules/<name>/index.md` の参照を持たせ、CSMが整合性を検証。不整合時は警告UI表示。

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

### CSM旧フォーマット（v0.3.0まで）

```
<!-- CSM:AUTO:START -->
あなたはCSM開発部所属のエンジニアです。
...
<!-- CSM:AUTO:END -->

（ユーザーカスタム記述）
```

### 判断: **採用** — Phase 2

**方針: CSM:AUTOマーカー廃止 → YAMLフロントマターのdescriptionに統合**

テスト結果: YAMLフロントマターの `description` フィールドに自動生成テキストを入れ、本文をカスタム部分にする方式で、Claude Codeが両方正しく認識することを確認済み。

**新フォーマット:**

```yaml
---
name: CSM開発部
model: sonnet
effort: high
scope: project
description: |
  あなたはCSM開発部所属のエンジニアです。
  - 回答の冒頭に「【CSM開発部】」と付ける
  ...
---

## 歴代セッションの記録
### 2026-04-05 (旧ID: xxx)
...

## カスタムルール
手動追記部分
```

**設計ポイント:**

| 領域 | CSMの管理範囲 | ユーザーの管理範囲 |
|------|-------------|------------------|
| YAMLフロントマター | `description` を含む全フィールドを書き換え | 直接編集可（CSMが次回同期時に上書き） |
| 本文（`---` より下） | **一切触らない** | 自由に編集（歴代セッション、カスタムルール等） |

**CSM:AUTOマーカーからの移行:**
- `<!-- CSM:AUTO:START/END -->` マーカーを廃止
- 旧マーカー内のテキスト → `description` フィールドに移動
- 旧マーカー外のテキスト → 本文（`---` より下）にそのまま残る
- 既存ルールファイルは初回起動時に自動マイグレーション

**実装ステップ:**
1. `autoGenerateRuleFile()` をYAMLフロントマター出力に変更（`description` に行動規範を格納）
2. `parseAgentFrontmatter()` 関数追加でメタデータ解析
3. エージェント設定変更時はフロントマターのみ書き換え、本文は保持
4. 既存CSM:AUTOマーカー形式の自動マイグレーション処理

**メリット:**
- Anthropic公式のサブエージェント定義フォーマットに準拠
- CSM:AUTOという独自仕様が不要になる
- CSMなしでもCLIから `--append-system-prompt-file` で直接使える
- 本文の保護が「マーカー間の判定」から「フロントマター外は触らない」に簡素化

> **リスク:** フロントマターと `.claude/agents/` 設定ファイルの不整合（どちらが真実か問題）。
> **対策:** `.claude/agents/<name>.yml` を設定の正（Single Source of Truth）とし、ルールファイルのフロントマターは派生データとする。session-manager.json の agents 配列は `.claude/agents/` への移行完了後に廃止予定。

---

## 5. effortパラメータ

### 公式仕様

| 項目 | 公式推奨 |
|------|----------|
| 深度制御 | `effort`（low/medium/high/max） |
| Extended Thinking | `thinking: {type: "adaptive"}` + `effort` |
| CLIフラグ | `--effort` フラグ |

### 判断: **対応済み** — 追加作業なし

CSMは公開前のため、初版（v0.3.0）からeffortパラメータに対応済み:
- `AgentConfig` に `effort` フィールド（4段階: low/medium/high/max）
- `cliBuilder.ts` は `--effort` フラグを出力
- フォームUIにeffort選択を実装済み

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

### Phase 1: v0.3.1 — フック活用

| 作業 | 影響ファイル |
|------|-------------|
| SubagentStop/Start フックスクリプト作成 | `~/.claude/scripts/csm/` (3ファイル新規) |
| SessionStart(compact) TODO再注入 | `settings.json` (4フック追加) |
| PreCompact に todo-flush 二重登録 | |

### Phase 2: v0.4.0 — 公式フォーマット統合 + ルール/データ分離

| 作業 | 影響ファイル |
|------|-------------|
| `.claude/agents/<name>.yml` に設定データ移行 | `agentManager.ts`, `dataStore.ts` |
| session-manager.json agents → `.claude/agents/` マイグレーション | `extension.ts` |
| CSM:AUTO → YAMLフロントマターdescription移行 | `agentManager.ts`, `agentFormPanel.ts` |
| 既存ルールファイルの自動マイグレーション | `extension.ts` |
| 出力スタイル定義サポート | `types.ts` |
| TaskCreated/TaskCompleted フック | |
| ルール/設定の整合性検証ロジック | `agentManager.ts` |

### Phase 3: v0.5.0 — SDK直接呼び出し化

| 作業 | 影響ファイル |
|------|-------------|
| SDK直接呼び出し基盤（dynamic import + フォールバック） | `sdkClient.ts` (新規) |
| list_sessions / get_session_messages SDK化 | `sessionLoader.ts` |
| fork_session / tag_session SDK化 | `extension.ts` |
| rename_session 同期（CSMリネーム時にSDK同時実行） | `extension.ts`, `dataStore.ts` |
| delete_session CLI経由（ユーザー確認付き） | `extension.ts` |

---

## 8. 既存設計との整合性マトリクス

| 既存設計 | 統合知見 | 整合性 | 対応方針 |
|----------|----------|--------|----------|
| SubagentStopフック設計（§8） | Hooks #3 SubagentStop | **完全一致** | 設計書の仕様をそのまま実装。公式入力JSONスキーマに合わせる |
| TODO.md自動管理（todo-flush.js） | Hooks #3 SessionEnd/PreCompact | **補完関係** | 既存Stopに加え、SessionEnd/PreCompactにも同スクリプト登録 |
| フォルダ構造（.agent-rules/\<name\>/） | 公式 .claude/agents/ パス | **役割分離** | ルール(.md)は.agent-rules/、設定(.yml)は.claude/agents/。参照パスで連結 |
| CSM:AUTOマーカー（廃止） | YAMLフロントマターdescription | **統合完了** | CSM:AUTO廃止。descriptionに行動規範、本文にユーザーカスタムの2層構造 |
| effortフォームUI | effort公式推奨 | **対応済み** | 初版からeffort対応。追加作業なし |
| TaskTracker（JSONL走査） | TaskCreated/Completed フック | **段階移行** | Phase 2でフックベースに移行。JSONL走査はフォールバック保持 |
| リネーム（customName独自管理） | SDK rename_session() | **同期採用** | CSMリネーム時にSDKも同時実行。customNameは優先表示用に残す |

---

## 9. リスクと対策

| # | リスク | 影響度 | 確率 | 対策 |
|---|--------|--------|------|------|
| R1 | Agent SDK TypeScript版のAPI変更・非互換 | 高 | 中 | SDK障害時はJSONL直接読み取り（sessionLoader.ts）にフォールバック |
| R2 | フック増加によるセッション遅延 | 中 | 低 | 全CSMフック async:true + timeout:10。累積影響を計測 |
| R3 | ルール(.agent-rules)と設定(.claude/agents)の参照パス不整合 | 中 | 中 | .yml に ruleFile パスを持たせCSMが整合性検証。不整合時は警告UI |
| R4 | YAMLフロントマターdescriptionと.claude/agents/設定の不整合 | 中 | 中 | .claude/agents/をSingle Source of Truth。descriptionは派生データ。本文はCSM不干渉 |
| R5 | 公式フック仕様の変更 | 中 | 低 | 各フックスクリプトは独立。不要時はsettings.jsonから除外 |
