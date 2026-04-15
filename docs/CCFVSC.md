# Claude Code for VS Code — 変更履歴調査（2026年3月下旬〜4月）

> 調査日: 2026-04-15
> 対象: v2.1.84（3/26）〜 v2.1.108（4/14）

## セッション管理

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.108 | 4/14 | `/recap` コマンド追加（セッション復帰時にコンテキスト提供） |
| 2.1.108 | 4/14 | `/resume` で `/rename` 設定名・色が失われるバグ修正 |
| 2.1.108 | 4/14 | トランスクリプト書き込み失敗（ディスク満杯等）が無視されていた問題修正 |
| 2.1.108 | 4/14 | `--resume` でトランスクリプトが自己参照メッセージ時に切り詰められる問題修正 |
| 2.1.108 | 4/14 | `ENABLE_PROMPT_CACHING_1H` env varで1時間TTL設定可能 |
| 2.1.101 | 4/10 | `claude -p --resume <name>` — タイトル名でセッション再開可能 |
| 2.1.101 | 4/10 | 大規模セッションで `--resume`/`--continue` のコンテキスト喪失修正 |
| 2.1.101 | 4/10 | `--resume` のチェーンリカバリがサブエージェント会話に誤接続する問題修正 |
| 2.1.94 | 4/7 | `--resume` のプロンプトキャッシュミス修正（v2.1.69以降） |
| 2.1.91 | 4/2 | `--resume` で async transcript書き込み失敗時のチェーンブレーク修正 |
| 2.1.91 | 4/2 | `SessionStart` hooksがプロセス再起動で2回発火する問題修正 |
| 2.1.86 | 3/27 | `--resume` が v2.1.85前セッションで tool_use idsエラー修正 |
| 2.1.86 | 3/27 | `X-Claude-Code-Session-Id` ヘッダー追加（proxy集約用） |

## Hooks

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.108 | 4/14 | `/undo` エイリアス（`/rewind`の別名） |
| 2.1.105 | 4/13 | **PreCompact hook** — コンパクション前にブロック可能（exit code 2 or `{"decision":"block"}`） |
| 2.1.101 | 4/10 | hookイベント名の誤りでsettings.json全体が無視されない（レジリエンス向上） |
| 2.1.98 | 4/9 | PreToolUse hookの`permissionDecision`がmanaged-settings denyを無視する問題修正 |
| 2.1.98 | 4/9 | 管理設定のallowルール削除後も有効のままだった問題修正 |
| 2.1.97 | 4/8 | `StopFailure` hook評価失敗修正 |
| 2.1.94 | 4/7 | Plugin skill hooksがYAML frontmatterで無視される問題修正 |
| 2.1.94 | 4/7 | `CLAUDE_PLUGIN_ROOT` 未設定時にhooksが"No such file or directory"エラー |
| 2.1.90 | 4/1 | **PermissionDenied hook** — auto mode分類器拒否後に発火、`{retry:true}`でリトライ |
| 2.1.90 | 4/1 | `PreToolUse` hookがJSON emitしてexit code 2でブロックできない問題修正 |
| 2.1.90 | 4/1 | `SessionEnd` hooksが1.5s後に強制終了される問題修正 |
| 2.1.89 | 4/1 | **`"defer"` permission決定** — headlessセッションでtool call一時停止 |
| 2.1.89 | 4/1 | Conditional hooks `if` fieldの修正（heredoc/newline/env-var prefix対応） |
| 2.1.85 | 3/26 | **Conditional hooks `if` field** — permission rule構文でフィルタリング |
| 2.1.84 | 3/26 | **TaskCreated hook** / **WorktreeCreate hook** 追加 |

## エージェント・サブエージェント

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.108 | 4/14 | スラッシュコマンド自動検出（`/init`, `/review`等がSkill toolで実行可能） |
| 2.1.105 | 4/13 | プラグインの**バックグラウンドmonitor**サポート（`monitors` manifestキー） |
| 2.1.105 | 4/13 | **`/proactive` エイリアス**（`/loop`の別名） |
| 2.1.101 | 4/10 | `/team-onboarding` コマンド追加 |
| 2.1.101 | 4/10 | バックグラウンドサブエージェントがエラー終了時に部分的な進捗を報告しない問題修正 |
| 2.1.98 | 4/9 | サブエージェント（ワークツリー隔離）のcwdリーク修正 |
| 2.1.98 | 4/9 | コンパクション時にサブエージェントトランスクリプトが重複保存修正 |
| 2.1.98 | 4/9 | **Monitor tool** — バックグラウンドスクリプトのストリーミングイベント |
| 2.1.97 | 4/8 | `/agents` に `● N running` インジケータ表示 |
| 2.1.94 | 4/7 | **plugin skill**: `"skills": ["./"]`でfrontmatter `name`をinvocation nameとして使用可能 |
| 2.1.92 | 4/4 | tmuxウィンドウ削除後にsubagent生成が永続的に失敗する問題修正 |
| 2.1.89 | 4/1 | **Named subagents** — `@` mention typeaheadに表示 |
| 2.1.89 | 4/1 | Background agentをkillしても部分結果保持 |
| 2.1.89 | 4/1 | `MCP_CONNECTION_NONBLOCKING=true` — `-p`モードでMCP接続待ちスキップ |
| 2.1.84 | 3/26 | Background bash processes（subagents）のexit時クリーンアップ失敗修正 |

## セキュリティ

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.98 | 4/9 | Bash tool権限バイパス（バックスラッシュエスケープフラグ）修正 |
| 2.1.98 | 4/9 | 複合Bashコマンドが強制permissionプロンプトバイパス修正 |
| 2.1.98 | 4/9 | **Linuxプロセスサンドボックス** — PID namespace隔離 |
| 2.1.97 | 4/8 | `--dangerously-skip-permissions`が保護パスへの書き込み承認後ダウングレード修正 |
| 2.1.92 | 4/4 | `sandbox.failIfUnavailable`でサンドボックス未可用時のExit |
| 2.1.84 | 3/26 | **PowerShell tool** 追加（Windows opt-in preview） |

## VS Code 拡張固有

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.108 | 4/14 | `/resume` ピッカーが現在ディレクトリのセッション優先表示 |
| 2.1.105 | 4/13 | EnterWorktree toolに`path`パラメータ（既存ワークツリー切り替え） |
| 2.1.98 | 4/9 | ファイル添付がエディタタブ閉じ時クリアされるバグ修正 |
| 2.1.98 | 4/9 | **LSPクライアント情報** — 言語サーバーに`clientInfo`で自身を識別 |
| 2.1.97 | 4/8 | **フォーカスビュー切り替え**（Ctrl+O）— NO_FLICKERモード |
| 2.1.97 | 4/8 | `refreshInterval`ステータスライン設定追加 |
| 2.1.94 | 4/7 | デフォルトeffortレベル: API key等でmedium → highに変更 |
| 2.1.89 | 4/1 | **`CLAUDE_CODE_NO_FLICKER=1`** — ちらつき無しalt-screenレンダリング |
| 2.1.84 | 3/26 | Windows git-bash必須エラー誤検出修正 |

## パフォーマンス

| Ver | 日付 | 変更 |
|-----|------|------|
| 2.1.108 | 4/14 | プロンプトキャッシングTTL制御（1時間/5分） |
| 2.1.105 | 4/13 | stalled API stream — 5分無応答で自動abort・リトライ |
| 2.1.101 | 4/10 | OS CA証明書ストアデフォルト信頼（TLSプロキシ対応） |
| 2.1.98 | 4/9 | MCP HTTP/SSE接続の~50MB/hrバッファリーク修正 |
| 2.1.91 | 4/2 | MCP tool result永続化（最大500Kサイズ対応） |

---

## CSMへの示唆・活用候補

### 高優先
- **`/recap`** — CSMのセッション引き継ぎ機能と重複/補完。CSMのtestament機能との統合検討
- **`--resume <name>`** — タイトル名でセッション再開可能。CSMのsessionId紐づけを簡略化できる可能性
- **PreCompact hook** — コンパクション前にCSM_SUMMARYを自動生成できる

### 中優先
- **Named subagents / `@` mention** — CSMのエージェント管理と連携検討
- **Monitor tool** — agentWatcherのPIDベース検出の代替候補
- **PermissionDenied hook** — `/csm-ask-agent`の安全ガードに活用
- **plugin skill** — CSMスキルをプラグイン形式で配布できる可能性

### 低優先
- **`/team-onboarding`** — CSMの組織図機能と補完関係
- **Conditional hooks `if`** — hookの条件付き発火で精度向上
- **TaskCreated hook** — CSMのタスクトラッカーと連携

---

Sources:
- [Claude Code Changelog（公式）](https://code.claude.com/docs/en/changelog)
- [GitHub CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Releasebot - Claude Code](https://releasebot.io/updates/anthropic/claude-code)
- [April 2026まとめ](https://help.apiyi.com/en/claude-code-changelog-2026-april-updates-en.html)
