# CSM 競合調査レポート（2026-04-25）

調査対象: Claude Session Manager (CSM) v0.5.0 大型リニューアル設計参考
作成日: 2026-04-25
作成者: researcher（調査部）→ director / CSM 開発チーム
調査競合数: 23 製品（直接競合 8、間接競合 9、参考 6）

---

## 1. エグゼクティブサマリー

1. **CSMの最大脅威は Anthropic公式 Claude Code for VS Code（1,160万DL）と VS Code 1.109 公式 multi-agent unified session view**。両者ともセッション管理を IDE 内蔵化しており、CSM の中核機能と直接被る。**CSMは「公式が拾わない隙間（組織図・親子関係・日本語・プロジェクト紐づけ）」で勝負するしか道はない**。
2. **直接競合の Web/デスクトップツールが急増中** — `claude-code-history-viewer`(1.1k★, Tauri), `claude-code-agents-ui`(309★, Nuxt3), `agent-flow`(806★, スタンドアロン+VS Code), `claude-studio`(npm配布) などが組織図・関係グラフ・workflow編集を既に提供。**「VS Code 拡張で完結」「日本語特化」「組織図 × 親子関係 × プロジェクト紐づけ」がCSMの現実的な勝ち筋**。
3. **Roo Code が 2026-05-15 に shutdown** — 同サービスのユーザー（Architect/Code/Debug/Ask モード文化に慣れた層）が漂流する。CSM は「VS Code 拡張で動く、エージェント役割管理＋日本語フレンドリー」として受け皿になれる**好機**。
4. **ECC（everything-claude-code）は CSM の競合ではなく相互補完**。ECC は 48 agents/183 skills/79 commands を提供する「ハーネス層」、CSM は VS Code 内蔵の「管理 GUI 層」。両者を組み合わせると「ECC の機能群を CSM の GUI で管理する」エコシステムが描ける。
5. **日本語特化拡張は事実上不在**。Claude Code 本体は i18n 未対応（GitHub Issue #4866 提案中）、Marketplace に日本語特化の Claude 系拡張なし。**CSM の「日本語フレンドリー方針」は希少な差別化軸**として明確に成立する。

---

## 2. カテゴリ別 競合リスト

### A. Claude Code 周辺ツール（VS Code Marketplace / OpenVSX）

#### A-1. **Anthropic Claude Code for VS Code**（公式）★最重要競合★

| 項目 | 内容 |
|------|------|
| URL | https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code |
| 価格 | 無料（Pro/Max/Team/Enterprise の Claude サブスク前提）|
| インストール数 | **11,602,231（1,160万）** |
| 評価 | 4★（658件レビュー）|
| 主要機能 | (1) Claude Code CLI ネイティブ統合 (2) v2.1.69+ で Activity Bar セッションリスト (3) フルマークダウンプランビュー (4) ネイティブ MCP 管理ダイアログ (5) コンパクションカード (6) サブエージェント / カスタムスラッシュコマンド / MCP (7) ファイル選択 @-mention (8) 複数会話タブ / ウィンドウ |
| CSMと被る部分 | **セッション一覧・履歴閲覧・複数セッション切替** が完全に競合。プランビュー、MCP管理も被る。 |
| CSMにない強み | 公式統合の信頼性、リモートセッション対応、Claude公式UI/UX標準、最新仕様への即時追随 |
| CSMの優位性 | **エージェント組織図、親子関係、プロジェクト紐づけ、日本語、agents/*.md GUI 編集**は公式未対応。HISTORY/TODO 自動記録も独自。 |
| ターゲット層 | Claude Code 利用者全般 |
| 開発状況 | 超アクティブ（毎週リリース）|

#### A-2. **Cline**（旧 Claude-Dev）★主要競合★

| 項目 | 内容 |
|------|------|
| URL | https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev |
| 価格 | 無料・OSS / BYOK |
| インストール数 | **3,723,998（370万）** |
| 評価 | 4★（282件レビュー）/ 最新 v3.81.0 |
| 主要機能 | (1) 承認制エージェント (2) ファイル diff (3) ターミナル実行 (4) ブラウザ自動化 (5) MCP 拡張 (6) `@url`/`@file`/`@folder`/`@problems` (7) Checkpoints (8) マルチプロバイダ対応（OpenRouter/Anthropic/OpenAI/Gemini/Bedrock/Vertex/Cerebras/Groq/Ollama）|
| CSMと被る部分 | エージェント実行、checkpointセッション復元（履歴は弱め）|
| CSMにない強み | マルチプロバイダ、ブラウザ自動化、MCP拡張ライブラリの厚み |
| CSMの優位性 | Claude Code CLI ネイティブ統合、jsonl 履歴の深い分析、組織図、日本語 |
| ターゲット層 | OSS派 / マルチプロバイダ志向 / IDE内エージェント実行 |
| 開発状況 | 超アクティブ |

#### A-3. **Roo Code**（旧 Roo-Cline）★ 2026-05-15 終了 ★

| 項目 | 内容 |
|------|------|
| URL | https://github.com/RooCodeInc/Roo-Code |
| 価格 | 無料・OSS / BYOK |
| インストール数 | (推定) Cline比 30-40% 規模 |
| 主要機能 | (1) **モード制（Architect/Code/Debug/Ask/Orchestrator+Custom）** (2) カスタムモード YAML 共有 (3) Orchestrator が他モード調整して長時間タスク実行 (4) ファイル権限・ツールアクセス・専門指示をモード単位で構成 |
| CSMと被る部分 | **役割（モード）管理 + Orchestrator 親子委譲構造**が CSM のエージェント組織図と完全に被る |
| CSMにない強み | モード単位の細粒度ツール権限、YAML エクスポート/インポートで配布可能 |
| CSMの優位性 | VS Code 拡張で「組織図」を可視化、Claude Code CLI 連携、日本語、進捗(HISTORY/TODO)自動記録 |
| ターゲット層 | 役割ベース開発を好むエンタープライズ |
| 開発状況 | **2026-05-15 全製品（Extension/Cloud/Router）shutdown** |
| 戦略含意 | **Roo Code 難民を CSM が受け皿に** — Architect/Code/Debug/Ask 等のテンプレートを CSM のエージェント定義に標準提供すれば、移行先になり得る |

#### A-4. **claude-code-history-viewer (CCHV)**（直接競合）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/jhlee0409/claude-code-history-viewer |
| 価格 | 無料・OSS / MIT |
| Star数 | **1.1k** |
| 形態 | デスクトップアプリ（Tauri v2 + React + Rust）/ macOS / Windows / Linux / Webサーバー / Docker / systemd |
| 最終更新 | v1.11.0（2026-04-12）|
| 主要機能 | (1) **7アシスタント統合**（Claude Code/Gemini/Codex/Cline/Cursor/Aider/OpenCode）(2) グローバル検索 (3) Analyticsダッシュボード（トークン/コスト）(4) セッションボード (5) リアルタイムファイル監視 (6) **月別カレンダーヒートマップ** (7) セッション ID/ファイルパス/resumeコマンド copy (8) ネイティブ rename + bold 表示 (9) ANSI 色 (10) 5言語多言語対応 (11) アクセシビリティ充実（キーボード/スクリーンリーダ/フォントスケール/高コントラスト） |
| CSMと被る部分 | 履歴ビューア、検索、bookmark/rename、jsonl 解析がほぼ完全に被る |
| CSMにない強み | クロスアシスタント、ヒートマップUI、デスクトップアプリでの操作性、アクセシビリティの完成度 |
| CSMの優位性 | VS Code 内蔵で IDE フローを切らない、エージェント定義 GUI 編集、組織図、日本語特化、プロジェクト紐づけ |
| ターゲット層 | 複数AIツールを並行利用するパワーユーザー |
| 開発状況 | アクティブ |

#### A-5. **Claude Code and Codex Assist**（agsoft）

| 項目 | 内容 |
|------|------|
| URL | https://marketplace.visualstudio.com/items?itemName=agsoft.claude-history-viewer |
| 価格 | 無料 |
| インストール数 | 5,152 |
| 評価 | 3.5★ |
| 主要機能 | Claude/Codex 両対応、`~/.claude/projects/`+`~/.codex/sessions/` 解析、GitHub-style diff、SQLite 全文検索、Analytics、ファイルタイムライン |
| CSMと被る部分 | セッション履歴・差分・全文検索・ダッシュボード |
| CSMにない強み | Codex 統合、ファイルタイムライン |
| CSMの優位性 | エージェント管理、組織図、TODO/HISTORY 自動連携、日本語 |
| 開発状況 | 中規模アクティブ |

#### A-6. **Claude Code Dashboard**（jspw）

| 項目 | 内容 |
|------|------|
| URL | https://marketplace.visualstudio.com/items?itemName=jspw.claude-code-dashboard |
| 価格 | 無料 |
| インストール数 | 333 |
| 評価 | 5★（1件）|
| 主要機能 | 30日トークン使用量、コスト推定、月次予算上限、ヒートマップ、生産性Analytics、全文検索、リアルタイム監視（任意 hooks）、サブエージェント帰属コスト |
| CSMと被る部分 | ダッシュボード、検索、サブエージェントコスト追跡 |
| CSMにない強み | 月次コスト上限、productivity 指標 |
| CSMの優位性 | エージェント定義管理、組織図、jsonl 深い分析、日本語 |
| 開発状況 | 小規模アクティブ |

#### A-7. **Claudemeter** / **Claude Code Usage Tracker**（参考）

| 項目 | Claudemeter | Usage Tracker |
|------|-----------|--------------|
| インストール数 | 1,850 | 2,629 |
| 評価 | 5★（4件）| 5★ |
| ターゲット | リアルタイム使用量モニター | ステータスバー quota 表示 |
| CSMとの関係 | 補完関係（CSM が usage 表示を取り込むなら参考に）|

---

### B. AIエージェント管理ツール（汎用フレームワーク GUI）

#### B-1. **CrewAI / AutoGen / LangGraph**（汎用 SDK／VS Code とは弱結合）

| 項目 | 内容 |
|------|------|
| 価格 | OSS + 商用クラウド |
| 主要機能 | LangGraph: グラフベースワークフロー、time-travel デバッグ、状態管理 / CrewAI: ロール/バックストーリー/ゴール DSL / AutoGen (Microsoft Agent Framework): 会話型マルチエージェント |
| CSMと被る部分 | **マルチエージェント概念のみ**。具体的な VS Code GUI とは別レイヤー |
| CSMにない強み | 産業グレードの状態管理・分散実行・MCP統合 |
| CSMの優位性 | Claude Code に特化、VS Code 拡張、日本語、jsonl 履歴管理 |
| 戦略含意 | **CSM は「ローカル個人開発者」セグメント、CrewAI/LangGraph は「サーバーサイドプロダクション」セグメント** で住み分け |

#### B-2. **claude-studio**（直接競合の隙間製品）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/androidZzT/claude-studio |
| 形態 | npm（`npx claude-code-studio`）/ 1★（最新v1.2.8: 2026-04-15）|
| 主要機能 | **DAG ビジュアルワークフローエディタ**（dispatch/report/sync/roundtrip 4種類のエッジ）、9 ビルトインテンプレート、スキル管理、AI生成（`claude -p` 経由でワークフロー自動生成）、リアルタイム実行ステータス、checkpoint approval |
| CSMと被る部分 | **エージェント関係性のビジュアル表現**は被るが、CSM は組織図、claude-studio は DAG ワークフロー |
| CSMにない強み | DAG エディタ、AIワークフロー生成、4種類のエッジ概念 |
| CSMの優位性 | VS Code 内蔵、jsonl 履歴管理、TODO/HISTORY 連携、日本語 |
| 戦略含意 | **CSMが「DAGワークフローモード」を取り込めば claude-studio 上位互換に** |

#### B-3. **agent-flow**（直接競合：可視化）

| 項目 | 内容 |
|------|------|
| URL | https://github.com/patoles/agent-flow |
| Star数 | **806** |
| 形態 | スタンドアロン（`npx agent-flow-app`）+ **VS Code拡張** + ソースから |
| 主要機能 | **リアルタイムエージェント可視化**（実行中の think/branch/coordinate を node graph 表示）、tool call チェーンのデバッグ、パフォーマンスボトルネック識別 |
| CSMと被る部分 | エージェント関係グラフの可視化（read-only）|
| CSMにない強み | リアルタイム実行ストリーム表示、tool 呼び出しチェーンの可視化 |
| CSMの優位性 | エージェント定義の編集、組織図 + 親子管理、jsonl 履歴、日本語 |
| 戦略含意 | **CSM は「設計＋運用」、agent-flow は「実行可視化」** で組み合わせ可能。CSM が agent-flow 連携を提供すれば相補効果 |

#### B-4. **claude-code-agents-ui**（Ngxba）★最直接競合★

| 項目 | 内容 |
|------|------|
| URL | https://github.com/Ngxba/claude-code-agents-ui |
| Star数 | 309（forks 118）|
| 形態 | **Web アプリ（Nuxt 3）/ ローカル http://localhost:3000 / Bun または Node.js 18+** |
| 主要機能 | (1) **エージェント設定ファイル ビジュアルエディタ** (2) **エージェント・コマンド・スキルの関係グラフ可視化** (3) ワークフロービルダー (4) Agent Studio（live testing） (5) 統合ターミナル (6) **`~/.claude` 直読み/直書き** (7) GitHub からの skill インポート (8) DBレス |
| CSMと被る部分 | **3タブ的構成（エージェント/スキル/ワークフロー）、関係グラフ、`~/.claude` 直読みは CSM とコア部分が完全一致** |
| CSMにない強み | ワークフロービルダー、live testing、GitHub skill インポート、Web UI の自由度 |
| CSMの優位性 | **VS Code 内蔵で IDE フロー切れない**、jsonl 履歴管理、TODO/HISTORY、日本語、デスクトップアプリ予定（COMING SOON）でない安定形態 |
| ターゲット層 | Web UI で `~/.claude` を可視化したい開発者 |
| 開発状況 | アクティブ（130 commits）|
| 戦略含意 | **これは CSM の最も近い形態的競合**。VS Code拡張 vs Webアプリの選好は分かれるため共存可能だが、機能・UX で先行されないよう要注意 |

#### B-5. **その他オーケストレータ**

- `wshobson/agents` — Intelligent automation（GitHub）
- `ruvnet/ruflo` — エンタープライズ swarm
- `claude-code-by-agents` (baryhuang) — Desktop app + API、@mention で local/remote agent
- `barkain/claude-code-workflow-orchestration` — Claude Code プラグイン、自動タスク分解
- `catlog22/Claude-Code-Workflow` — JSON駆動マルチエージェント
- `stellarlinkco/myclaude` — Claude/Codex/Gemini/OpenCode 連携

→ **CSM はこれらと「VS Code 拡張で完結」「日本語フレンドリー」で差別化**。

---

### C. Cursor / Windsurf / Zed のエージェント機能

#### C-1. **Cursor**

| 項目 | 内容 |
|------|------|
| 価格 | $20/月 |
| 形態 | VS Code フォーク（独自IDE）|
| 主要機能 | Composer マルチファイル編集、@codebase インデックス、Agent モード（自律的計画→実行→自己修正）、background agents、predictive completion、parallel subagents |
| CSMと被る部分 | エージェント、サブエージェント並列、セッション履歴 |
| CSMにない強み | IDE 全体のAI最適化、コードベースインデックス、tab補完、background agents |
| CSMの優位性 | VS Code 純正環境、組織図、Claude Code CLI 連携、日本語特化、無料 |
| 戦略含意 | **Cursor を選ばない（or 補助的に使う）VS Code 派ユーザーが CSM のターゲット**。Cursor は IDE そのもの、CSM は VS Code 内拡張という棲み分け |

#### C-2. **Windsurf**（Codeium）

| 項目 | 内容 |
|------|------|
| 形態 | VS Code フォーク |
| 主要機能 | **Cascade**（横断推論型エージェント、コードベース全体に対する変更）、**Flows**（多段階エージェントステップを停止/再開/リプレイ可能）、ターミナル/Web 操作 |
| CSMと被る部分 | Flows のステップ管理（CSM の TODO/HISTORY と被る部分あり）|
| CSMにない強み | コードベース横断推論、リプレイ可能ワークフロー |
| CSMの優位性 | VS Code、組織図、Claude Code 連携、日本語 |

#### C-3. **Zed**

| 項目 | 内容 |
|------|------|
| 形態 | Rust 製独自 IDE（0.4s 起動、2ms 入力遅延）|
| 主要機能 | 高速性能、Claude Code を agentic コンパニオンとして統合 |
| CSMとの関係 | Zed は VS Code とは別ブランド。CSM の VS Code ユーザーとは別市場 |

---

### D. プロジェクト管理 × AI 系

#### D-1. **Asana / Notion / Linear の Claude/MCP 連携**

| 項目 | 内容 |
|------|------|
| 主要機能 | Asana・Notion 公式 MCP サーバー、Claude/Cursor/VS Code から API 経由でタスク作成/更新 |
| CSMとの被り | **薄い**。これらは外部 SaaS のタスク管理を Claude から触る統合。CSM はローカル `~/.claude/agents`+`session-manager.json` 管理 |
| CSMの優位性 | ローカル完結、jsonl 履歴、agents 定義 GUI、日本語 |
| 戦略含意 | **Linear/Notion MCP 連携を CSM に組み込めば「ローカル+SaaS」の橋渡し**役になれる |

#### D-2. **Cowork**

- Claude を一般作業（コード以外）に使う general-purpose AI agent。ファイル操作可。CSMとは別領域。

---

### E. ECC（everything-claude-code）との関係再整理

| 項目 | 内容 |
|------|------|
| URL | https://github.com/affaan-m/everything-claude-code |
| 規模 | **48 agents / 183 skills / 79 commands**、v1.10.0 で 140K+ stars |
| 形態 | Claude Code プラグイン + マニュアルインストール + **Python デスクトップ GUI**（`ecc_dashboard.py`）|
| クロスハーネス | Claude Code / Cursor / Codex CLI / OpenCode / Antigravity |
| Hook | Claude Code 8 / Cursor 15+ / OpenCode 11+ |
| Session 管理 | `/sessions` コマンドで履歴追跡、SQLite state store |
| MCP | 14 サーバー統合 |
| Security | AgentShield 102 ルールスキャン |
| 学習 | Instinct-based continuous learning（`/instinct-import`、`/evolve`）でセッションパターンをスキル化 |

**CSMとの関係（再定義）**:

| レイヤー | 担当 | 役割 |
|---------|------|------|
| ハーネス層 | **ECC** | 実行品質、スキル群、セキュリティスキャン、学習 |
| GUI/管理層 | **CSM** | VS Code 内可視化、エージェント定義 GUI、組織図、jsonl 履歴、TODO/HISTORY、日本語 UI |

→ **競合ではなく相互補完**。CSM が ECC をサポートする統合点（例: ECC スキル一覧をCSMから操作、ECC instinct セッションを CSM に表示）を作ると、両者のユーザーが両方を使う構造になる。

ECC dashboard は Python（Tkinter? ）で、VS Code 内で動かないため、**CSM が「VS Code 内で ECC を扱える唯一のGUI」になれば独自地位を築ける**。

---

## 3. 機能比較マトリクス

凡例: ◎=主力機能 / ○=対応 / △=部分対応 / ×=非対応

| 機能 | CSM 0.4 | CSM 0.5 構想 | Anthropic公式 | Cline | Roo Code | CCHV | claude-code-agents-ui | claude-studio | agent-flow | ECC | VS Code 1.109公式 |
|------|---------|------------|--------------|-------|---------|------|----------------------|---------------|-----------|-----|-----------------|
| **形態** | VSCode | VSCode | VSCode | VSCode | VSCode | Desktop | Web | npm | スタンドアロン+VSCode | プラグイン+Pyデスクトップ | VSCode |
| **セッション一覧** | ◎ | ◎ | ◎(2.1.69+) | △ | △ | ◎ | △ | × | × | ○ | ◎ |
| **jsonl履歴閲覧** | ◎ | ◎ | ◎ | △ | △ | ◎ | △ | × | × | △ | ◎ |
| **タグ/ブックマーク** | ○ | ◎ | △ | × | × | ○ | × | × | × | × | △ |
| **エージェント管理(.md GUI編集)** | ◎ | ◎ | × | × | △(YAML) | × | ◎ | ○ | × | △(プラグイン) | △ |
| **親子関係/組織図** | ○ | ◎ | × | × | ◎(Orchestrator) | × | ○(関係グラフ) | ○(DAG) | △(node graph) | △(自律クラスタ) | △ |
| **プロジェクト紐づけ** | △ | ◎ | △ | × | △ | △ | △ | × | × | × | △ |
| **HISTORY/TODO自動記録** | ◎ | ◎ | × | △(Checkpoint) | × | × | × | × | × | △(SQLite) | × |
| **SessionStart/Stop hook連携** | ◎ | ◎ | △ | × | △ | × | × | × | × | ◎ | △ |
| **リアルタイム実行可視化** | × | △ | △ | △ | △ | × | △ | △ | ◎ | × | △ |
| **DAGワークフロー編集** | × | △ | × | × | × | × | ○ | ◎ | × | × | × |
| **複数AIアシスタント統合** | × | × | × | ◎ | × | ◎(7種) | × | × | △ | ◎(5種) | ◎(Claude+Codex+Copilot) |
| **日本語UI** | ◎ | ◎ | × | × | × | △(5言語) | × | × | × | × | × |
| **コスト/usage追跡** | × | △ | △ | × | × | ◎ | × | × | × | × | △ |
| **MCP管理 GUI** | △ | ○ | ◎ | ◎ | △ | × | × | ○ | × | ○ | ◎ |
| **Skill 編集 GUI** | × | △ | × | × | × | × | ◎ | ○ | × | △(CLI) | × |
| **Workflow ビルダー** | × | △ | × | × | △(モード) | × | ◎ | ◎ | △ | × | △ |

---

## 4. CSM への提言（v0.5.0 設計に反映すべき項目）

### 提言1. **「組織図」を CSM の中核アイデンティティに格上げする**【最優先】

- 競合の関係グラフ（claude-code-agents-ui）、DAG（claude-studio）、node graph（agent-flow）はあくまで「実行関係 / ワークフロー」。
- **CSM の組織図は「親子（reporting line）」と「役割（role）」を持つ人事組織図メタファ**で、これは他に類例なし。
- **D3.js / Mermaid / vis-network のいずれかを採用**。Mermaid は VS Code 標準サポートで導入容易（推奨）。D3 はインタラクティブだが実装重め。**Mermaid + 上にクリッカブルレイヤを乗せる**ハイブリッドが現実解。
- 親子リアルタイム編集（drag&drop）が決め手になる。これは agents/*.md の `parent:` メタデータ更新と紐づけ。

### 提言2. **Roo Code 難民の受け皿になる「ロールテンプレート集」を標準同梱**

- Roo Code は 2026-05-15 終了。Architect / Code / Debug / Ask / Orchestrator のモード文化を継承。
- CSM 初回セットアップで「Roo Code 風テンプレート（Architect/Code/Debug/Ask/Orchestrator）」を 1クリックインストールできるようにする。
- agents/*.md として `~/.claude/agents/` に投入。
- `csm-redesign-spec.html` のテンプレート機能と統合。

### 提言3. **「3タブ構成」のまま、各タブを目的特化に深化させる**

セッション/エージェント/プロジェクトの3タブ構成は claude-code-agents-ui に近いが、**CSM は各タブの「VS Code Tree View 標準UI + Webview 詳細パネル」を磨くことで差別化**できる。

- **セッションタブ**: jsonl 履歴 + タグ + ブックマーク + 検索 + 「resume コマンド copy」(CCHV機能取り込み)
- **エージェントタブ**: 組織図 + agents/*.md GUI 編集 + ロールテンプレート + skill バインド + ECC 連携
- **プロジェクトタブ**: プロジェクト一覧 + そのプロジェクトに紐づく agents / 直近セッション / TODO / HISTORY / 統計

### 提言4. **「日本語フレンドリー方針」を製品 USP として明示する**

- Claude Code 本体は i18n 未対応（GitHub Issue #4866）、Marketplace に日本語特化拡張なし。
- **Marketplace のタイトル・説明・README を日本語＋英語の二重表記**に。
- スキル/agents 説明の自動日本語訳機能（前回のセッションで議論）を **v0.5.0 の差別化機能** として実装。
- 元 Anthropic 英文（コード/スキル本体）はそのまま、表示時のみ日本語訳をかぶせる方式。
- **「日本語コミュニティの第一選択肢」のポジションを取りに行く**（Qiita/Zenn 連携、日本語 README、Twitter 露出）。

### 提言5. **HISTORY/TODO 自動記録 = 「セッション運営ログ」** をブランドメッセージ化

- これは他競合のどこにもない CSM 固有機能。
- 単なるログでなく **「組織の運営記録」**として、誰がいつ何をしたかをエージェント単位で蓄積。
- Linear/Asana/Notion MCP 連携で「自動的に SaaS 側にも反映」できれば、**「ローカルで運営ログを取りつつ SaaS と同期」**という独自ポジション。

### 提言6. **agent-flow / claude-studio との連携 or 取り込み**（v0.5.x で要検討）

- agent-flow（リアルタイム可視化）と claude-studio（DAGエディタ）は CSM と相補的。
- v0.5.0 では取り込まず、**「CSMから agent-flow を起動」「CSMから claude-studio へエクスポート」** の連携ボタンを置くにとどめる（巨額の実装を避けつつ補完）。
- v0.6 以降で内蔵検討。

### 提言7. **Claude Code Dashboard の「コスト上限」「ヒートマップ」を取り込む**

- jspw.claude-code-dashboard 333 インストールに留まるが、機能は良質。
- CSM のセッションタブ詳細パネルに「月次コスト上限警告」「カレンダーヒートマップ」を追加するのは低コスト高効果。

### 提言8. **VS Code 1.109 の Agent Sessions view と「衝突せず棲み分け」を設計する**

- VS Code 1.109 公式 Agent Sessions view は **Copilot ベース**で Claude/Codex を統合する layer。
- CSM は **「Claude Code 専用、jsonl 直読み、エージェント定義 GUI、組織図、日本語」**で公式と棲み分け。
- 公式 view が拾えない領域（agents/*.md GUI 編集、組織図、HISTORY/TODO、日本語）に集中することが、長期的に CSM が生存する唯一の戦略。
- **「公式に飲み込まれにくい機能」**を意図的に厚く育てる。

### 提言9. **ECC との明示的協調をバンドル機能として用意**

- ECC 140K stars のユーザーベースは無視できない。
- CSM 内に **「ECC 連携モード」**を用意：
  - ECC のスキル一覧を CSM から閲覧/有効化
  - ECC instinct セッションを CSM の履歴に統合表示
  - ECC コマンド（/evolve, /instinct-import 等）を CSM のコマンドパレットから起動
- ECC 側は CLI/プラグイン、CSM 側は VS Code GUI、で**明確に守備範囲を分離**。

### 提言10. **「警戒すべき競合 TOP3」と CSM の防衛戦略**

| 順位 | 競合 | 脅威の種類 | CSMの防衛策 |
|------|------|----------|-----------|
| **1位** | **Anthropic 公式 Claude Code for VS Code**（1160万DL）| 中核機能を公式が無償提供。今後さらに機能拡張で CSM を飲み込む可能性 | 公式が拾わない隙間（組織図、agents/*.md GUI、日本語、TODO/HISTORY、プロジェクト紐づけ）に集中。**「公式の補助」のポジショニング**で生存 |
| **2位** | **claude-code-agents-ui (Ngxba)** | 形態的な最近接競合。3タブ構成・関係グラフ・~/.claude直読みが完全一致 | **VS Code 拡張で完結する**点と**日本語特化**で差別化。組織図（関係グラフ以上）と HISTORY/TODO で機能差をつける |
| **3位** | **VS Code 1.109 Agent Sessions view (公式)** | Microsoft 公式が unified agent session view を提供 | Copilot ベースの公式 view と Claude Code 専用の CSM で棲み分け。VS Code 1.109 が Claude を扱う際の補完拡張として位置取る |

---

## 5. CSM が学ぶべき UX/機能 トップ5

| # | 学習元 | 機能 | CSM での実装案 |
|---|-------|------|--------------|
| 1 | CCHV | **bookmark 名付けされたセッションは bold 表示、無名は italic** | 視認性向上のため即取り込み |
| 2 | Roo Code | **モード（役割）の YAML エクスポート/インポート** | エージェント定義を `.csm-bundle.yaml` にエクスポートして配布可能に |
| 3 | claude-code-agents-ui | **エージェント・スキル・コマンドの依存ギャップ可視化** | 組織図と並べて「未定義参照」を赤マークで提示 |
| 4 | Claude Code Dashboard | **月次コスト上限警告 + カレンダーヒートマップ** | セッションタブ詳細パネルに統合 |
| 5 | agent-flow | **リアルタイム tool call チェーン可視化** | v0.6 で連携起動ボタン → 将来内蔵 |

---

## 6. 出典 URL 一覧

### A. 公式・Marketplace
- Anthropic Claude Code for VS Code: https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code
- Cline: https://marketplace.visualstudio.com/items?itemName=saoudrizwan.claude-dev
- Claude Code and Codex Assist: https://marketplace.visualstudio.com/items?itemName=agsoft.claude-history-viewer
- Claude Code Dashboard: https://marketplace.visualstudio.com/items?itemName=jspw.claude-code-dashboard
- Claudemeter: https://marketplace.visualstudio.com/items?itemName=hypersec.claudemeter
- Claude Code Usage Tracker: https://marketplace.visualstudio.com/items?itemName=YahyaShareef.claude-code-usage-tracker
- Claude Code History (doorsofperception): https://marketplace.visualstudio.com/items?itemName=doorsofperception.claude-code-history

### B. GitHub プロジェクト
- everything-claude-code (ECC): https://github.com/affaan-m/everything-claude-code
- Roo Code: https://github.com/RooCodeInc/Roo-Code
- claude-code-history-viewer (CCHV): https://github.com/jhlee0409/claude-code-history-viewer
- claude-code-agents-ui (Ngxba): https://github.com/Ngxba/claude-code-agents-ui
- claude-studio (androidZzT): https://github.com/androidZzT/claude-studio
- agent-flow (patoles): https://github.com/patoles/agent-flow
- claude-code-by-agents (baryhuang): https://github.com/baryhuang/claude-code-by-agents
- ruflo (ruvnet): https://github.com/ruvnet/ruflo
- wshobson/agents: https://github.com/wshobson/agents
- claude-code-workflow-orchestration (barkain): https://github.com/barkain/claude-code-workflow-orchestration
- awesome-claude-code: https://github.com/jqueryscript/awesome-claude-code

### C. ドキュメント
- Claude Code VS Code: https://code.claude.com/docs/en/vs-code
- Claude Code Agent Teams: https://code.claude.com/docs/en/agent-teams
- VS Code Multi-Agent Development blog: https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development
- VS Code Third-party agents: https://code.visualstudio.com/docs/copilot/agents/third-party-agents
- VS Code Subagents: https://code.visualstudio.com/docs/copilot/agents/subagents
- Roo Code Custom Modes: https://docs.roocode.com/features/custom-modes
- Roo Code Modes: https://docs.roocode.com/basic-usage/using-modes
- ClaudeWorld 2.1.69 解説: https://claude-world.com/articles/claude-code-vscode-upgrade-2026/

### D. 比較・分析記事
- Cline vs Roo Code vs Cursor: https://betterstack.com/community/comparisons/cline-vs-roo-code-vs-cursor/
- The 13 Best Agentic IDEs 2026: https://www.datacamp.com/blog/best-agentic-ide
- Best AI Code Editor 2026: https://www.nxcode.io/resources/news/best-ai-code-editor-2026-cursor-windsurf-copilot-zed-compared
- LangGraph vs CrewAI vs AutoGen 2026: https://dev.to/pockit_tools/langgraph-vs-crewai-vs-autogen-the-complete-multi-agent-ai-orchestration-guide-for-2026-2d63
- ECC 82K star 解説: https://medium.com/@tentenco/everything-claude-code-inside-the-82k-star-agent-harness-thats-dividing-the-developer-community-4fe54feccbc1
- claude-studio 解説 (DEV): https://dev.to/zagentz/claude-studio-a-visual-orchestration-platform-for-claude-code-multi-agent-workflows-5g0p

### E. 日本語ソース
- Qiita ryu-ki Claude Code for VS Code: https://qiita.com/ryu-ki/items/49023459c67f0348e3ee
- CayTech Lab Claude Code VSCode: https://caymezon.com/claude-code-vscode-extension-guide/
- Uravation Claude Code VS Code 拡張: https://uravation.com/media/claude-code-vscode-extension-guide-2026/
- Claude Code 日本語UI 要望 Issue: https://github.com/anthropics/claude-code/issues/4866

### F. SaaS連携
- Asana Claude integration: https://asana.com/resources/claude-asana-integration
- Notion MCP: https://developers.notion.com/guides/mcp/mcp
- Asana MCP Server: https://developers.asana.com/docs/using-asanas-mcp-server

---

## 7. 要追加調査項目

- **OpenVSX 側のインストール数・代替Marketplaceでの存在感**（特に VSCodium/Cursor で配布する場合）
- **Cline / Roo Code の中の人がCSMをフォーク・取り込む可能性**（Roo Code 終了後のメンテナ吸収先）
- **claude-code-agents-ui の "COMING SOON" デスクトップアプリのリリース時期**（CSM のVS Code 拡張形態優位性が崩れるか）
- **Anthropic 公式が今後 agents/*.md GUI 編集や組織図を実装するか**（公式ロードマップ要追跡）
- **VS Code 1.109 Agent Sessions view が Claude Code CLI セッションをどこまで管理できるか**（実機検証推奨）
- **日本語コミュニティでの Claude Code 関連の OSS 活動**（Qiita/Zenn 内の隠れた競合）
- **Linear/Notion MCP × CSM の統合 PoC**（ローカル運営ログと SaaS の橋渡し検証）

---

以上。

<!-- CSM_SUMMARY
1行目: CSM v0.5.0 大型リニューアル設計参考のため、Claude Code 周辺ツール/AIエージェント管理/Cursor等IDE/プロジェクト管理×AI/ECC の5カテゴリ、計23製品を調査した競合レポートを作成。
2行目: 警戒すべきTOP3はAnthropic公式Claude Code for VS Code(1160万DL)、claude-code-agents-ui(309★Web app、形態最近接)、VS Code 1.109公式Agent Sessions view。CSMの差別化軸は「VS Code拡張で完結×組織図×親子関係×プロジェクト紐づけ×日本語特化×HISTORY/TODO自動記録」。
3行目: Roo Code 2026-05-15終了で難民受け皿の好機、ECCは競合でなくハーネス/GUI層で相補、CCHVのbold表示やRoo CodeのYAMLエクスポート等の取り込み価値あり、提言10項目を整理。
CSM_SUMMARY -->
