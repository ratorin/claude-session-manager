# 引き継ぎ: 「Claude で開く」が別フォルダの空ウィンドウを開く不具合（v0.6.3）

- 作成日: 2026-10-01
- 対象: Claude Session Manager（CSM）開発担当
- リポジトリ: `C:\xampp\Project\claude-session-manager`（ブランチ master、基点コミット `106eaaf` = v0.6.2）
- 状態: **修正はソースに入っているが未コミット。vsix 未作成。実機のボタン操作での確認は未実施。**

## 1. 要点

会話ビューワーの「▶ Claude で開く」を押すと、無関係なフォルダで新しいウィンドウが開き、会話が復元されないことがある。セッションの途中で `cd` していると起きる。

原因は、開き先フォルダの判定に「会話の末尾に記録された cwd」を使っていたこと。Claude Code がセッションを探すのは起動時の cwd に対応する `projects/<slug>` なので、移動先のフォルダで開いても見つからない。

開き先を常に起動時の cwd（JSONL で最初に cwd を持つ行）で決めるように直した。ユニットテストは 170 件すべて通過している。

開発担当にお願いしたいのは次の 3 点。

1. 差分の確認とコミット
2. vsix の作成と、VS Code / Cursor へのインストール
3. 実機での動作確認（手順は 7 章）

## 2. 発生した事象

2026-10-01 12:06、VS Code（ワークスペース `C:\GDrive`）の会話ビューワーで「▶ Claude で開く」を押した。

- 対象セッション: `4c640deb-0f79-4a54-9646-f315105f8f7b`
- JSONL の場所: `C:\Users\taro\.claude\projects\c--GDrive\4c640deb-0f79-4a54-9646-f315105f8f7b.jsonl`（現存、4.5MB）
- 期待: 現在のウィンドウでセッションが開く
- 実際: `c:\tmp\xampp\xampp\Project\claude-session-manager` で新しいウィンドウが開き、空の新規会話になった

Claude Code 拡張のログに記録が残っている。

`C:\Users\taro\AppData\Roaming\Code\logs\20261001T085907\window4\exthost\Anthropic.claude-code\Claude VSCode.log`

```
12:06:37.140 update_panel_host_session {"kind":"restore_declined","sessionId":"4c640deb-..."}
12:06:37.182 launch_claude cwd: c:\tmp\xampp\xampp\Project\claude-session-manager
12:06:37.201 Spawning Claude ... resume: undefined
```

Claude Code 拡張側の URI ハンドラ（`/open?session=`）は 2.1.285 と 2.1.286 で同一であり、拡張側の変更が原因ではない。

## 3. 原因

対象セッションは `c:\GDrive` で起動し、途中で `cd` している。JSONL 内の cwd の内訳は次のとおり。

| cwd | 行数 | 初出行 |
|---|---|---|
| `c:\GDrive` / `C:\GDrive` | 838 | 3 |
| `C:\tmp\claude-session-manager` | 25 | 182 |
| `C:\tmp\xampp\xampp\Project\claude-session-manager` | 410 | 209 |

判定の流れは次のとおりだった。

1. `C:\xampp\Project\claude-session-manager\src\panels\webviewPanel.ts` 158 行目が `loadSessionTail(filePath, initialMessages)` を呼ぶ。`claudeManager.preview.initialMessages` の既定は 200。
2. `loadSessionTail` は末尾の行を先に解析し、そこで最初に見つけた cwd を `ParsedSession.cwd` にしていた。先頭を読むのは cwd が取れなかったときだけだった。
3. 同ファイル 248 行目が、その cwd を `openSessionInClaudeSmart({ sessionCwd })` に渡す。
4. `C:\xampp\Project\claude-session-manager\src\commands\openInClaudeHelper.ts` は `opts.sessionCwd ?? await resolveSessionCwd(sid)` で、渡された値を優先していた。
5. そのフォルダが現ワークスペース外なので `vscode.openFolder(forceNewWindow)` が走る。開いた先のウィンドウには該当 `projects/<slug>` が無く、復元が拒否される。

修正前のビルドに実セッションを読ませて再現を確認した。

| `initialMessages` | 返る cwd |
|---|---|
| 30 / 50 / 100 | `C:\GDrive` |
| 200（既定） | `C:\tmp\xampp\xampp\Project\claude-session-manager` |

同じ `currentFullSession.cwd` は「ターミナルで再開」（`webviewPanel.ts` 294 行目）でも使われている。こちらは `claude --resume` を誤ったフォルダで起動するため、"No conversation found" になる。

会話一覧の右クリック「Claude で開く」（`C:\xampp\Project\claude-session-manager\src\commands\sessionCommands.ts` 265 行目）は、軽量ローダーの先頭 cwd を渡しているので影響を受けない。

### 影響範囲

調査時点の実データ（`C:\Users\taro\.claude\projects`）では、末尾側の cwd が保存先フォルダと異なるセッションが 160 件中 25 件あった。このうち移動先が現ワークスペースの外にあるものが実際に失敗する。移動先がワークスペースの配下なら、包含判定が双方向なので新ウィンドウは開かない。

## 4. 修正内容

### 4.1 起動時 cwd を読む関数を追加

`C:\xampp\Project\claude-session-manager\src\utils\sessionLoader.ts`

- `readLaunchCwd(filePath)`（961 行目、export）: JSONL を 64KB 単位で読み、行単位で「最初に cwd を持つ行」を探す。上限は 1MB。ファイルが無い、または上限内に cwd 行が無いときは `undefined`。
- `cwdOfJsonlLine(line)`（941 行目）: 1 行から cwd を取り出す補助関数。

固定バイト数の読み取りにしなかった理由は、先頭に cwd を持たない巨大な行があるセッションが実在するため。実データ 343 件のうち、cwd 行が先頭 16KB に収まらないものが 6 件、64KB に収まらないものが 4 件あり、最大は 193.8KB だった。マルチバイト文字がチャンク境界で割れないよう、バイト列のまま改行で区切っている。

### 4.2 `loadSessionTail` は起動時 cwd を優先

同ファイル 1124 行目。

```ts
cwd = (await readLaunchCwd(filePath)) || cwd;
```

他のメタデータ（model、sessionId など）を先頭 64KB で補う既存処理は変えていない。

### 4.3 ヘルパーは JSONL を優先

`C:\xampp\Project\claude-session-manager\src\commands\openInClaudeHelper.ts`

```ts
// 修正前
const sessionCwd = opts.sessionCwd ?? await resolveSessionCwd(sid);
// 修正後（75 行目）
const sessionCwd = (await resolveSessionCwd(sid)) ?? opts.sessionCwd;
```

`resolveSessionCwd`（131 行目）は先頭 16KB の固定読みをやめ、`readLaunchCwd` に委譲した。渡された `sessionCwd` は、JSONL が見つからないときのフォールバックとしてだけ使う。

Orchestration 経路（`C:\xampp\Project\claude-session-manager\src\extension.ts` 790 行目・807 行目）は稼働中プロセスの cwd を渡している。これも `cd` 後の値になり得るので、JSONL があれば起動時 cwd に切り替わる。JSONL が無い場合の挙動は従来どおり。

### 4.4 変更ファイル一覧

| ファイル | 内容 |
|---|---|
| `C:\xampp\Project\claude-session-manager\src\utils\sessionLoader.ts` | `readLaunchCwd` 追加、`loadSessionTail` の cwd 決定を変更 |
| `C:\xampp\Project\claude-session-manager\src\commands\openInClaudeHelper.ts` | cwd の優先順位を変更、`resolveSessionCwd` を委譲に変更 |
| `C:\xampp\Project\claude-session-manager\src\panels\webviewPanel.ts` | コメントのみ |
| `C:\xampp\Project\claude-session-manager\src\commands\sessionCommands.ts` | コメントのみ |
| `C:\xampp\Project\claude-session-manager\test\unit\open-in-claude-cwd.test.js` | 新規（6 件） |
| `C:\xampp\Project\claude-session-manager\test\unit\agent-hooks-qa.test.js` | W1 の文字列照合を新しい優先順位に更新 |
| `C:\xampp\Project\claude-session-manager\package.json` | 0.6.2 → 0.6.3 |
| `C:\xampp\Project\claude-session-manager\CHANGELOG.md` | v0.6.3 の項を追加 |
| `C:\xampp\Project\claude-session-manager\README.md` | 直近の変更に v0.6.3 を追加 |

`C:\xampp\Project\claude-session-manager\package-lock.json` の version は以前から 0.5.23 のままで、今回は触っていない。

## 5. テストと検証

### ユニットテスト

`C:\xampp\Project\claude-session-manager` で `npm test` を実行し、170 件すべて通過（既存 164 件 + 新規 6 件）。

新規 6 件の内容。

- `loadSessionTail` は末尾に別の cwd があっても起動時の cwd を返す
- 移動先 cwd を渡されても、JSONL の起動時 cwd で判定して新ウィンドウを開かない
- 先頭に cwd を持たない約 240KB の行があっても起動時 cwd を取り出せる
- `readLaunchCwd` はファイルが無い・cwd 行が無いとき `undefined`
- `readLaunchCwd` は末尾に改行の無い 1 行だけのファイルからも取り出せる
- JSONL が無いときは渡された `sessionCwd` にフォールバックする（従来動作）

修正前のコードで 1 件目と 2 件目が失敗することを確認してから修正した。

既存テスト W1 は「`opts.sessionCwd` を優先する」というソース文字列を照合していた。これは今回の不具合そのものを固定していたので、新しい優先順位に書き換えた。

### 実データでの検証

`vscode` をモックし、`C:\Users\taro\.claude\projects` の全セッションに対して開き先判定を回した。読み取りのみで、ウィンドウ操作や URI 送信は起きない。各セッションの起動時フォルダをワークスペースとし、わざと誤った `sessionCwd` を渡している。

| ビルド | 対象 | 誤フォルダで新ウィンドウを開く件数 |
|---|---|---|
| 修正後（リポジトリ `out`） | 343 件（うち cwd 行なし 60 件） | 0 |
| 修正前（0.5.37 原本） | 同上 | 283（cwd を持つ全件） |

### コードレビュー

code-reviewer エージェントによるレビューで CRITICAL / HIGH の指摘はなし。MEDIUM の「先頭 16KB の固定読みでは取りこぼす」は 4.1 で対応済み。残りは 8 章に記載。

## 6. 現在の配置状況

| 場所 | 版 | 状態 |
|---|---|---|
| `C:\xampp\Project\claude-session-manager` | 0.6.3 | 修正済み、未コミット、vsix 未作成 |
| `C:\Users\taro\.vscode\extensions\ratorin.claude-session-manager-0.5.37` | 0.5.37 | 同内容を `out` に直接適用済み（下記） |
| `C:\Users\taro\.cursor\extensions\ratorin.claude-session-manager-0.6.2` | 0.6.2 | 未修正 |

VS Code に入っているのは 0.5.37 で、ソースより古い。版を飛ばさずに復旧させるため、コンパイル済み JS の 2 ファイルを直接書き換えた。原本は同じフォルダに残してある。

- `C:\Users\taro\.vscode\extensions\ratorin.claude-session-manager-0.5.37\out\commands\openInClaudeHelper.js`（原本: `openInClaudeHelper.js.orig-0.5.37`）
- `C:\Users\taro\.vscode\extensions\ratorin.claude-session-manager-0.5.37\out\utils\sessionLoader.js`（原本: `sessionLoader.js.orig-0.5.37`）

反映には VS Code のウィンドウ再読み込みが必要。0.6.3 をインストールすれば、この直接書き換えは不要になる。

## 7. 実機確認の手順（未実施）

1. `C:\GDrive` を開いた VS Code で、CSM の会話一覧からセッション `4c640deb` をビューワーで開く。
2. ヘッダの「▶ Claude で開く」を押す。
3. 新しいウィンドウが開かず、現在のウィンドウでセッションが復元されることを確認する。
4. 同じビューワーで「ターミナルで再開」を押し、`claude --resume` が "No conversation found" にならないことを確認する。
5. 別プロジェクトのセッション（例: `C:\xampp` で起動したもの）で同じ操作をし、`C:\xampp` の新しいウィンドウが開くことを確認する。この経路は従来どおりの動作。

## 8. 残課題

今回は直していない。優先度は高くない。

- **リンク切れ判定が効かない経路がある**: `openInClaudeHelper.ts` 63 行目の JSONL 実在チェックは `opts.sessionCwd === undefined` のときしか働かない。ビューワーと Orchestration は `sessionCwd` を渡すため、JSONL が無くても新ウィンドウを開いてしまう。`resolveSessionCwd` の結果を使って判定を統一できる。
- **`extractCwdFromJsonl` は先頭 4KB しか読まない**: `sessionLoader.ts` 442 行目。実データでは 14 件が 4KB 内に cwd 行を持たない。`readLaunchCwd` に置き換えられる。一覧用の軽量ローダーが読む先頭バイト数は未確認で、同じ取りこぼしがあり得る。
- **新ウィンドウ経路の URI 送信はタイミング依存のまま**: `openInClaudeHelper.ts` 105 行目の `setTimeout` 1500ms。今回は変更していない。
- **新規テストの後始末**: フォールバックのテストは 1500ms のタイマーが残り、一時フォルダと `HOME` / `USERPROFILE` を元に戻していない。`node --test` はファイルごとに別プロセスなので実害はない。
- **同じセッションが 2 つのフォルダにある**: `64a68883` と `aec9e56f` は `C:\Users\taro\.claude\projects\C--workspace-CMS-CurtainNext` と `C:\Users\taro\.claude\projects\c--workspace-CMS` の両方に JSONL がある。起動時 cwd は `C:\workspace\CMS`。再紐づけ時の複製と思われる。

## 9. 参考: 同時に調べた「過去のセッションが消えた」件

CSM の不具合ではないが、利用者はこの 2 つを同じ問題として受け取っていた。

- `C:\Users\taro\.claude\settings.json` の `cleanupPeriodDays: 3650` は 2026-07-27〜08-04 の間に追加された。それ以前は既定の 30 日保持で、更新日が 2026-07-03 より前の JSONL が Claude Code 本体の掃除で消えていた。
- 設定後の欠損はない。7 月以降にログへ記録のある 52 セッションはすべて現存する。
- 古いコピーから 183 件を復元した。一覧は `C:\Users\taro\.claude\restored-sessions-20261001.txt`。
- 4 月中旬〜7 月 2 日のセッションはどこにも残っていない。

CSM 側で検討できること。

- `C:\Users\taro\.claude\csm-session-backups` のバックアップ対象は、エージェントに紐づいたセッションだけ（`backupLinkedSessions`、サイズ上限あり。現在 27 件）。ブックマーク・タグ・名前を付けただけのセッションは対象外で、Claude Code 本体の掃除で消えると CSM からは復元できない。現に、ブックマーク 2 件と名前付き 3 件が参照切れのまま残っている。
- `cleanupPeriodDays` が未設定または短いとき、CSM が警告を出せば同じ消失を防げる。
