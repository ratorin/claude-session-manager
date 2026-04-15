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

出力形式: `{sessionId}|{permissionMode}`
（model/effortは `--agent` モードでフロントマターから自動適用されるため不要）

エラー時は `ERROR:` で始まるメッセージが stderr に出る。

### Step 2: 出力ファイル名の生成

タスク名は指示内容の先頭20文字をファイル名に使える形に変換（日本語OK、スペース→アンダースコア）。

```
~/.claude/agents/{agent-name}/tmp/agent_{agent-name}_{タスク名}.txt
```

### Step 3: コマンド実行

常に `--agent` を使用する。セッションIDがある場合は `--resume` を追加して既存セッションを継続する。
`--agent` により `agents/<name>.md` のフロントマター（model, effort等）が自動適用されるため、個別指定は不要。

**セッションIDがある場合（既存セッション継続）:**
```bash
claude --agent "{agent-name}" --resume "{sessionId}" \
  -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```

**セッションIDが空の場合（新規セッション起動）:**
```bash
claude --agent "{agent-name}" -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```

- `run_in_background: true` でバックグラウンド実行する
- 実行開始をユーザーに報告する（「{agent-name} に指示を送りました（mode: {permissionMode}）」）

**フォールバック:** 完了後に出力ファイルが空（0バイト）だった場合、`--resume` を外して再試行する:
```bash
claude --agent "{agent-name}" -p "{指示内容}" \
  --permission-mode "{permissionMode}" \
  > "{出力ファイル}" 2>&1
```

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
