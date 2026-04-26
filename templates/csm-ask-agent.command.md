# エージェントに指示を送って結果を受け取る

`$ARGUMENTS` を解析して、指定エージェントに指示を送信し、完了を待って結果を返す。

## 引数の解析

`$ARGUMENTS` は以下の形式:
```
<agent-name> "指示内容"
```

例:
- `csm-impl "extension.tsの行数を教えて"`
- `al-dev "ヘッダーの幅を200pxに"`
- `researcher "Claude Codeの最新仕様を調査して"`

agent-name が省略された場合、ユーザーに聞く。

## 実行手順

### Step 1: エージェント設定の取得

以下のコマンドで一発取得（クォート問題なし）:

```bash
python ~/.claude/scripts/csm-ask-agent.py {agent-name}
```

出力形式: `{sessionId}|{permissionMode}|{workDir}`
（model/effortは `--agent` モードでフロントマターから自動適用されるため不要）

`workDir` が空でない場合、必ずそのディレクトリにcdしてから claude を起動する（`--resume` は
セッション作成時のcwdと同じでないと「No conversation found」エラーになる）。

エラー時は `ERROR:` で始まるメッセージが stderr に出る。

### Step 2: 出力ファイル名の生成

タスク名は指示内容の先頭20文字をファイル名に使える形に変換（日本語OK、スペース→アンダースコア）。

```
~/.claude/agents/{agent-name}/tmp/agent_{agent-name}_{タスク名}.txt
```

### Step 3: コマンド実行

常に `--agent` を使用する。セッションIDがある場合は `--resume <sessionId>` を追加して既存セッションを継続する。
`--agent` により `agents/<name>.md` のフロントマター（model, effort等）が自動適用されるため、個別指定は不要。

**セッションIDがある場合（既存セッション継続・推奨）:**
```bash
cd "{workDir}" && claude --agent "{agent-name}" --resume "{sessionId}" \
  -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```
（workDirが空の場合は `cd` を省略。ただし`--resume`はcwd依存のため、可能な限りworkDir設定を推奨）

**セッションIDが空の場合 — 名前ベース resume を試みる（Claude Code v2.1.101+）:**

Claude Code v2.1.101 以降は `--resume <agent-name>` でエージェント名からセッションを検索できる。
CSM からセッションIDを取得できない場合（Step 1 が ERROR の場合など）はこちらを試す。

```bash
cd "{workDir}" && claude --agent "{agent-name}" --resume "{agent-name}" \
  -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```

**セッションIDも名前ベース再開も失敗する場合（新規セッション起動）:**
```bash
cd "{workDir}" && claude --agent "{agent-name}" -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```
（workDirが空の場合は `cd` を省略）

- `run_in_background: true` でバックグラウンド実行する
- 実行開始をユーザーに報告する（「{agent-name} に指示を送りました（mode: {permissionMode}）」）

**エラー判定とリカバリー:**

完了後に出力ファイルを確認し、以下のパターンで分岐する：

| 状況 | 対応 |
|---|---|
| 出力に `No conversation found with session ID` を含む | **自動で新規起動しない**。workDirのcdが抜けている可能性が高い。workDirを再取得してcdしてから`--resume`で再試行。それでも同じエラーなら**ユーザーに「紐づけセッションが見つかりません。新規で起動し直しますか？」と確認**。 |
| 出力に `No conversation found` を含む（名前ベース時） | 名前が一致するセッションなし。新規起動前に必ずユーザーに確認する。 |
| 出力ファイルが完全に空（0バイト） | まず workDir で cd してリトライ。それでも空ならユーザーに確認。 |
| 正常な出力（結果テキストあり） | そのまま完了報告に進む。 |

**禁止:** `--resume` を勝手に外して新規セッションを起動しない。CSM の紐づけと実セッションが分離する原因になる。必ずユーザーの明示的な承認を取る。

### Step 4: 完了・結果報告

バックグラウンドタスクが完了したら出力ファイルを読んで結果を報告する。

**報告フォーマット:**
```
【{agent-name} 完了報告】
{出力ファイルの内容（末尾2000文字以内に要約）}
```

## 繰り返し指示（ループ）

結果を見て追加指示が必要な場合は、同じエージェントに再度 `/ask-agent` を使う。
`--resume` で同じセッションに会話が蓄積されるため、子エージェント側に文脈が残る。

## permission-mode 一覧

| モード | 用途 | -p との相性 |
|--------|------|-------------|
| `acceptEdits` | 編集系を自動許可（推奨デフォルト） | ✅ |
| `auto` | ほぼ全自動 | ✅ |
| `plan` | 計画のみ、実行は承認後 | ❌ 実行されない |
| `default` | 毎回確認 | ❌ 止まる |
| `bypassPermissions` | 全自動（危険） | ✅ |

`-p` モードで使う場合は `acceptEdits` か `auto` を推奨。

## 禁止事項

- `claude -p` 単体（--agent も --resume もなし）は禁止
- `--continue` は禁止（別エージェントのセッションが割り込む）
- Agent ツール（subagent_type）は使わない。必ずCLI起動する
