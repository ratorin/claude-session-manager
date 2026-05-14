# CSM × Governance Integration 提案書

## 背景

### 現状の課題
- CSMのセッションサマリーは「何を話したか」が中心
- 「何を変更したか」「何が検知されたか」の具体的アクションログがない
- セッション引継ぎ時に「前回何をしたか」の粒度が粗い

### 使える資産
ECC（Everything Claude Code）プラグインに `governance-capture.js` というフックが同梱されている。
現在は未使用（環境変数 `ECC_GOVERNANCE_CAPTURE=1` が未設定のため空回り状態）。

---

## governance-capture.js の機能

### 検知するイベント（5種類）

| イベント | トリガー | 例 |
|---------|---------|-----|
| `secret_detected` | コード内にハードコード秘密鍵を検知 | AWS Key, JWT, GitHub Token, 秘密鍵ファイル |
| `policy_violation` | ポリシー違反操作 | .env, credentials, .pem 等の機密ファイル操作 |
| `security_finding` | セキュリティ関連ツール実行 | Bashコマンド実行（任意コマンド実行のため） |
| `approval_requested` | 承認が必要な危険操作 | `git push --force`, `rm -rf`, `DROP TABLE`, `DELETE FROM` |
| `hook_input_truncated` | フック入力サイズ超過（1MB超） | 大量データ処理時 |

### 対象パターン（検知ルール）

**秘密鍵パターン:**
- AWS Key: `AKIA/ASIA + 16文字`
- Generic: `secret/password/token/api_key = "値"`
- Private Key: `-----BEGIN PRIVATE KEY-----`
- JWT: `eyJ...` 形式
- GitHub Token: `ghp_/gho_/ghu_/ghs_/ghr_ + 36文字以上`

**承認必要コマンド:**
- `git push --force`
- `git reset --hard`
- `rm -rf`
- `DROP TABLE/DATABASE`
- `DELETE FROM table;`

**機密ファイルパス:**
- `.env`, `.env.local`, `.env.*`
- `credentials`, `secrets.*`
- `.pem`, `.key`, `id_rsa`

### 現在の出力形式

```json
{
  "id": "gov-1713081234567-a1b2c3d4",
  "sessionId": "session-uuid",
  "eventType": "secret_detected",
  "payload": {
    "toolName": "Edit",
    "hookPhase": "pre",
    "secretTypes": ["aws_key"],
    "location": "input"
  }
}
```

出力先: `process.stderr` にJSON文字列（現状DBには保存されていない）

---

## 提案: CSMへの統合

### Phase 1: 有効化と記録開始（すぐできる）

**作業内容:**
1. `~/.claude/settings.json` の `env` に `ECC_GOVERNANCE_CAPTURE=1` を追加
2. stderrの出力をログファイルに保存するよう設定

**メリット:** 改修不要で記録が始まる
**デメリット:** stderrのテキストログなので構造化されていない

```jsonc
// ~/.claude/settings.json
{
  "env": {
    "ECC_GOVERNANCE_CAPTURE": "1",
    "ECC_SESSION_ID": "" // CSMのセッションIDを渡せば紐付く
  }
}
```

### Phase 2: CSM SQLiteへの直接記録（軽い改修）

**作業内容:**
- `governance-capture.js` の `emitGovernanceEvent()` を改修
- stderr出力に加えて、CSMのSQLiteに `governance_events` テーブルを作成しINSERT

**テーブル設計案:**
```sql
CREATE TABLE governance_events (
  id TEXT PRIMARY KEY,           -- gov-timestamp-random
  session_id TEXT,               -- CSMセッションID
  event_type TEXT NOT NULL,      -- secret_detected, policy_violation, etc.
  tool_name TEXT,                -- Bash, Edit, Write
  hook_phase TEXT,               -- pre / post
  payload TEXT,                  -- JSON詳細
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX idx_gov_session ON governance_events(session_id);
CREATE INDEX idx_gov_type ON governance_events(event_type);
```

### Phase 3: セッションサマリーへの統合（CSM改修）

**作業内容:**
- CSMのセッションサマリー生成時に `governance_events` を参照
- セッションサマリーに「Actions Log」セクションを追加

**出力イメージ:**
```markdown
# Session: 2026-04-14
## Summary
darosの設定ファイルを修正...

## Actions Log
| 時刻 | 種別 | 内容 |
|------|------|------|
| 14:30 | security_finding | Bash: mysql接続コマンド実行 |
| 14:35 | secret_detected | Edit: config.py にDB接続文字列 |
| 14:40 | approval_requested | Bash: git push --force (denied) |

## Files Modified
- daros/config.py
- ...
```

---

## ファイル構成

```
~/.claude/
├── settings.json                          # env.ECC_GOVERNANCE_CAPTURE=1 を設定
├── scripts/hooks/governance-capture.js    # ECC同梱（改修対象）
└── scripts/csm/
    ├── session-summary.js                 # 既存: サマリー生成（Phase 3で改修）
    └── subagent-signal.js                 # 既存: サブエージェント追跡
```

### フック定義（settings.json 内、現在有効）

governance-captureは Pre と Post の2箇所で発火:
- `PreToolUse` matcher=`Bash|Write|Edit|MultiEdit`
- `PostToolUse` matcher=`Bash|Write|Edit|MultiEdit`

---

## 工数見積り

| Phase | 内容 | 規模 |
|-------|------|------|
| 1 | 環境変数設定のみ | 5分 |
| 2 | SQLite保存の改修 | governance-capture.js に20-30行追加 |
| 3 | サマリー統合 | session-summary.js の改修 |

---

## リスク・注意点

- governance-capture.js はECCプラグイン同梱のため、ECC更新で上書きされる可能性あり
  - 対策: 改修版を別ファイル（`governance-capture-csm.js`）として保存し、settings.jsonのフック定義を差し替える
- 全Bash/Edit/Writeで同期的に走るため、処理が重いとレスポンスに影響
  - 対策: SQLite書き込みは非同期化 or バッファリング
- セッションIDの受け渡し方法を決める必要がある
  - 案: `ECC_SESSION_ID` 環境変数をCSMのSessionStartフックで設定
