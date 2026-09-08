# CSM 設計前提: エージェント呼び出しアーキテクチャ

**起票日:** 2026-09-08
**起票者:** craft-master セッション（実障害から起票）
**対象:** CSM v0.6.x 以降の設計方針
**ステータス:** R1 / R2 / R3 / R4 / R5(最小案) 実装済み（CSM v0.6.0）。R5(本体) / R6 は下記参照
**検証・実装:** 2026-09-08（csm-dev セッション。§8 に実測に基づく訂正を追記）

---

## 1. なぜこの文書が必要か

CSM は「エージェントを定義し、セッションに紐付け、履歴を追える」ことを価値としている。
しかし **CSM の管理外でエージェントが実行される経路が存在し、ユーザーからは区別がつかない。**
2026-09-08 に実際にユーザーの不信を招く事故が発生したため、設計の大元として明文化する。

### 発生した事故（実話）

1. `craft-master` セッションが sv2026h の RDP 障害調査を **子エージェント `Craft_sv` に依頼**した
2. 調査・復旧は成功し、親セッションには完全な報告が届いた
3. **ユーザーが CSM UI で `Craft_sv` を開いたら、その会話が一切無かった**
4. ユーザー:「疑似的に子エージェント作ってやりとりしてるのではないか」

**指摘は正しかった。** 実行されていたのは CSM が管理する `Craft_sv` セッションではなく、
定義ファイルだけ読み込んだ**使い捨てインスタンス**だった。

---

## 2. 根本原因: 2 つの独立した実行経路

同じ「Craft_sv に依頼する」という行為に、**実体が全く異なる 2 経路**がある。

| | 経路 A: Agent ツール | 経路 B: csm-ask-agent |
|---|---|---|
| **起動方法** | `Agent(subagent_type: "Craft_sv")` | `claude --agent Craft_sv --resume <sessionId> -p "..."` |
| **プロセス** | 親セッション内のサブタスク | 別プロセスで CLI 起動 |
| **読み込む定義** | `.claude/agents/*.md`（**プロジェクト・ユーザー両方**） | `~/.claude/agents/*.md`（**ユーザーのみ**） |
| **会話の保存先** | `<親セッションのtmp>/tasks/<agentId>.output`（JSONL transcript） | `~/.claude/projects/<proj>/<sessionId>.jsonl` |
| **CSM から可視か** | ❌ **完全に不可視** | ✅ 可視 |
| **文脈の蓄積** | 毎回ゼロから（使い捨て） | セッションに永続蓄積 |
| **速度** | 速い・並列可 | 遅い（巨大セッションの再ロード） |
| **CSM の agentSessions との関係** | **無関係** | `sessionId` で直結 |

### 現在の紐付けデータ（`~/.claude/session-manager.json`）

```json
{
  "agentSessions": {
    "craft-master": { "sessionId": "663a04e6-5348-440e-84d7-26335151bac5", "sessionMode": "fixed" },
    "Craft_sv":     { "sessionId": "8a62c795-d163-4547-b6c0-6523e03878e6", "sessionMode": "fixed" }
  }
}
```

経路 A で実行しても、この `8a62c795…` には**一行も書き込まれない**。
CSM UI は `agentSessions` を正として表示するため、経路 A の実行は存在しないことになる。

---

## 3. 現状の実装ギャップ（4 件）

### G1. 経路 A の実行が CSM から完全に不可視 【重大度: 高】

親エージェントが Agent ツールを使うのは自然な選択（速い・並列できる）。
しかし CSM 側にはそれを検知する仕組みが無いため、

- ユーザーは「依頼したはずの作業」が履歴に無くて混乱する
- 組織図上のエージェントが「何もしていない」ように見える
- 実際にはサーバに変更が加えられている（今回は `systemctl restart gdm` を実行）ため、**監査上も危険**

### G2. 定義ファイルのスコープ不一致 【重大度: 中】

`csm-ask-agent.py` はユーザースコープのみを探索する:

```
ERROR: Agent file not found: C:\Users\taro/.claude/agents/Craft_sv.md
```

一方、実際の定義は `c:/GDrive/.claude/agents/Craft_sv.md`（プロジェクトスコープ）にあった。

- Agent ツールは両スコープを読むので**呼べてしまう**
- csm-ask-agent は読めずに**失敗する**
- 結果、「経路 B が使えないから経路 A にフォールバック」という**望ましくない誘導**が起きる

これが今回の事故の直接的な引き金だった。

### G3. `workDir` 未指定による resume 失敗 【重大度: 中】

`claude --resume <sessionId>` は **起動時の cwd がセッション作成時と一致していないと失敗**する
（`No conversation found with session ID`）。

- `Craft_sv` の定義には `workDir` が無かった
- セッション実体は `~/.claude/projects/**c--GDrive**/8a62c795….jsonl`
- 正しい cwd は `c:\GDrive`
- 親の `craft-master` は `c:\GDrive\craftwork` なので、**親の workDir を継承すると失敗する**

**この情報は `sessionId` が属するプロジェクトディレクトリ名から機械的に導出できる**
（`c--GDrive` → `c:\GDrive`）のに、現状は人間が手で書く前提になっている。

### G4. セッション肥大化で経路 B が実用的でなくなる 【重大度: 中】

`Craft_sv` のセッション実体は **88 MB**（2026-09-08 時点）。
`--resume` するたびに全ロードするため起動が重く、
「軽い調査を投げたいだけ」の用途では経路 A を選ばざるを得ない。

**つまり G4 が G1 を誘発している。** 肥大化対策なしに「経路 B に統一しろ」は成立しない。

---

## 4. 設計要件

### 必須要件

#### R1. 定義ファイル探索をスコープ統合する

`csm-ask-agent.py`（および CSM 拡張本体）の探索順を Agent ツールと揃える:

```
1. <projectDir>/.claude/agents/<name>.md   ← プロジェクトスコープ（優先）
2. ~/.claude/agents/<name>.md              ← ユーザースコープ
```

- 両方にある場合はプロジェクト優先（Claude Code 本体の慣習に合わせる）
- 見つかった側のパスをログに出す（どちらを読んだか判別できるように）

**現状の暫定回避策**（2026-09-08 実施）: ユーザースコープに手動コピー。
これは同期漏れのリスクがあるので、R1 実装後は撤去したい。

#### R2. `workDir` を自動導出する

`agentSessions[<name>].sessionId` から、そのセッションが属するプロジェクトディレクトリを逆引きし、
`workDir` が未指定なら自動補完する。

```
~/.claude/projects/c--GDrive/8a62c795-….jsonl
                   ^^^^^^^^^
                   → "c:\GDrive"
```

- ディレクトリ名の変換規則: `c--GDrive` → `c:\GDrive`、`c--xampp-Project-foo` → `c:\xampp\Project\foo`
- 定義に明示的な `workDir` があればそちらを優先
- 導出できなかった場合は**起動せずにエラー**（黙って失敗して `--resume` が新規セッションを作るのが最悪ケース）

#### R3. 経路 A の実行を CSM から可視化する

Agent ツール経由の実行は `<セッションのtmpディレクトリ>/tasks/<agentId>.output` に
JSONL の transcript が残る。これを CSM が拾えるようにする。

- **最小案**: 親セッションの transcript を走査し、`Agent` ツール呼び出し（`subagent_type` 付き）を抽出。
  組織図・エージェント詳細に「Agent ツール経由の実行 N 件」として集計表示
- **理想案**: `tasks/*.output` を読んで、使い捨て実行の会話も CSM UI で閲覧可能にする
  （「一時実行」タブなど、永続セッションとは区別して表示）

**重要なのは「見えないまま実行された」状態を無くすこと。** 完全な会話表示は必須ではない。

### 望ましい要件

#### R4. UI で 2 経路を明示的に区別する

エージェント詳細画面・組織図に、その実行が

- 🔵 **永続セッション**（csm-ask-agent 経由、履歴が積まれる）
- ⚪ **一時実行**（Agent ツール経由、使い捨て）

のどちらかをバッジ表示する。ユーザーが「なぜ履歴が無いのか」を自力で理解できる状態にする。

#### R5. セッション肥大化への対処（G4 対策）

経路 B を実用的に保つため、以下のいずれか:

- **アーカイブ分割**: 一定サイズ/日数を超えたら旧部分を別ファイルに退避し、
  `agentSessions` は新しい方を指す。CSM UI では連結して閲覧
- **サマリ引き継ぎ**: 肥大化したセッションを要約して新セッションに引き継ぎ、`sessionId` を更新
- 少なくとも **CSM UI にセッションサイズを表示**し、肥大化を可視化する（実装コスト最小）

#### R6. 呼び出し経路の推奨をドキュメント化

CSM 側で運用ルールを提示する。今回ユーザーが選んだ運用:

| ケース | 推奨経路 |
|---|---|
| 軽い調査・状態確認・並列実行したいとき | 経路 A（Agent ツール）※使い捨てと明示すること |
| 継続案件・設定変更・記録を残すべき作業 | 経路 B（csm-ask-agent） |

---

## 5. 実装時の参考情報

### 関連ファイル

| パス | 役割 |
|---|---|
| `~/.claude/session-manager.json` | `agentSessions` にエージェント名 → sessionId のマッピング |
| `~/.claude/scripts/csm-ask-agent.py` | 経路 B の起動スクリプト。**R1/R2 の修正対象** |
| `~/.claude/agents/<name>.md` | ユーザースコープの定義 |
| `<projectDir>/.claude/agents/<name>.md` | プロジェクトスコープの定義 |
| `~/.claude/projects/<proj>/<sessionId>.jsonl` | 永続セッション実体 |
| `<tmp>/claude/<proj>/<parentSessionId>/tasks/<agentId>.output` | 経路 A の transcript |

### csm-ask-agent.py の現在の出力仕様

```
$ python ~/.claude/scripts/csm-ask-agent.py Craft_sv
8a62c795-d163-4547-b6c0-6523e03878e6|acceptEdits|c:/GDrive
                                      ^^^^^^^^^^^ ^^^^^^^^
                                      permissionMode  workDir
```

R2 実装後は `workDir` が空でも sessionId から導出して返すこと。

### 定義ファイルの frontmatter 実例（修正後の Craft_sv）

```yaml
---
name: "Craft_sv"
displayName: "クラフトサーバー管理部"
model: claude-opus-4-6
memory: project
permissionMode: acceptEdits
historyEnabled: true
todoEnabled: true
parentAgent: "craft-master"
workDir: "c:\\GDrive"        # ← R2 で自動導出したい項目
effort: high
showInOrgChart: true
---
```

---

## 6. 検証項目（実装後の受け入れ基準）

- [x] プロジェクトスコープにしか定義が無いエージェントを `csm-ask-agent` で呼べる（R1）— テスト A1/A2/A4、実環境で `Craft_sv` を確認
- [x] `workDir` 未指定の定義でも `--resume` が正しい cwd で成功する（R2）— テスト B1/B2/B3
- [x] `workDir` が導出できない場合、新規セッションを作らずエラー終了する（R2）— テスト B4/B5
- [x] Agent ツール経由で子エージェントを実行したあと、CSM UI に痕跡が残る（R3）— テスト S1〜S8
- [x] 永続セッションと一時実行が UI 上で区別できる（R4）— `EphemeralRunItem` / `⚪N` バッジ
- [x] セッションサイズが UI に表示される（R5 最小案）— `AgentItem` tooltip「セッション容量」

---

## 7. 補足: 今回の暫定対応（2026-09-08 実施済み）

R1〜R2 の恒久対応前に、手動で以下を実施した。**実装後は不要になる。**

1. `~/.claude/agents/Craft_sv.md` を新規作成（プロジェクト版のコピー）
2. `workDir: "c:\\GDrive"` を frontmatter に追記
3. 担当サーバー一覧（sv2026h / sv2026k / heimdall の IP・SSH コマンド）を本文に追記

動作確認:

```
$ python ~/.claude/scripts/csm-ask-agent.py Craft_sv
8a62c795-d163-4547-b6c0-6523e03878e6|acceptEdits|c:/GDrive   ← 解決成功
```

---

## 8. 実装時の検証結果と訂正（2026-09-08 追記）

§1〜§7 の起票内容を実コード・実データに突き合わせた結果。**指摘の骨子はすべて裏付けが取れた**が、
2 点の訂正と 1 点の「書かれているより悪い」事実があった。

### 8.1 G1 の裏付け（実測）

`craft-master` セッション `663a04e6…`（50,504 行）を解析:

| 項目 | 実測値 |
|---|---|
| Agent ツール呼び出し | **17 件**（`qa`×4, `researcher`×3, `general-purpose`×3, `code-reviewer`×2, … **`Craft_sv`×1**） |
| 親 JSONL 内の `isSidechain` 行 | **0 件**（＝会話は親セッションに残らない） |
| 該当実行 | `2026-09-08T00:20:07.631Z` / `Craft_sv` / 「sv2026h RDP 接続不可の調査」 |
| 一時トランスクリプト | `…/Temp/claude/c--GDrive/663a04e6…/tasks/aaa1491813555354b.output`（231 行 / 748 KB） |

その `.output` は整形された JSONL で、`agentId` / `isSidechain:true` / 親 `sessionId` / `cwd` / `slug` を持ち、
さらに **`attributionAgent: "Craft_sv"` が 29 行に含まれていた**。エージェント名が直接取れるため、
親セッションとの突き合わせをしなくても所属を判定できる。

### 8.2 訂正 1 — R2 は「未実装」ではなく「実装済みで壊れていた」

`csm-ask-agent.py` には既にスラグ逆引きがあった。しかし実データで機能しない:

```python
if proj.startswith("c--"):                            # 小文字のみ
    resume_cwd = "c:/" + proj[3:].replace("-", "/")   # 非可逆
```

`~/.claude/projects/` の実ディレクトリ 22 件で確認:

| 実ディレクトリ名 | 旧コードの結果 | 正しい cwd |
|---|---|---|
| `C--xampp-Project-claude-session-manager` | **空**（大文字 `C--` で判定漏れ） | `c:\xampp\Project\claude-session-manager` |
| `C--GDrive-obsidian` / `C--tmp` | **空** | 〃 |
| `c--xampp-htdocs-yosuga-xs` | `c:/xampp/htdocs/yosuga/xs` ❌ | `c:\xampp\htdocs\yosuga-xs` |
| `c--gdrive-at-atc-web-deploy` | `c:/gdrive/at/atc/web/deploy` ❌ | — |

**つまり R2 が警告する「黙って失敗 → `--resume` が新規セッションを作る」最悪ケースは、
起票時点で既に発生していた。**

さらに、スラグ逆引きというアプローチ自体が不要だった。セッション JSONL に正解が入っている:

```json
{"…", "cwd": "c:\GDrive", "sessionId": "8a62c795-…", "version": "2.1.141"}
```

→ **実装は「スラグの解読」ではなく「JSONL の `cwd` を読む」に変更した**（可逆・確実）。

#### R2 の仕様変更: workDir よりセッション cwd を優先する

§4 の R2 は「定義に明示的な `workDir` があればそちらを優先」としていたが、**これは誤り**。
`claude --resume` は cwd から算出したプロジェクトキーでセッションを探すため、
cwd が完全一致しないと必ず失敗する。`workDir` を優先すると起票された事故そのものが再発する。

実際、`Craft_sv` 以外にも同じ潜在バグを抱えていたエージェントが見つかった:

| エージェント | frontmatter `workDir` | セッション実体の cwd | 旧実装での結果 |
|---|---|---|---|
| `craft-master` | `c:\GDrive\craftwork` | `c:\GDrive` | resume 失敗 |
| `csm-impl` | `c:/xampp/Project/claude-session-manager` | `c:\xampp` | resume 失敗 |

→ **sessionId がある場合はセッション cwd を採用**し、`workDir` と食い違うときは `INFO:` で通知する。

### 8.3 訂正 2 — CSM 拡張本体は既にマルチスコープ対応済み

§4 R1 は「`csm-ask-agent.py`（および CSM 拡張本体）」としているが、
`src/agents/agentFileManager.ts` は既に
global + ワークスペース各フォルダ + `claudeManager.additionalAgentDirs` + エージェントの `workDir` を走査し、
プロジェクト優先でマージしている。**R1 はスクリプト単独の問題**だった。

### 8.4 追加発見 — テンプレートがユーザーへ届かない構造だった

`~/.claude/scripts/csm-ask-agent.py` が**リポジトリの `templates/` より数世代古かった**。
原因は `installCsmAskAgent` が「既存ファイルはスキップ」する実装だったこと:

```ts
try { await fs.promises.access(t.dest); continue; } catch { /* インストール */ }
```

一度インストールすると以後の修正が永久に届かない。R1/R2 を直しても配布されないため、
**テンプレートにバージョンマーカー（`CSM-TEMPLATE-VERSION`）を入れ、更新経路を追加した**
（`claudeManager.updateCsmAskAgentTemplates` / 起動時チェック。旧ファイルは `.trash` へ退避）。

### 8.5 追加発見 — 呼び出し経路のルールが三者で矛盾していた

| 場所 | 記述 |
|---|---|
| `~/.claude/commands/csm-ask-agent.md` | 「Agent ツールは**使わない**。必ず CLI 起動する」 |
| `c:/xampp/CLAUDE.md` | 「Agent ツールは**使い捨て調査のみ許可**」 |
| 本文書 §4 R6 | 「軽い調査は経路 A 推奨」 |

事故の遠因。R6 の線（使い捨て調査は許可、ただし明示する）に統一した。

### 8.6 R3 の主従を入れ替えた

§4 R3 は「最小案 = 親セッション走査」「理想案 = `tasks/*.output` を読む」としていたが、
`tasks/*.output` は **OS の一時領域にあり短命**（実測: 446 ファイル中、エージェントの
トランスクリプトとして残っていたのは 1 件のみ。17 回の実行に対し 1 件）。

→ **恒久的な記録である親セッション JSONL を主**、`tasks/*.output` を従（残っていれば全文表示）とした。

性能面: 親セッション JSONL は最大 **527 MB**（`c--xampp/ad8b8a3d…`）。以下の 2 段構えで実用に載せた。

1. 行バッファ上で `"subagent_type"` の**バイト列**を検索してから初めて UTF-8 デコード + `JSON.parse`
2. 読み取り位置（byte offset）を記録し、追記分だけを読む**増分スキャン**（JSONL は追記専用）

実測: 287 MB の全走査で 0.5 秒。以降の増分スキャンはほぼゼロコスト。

### 8.7 実装物

| 要件 | 実装 |
|---|---|
| R1 | `templates/csm-ask-agent.py` — `candidate_agent_roots()` / `resolve_agent_file()`。cwd の祖先 → セッション cwd の祖先 → ユーザースコープ。`CSM_AGENT_DIRS` で追加可。`--where` で探索順を副作用なしに確認できる |
| R2 | 同上 — `session_cwd_from_jsonl()` / `resolve_resume_cwd()`。導出不能時は `ERROR:` + 終了コード 1 |
| R3 | `src/services/agentToolRunService.ts` — 増分スキャン + `findEphemeralTranscript()` |
| R4 | `src/providers/agentTreeProvider.ts` — `EphemeralRunItem`（⚪ 一時実行）、`AgentItem` の description に `⚪N` バッジ、tooltip に注記 |
| R5(最小案) | `AgentItem` tooltip に「セッション容量」を表示（`formatBytes`） |
| R6 | `templates/csm-ask-agent.command.md` / `c:/xampp/CLAUDE.md` を統一 |
| 8.4 | `claudeManager.updateCsmAskAgentTemplates` + 起動時チェック |

テスト: `test/unit/ask-agent-resolve.test.js`（12 件・実際に python を隔離 HOME で起動）、
`test/unit/agent-tool-run.test.js`（10 件）。合計 153 件パス。

### 8.8 未実装

- **R5 本体**（アーカイブ分割 / サマリ引き継ぎ）— 設計が重いので別途。現状は容量表示のみ
- **R3 理想案の常時保持** — `tasks/*.output` が消える前に CSM 側へ退避する仕組みは未実装。
  一時トランスクリプトが残っていれば開けるが、消えていれば呼び出し元セッションを開く導線のみ
- **§7 の暫定回避策の撤去** — `~/.claude/agents/Craft_sv.md`（ユーザースコープへの手動コピー）は
  R1 実装により不要になったが、プロジェクト版との内容差（担当サーバー一覧の追記）があるため
  自動削除はしていない。差分を確認したうえでユーザーが撤去する
