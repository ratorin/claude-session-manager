# 更新履歴

## v0.5.28 (2026-07-13) — v0.5.27 レビュー修正（HIGH 1 + MEDIUM 2 + LOW 1）

v0.5.27 のコードレビューで検出された堅牢性の穴 4 件を修正。ユーザー可視の挙動を修復し、UNC パスや存在しないフォルダでのエッジケースを潰した。

### 🩹 (HIGH-1) `openAgentInClaude` の else 分岐に警告メッセージを復活

`package.json` の設定 `agent.openInNewWindowWhenFolderMismatch` の説明は「OFF にすると従来の警告メッセージのみ」だが、v0.5.27 リファクタで旧 `showInformationMessage` が削除されて **設定 OFF + フォルダ不一致時に無言**（説明との矛盾）だった。

- `agentCommands.ts` の `else` 分岐に条件付き警告を復活: `!allowNewWindow && targetFolder && wsFolders.length > 0 && !isFolderInAnyWorkspace(targetFolder, wsFolders)`。
- `isFolderInAnyWorkspace` を `pathUtils` から import。
- メッセージ本文に「設定 `claudeManager.agent.openInNewWindowWhenFolderMismatch` を有効にすると自動で新ウィンドウを起動できます」を追記し、ユーザーが設定 ON への導線を得られるようにした。

### 🩹 (MEDIUM-2) `revealAgentFolder` を共通ヘルパー化 + 存在確認 + reject 通知

v0.5.27 の `onRevealFolder` は 2 か所で同一ロジックを重複させ、`void vscode.commands.executeCommand(...)` で **reject を握りつぶし**、また **存在しないパスで無反応** だった。

- 新関数 `revealAgentFolder(workDir)` を `agentCommands.ts` に追加:
  1. `translateWorkDirPath` で HGFS 変換
  2. `fs.existsSync(resolved)` で存在確認 → 無ければ `showWarningMessage(『フォルダが見つかりません: ...』)`
  3. `executeCommand('revealFileInOS', ...).then(undefined, err => showWarningMessage(『エクスプローラを開けませんでした: ...』))`
- `fs.existsSync` を try/catch で包み、権限エラー等でも UI にフィードバック。
- 2 箇所の `onRevealFolder: (workDir) => { ... }` を `onRevealFolder: (workDir) => revealAgentFolder(workDir)` に集約（コピペ二重管理の解消）。

### 🩹 (MEDIUM-3) `translateWorkDirPath` の UNC パス保持

UNC パス（`\\server\share\...`）を旧実装は `.replace(/\\/g, '/')` で `\\` を単一 `/` に潰していたため、`//server` にすべき先頭が `/server` になり `revealFileInOS` が誤場所を開いていた（実質的に開けない）。

- 関数冒頭で **UNC 判定** `^(?:\\\\|\/\/)[^\\/]/` を先に行い、UNC の場合は先頭 `\\` or `//` を `//` に固定してから残りを `/` に正規化し **先頭 2 連スラッシュを保持**。
- 非 UNC の Windows 通常パス（`C:\xampp\...`）と Linux HGFS マッピング（`c:/GDrive/... → /mnt/hgfs/GDrive/...`）の挙動は不変。
- エッジケース: 先頭 `\` 1 文字（`\localonly\path` 等）は UNC 判定にヒットしないため従来通り単一 `/` に潰す（後方互換）。

### 📝 (LOW-4 記録) `needsNewWindowForClaudeOpen` の空ウィンドウ挙動

修正不要のレビュー指摘。空ワークスペース（Welcome 画面）状態で `needsNewWindow=true` を返し新ウィンドウを開くと **元の空ウィンドウが残る** 点に留意。

- `pathUtils.ts` の JSDoc に **`LOW-4` の記録コメント**を追記: 「対象フォルダが分かっているのに現ウィンドウで自動 `openFolder` してしまうとユーザーの意図（例: Welcome を意図的に開いている）を壊す恐れがあるため、この判断は現状維持とする。将来 UX 要望が出れば別 Sprint で追加検討」。
- コード変更はなし。テスト V4 でコメント存在を静的確認。

### 🧪 テスト（V1〜V4、4 件新規、合計 112 pass）

- **V1** HIGH-1: `agentCommands.ts` に `isFolderInAnyWorkspace` の import と else 分岐 3 条件警告があること、「別フォルダ...で作成されています」メッセージが含まれることを静的確認
- **V2** MEDIUM-2: `revealAgentFolder` 関数、`fs.existsSync`、「フォルダが見つかりません」文字列、`.then(undefined, (err) => ...)` reject 拾い、「エクスプローラを開けませんでした」文字列を静的確認
- **V3** MEDIUM-3: `translateWorkDirPath` の UNC 往復（`\\server\share` → `//server/share`、深いパス、既に `//` 形式のもの）+ 非 UNC の Windows/HGFS が壊れていないこと + 先頭 `\` 1 文字のみは従来通り単一 `/` に潰す（後方互換）ケース
- **V4** LOW-4: `needsNewWindowForClaudeOpen('', [], true) === false`（対象空なら空ウィンドウ開かない）+ ソースコメントに `LOW-4` と「空ウィンドウ」の記載
- **U6 更新**: 旧「`onRevealFolder: (workDir) => { ... }` が 2 回」から新「`onRevealFolder: (workDir) => revealAgentFolder(workDir)` が 2 回」に変更（共通ヘルパー化を反映）。
- **U6 (e)**: `.then(undefined, err=>...)` の regex を `[^)]*` 制限（`)` を含めない）から自由形に緩和（`Uri.file(resolved)` の `)` で切れていた）。

### 検証

- `npx tsc --noEmit` クリーン
- `npm test`: **112 / 112 pass**（108 → 112、V1〜V4 追加、U6 更新）
- `package.json` `0.5.27` → **`0.5.28`**。設定新設なし（v0.5.27 の設定をそのまま利用）。

### 判断・見送り事項

- **`revealAgentFolder` を共通ヘルパー化**（v0.5.27 レビューの明示的要望 = 「2 箇所とも同一修正」）— 単一の関数に集約することでコピペ二重管理を解消。将来同種のリンクが増えても 1 か所改修で対応可。
- **`fs.existsSync` を採用**（非同期 `fs.promises.access` ではない）— 同期でも十分軽量（1 パス check）+ 呼び出し元がクリック応答内で同期完結できる方が UX 良好（await タイミングで別 UI 状態変化を待たない）。
- **UNC 判定の regex `^(?:\\\\|\/\/)[^\\/]/`** — 先頭 `\\` or `//` が **2 連続** で **その後に非区切り文字**（=サーバー名の最初の 1 文字）があることを要件化。`\\\\` 3 連続や `\\localonly\path`（先頭 `\` 1 文字）は UNC ではないので従来通り扱う。
- **`revealFileInOS` の失敗を warning にとどめる**（error 表示にしない）— UX 上「ちょっとした失敗」で赤い error banner を出すのは過剰。warning（黄色）が適切な重要度。
- **LOW-4 は現状維持** — 「対象空 → false」は既存 U3 でも保証済み。追加のテスト V4 は「コメント記載の追跡」の意味合いが大きい（レビュー指摘への説明責任の明示）。
- **V3 テストの `\\localonly\path` ケース** — 先頭 `\` 1 文字は UNC ではないため単一 `/` に潰す（`/localonly/path`）。従来動作を維持することで後方互換を担保。
- **`else` 分岐の警告メッセージは新ウィンドウ起動を促す文言を含める** — ユーザーが「なぜ開かないんだろう」から設定変更に辿り着けるよう、`claudeManager.agent.openInNewWindowWhenFolderMismatch` のキー名を本文に明示。

## v0.5.27 (2026-07-13) — エージェントフォルダパス表示 + Claude で開くの新ウィンドウ起動

ユーザー要望 2 点を実装。

### 📁 (1) エージェントプレビューの基本情報にフォルダパス（リンク付き）

- `agentPreviewPanel.ts` の基本情報グリッドに **「フォルダ」行** を追加。`agent.workDir` を表示。空なら `（未設定）`（リンクにしない）。
- パスは **`.folder-link` ボタン**（既存 `.agent-link` と別クラス、等幅フォント + word-break: break-all）。クリックで webview→拡張へ `postMessage({type:'revealFolder'})` → 拡張側 `onRevealFolder(workDir)` コールバックで `vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(translateWorkDirPath(workDir)))` を実行し **OS のファイルエクスプローラで対象フォルダを表示**。
- `AgentPreviewCallbacks` に `onRevealFolder?: (workDir: string) => void` を追加（optional、実装なくても動く）。`agentCommands.ts` の 2 か所の `showAgentPreview` 呼び出し（`previewAgent` / `previewAgentByName`）両方で配線。
- HTML 出力は既存の `escapeHtml` で必ずエスケープ。

### 🪟 (2) Claude で開くの新ウィンドウ起動

`openAgentInClaude` は旧実装ではセッション作成時 cwd と現ワークスペースが違うときに **警告メッセージを出すだけ** で、実際にはユーザーが手動で対応する必要があった。今回これを **「実際に新しい VS Code ウィンドウで対象フォルダを開く」動作に格上げ**。

- **対象フォルダの決定** — `resolveOpenInClaudeTargetFolder(sessionCwd, workDir)`（純関数）で `sessionCwd`（既存の `projects/*.jsonl` 走査で取得）を優先、取れなければ `agent.workDir` をフォールバック。
- **包含チェック** — `needsNewWindowForClaudeOpen(targetFolder, wsFolders, allowNewWindow)`（純関数）で現ワークスペース群のいずれかに双方向包含（`isContainedIn` の 2 方向、v0.5.16 流儀）していれば `false`。包含しない or ワークスペース未オープンの場合 `true`。
- **新ウィンドウ経路** — `vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(translateWorkDirPath(target)), { forceNewWindow: true })` で新ウィンドウを開き、その直後（1500ms setTimeout）に `vscode.env.openExternal(scheme://anthropic.claude-code/open?session=<sid>)` を **ベストエフォート** で送る。事前に案内メッセージ「自動復元されない場合は再度『Claude で開く』を押してください」を表示。
- **既存経路** — 包含済み or 設定 OFF なら旧通り URI ハンドラのみ（`openExternal`）で即座に開く。
- **設定** — `claudeManager.agent.openInNewWindowWhenFolderMismatch`（既定 `true`）で新ウィンドウ経路の ON/OFF。OFF なら判定を素通りし、常に URI ハンドラのみ（旧挙動）。

### 🤔 判断メモ（タイミング依存の扱い）

`vscode.openFolder` は新しい VS Code ウィンドウを起動し、そこで拡張ホストが**再起動**する。同一プロセスから直後に `openExternal(uri)` しても、URI が届く先は必ずしも新ウィンドウとは限らない（OS 経由で開かれる URI ハンドラは、その時点で URI ハンドラ登録済みの任意のウィンドウに解決されうる）。よって:

- **確実性の高い部分（フォルダを新ウィンドウで開く）は同期的に実装**。
- **セッション自動復元はベストエフォート**（`setTimeout(1500ms)` で URI 送信）。
- **フォールバック案内**を info メッセージで先出し（新ウィンドウが開いた後、ユーザーが CSM のライブ状態から再度クリックすれば必ず復元できる）。

この判断根拠を CHANGELOG + guide.html の両方に明記。

### 🔧 純関数の分離（テスト可能な形）

`src/utils/pathUtils.ts` に追加:
- `resolveOpenInClaudeTargetFolder(sessionCwd, workDir): string`
- `isFolderInAnyWorkspace(targetFolder, workspaceFolders): boolean`（v0.5.16 と同じ双方向包含）
- `needsNewWindowForClaudeOpen(targetFolder, workspaceFolders, allowNewWindow): boolean`

いずれも vscode 非依存で node 単体テスト可能。

### 🧪 テスト（U1〜U6、6 件新規、合計 108 pass）

- **U1** `resolveOpenInClaudeTargetFolder`: sessionCwd 優先、workDir フォールバック、空/空白の扱い
- **U2** `isFolderInAnyWorkspace`: 双方向包含（v0.5.16 流儀）、Windows/POSIX 両対応、空配列 / 空文字は false
- **U3** `needsNewWindowForClaudeOpen`: allowNewWindow=false / 対象空 / 包含済み → false、別プロジェクトや WS 未オープン → true
- **U4** `package.json`: `agent.openInNewWindowWhenFolderMismatch` 設定（既定 true）
- **U5** `agentPreviewPanel.ts` 静的検証: フォルダ行 / folder-link CSS / btn-reveal-folder / （未設定）表示 / revealFolder ハンドラ / onRevealFolder 型
- **U6** `agentCommands.ts` 静的検証: pathUtils から純関数 import / 設定キー参照 / `vscode.openFolder` + `forceNewWindow: true` / 案内メッセージ / `onRevealFolder` が 2 プレビュー呼び出しに配線 / `revealFileInOS` 呼び出し

### 📖 ドキュメント

- **CHANGELOG**: 本節を追加。
- **README.md**: エージェント節に「基本情報にフォルダパス（リンク）」「Claude で開く時の新ウィンドウ起動」を追記。変更履歴に v0.5.27 追加。
- **guide.html**: 「基本情報 + 新ウィンドウ起動（v0.5.27）」節を追加、タイミング依存の説明も同梱。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **108 / 108 pass**（102 → 108、U1〜U6 追加）。
- `package.json` `0.5.26` → **`0.5.27`**。設定 1 種（`agent.openInNewWindowWhenFolderMismatch`）新設。

### 判断・見送り事項

- **セッション自動復元は setTimeout(1500ms) のベストエフォート** — 拡張ホスト再起動の待ち時間を厳密に測る手段がなく、`openFolder` の完了を待っても対象ウィンドウの CC 拡張が activate 済みかどうかは判別不能。1500ms は経験値（VS Code 起動 1〜2 秒が目安）。届かなかった場合の再操作導線（案内メッセージ）を必ずセットで提示する設計。
- **URI 送信を後回しにする** — `openFolder` 前に `openExternal` すると URI が現在のウィンドウ側で解決され誤動作するため、必ず後（かつ小さな遅延）で送る。
- **`revealFileInOS` を採用**（`vscode.env.openExternal(vscode.Uri.file(...))` ではない） — VS Code の標準コマンド。Windows→エクスプローラ / macOS→Finder / Linux→ファイルマネージャに自動でルーティングされる。ファイルではなくフォルダを渡してもディレクトリを開いてくれる（挙動確認済み）。
- **`onRevealFolder` を optional にした** — 既存の外部ユーザ（もしいれば）や、将来の別 UI から `showAgentPreview` を呼ぶケースで、フォルダリンクを付けなくても動くようにするため。実装側で「未定義なら黙って無視」の防御あり。
- **`.folder-link` は等幅 + word-break: break-all** — 長い Windows パスでも改行して折り返す。等幅で識別性が高い。
- **設定 OFF 時の挙動を維持** — `allowNewWindow=false` なら旧同様に URI ハンドラのみで動く（ダイアログ / info も出さない）。ユーザーが自分で warning フリー運用を選べる。
- **`translateWorkDirPath` を通す** — Windows パスを Linux HGFS にマップするケース（dev-lamp 上での実行など）を尊重。既存の他コマンドと一貫。
- **spec 中「revealInExplorer」との差** — VS Code の `revealInExplorer` は VS Code 内エクスプローラーで表示するコマンド。ユーザ要望は OS のファイルエクスプローラなので `revealFileInOS` を採用。

## v0.5.26 (2026-07-13) — 組織図の整理（グローバル除外復活 + ルート絞り込み + 階層モード全面再設計 + 線視認性改善）

ユーザーからのフィードバック 4 点を反映した組織図の整理スプリント。

### 🩹 (A) グローバルエージェントの混入バグ修正（フィルタ復活）

`showOrgChart` が全エージェントをそのまま `buildOrgChartHtml` に渡していたため、`shouldShowInOrgChart` フィルタが v0.5.23 リデザイン時に**適用漏れ**していた（`buildMiniOrgChartData` には残っていた）。qa / doc-writer / researcher などのグローバル汎用エージェントがグラフ・階層・グループの全モードに混入していた。

- `showOrgChart` に **`orgChartEngine.filterOrgChartAgents(enriched, showGlobal, defaultRoot)`** を挿入。グラフ / 階層 / グループの 3 モード全てに効かせる。
- 判定は `agentUtils.shouldShowInOrgChart` と一致させた純関数 `isOrgChartMember`（`orgChartEngine`）を採用（テスト独立性のため engine 側に再実装、ルールは 1:1 同期）。
- **ツールバー「グローバルも表示」トグル**（既定 OFF、設定 `claudeManager.orgChart.showGlobal`）を追加。ON にすると `parentAgent` 未設定のグローバル汎用エージェントも含めて表示。設定はトグル操作で自動永続化（`ConfigurationTarget.Global`）。

### 🌱 (B) ルート絞り込み

複数プロジェクトのエージェントが 1 枚に同居してカオスになる問題への対策。

- **ツールバー「ルート」セレクタ**（`<select>`）を追加。`parentAgent` を辿った最上位を列挙（`orgChartEngine.computeRoots`）し、選択したルート配下（BFS で子孫収集）のみを表示（`orgChartEngine.extractSubtree`）。「すべて」も選択肢に。
- 設定 **`claudeManager.orgChart.defaultRoot`**（既定 `""`＝すべて）で永続化。セレクタ変更で自動保存。
- ルート判定は循環参照防御あり（visited セット）。ルート自身がグローバルの場合、`showGlobal=false` ならそのルート自身は除外し配下の部門エージェントだけを残す（挙動をテスト T5 で明示）。
- `showGlobal` / `defaultRoot` の切替は Webview から `postMessage({type:'setShowGlobal'|'setRoot'})` を送り、拡張側 `handleOrgChartMessage` で永続化 + `rebuildOrgChart()` で HTML 全再生成（絞り込み対象集合が変わるため部分更新ではなく全再生成が安全）。

### 🌳 (C) 階層モードを縦型インデントツリーに全面差し替え

ユーザーから「イメージとかなりかけ離れている」「折りたためると良い」との指摘。

- **旧: カード階層（横並び、横スクロール地獄）** → **新: ファイルツリー / Obsidian アウトライン風の縦積み + インデント + ▶/▼ トグル**。
- **折りたたみ対応**: 各ノードに子があれば `▶`（畳んだ状態）/ `▼`（開いた状態）のキャレットを表示、クリックで開閉。行本体クリックは従来通り `openSession` プレビューへ。
- **既定展開**: 深さ 0〜1 の（子を持つ）ノードを既定で展開＝**上位 2 階層まで表示**。ユーザーが手動で開閉した後はその状態を尊重（`tvExpanded` Set をパネル内 state で保持、設定永続化なし）。
- **判断根拠**: 元カード階層は横並び前提でエージェントが多いと画面外に流れて可視性が悪い。ファイルマネージャ / VS Code エクスプローラの慣習が最も期待に近い（縦積み + インデント + 三角トグル）。CHANGELOG と guide.html の両方に明記。

### 🖋 (D) 線の視認性改善

- **グラフモードのエッジ**: 親子（cmd）のアルファ `0.35 → 0.65`、線幅 `1.1 → 1.8`（zoom 補正付き）、色 `#6b7185 → #a4aac0`（明るめグレー）。連携（金色点線）と形状 + 色で区別。
- **親→子矢印**: 親子エッジの子側端に**小さな三角矢印**を追加。指揮系統の方向が一目で分かる。矢印は `zoom` 補正付き。ホバー減光時は非表示（矢印がちらつかない）。
- **階層モードの縦罫線**: `1px var(--border)` → **`2px var(--text-dim) opacity 0.55`** で太く・コントラスト UP（旧は薄すぎて視認性が悪かった）。
- **行ホバー**: 行の左端に `2px accent` の縦ハイライトを付与し、ホバー時のフォーカス位置を明確化。

### 🧪 テスト（T1〜T7、7 件新規、合計 102 pass）

- **T1** `isOrgChartMember`: 3 ルール（明示 > parentAgent > false）— `agentUtils.shouldShowInOrgChart` と 1:1 一致
- **T2** `computeRoots`: parentAgent なし or 未知（親が集合外）は全てルート扱い（`director` / `ponta` / `Curtain_leader` / `lost(親未知)`）
- **T3** `extractSubtree`: 指定ルート配下のみ BFS で収集、空文字は全件、未知ルートは全件フォールバック
- **T4** `extractSubtree`: 循環参照でも無限ループしない（visited 防御）
- **T5** `filterOrgChartAgents`: `showGlobal × rootName` の 4 組合せ（グローバル除外 / 全員 / ルート限定 + グローバル除外）— **『同一プロジェクト外の窓が混入しない』『グローバルエージェントがルート指定でも除外される』の両方を明示的にテスト**
- **T6** `package.json`: `orgChart.showGlobal` / `orgChart.defaultRoot` の 2 設定が新規宣言
- **T7** `orgChartPanel.ts`: `filterOrgChartAgents` の呼び出し、`setShowGlobal` / `setRoot` ハンドラ、`rebuildOrgChart` による再生成、`root-select` / `btn-show-global` UI、`tv-row` / `tv-caret` / `tvExpanded`（縦型ツリー）、親→子矢印コメントが埋め込まれている

### 📖 ドキュメント

- **CHANGELOG**: v0.5.26 節を追加（本節）。
- **README.md**: 組織図節に「(A) グローバル除外」「(B) ルート絞り込み」「(C) 階層モード縦型インデント化」「(D) 線視認性 + 親→子矢印」を明記。設定に `orgChart.showGlobal` / `orgChart.defaultRoot` を追記。変更履歴に v0.5.26 追加。
- **guide.html**: セクション 7 に **v0.5.26 組織図の整理** 段落を追加（トグル / セレクタ / 折りたたみ操作 / 線の見た目改善を説明）。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **102 / 102 pass**（95 → 102、T1〜T7 追加）。
- `package.json` `0.5.25` → **`0.5.26`**。設定 2 種（`orgChart.showGlobal` / `orgChart.defaultRoot`）を新設。

### 判断・見送り事項

- **階層モードは全面差し替え（カード → 縦型インデント）** — ユーザーからの「イメージとかなりかけ離れている」を素直に受け止め、ファイルツリー慣習に寄せた。旧カード階層のコード（`renderCardCol` / `renderCard` / `.tcol` / `.tier` / `.subtree`）は撤去。CSS の `.card` / `.tier` / `.subtree` は使わなくなったが将来再利用の可能性があるため CSS 定義自体は残置（実害なし・軽量）。
- **折りたたみ状態は設定永続化しない** — セッション内での短期記憶。ユーザーがエージェント構成を変えたときに古い ID の折りたたみ状態を持ち越すと混乱するため。パネル再オープンで既定（上位 2 階層展開）に戻る。
- **既定展開 = 深さ 0〜1（上位 2 階層）** — 部門構成（例: director → csm-dev → csm-impl）で「部門長までは開いた状態」がユーザーの期待。深さ 2 以上（実装エンジニアレベル）は畳んで見せ、必要に応じて展開してもらう。
- **矢印は親子（cmd）エッジのみ** — 連携（collab）エッジは相互やりとりの記録で方向性はあるが視覚的に矢印まで付けると煩雑になる。金色点線 + 線幅で識別可能なので矢印は付けない。
- **`isOrgChartMember` を engine 側にも実装（agentUtils と 2 実装）** — テストで vscode モックの読み込みを避けるため。ルールは同一（同じコメントを両方に貼付）で将来ドリフトしないよう注意コメント記載。
- **`extractSubtree` を空/未知ルート → 全件返す** — 「無効な defaultRoot に飛ばされたユーザーが空画面を見て困る」を回避するグレースフルフォールバック。
- **rebuildOrgChart で HTML 全再生成** — 部分更新（`postMessage` で NODES を上書き）も可能だが、力学位置が全部リセットされ / モード切替状態も維持しづらいため単純に全再生成。切替後は `defaultMode` 設定 → 現在モードで復元される。
- **VS Code の QuickPick 経由でルート選択も検討したが `<select>` を採用** — Webview 内で自己完結する方がクリック→即反映で UX が良く、拡張ホスト往復のレイテンシもない。
- **『紐づけミス（Ponta を CSM 配下）』はコード側で救わない** — ユーザーの `agents/*.md` の `parentAgent` フィールドが間違っている場合、ルート絞り込みで「Ponta 配下として CSM の子孫が出る」等の見え方になるが、それはユーザーの直しどころ（データ側の修正）を示唆する動作でもある。UI での自動修正は行わない。

## v0.5.25 (2026-07-13) — 組織図グラフのズーム/パン対応

ユーザーからのフィードバック「グラフモードは気に入ったが、エージェントが増えるとカオスになる」を受け、Obsidian 風力学グラフに **ホイールズーム + 背景ドラッグパン + フィット** を追加しました。

### 🔍 ビューポート（zoom / pan）導入

- **状態**: `{ zoom, panX, panY }` を Canvas 描画層に導入。ズーム範囲は **0.2〜4.0** でクランプ。
- **座標変換の一元化**: `ctx.setTransform(DPR * zoom, 0, 0, DPR * zoom, DPR * panX, DPR * panY)` でワールド → デバイス変換を 1 か所に集約。ノード座標・エッジ・ラベルは**ワールド座標のまま描画**し、変換は ctx に任せる。
- **`screenToWorld(sx, sy)`**（クライアント側 + `orgChartEngine.screenToWorld`（純関数））をマウスイベント全てで経由: `mousemove` の `hover` 判定、`mousedown` の `pick`、`click` のノード命中、`wheel` のズーム基点計算、ノードドラッグ中の座標更新 — 全てワールド座標に統一（ズーム時のホバー/ドラッグずれを根絶）。

### 🖱️ 入力

- **ホイール = カーソル基点ズーム**（判断: Miro / tldraw / Excalidraw の慣習に寄せた。全画面 Canvas でスクロール概念が無いため `ctrlKey` 修飾は不要とし、トラックパッド pinch（`ctrlKey=true` が付く）も同じくズーム扱い）。カーソル下のワールド点がズーム前後で同じスクリーン座標に留まるよう `panX/panY` を補正（純関数 `orgChartEngine.zoomAt` を移植）。
- **背景ドラッグ = パン** / **ノードドラッグ = ノード移動** の区別: `mousedown` で `pickNode(worldX, worldY)` して命中ならノードドラッグ、外れなら `panDrag = { startSx, startSy, startPanX, startPanY }` を保存し、以降の `mousemove` で `panX/panY = startPan + (currentScreen - startScreen)` で更新。
- **ダブルクリック = 全体フィット**（一般的なグラフエディタ慣習）。
- **ツールバー ＋ / − / ⤢ ボタン**: 画面中央基点でズーム、フィットで全ノードのバウンディングボックスに `padding=40` の余白付きで合わせる。他モード（階層/グループ）ではボタンとバッジを非表示。
- **ズーム倍率バッジ**: 右下に `120%` の形で表示（グラフモード時のみ）。

### 🔧 純ロジック分離（テスト可能な形で）

`src/utils/orgChartEngine.ts` に以下を新設:

- `Viewport` 型（`{ zoom, panX, panY }`）と `ZOOM_MIN` / `ZOOM_MAX` 定数
- `screenToWorld(viewport, sx, sy)` / `worldToScreen(viewport, wx, wy)`
- `zoomAt(viewport, anchorSx, anchorSy, factor, min?, max?)`: カーソル基点ズーム（不変値変換）
- `centerViewportOn(viewport, wx, wy, stageW, stageH, newZoom?)`: 指定ワールド点をステージ中心に置く
- `fitToView(points, stageW, stageH, padding?)`: 全ノードのバウンディングボックスに zoom/pan をフィットさせる

クライアント側の `zoomAtScreen` / `fitToView` / `centerOn` はこれらの純関数と同じ算式で実装（webview で import できないため移植）。

### 🎯 既存機能の維持

- ホバー減光・稼働パルス・連携レイヤー（金色点線）・凡例フィルタ・他プロジェクト減光は全て維持。
- **検索センタリング**: `centerOn(id)` を viewport pan に変更（旧: ノード座標を強制移動）。現在の zoom が 1 未満なら 1 に軽くズームインしてから中央配置。
- **初期表示は全体フィット**: `seedPositions()` 後の次フレームで `fitToView()` を呼び、エージェント数が多いケース（v0.5.23 以降の増加ケース）でも初回表示がカオスにならないよう調整。
- **ラベルの読み取り性**: ズーム倍率に反比例させて `font-size = 11.5 / zoom` で描画（実効フォント高が安定）。ラベルオフセット `n.r + 15` も `15/zoom` に補正。

### 🧪 テスト

`test/unit/agent-hooks-qa.test.js` に **S1〜S7、7 件追加**（合計 **95 pass**）:

- **S1** `screenToWorld` / `worldToScreen`: 3 種の viewport で逆変換恒等性
- **S2** `zoomAt`: アンカー下のワールド点がズーム前後で同じスクリーン座標
- **S3** `zoomAt`: `ZOOM_MIN` / `ZOOM_MAX` のクランプ
- **S4** `fitToView`: 全ノードが `padding` 分の内側に収まる（境界近傍の 1e-6 許容）
- **S5** `fitToView`: 空配列で既定 viewport（zoom=1, ステージ中央 pan）
- **S6** `centerViewportOn`: 指定点がスクリーン中心
- **S7** `orgChartPanel.ts` 静的検証: viewport / screenToWorld / setTransform / wheel リスナー / panDrag / dblclick / 3 ボタン / バッジ / `pickNode(worldX, worldY)` シグネチャが埋め込まれている

### 📖 ドキュメント

- **README.md**: 組織図節「グラフモードの操作」を追記（ホイールズーム・背景ドラッグパン・ダブルクリックフィット・±ボタン・倍率バッジ）。変更履歴に v0.5.25 追加。
- **guide.html**: セクション 7「エージェント組織図」に **v0.5.25 グラフ操作** 段落を追加。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **95 / 95 pass**（88 → 95、S1〜S7 追加）。
- `package.json` `0.5.24` → **`0.5.25`**。設定新設なし（グラフモード内のクライアント状態のみ、リロードで zoom=1 リセット）。

### 判断・見送り事項

- **ホイール = ズーム（Ctrl 修飾不要）** を採用 — グラフモードは全画面 Canvas でスクロール概念が無く、Miro / tldraw / Excalidraw の慣習が最も直感的。トラックパッド pinch も `ctrlKey=true` 付き wheel として届くため同じく自然にズーム扱いになる。プレーンな wheel をパンにする案（VS Code のエディタ慣習）は却下: 直後にドラッグでパンできるため wheel パンの必要性が薄い。
- **ズーム倍率の永続化は見送り** — グラフモードは「今開いたときの見え方」が重要で、次回起動時の見え方はノード位置（未保存）ともセットにしないと復元できない。ズーム値だけ復元すると意図せぬ拡大/縮小状態で開くことになる。フィット初期表示のほうがユーザー体験として安定。
- **ラベルのズーム逆補正は `font-size = 11.5 / zoom`（クランプなし）** — 実効フォントサイズを 11.5px に固定するシンプル式を採用。極端なズームアウト時（0.2x）でも 11.5px、極端なズームイン時（4x）でも 11.5px。UI レイアウトが崩れる懸念より読みやすさを優先。
- **タッチデバイス（ピンチジェスチャ）専用対応は見送り** — VS Code の webview はブラウザ相当で、`ctrlKey=true` 付き wheel（ブラウザピンチ）が上記実装で自動的にズームになるため、iPad / トラックパッド pinch は自然に動く。マルチタッチイベント（`touchstart` 2 本指）専用の追加コードは需要が読めないため未実装。
- **背景マウスカーソル**: パン中は `cursor: move`、ノードドラッグ中は `cursor: grabbing`、通常は `cursor: grab`。ホバー時は `pointer`。
- **フィットボタンのアイコン**: モックにない要素だが「⤢」（U+2922、NORTH EAST AND SOUTH WEST ARROW）を採用（一般的な「フィット」記号）。将来 codicon 差し替えの検討余地あり。
- **PNG / SVG エクスポートは v0.5.23 で撤去済み**。ズーム対応と併せてエクスポート復活する需要が出れば別 Sprint で対応。
- **spec の項目 (7) 判断メモ**: 上記「ホイール = ズーム」参照。判断根拠を CHANGELOG と guide.html の両方に明記。

## v0.5.24 (2026-07-13) — ライブ状態ツリー化 + cwd 推測マッチング撤去

『動かしていないエージェントが稼働中に見える』重大な誤紐付けを根絶し、ライブ状態ビューを **フラット → エージェント別 2 階層ツリー** にリファクタしました。

### 🩹 撤去: cwd 推測マッチング（実害あり）

- `agentLiveTreeProvider.buildLiveAgentViews` の **`matchLevel === 'cwd'` 分岐を削除**。エージェント名を付けるのは `matchLevel === 'session-id'`（本物の `sessionId` 紐付け）のときだけ。
- **実害の詳細**: 複数エージェントが同一 `workDir`（例: `c:/xampp`）を共有していると、内部 `cwdMap` は最初の 1 体（例: 取締役）しか保持できず、そのフォルダで動くユーザーの通常チャット窓 N 本すべてが『取締役(推定)』『Daros開発部長(推定)』等に誤って貼り付いていた。CC 2.1.207 の `sessions/*.json` には `agent` フィールドが存在しないため、`agentSessions`（`sessionId` 紐付け）が唯一の確実な同定手段。
- 表示側の **「(推定)」サフィックス** と cwd tooltip 行、`matchSuffix` 変数、内部 `cwdMap` 生成もすべて撤去。
- `LiveAgentView.matchLevel` の型は互換のため `'session-id' | 'cwd' | 'none'` のまま残置（型定義に「`'cwd'` は決して返らない」と明記）。

### 🌳 ライブ状態ビューを 2 階層ツリー化

- **ルート**: 各エージェント（本物紐付けで稼働セッションを持つもののみ、稼働ゼロは非表示）を `collapsibleState=Expanded` で表示。`label = displayName`、`description = 稼働 N`。
- **直下（各エージェント配下）**: そのエージェントで動いている稼働セッション（複数窓・複数ワークツリー等が並ぶ）。CC 公式 `sessionName` → sid 先頭 8 文字の順でラベル、PID・kind・経過時間を description に。
- **未定義グループ**: 本物紐付けの無い稼働セッションを `未定義（N）` のフォルダに集約（`Collapsed` 既定）。label = CC 公式 name（無ければ sid8）、description = フォルダ名（`cwd` の basename）。エージェント稼働とは明確に別扱い。
- **部門長判定**: `parentAgent` を持つ子エージェントの数を tooltip に「配下エージェント計 M」で表示（`groupByDept` と同じ流儀の直下カウント）。
- **経過時間**: `sessions/*.json` の `startedAt` から `Math.max(0, Math.floor((now - startedAt) / 1000))` で算出（v0.5.22 の `orchestrationViewModel` と同じ式）。startedAt 不明時は非表示。
- **-p / background セッションのレジューム不可**: tooltip に「※ -p / background セッションはレジューム不可の場合があります」を追記（`kind === 'background'` などから判別）。

### 🔧 純ロジック分離とテスト

- **`resolveLiveAgentViews`** / **`buildLiveTreeStructure`** を `src/services/liveAgentTypes.ts` に配置（vscode 非依存）。`agentLiveTreeProvider.buildLiveAgentViews` は互換用の薄い再エクスポート。
- テスト追加（`R1〜R7`、7 件、合計 **88 pass**）:
  - **R1** `resolveLiveAgentViews`: 同一 workDir 共有時でも通常チャット窓が `linkedAgentName` を持たず `'none'` のまま（**cwd 誤爆再発防止の明示テスト**）
  - **R2** `buildLiveTreeStructure`: エージェント別ツリー + 未定義グループ + `subordinateAgentCount` 集計
  - **R3** 万一 `matchLevel==='cwd'` が来ても未定義に落ちる（防御的動作）
  - **R4** `agentLiveTreeProvider.ts` からコード上の `matchSuffix` / `"(推定)"` 文字列 / cwd 用 Map 宣言がすべて撤去されている（コメント記述は許容）
  - **R5** `package.json` の `showUnregisteredLive` description が「未定義グループ」に更新、`liveStatus.showUndefinedGroup` は新設していない（重複回避）
  - **R6** `openLiveSessionInClaude` コマンドが登録済み
  - **R7** `elapsedSec = Math.max(0, Math.floor((now - startedAt) / 1000))` 式で計算

### 🎛 設定

- **`claudeManager.agents.showUnregisteredLive`**（既定 `true`）を **「未定義グループの表示 ON/OFF」の意味に統合**。description を更新。新設 `claudeManager.liveStatus.showUndefinedGroup` は **導入せず**（重複回避）— 旧 v0.5.22 で追加された既存キーを流用することでユーザー設定の破壊を回避。
- **新規コマンド `claudeManager.openLiveSessionInClaude`**: 未定義グループ配下のセッション行クリック時に Claude Code を起動（`SessionItem` を持たない tree item のため文字列 `sessionId` を直接受け取る派生コマンド）。既存の `claudeManager.openInClaude`（`SessionItem` 引数）と併存。

### 📖 ドキュメント

- **README.md**: 🟢 ライブ状態ビュー節を書き直し（ツリー化・未定義グループ・cwd 推測撤去を明記）。変更履歴に v0.5.24 追加。
- **guide.html**: 「ライブ状態ツリー化 + 誤紐付け撤去（v0.5.24）」節を追加（挙動 5 点 + 部門長 tooltip + 経過時間）。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **88 / 88 pass**（81 → 88、R1〜R7 追加）。
- `package.json` `0.5.23` → **`0.5.24`**。設定新設なし（既存キーの意味統合のみ）。

### 判断・見送り事項

- **`claudeManager.liveStatus.showUndefinedGroup` の新設は見送り** — 既存 `agents.showUnregisteredLive`（v0.5.22 追加）が「フラットリスト時代の未登録行表示 ON/OFF」という近縁概念だったため、意味を『未定義グループ ON/OFF』に統合。設定重複と description 分裂を回避しつつ、ユーザーの既存設定値も破壊しない（`true` のままなら未定義グループが表示される）。
- **部門長 tooltip の「配下エージェント計」は直下のみ** — `parentAgent === X` の直下のみカウント（再帰的な合計ではない）。組織階層が深い場合の「取締役の傘下 30 名」のような再帰合計は将来 UX 要望が出れば別 Sprint で追加。
- **セッションクリック導線** — 紐付け済み → `previewAgentByName`（エージェントプレビュー）、未定義 → `openLiveSessionInClaude`（Claude Code で開く）。両方とも既存の右クリック context menu と重複しない single command で動作。
- **`LiveAgentView.matchLevel` の型に `'cwd'` を残置** — buildLiveAgentViews からは決して返らないが、型変更で他モジュールに波及する破壊的変更を避けるため互換のために残置。将来 v1.0 で型からも削除予定。
- **未定義グループの label に登録済みか未登録かの区別を出さない** — ラベルはあくまで「そのセッションが何か（CC 公式 sessionName や sid）」を表す責務。「なぜここにいるか（紐付け無し）」は tooltip に集約。
- **cwd 推測マッチングは復活させない** — sessions/*.json に将来 `agent` フィールドが復活しても、それは cwd 推測ではなく公式値経路として `agentWatcher.update()` の agent フィールド分岐（v0.5.22 追加済み）が担当する。

## v0.5.23 (2026-07-13) — 組織図リデザイン（Obsidian 風グラフに全面刷新、Cytoscape/ELK 撤去）

### 🩹 コミット前レビュー修正（HIGH 2 + LOW 2）

- **HIGH-1 `media/walkthrough/step5.md` を新 UI に合わせ全面書き直し** — 旧記述（Cytoscape / 「ツリー・関係・グループ」/ 親エージェント別フィルタ / PNG・SVG エクスポート）を撤去し、新 UI（Obsidian 風グラフ / `[グラフ | 階層 | グループ]` サブモード / 連携トグル / 他プロジェクト減光）に置換。**存在しないボタンを初見ユーザーに案内する事故を防止**。
- **HIGH-2 「他プロジェクトを隠す」トグルと モードセグメントの選択を Global 設定に永続化** — Webview 側でボタン click 時に `postMessage({type:'setHideOtherProjects', value})` / `postMessage({type:'setDefaultMode', value})` を送り、拡張側 `handleOrgChartMessage` で `workspace.getConfiguration('claudeManager').update(..., ConfigurationTarget.Global)`。CHANGELOG/README/step5 の「設定 `orgChart.hideOtherProjects` で永続化」表記との不一致を解消。書き込み失敗はサイレント（次回起動時に既定へ戻るのみで安全）。
- **LOW-1 `src/commands/orgChartCommands.ts:67` の古いコメント更新** — `// extensionUri for Cytoscape resource loading` → `// v0.5.23: extensionUri は現在未使用（Cytoscape/ELK 撤去後の後方互換のため引数だけ温存）` に差し替え。
- **LOW-2 `src/utils/collabLog.ts` の集計キー衝突対策** — 従来の 1 文字区切りだと `a b`+`c` と `a`+`b c` が衝突する余地があったため、`JSON.stringify([from, to])` に置換。名前に空白を含むエージェント（現状は無いが将来対応）でも安全。
- 検証: `npx tsc --noEmit` クリーン / `npm test` 81 / 81 pass 維持。

オーナー承認済みモック（`docs/mockups/orgchart-redesign-mock.html`）を実データで実装。**破壊的変更として Cytoscape.js / cytoscape-elk / elk.bundled の 3 ファイル同梱と実装依存を撤去** — 旧「関係」「グループ」モードで発生していた真っ暗バグも実装ごと消滅した。

### ✨ メインモード: Obsidian 風力学グラフ（Canvas 自前実装）

- **モック `makeSim` を `src/utils/orgChartEngine.ts` の純ロジックへ移植・発展** — Node.js 単体テストで力計算・隣接・グルーピング挙動を検証可能に。
- **ノード**: 半径 = `7 + 部下数 * 2.2 + ライブボーナス(2) + director ボーナス(4)`、色 = `modelCatalog.colorHex`、稼働中はパルス + 緑ドット、**全ノードのラベルを常時表示**、ホバーで隣接以外を減光、ドラッグ再配置、`prefers-reduced-motion` で物理アニメ抑制（位置固定）。
- **既存機能を維持**: 検索ボックスは v0.5.18 相当の挙動（マッチノードをセンタリング）、凡例チップは Fable/Opus/Sonnet/Haiku/稼働中 の 5 種でフィルタ、ノードクリックは既存 `onOpenSession` 経路（`postMessage`）を踏襲、`agentWatcher` からのライブ状態は初期表示時に反映。
- **ダーク固定** — モックの宇宙感（放射グラデーション + Canvas グロー）を尊重。VS Code テーマの Light/HC はグラフモードでは適用しない（**設計判断**: 力学グラフの視認性はダーク前提で調整済みで、テーマ追従すると Canvas 色計算が二重管理になる）。階層/グループのサブモードは `var(--vscode-*)` でテーマ追従する。

### 🔗 連携レイヤー（連携トグル OFF が既定）

- **`~/.claude/csm-collab-log.jsonl` を新設**。フォーマット: `{"ts": epoch_ms, "from": "director", "to": "csm-impl"}` の 1 行 append。
- **`templates/csm-ask-agent.py:append_collab_log()` で追記実装** — `sender` は環境変数 `CSM_AGENT_NAME` があればそれ、無ければ `"director"` を近似的に使用。**書き込み失敗は本処理に影響させずサイレント**（`pass` で握りつぶし）。
- **`src/utils/collabLog.ts` に集計ロジック分離** — `readCollabLog(path?)` + `aggregateCollabLog(entries, nowMs, windowDays=7)` — 純関数でテスト容易。破損行はスキップ、自己送信は集計対象外、ts 数値以外は除外。
- **UI**: ツールバー右の「連携」トグル ON で、直近 7 日の集計エッジを金色点線（太さ = 回数、最大 5px）で重ね描き。ログ未蓄積時は「連携ログはまだありません（/csm-ask-agent の利用で蓄積されます）」のヒント表示。集計は ON 時に `postMessage` でオンデマンド再取得。

### 🌫 ワークスペース減光 / 非表示

- **`agent.workDir` を `pathUtils.isContainedIn` で現ワークスペース群と照合**（v0.5.16 の `isSessionInAnyWorkspace` と同じ流儀）。範囲外エージェントは既定で opacity 0.25 の減光表示。
- **`workDir` 未設定 は全プロジェクト共通とみなし通常表示** — グローバル汎用エージェント（QA・ドキュメント作成等）が減光されない。
- **「他プロジェクトを隠す」トグル**（設定 `claudeManager.orgChart.hideOtherProjects` で永続化）で完全非表示化も可能。

### 🗂 サブモード（ツールバーセグメント: グラフ / 階層 / グループ）

- **階層モード**: モックのカードツリーを実データで**動的生成**（全階層、横スクロール、カードに `displayName / モデルバッジ / 稼働ドット / 部下数`、クリックで既存の `openSession` 経路）。VS Code テーマ追従。
- **グループモード**: 部署別（最上位系統でクラスタリング・循環参照防御あり）/ モデル別（`MODEL_CATALOG` の順）/ 稼働状態別（稼働中 / 待機 / 未紐づけ）のチップ切替で再クラスタリング。
- **設定 `claudeManager.orgChart.defaultMode`**（`graph` / `tree` / `group`、既定 `graph`）を新設。

### 🎨 テーマ（設計判断）

- **グラフモードはダーク固定**（モックの宇宙感を尊重、Canvas 色計算の二重管理を回避）。CHANGELOG に判断を明記。
- **階層 / グループは `var(--vscode-*)` でテーマ追従**（Light / High Contrast にも自動対応）。

### 🧪 テスト（Q1〜Q12、12 件新規追加）

- **Q1〜Q6**: `orgChartEngine` の純ロジック — `computeNodeRadius` / `simulateStep`（位置更新 + drag 固定 + 境界クランプ） / `computeNeighbors` / `groupByDept`（循環参照防御含む） / `groupByModel`（カタログ順） / `groupByStatus`
- **Q7〜Q9**: `collabLog` — 7 日窓集計 + `latestTs` / 存在しないファイルの空配列（サイレント） / 合成 JSONL の読み取り + 破損行スキップ
- **Q10**: `package.json` に `orgChart.defaultMode` / `orgChart.hideOtherProjects` 設定が宣言されている
- **Q11**: Cytoscape / ELK ライブラリの実利用が撤去されている（resources/ ファイル削除 + import/require/グローバル参照が消えていること）
- **Q12**: `csm-ask-agent.py` に `append_collab_log` 関数と `CSM_AGENT_NAME` 環境変数対応、失敗時サイレント（`pass`）が入っている
- **69 → 81 pass**

### 🗑 破壊的変更 / 撤去

- **`resources/cytoscape.min.js` / `resources/cytoscape-elk.js` / `resources/elk.bundled.js` を `.trash/orgchart-v0.5.22/` へ退避**（rm 禁止ルール準拠）。
- `orgChartPanel.ts` は Cytoscape の `webview.asWebviewUri` 経路と CSP 追加ホストを撤去。CSP を `default-src 'none'` に絞りつつ `style-src` に `unsafe-inline` を追加（Canvas + 動的 style の必要最低限）。
- `showOrgChart` の `extensionUri` 引数は互換のため残置（呼び出し元は無変更）。

### 📖 ドキュメント更新

- **README.md**: 「🌳 組織図」節を全面刷新（Cytoscape.js 表記撤去、新 3 モード + 連携 + ワークスペース減光を追記）。変更履歴に v0.5.23 追加。
- **guide.html**: セクション 7「エージェント組織図」に **v0.5.23 リデザイン** 段落を追加（メイン / サブ / 連携 / ワークスペース / Cytoscape 撤去）。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **81 / 81 pass**（69 → 81、Q1〜Q12 追加）。
- `package.json` `0.5.22` → **`0.5.23`**、`orgChart.defaultMode` / `orgChart.hideOtherProjects` の 2 設定を新設。

### 判断・見送り事項

- **モックの「案C 放射状マップ」は移植せず** — メイン（グラフ）と階層 / グループの 3 モードで用途を満たすと判断。将来ユーザ要望が出れば別 Sprint で追加。
- **PNG / SVG エクスポート**は Canvas ベースへの移行に伴い一旦撤去。将来 `canvas.toBlob()` で PNG 復活は容易だが、需要が低いため今回はスコープ外。
- **`onOpenInClaude` コールバックは実質未使用**（クリック時は `openSession` に統一）。旧 API は温存し、将来ノード右クリックメニュー実装時に再利用できるようにする。
- **物理停止ボタン**はモックにあったが未実装（`prefers-reduced-motion` で十分と判断）。
- **collab-log の書き込みは `csm-ask-agent.py` の `get_agent_info` 経路のみ**。`--list` / `--pending` は集計対象外（コマンド発行者と受信者の関係が薄いため）。
- **モックの HTML との差分**: モックはハードコード 17 エージェントだが実装は `dataStore.getAgents()` から動的取得。ノード ID は `agent.name`、色は `MODEL_CATALOG.colorHex` から取得。
- **`csm-collab-log.jsonl` の肥大化対策**（ローテーション等）は未実装 — 現状 1 行 100 バイト前後 × 週 100 回程度で問題なしと想定。将来 1 万行を超えたら別 Sprint で対応。
- **Cytoscape 復活**は仕様上ない想定のため撤去確定。将来グラフ描画が必要になったら新設で対応する。

## v0.5.22 (2026-07-13) — CC 追従スプリント（P0 バックログ + 死蔵撤去 + Fable 5d 投機追加）

`docs/v0.6.0-roadmap.md` の P0 積み残しと QA レポート §5 の要確認事項を一括対応。CC 2.1.20x（実機確認: 2.1.207）に追従。**破壊的変更として `claudeAgentsService.ts` と `claudeManager.claudeAgentsIntegration.*` 4 設定を撤去** — 移行注記は下記参照。

### ➕ P0: sessions/*.json の公式メタを活用（T6-1.3〜1.5）

- **`agentWatcher.update()` が `kind` / `entrypoint` / `version` / `name` / `nameSource` / `agent` を収集** し、`sessionMetaMap` に保持。`AgentWatcherState` にも `sessionKind` / `sessionName` / `sessionAgent` 等を露出。
- **`orchestrationViewModel.buildOrchestrationViewModel` を公式 `kind` 優先に切替**:
  - `kind === 'background'` は公式値を最優先で信頼
  - kind が空 or `'interactive'` のときのみ、従来の `subagents.length >= 3` ヒューリスティックにフォールバック
  - サブエージェント数だけで background 誤判定していた既存バグを解消
- **ライブ表示のセッションタイトル**: 「CSM 表示名 > **CC 公式 `name`** > sessionId 先頭 8 文字」の優先順に。`nameSource`（例: `derived`）は tooltip の CC バージョン・entrypoint と並べて表示。
- **`agent` フィールド活用**: `sessions/*.json` に `agent` が入っていれば（`--agent` 起動セッション）、`processedAutoLinkSids` に無い sid に対して agentSessions を即時補強。JSONL の `agent-setting` より確実な公式値優先のハイブリッド。T6-1.6（完全置換）は P1 のため今回は補強に留める。

### 🗑 T6-1.1/1.2: 死蔵撤去（**破壊的変更**）

- **`src/services/claudeAgentsService.ts`（515 行）を撤去** — TTY 必須で拡張ホストから呼び出せない `claude agents --json` CLI 呼び出し系。`.trash/claudeAgentsService.ts.20260713` に退避（rm 禁止ルール準拠）。
- 型と `formatElapsed` は **`src/services/liveAgentTypes.ts`** に切り出し、`agentLiveTreeProvider` と `orchestrationTreeProvider` から参照。
- **`extension.ts` の配線を削除** — `ClaudeAgentsService` の new / onDidChange / `supplementLiveFromClaudeAgents` 呼び出しを撤去。`orchestrationProvider.setClaudeAgentsService` も撤去し、`buildOrchestrationViewModel` は `agentWatcher` 単独版へ書き直し。
- **`agentWatcher.supplementLiveFromClaudeAgents` メソッドを削除**（v0.5.22 で呼び出し元がゼロ）。
- **package.json の廃止設定 4 種を完全削除**:
  - `claudeManager.claudeAgentsIntegration.enabled`
  - `claudeManager.claudeAgentsIntegration.pollingIntervalMs`
  - `claudeManager.claudeAgentsIntegration.scopeToWorkspace`
  - `claudeManager.claudeAgentsIntegration.showUnregistered`
  - **移行注記**: v0.5.21 で「（廃止予定）」プレフィックス付きだったこれらの設定は本 v0.5.22 で削除。ユーザー設定に残っていても VS Code は無視するだけで害はない。「未登録セッション表示」は `claudeManager.agents.showUnregisteredLive`（既定 true）に置換（agentLiveTreeProvider で参照）。
- **agentLiveTreeProvider の重複データソース分岐を撤去**、agentWatcher 単独動作に。tooltip の source 表記も「sessions/*.json + JSONL 監視（PID ベース）」に更新。

### 🔧 effort=max を全モデル選択可に緩和

- 前提（`claude --help` 表記）: `--effort low|medium|high|xhigh|max` にモデル制限の記載なし。
- **`modelCatalog.MODEL_CATALOG` の `allowsMaxEffort` を全モデル `true`** に変更（従来: Opus / Fable 系のみ true）。
- フォームの Max ラジオ説明を「最大（コスト大 — 上位モデル推奨）」に更新。UI の連動グレーアウトは撤廃せず、`ALLOWS_MAX_MODELS` が全モデル含む形で自然と全モデル有効化。
- `types.ts` のコメント・README・SPEC で「Opus / Fable 専用」表記を撤去し「全モデル可・コスト大につき上位モデル推奨」に統一。

### ➕ Fable 5d 利用率枠を投機的追加

- **`UsageData` に `usageFable5d` / `resetFable5d` を追加**。
- **ヘッダ候補**: `anthropic-ratelimit-claude-fable-5d-utilization` / `anthropic-ratelimit-fable-5d-utilization` / `anthropic-ratelimit-unified-fable-5d-utilization`（Sonnet/Opus と同パターン 3 種）。
- **`USAGE_MULTIDAY_COLUMNS` に `fable-5d` 列を追加**（label `F`、longLabel `Fable 5日`）— 既に配列駆動化（v0.5.17 §4-2）されていたため 1 行追加のみ。
- **ヘッダ非提供時は `-1` でグレースフルフォールバック** — 既存の `>= 0` 判定で自動的に非表示（statusBar / tooltip / 警告色判定・通知フラグすべて）。
- **通知フラグを配列駆動化** — 個別 `notifiedSonnet5d90` 等の Boolean を `notified5dFlags: Record<key, {at90, at100}>` に統合。列追加時にフラグ変数を増やさなくて済む。

### 📖 README / guide 追従状況更新

- `README.md` 追従状況節を「確認日 2026-07-13 / CC 2.1.20x 系」に更新。
- **fast mode 非対応**を明記（根拠: `claude --help` に CLI オプション無し）。CSM 側で per-agent 設定はしない。
- **effort の max はモデル制限無し**を明記。
- **sessions/*.json 公式値活用**の項目を追記（`kind`/`name` 等）。
- **ライブデータ源**を「sessions/*.json + PID 監視のみ」に整理し、`claude agents --json` 撤去を明記。

### 🧪 テスト

- **K1 / K2 を v0.5.22 の 3 列（fable-5d 追加）に更新**（`data` オブジェクトに `usageFable5d/resetFable5d` を追加）
- **K3**（新規）: Fable 5d のグレースフルフォールバック — ヘッダ非提供時（-1）は非表示、提供時（>=0）は F 列が出ることを検証
- **O1**（新規）: modelCatalog.allowsMaxEffort が全モデル true
- **O2**（新規）: SessionMeta / AgentWatcherState 拡張フィールドが types.ts に定義されている（ソース静的検証）
- **O3**（新規）: `src/services/claudeAgentsService.ts` が撤去済み + `liveAgentTypes.ts` が新設されている
- **O4**（新規）: `claudeManager.claudeAgentsIntegration.*` 設定 4 種が package.json から削除されている
- **58 → 63 pass**（K3 + O1〜O4 の 5 テスト追加）

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **63 / 63 pass → レビュー修正で 69 / 69 pass**（P1〜P6 の 6 回帰テスト追加、O2 は静的検証を実型に更新）。
- `package.json` `0.5.21` → **`0.5.22`**。

### 🔍 コードレビュー修正ラウンド（v0.5.22 コミット前）

CRITICAL / HIGH 0、MEDIUM 3・LOW 4 の 7 件を全対応（コミット前差戻し）。

- **M1** `agentLiveTreeProvider` のラベル生成に **`entry.sessionName`（CC 公式 name）を挿入**。優先順位: `linkedDisplayName` → `agentName` → **`sessionName`** → sid 先頭 8 文字。CC が付与する識別性の高い `xampp-07` 等が未紐づけセッションでも表示される。
- **M2** `sessions/*.json` の **`startedAt` を収集して経過秒を実測値で計算**。`agentWatcher.update()` が `SessionJsonMeta.startedAt` を保存し、`orchestrationViewModel` が `Math.floor((now - startedAt) / 1000)` で算出。`startedAt` 不明時は `elapsedSec = undefined` を返し、`orchestrationTreeProvider` 側で経過時間行を非表示（虚偽の `00:00:00` を撤廃）。
- **M3** `claudeManager.agents.showUnregisteredLive` を **`contributes.configuration` に正式宣言**（type: boolean, default: true）。旧 `claudeAgentsIntegration.showUnregistered` からの後継である旨を description に明記。CHANGELOG の移行注記と判断事項の矛盾も解消。
- **L1** `agentWatcher` の agent 補強ループで **`setAgentSession=false`（既存紐づけあり）でも `processedAutoLinkSids` にマーク**。次回 update で同一 sid の再試行を回避し、JSONL `agent-setting` 経路との実行順序の暗黙依存を解消。`agentDef=null` の未登録エージェント名や try/catch 内例外の場合はマークしない（後から登録される可能性を保持）。
- **L2** `orchestrationViewModel` の kind 判定ロジックを **公式 kind の厳密優先** に修正。旧: `(!meta?.kind || kind === 'interactive') && subagents.length >= 3` は公式 `interactive` を上書きしていた。新: `meta?.kind === undefined && subagents.length >= 3` — 公式値が明示的に interactive を指定していれば、サブエージェント数に関係なく interactive として扱う。
- **L3** `agentWatcher.ts` に 3 か所複製されていた匿名 `{ kind?, entrypoint?, ... }` 型を **`liveAgentTypes.SessionJsonMeta` に一本化**。`types.ts:SessionMeta`（`sessions/*.json` 全体像）はドキュメント兼テスト用として保持し、`startedAt` 追加。O2 テストを実型検証（import + 型使用箇所の grep）に更新。
- **L4** `orchestrationTreeProvider._buildRoot` に **`watcher.isEnabled()` ガード** を追加。監視 OFF 時は「エージェント監視が無効です」を `agentLiveTreeProvider` と同じ体裁で表示。空配列返却で sessions=0 の集計を出す誤解を防止。

**新規テスト（P1〜P6）**: 6 件すべて静的ソース検証で MEDIUM/LOW 各修正の実装を確実にトラップ。将来リグレッションで CHANGELOG の記載と実装が乖離した場合に即検出できる。

### 判断・見送り事項

- **T6-1.6（agent フィールド完全置換）は P1** のため今回は補強のみ。JSONL 内 `agent-setting` 経路と並列で動作。
- **~~`sessions/*.json` の `startedAt` を orchestration に伝播~~**（v0.5.22 レビュー修正 M2 で実施完了）
- **claudeAgentsService の TTY 復活**は仕様上ない想定のため撤去確定。将来 CC 側で子プロセスから叩ける JSON API が復活したら新設で対応する。
- **`agents.showUnregisteredLive` 設定**は **v0.5.22 レビュー修正 M3 で `contributes.configuration` に正式宣言**（既定 true）。旧設定 `claudeAgentsIntegration.showUnregistered` のユーザ設定値は自動移行されないが、既定 true の新設定で従来と同じ挙動が続く。

## v0.5.21 (2026-07-10) — Marketplace 公開前のドキュメント・文言整備（コード変更なし）

v0.5.14 〜 v0.5.20 の大量の機能追加に伴って積み上がった、ユーザー向けテキストの陳腐化・不整合を一掃した。**コードのロジック変更はなし**、文言と設定 description・コマンドタイトル・ドキュメントの更新のみ。

- **QA 対応（品質管理部レビュー、`docs/qa-text-review-v0.5.21.md`）**: HIGH 1 件（guide.html セクション 5 アンカーを id 方式へ修正）/ MEDIUM 4 件（README の CLI で開く cwd フォールバック追記、エージェント右クリック表を現行メニューに更新、SPEC.md の monitor 系デフォルト訂正、`locale` / `ui.defaultTab` の文言統一）/ LOW 6 件（設定一覧に `ui.defaultTab` / `locale.autoTranslate` 追記、モデル版数の「最新世代」寄せ、Walkthrough 起動導線を日本語化、`ONにする` / `APIへの` の半角スペース挿入、セッション/会話の用語方針明示）を全件反映。**LICENSE ファイルの存在を実プロジェクトで確認** — `.vscodeignore` で除外されておらず、パッケージに同梱される（README `[MIT](LICENSE)` リンクと整合）。判断: L-6（スクリーンショット/GIF 追加）は公開後フォローアップとして本 Sprint 対象外。

### 📖 README.md — 恒常構成に再編（機能別）

- **Sprint 毎の「v0.5.x 新機能」節が細切れに散っていた構成を撤去**し、以下の機能別セクションに整理:
  - 💬 会話管理 / 📜 会話ビューワー（v0.5.20 で高速化）/ 👤 エージェント管理 / 🎼 オーケストレーション / 🧠 メモリ管理 / 📁 プロジェクト管理 / 🌳 組織図 / 📊 利用制限モニター / 🎨 UI カスタマイズ / 🧭 オンボーディング / 🔒 セキュリティ
- **設定項目の一覧を全面刷新** — v0.5.17 〜 v0.5.20 で追加した 10 件以上の設定を漏れなく反映:
  - `usage.statusBarStyle` / `sessions.descriptionFields` / `sessions.expandRecentDateGroupsOnly` / `sessions.showFileSize` / `ui.showTabBar` / `preview.initialMessages` / `preview.maxMessageBytes` / `agents.expandMode` / `agents.activeOnly` / `agents.defaultGroupMode`
- **コマンド一覧を機能別カテゴリに再編** — セッション / エージェント / メモリ・プロジェクト・利用制限 の 3 グループに整理。v0.5.17 〜 v0.5.18 で追加された `searchAgents` / `groupAgents` / `toggleAgentActiveOnly` / `enableAgentMonitor` を反映。
- **冒頭の対応バージョン表記を更新** — 「CC 2.1.19x 系 / 2026-07 時点」の追従状況を明記。
- **クイックスタートを Get Started ウォークスルー中心の構成に更新**（v0.5.18）。
- **末尾に「変更履歴」節** — v0.5.14 以降の主要バージョンの 1 行サマリ + CHANGELOG.md への誘導。

### 📗 guide.html — 新機能の説明追加と旧記述の更新

- タイトル・ヒーローバージョンを **v0.4.4 → v0.5.21** に更新。
- **セクション 5「会話プレビュー」を「会話ビューワー」に改題**し、v0.5.20 の遅延読み込み仕様（末尾 N 件・追加読み込みボタン・巨大メッセージ切り詰めと『全文を表示』・表示中のメッセージから検索）と v0.5.19 の 2 ボタン（Claude で開く / CLI で開く）を全面追記。
- **末尾に「v0.5.14 〜 v0.5.21 新機能ハイライト」セクションを新設** — Fable 5 解禁 / ビューワー高速化 / エージェント検索 / グループ表示切替 / 稼働数バッジ / 対話中プレフィックス / ステータスバー表示モード / 日本語ラベル統一 / description 構成 / Get Started ウォークスルー / Activity Bar 削減 / 組織図検索 / タブバー非表示化 を段落単位で説明。

### 📕 package.json — 表記統一（文言のみ）

- **`displayName`** — `Claude Session Manager - セッション履歴管理` → `Claude Session Manager — 会話履歴・エージェント運用`（機能スコープを明示）
- **`description`** — Marketplace の商品説明として、対応機能（ブックマーク、タグ、検索、組織図、大容量セッション高速ビューワー、利用制限モニター）を列挙するよう更新。
- **コマンド title の表記統一**:
  - 「Claudeで開く」→ 「Claude で開く」「Claude Code で開く」（半角スペース挿入）
  - `セッションIDをコピー` → `セッション ID をコピー`（同名重複コマンドの表記を統一）
  - 「オーケストレーション更新」→ 「オーケストレーションを更新」
  - 「グループ切替」/「エージェント表示グループを切替」→ 「グループ表示を切替」「エージェントのグループ表示を切替」
  - 「プロジェクト/全て切替」→ 「プロジェクト内 / すべて を切替」
  - `ブックマークから削除` → `ブックマークを解除`
  - `ソート` → `ソート順を切替`
  - `確認待ち一覧` → `確認待ち一覧を表示`
  - `/csm-ask-agent hookをインストール` → `/csm-ask-agent フックをインストール`
- **設定 description の「です・ます」寄せ + 全半角統一**:
  - 未対応セッションフィルタ / ソート / グループ / タスクログ関連の説明文を全面「です・ます」調に統一（例: `stalled判定の閾値` → `応答停止（stalled）判定の閾値`）
  - `OFFにすると` → `OFF にすると`、`会話一覧のフィルターモード` → `会話一覧のフィルターモードです`
  - モデル別・状態別の「グルーピング」→ 「グルーピング」と「グループ表示」の混在を意識的に許容（前者は内部用語）
  - `Activity Bar` → 「アクティビティバー」（VS Code 日本語 UI 表記に統一）
- **廃止予定設定の明示** — `claudeManager.claudeAgentsIntegration.*` の 4 設定に「（廃止予定）」プレフィックスを追加。

### 📘 SPEC.md — 主要乖離のみ最新化

- 冒頭を「v0.5.21 時点」に改題し、**v0.5.14 / v0.5.17 / v0.5.18 / v0.5.19 / v0.5.20 の主要変更を各 1 行で追記**。
- **エージェント登録フォームの入力項目表**を最新化 — 「未設定（継承）」の概念、`permissionMode` / `allowedTools` / `isolation` / `background` / `maxTurns` / `effort` の Max の Fable 系対応を明記。
- 全面改稿はスコープ外のため、他セクションは温存。

### 🎯 UI 文言 — 今日追加した文字列の統一

- webviewPanel の会話ビューワー:
  - `▶ Claudeで開く` → `▶ Claude で開く`
  - `⌨ CLIで開く` → `⌨ CLI で開く`
  - ボタンツールチップ「このセッションをClaude Code拡張の画面で開きます」→ 「このセッションを Claude Code 拡張の画面で再開します」（半角スペース挿入 + 動詞統一）
  - CLI ボタンツールチップの表現を「新規ターミナルの claude CLI」→ 「新規ターミナルで claude --resume として」に統一
  - 「以前のメッセージを読み込む」ボタンの tooltip を「末尾から N 件のみ初期表示中」→ 「末尾から一定件数のみ初期表示中です」に整理
  - 検索プレースホルダは v0.5.20 の「表示中のメッセージから検索」を維持しつつ、tooltip の説明を「▲ 以前のメッセージを読み込むで対象範囲を広げられます」と誘導

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **58 / 58 pass**（コード変更なし・退行なし）。
- `package.json` `0.5.20` → **`0.5.21`**、設定・コマンドの追加削除なし（文言変更のみ）。

### 判断・見送り事項

- **guide.html の HTML 構造は温存**（Marketplace ページから直接は開かないため、大幅リフレッシュは Sprint 外）。冒頭バージョンと該当セクションの本文追記のみに絞った。
- **`claudeManager.claudeAgentsIntegration.*` の 4 設定**は「廃止予定」プレフィックスを追加したのみで、実際の削除は互換のため保留。将来 Sprint で撤去判断。
- **既存コマンド ID の名称変更は行っていない**（外部の keybindings や `/csm-ask-agent` 等の参照を壊さないため、title のみ変更）。
- **`SPEC.md` の全面刷新はスコープ外**として、モデル選択肢・ビューワー仕様・ボタン構成・フォーム項目の 4 点のみ最新化。

## v0.5.20 (2026-07-10) — セッションビューワーの起動高速化（遅延読み込み + tail リーダー）

背景: `parseSessionFile` の readFile 一括 + 全行 JSON.parse と、`getSessionHtml` の全メッセージを正規表現 markdown 変換して巨大 HTML を一括生成する構造で、実環境の 276MB / 154MB 級 JSONL では **ビューワーが開くまで数秒〜数十秒** かかっていた。

目標: **どんなサイズのセッションでも初期表示が体感 1 秒以内**。

### ➕ (1) 遅延読み込み — 末尾 N 件だけ初期描画

- 新設定 **`claudeManager.preview.initialMessages`**（既定 `200`、min 20 / max 2000）: 初期表示するメッセージ件数（末尾から）。
- ヘッダに **「▲ 以前のメッセージを読み込む」** ボタンを追加。クリックで拡張側から前の N 件を取得 → webview に postMessage → `insertAdjacentHTML('afterbegin', ...)` で先頭に差し込む（HTML 全体は再構築しない）。
- **タグ追加・削除経路（既存の setHtml 再構築）はそのまま**維持（メタ変更でメッセージ表示は初期状態にリセット。UX トレードオフとして許容）。

### ➕ (2) tail リーダー — 全文 readFile を回避

- **`readTailLines(filePath, maxLines, stopAtOffset?)`** を新設。fs.open + 1MB 単位のチャンク逆読み。
  - **境界の途中で切れた行**は residual として次チャンクの末尾に持ち越し（欠損・重複ゼロ）
  - **maxLines 到達時の cursor 位置を精密に計算**（未処理領域の末尾位置 = `chunkStart + partial.byteLen + unprocessedText.byteLen`）→ オンデマンド追加読みで重複しない
  - `reachedHead` は `!earlyBreak && cursor === 0`
- **`loadSessionTail(filePath, maxInitialMessages, showThinking)`** で初期表示用の `ParsedSession` を末尾 N 件だけで構築。
  - user/assistant 以外のメタ行が混じる想定で **`targetLines = max(maxInitial * 4, 100)`** を tail に確保
  - メタデータ（cwd / model / sessionId / firstUserMessage / claudeTitle）が tail で欠ける場合は **先頭 64KB** を追加で読み補完
- **`loadOlderMessages(filePath, stopAtOffset, max, showThinking)`** で追加取得。
- **判断: readline + リングバッファ方式（全文 stream）は 276MB 全体を読むためディスク帯域律速**。1MB tail 読みは典型的な NVMe で数十 ms のため、末尾チャンク逆読み方式を採用。CHANGELOG に明記。
- **軽量最適化**: `parseLinesToMessages` 内で `line.length < 20` の行は JSON.parse せずスキップ。

### ➕ (3) 巨大ツール出力の抑制 — 4KB 上限 + オンデマンド全文取得

- 新設定 **`claudeManager.preview.maxMessageBytes`**（既定 `4096`、min 512 / max 65536）。
- 1 メッセージの初期描画は上限まで切り詰め、超過分は **「全文を表示（<bytes>）」ボタン** に置換。
- ボタンクリック → webview から `{ type: 'loadFullMessage', uuid }` を postMessage → 拡張側で **`loadSingleMessageByUuid(filePath, uuid)`** が末尾からチャンク逆読みで uuid 一致行を探索（`substring(uuid)` 判定で JSON.parse スキップ）→ 全文を返送 → 該当 message の content を差し替え + ボタン削除。
- **初期 HTML に隠し全文を埋め込まない**（サイズ削減が目的）。
- `SimpleMessage` に `uuid?` / `fullBytes?` を追加。`uuid` が JSONL に無い古いセッションは切り詰めのみで「…以降省略」の静的表示に fallback。

### ⚠️ 検索の挙動変更

- クライアント側検索（`#searchInput`）は **読み込み済みメッセージが対象**（従来は全文）。placeholder と title に **「表示中のメッセージから検索」** を明記。仕様書許容範囲。

### 🧪 テスト（新規追加 N1〜N6、合計 52 → 58 pass）

- **N1**: `readTailLines` — 末尾 N 行を昇順で返す + 先頭到達判定
- **N2**: `readTailLines` — 1MB 境界跨ぎ（約 6MB × 3000 行の合成 JSONL）で欠損・重複が発生しないこと
- **N3**: `loadSessionTail` — 末尾 N 件だけで ParsedSession を構築 + head fill でメタ復元
- **N4**: `loadOlderMessages` — `oldestByteOffset` を渡して続きを重複なく取得、時系列順序が維持される
- **N5**: `loadSingleMessageByUuid` — 中央付近の uuid を大ファイルから取り出す + 存在しない uuid は null
- **N6**: `loadSessionTail` — 小さいファイルは `hasOlder=false` で全件返る
- 巨大ファイル（数百 MB）テストは合成 JSONL で代替可能と判断し、6MB×3000 行を上限に設定（テスト実行時間 < 100ms）
- テストハーネスは修正済み USERPROFILE 隔離 + fail-fast ガードを踏襲、一時ファイルは `os.tmpdir()` 配下（`setupTmpHome` の `.claude` サブディレクトリ）

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **52 → 58 pass**（N1〜N6 追加、既存に退行なし）。
- `package.json` `0.5.19` → **`0.5.20`**、新設定 2 件（`preview.initialMessages` / `preview.maxMessageBytes`）を追加。

### 判断・見送り事項

- **タグ追加・削除で HTML を再構築する経路**は変更せず（既存 UX 変更の副作用を回避）。**メッセージ表示は初期 N 件にリセット**され、追加読み分は失われる。副作用として許容。
- **検索範囲**: グローバル検索（拡張側でファイル走査する方式）は本 Sprint スコープ外。将来 Sprint で対応候補。
- **thinking ブロック**: `loadOlderMessages` / `loadSessionTail` にも `showThinking` を渡し、既存挙動を維持。
- **uuid が無い古いセッション**: 全文取得ボタンは表示せず「…以降省略」の静的表示。
- **loadSessionFull は残す**: tail 経路が万一失敗した場合のフォールバックとして残置（現行の parseSessionFile 呼び出し互換）。

## v0.5.19 (2026-07-09) — 「Claudeで開く」を拡張UIで開くよう変更 + CLIボタン分離

ユーザーフィードバック対応: v0.5.15 の「▶ Claudeで開く」がターミナルで CLI を起動していたが、
期待される挙動は Claude Code **拡張の画面**で開くことだった（セッションツリー右クリックの
`claudeManager.openInClaude` は元から正しい挙動）。

### 🔧 変更
- **「▶ Claudeで開く」** — 右クリックメニューと同一経路（`<uriScheme>://anthropic.claude-code/open?session=<id>` の URI ハンドラ）で **Claude Code 拡張の UI** を開くよう変更。
- **「⌨ CLIで開く」** — 従来のターミナル起動（作成時 cwd で `claude --resume`）は別ボタンとして存続。cwd 依存の注意書きはこちらの tooltip に移動。
- webview → 拡張のメッセージは `openInClaude`（拡張UI）/ `openInClaudeCli`（ターミナル）に分離。

## v0.5.18 (2026-07-09) — Sprint C-2: UX 改善 6 件（最終バッチ）

### 🔍 コードレビュー修正ラウンド（Sprint C-2 レビュー時点）

Sprint C-2 実装後のコードレビュー（CRITICAL 1 件・HIGH 3 件・MEDIUM 2 件）で検出した以下 6 件を追い込み修正（本 v0.5.18 に含める）。

#### レビュー修正 (1) [CRITICAL] — installCsmAskAgent の二重登録で activate() が失敗

- **症状**: `claudeManager.installCsmAskAgent` を `migrationCommands.ts:272`（既存の本実装）と `agentCommands.ts:174`（Sprint C-2 で追加した walkthrough 用ラッパー）の両方が `registerCommand` していた。VS Code の `commands.registerCommand` は同一 id の二重登録で例外を投げる。`activate()` は try/catch なしのため拡張全体のアクティブ化が失敗し、起動クラッシュ。
- **package.json 側の重複**: `contributes.commands` にも同 id が 2 件（403 行 / 610 行、タイトルが「/csm-ask-agent スキルをインストール」と「/csm-ask-agent をインストール」で不一致）。VS Code は Command Palette に両方表示してしまい混乱。
- **修正**:
  - `agentCommands.ts` 側の walkthrough 用ラッパーを削除。walkthrough step は既存の `migrationCommands.ts:272` 実装をそのまま呼ぶ。
  - `package.json` の 403 行側（Sprint C-2 追加分）を削除し 610 行側の 1 件だけを維持。
- **再発防止テスト（新規追加）**:
  - **M1-a**: `package.json` の `contributes.commands` を Map で数え上げ、重複 id が 0 件であることを保証。
  - **M1-b**: `src/**/*.ts` を静的スキャンして `vscode.commands.registerCommand('id')` 呼び出しを検出、同一 id が 2 か所以上あればエラーメッセージ付き `assert.fail`。以降どの Sprint でも同種の起動クラッシュを事前検知できる。

#### レビュー修正 (2) [HIGH] — 組織図の dimm 表示が canvas 描画に反映されない

- **症状**: `orgChartPanel.ts:272` の `.cy-node-dimmed { opacity: 0.2 }` は CSS ルール。Cytoscape は canvas 描画のため CSS はデッドコードで、検索・凡例チップの半透明化が全く効いていなかった。
- **修正**:
  - `buildStyle()`（543 行付近）の style 配列に `{ selector: '.cy-node-dimmed', style: { opacity: 0.2 } }` を追加。
  - CSS 側の `.cy-node-dimmed` ルールを撤去（コメントで撤去理由を明記）。
- **判断**: CSS 側の記述はテンプレートリテラル内のためバッククォート含み文字列を書けない制約があり、コメントは通常の全角/半角引用符で記載。

#### レビュー修正 (3) [HIGH] — グローバルエージェントの getParent が undefined を返し reveal 失敗

- **症状**: `agentTreeProvider.ts:199-205` の `getParent()` は `parentAgent` が無いケースを一律 `undefined` として返していたが、グローバルエージェント（`parentAgent` 無し + `shouldShowInOrgChart=false`）は実際は `GlobalAgentsSectionItem` の子として描画される。VS Code の `TreeView.reveal(item)` は親を辿れないと「該当要素なし」で失敗するため、`searchAgents` からグローバルエージェントを reveal しようとすると常にエラー。
- **修正**:
  - `GlobalAgentsSectionItem` の単一インスタンスを `lastGlobalSectionItem` にキャッシュ。
  - `getParent()` で `parentAgent` が無いケースは `shouldShowInOrgChart(agent)` を見て、false なら `lastGlobalSectionItem` を返す。true（トップレベル）なら従来どおり `undefined`。
  - `refresh()` でキャッシュを初期化。

#### レビュー修正 (4) [HIGH] — グルーピングモード配下で AgentItem が展開不能

- **症状**: `agentTreeProvider.ts:243`（GroupNodeItem 分岐）で `new AgentItem(a, ..., false, false, ...)` と hasChildren=false 固定。サブエージェント・タスクログを持つエージェントも Collapsed 不能で、`model`/`status`/`flat` モードで組織構造が消失。
- **修正**:
  - `GroupNodeItem` 分岐でも `org` モードと同じ `childMap`（親名 → 子エージェント[]）を計算し、`getVisibleTasksFn` でタスクログ有無も判定。
  - `hasChildrenFlag = childMap.has(a.name) || hasTasks` を `AgentItem` の 5 番目の引数に渡す。
  - AgentItem 分岐（既存）でサブエージェント / タスクログ描画するため、この修正で全モード共通に組織構造が復活。

#### レビュー修正 (5) [MEDIUM] — dispose() で _onDidChangeBadge がクリーンアップされない

- **症状**: Sprint C-2 で追加した `_onDidChangeBadge` EventEmitter が `dispose()` で解放されず、拡張再読み込み時にリソースリーク。
- **修正**: `dispose()` に `this._onDidChangeBadge.dispose()` を追加。

#### レビュー修正 (6) [MEDIUM] — mainTabPanel の残 #64b5f6 直書き

- **症状**: `mainTabPanel.ts:1124`（`.scope-project`）と `:1301`（`.tag-chip`）が Sprint C-2 の §4-10 テーマ追従から漏れて `color: #64b5f6` 直書きのまま。隣接ルール（`.memory-type-user`）は `var(--vscode-charts-blue)` に更新済みで不整合。
- **修正**: 2 か所を `var(--vscode-charts-blue, #64b5f6)` に統一。

### 検証（レビュー修正含む v0.5.18 最終）

- `npx tsc --noEmit` クリーン。
- `npm test`: **50 / 50 → 52 / 52 pass**（M1-a / M1-b の 2 テストを新規追加）。
  - **M1-b（registerCommand 静的重複チェック）は同種の CRITICAL バグを本 Sprint 以降で自動検知**する再発防止装置。
- テストハーネスは修正済み USERPROFILE 隔離 + fail-fast ガード維持。

### レビュー修正の判断・見送り事項

- **installCsmAskAgent 実装の統合**: `migrationCommands.ts` の既存実装が本命処理（テンプレートコピー・古い .sh 退避・refreshAll）を持つため、Sprint C-2 のラッパー側を撤去する形で解消。walkthrough は既存コマンドを直接呼ぶ設計に整理。
- **`agentCommands.ts` から `refreshAll` の削除**: 撤去したラッパーで `refreshAll` は使っていなかったため import 影響なし。
- **静的テストの適用範囲**: `src/commands/` `src/panels/` `src/extension.ts` に限定。他ディレクトリの新設時は必要に応じて walk 対象を拡張する。


仕様書 `docs/v0.5.x-fable-qa-20260709.md §4` の UX 改善 12 件のうち、Sprint C-1 で実装した 5 件（§4-1/2/5/6/12）に加え、本 Sprint C-2 で残り **§4-4 / §4-7 / §4-8 / §4-9 / §4-10 / §4-11** を実装。**§4-3（1M 上付き数字化）は前 Sprint 継続で保留**（現行の頭文字統一設計を尊重）。

### 🌱 §4-4 ライブ視認性

- **TreeView.badge API** で `claudeAgents` / `claudeAgentsLive` ビューアイコンに稼働数バッジを表示。
  - `AgentTreeProvider.updateBadge()` を新設し、`setWatcherStates()` の後に稼働数を再計算 → `onDidChangeBadge` イベントで extension.ts に通知 → `view.badge = { value, tooltip }` を反映。
  - tooltip は「N 件のエージェントが稼働中（登録 M 件中）」。
- **『稼働中のみ表示』フィルタトグル** — 新コマンド `claudeManager.toggleAgentActiveOnly` + 設定 `claudeManager.agents.activeOnly`（既定 `false`）。ツールバーに `$(filter)` アイコン追加。
  - 稼働中のエージェント本体だけでなく、その先祖ノード（親子連鎖）も残す実装で組織階層を維持。
- **description を『セッションタイトル + 経過時間』に絞る** — 旧 description の 👁/🙈（組織図表示フラグ）は tooltip の「表示」行へ移動。
  - 経過時間は `[対話中]` プレフィックスと重複しないよう `セッション名 · 5分` の形で出す（`isLive && !isOtherProject && mtimeMs !== undefined`）。
- **起動時の展開状態を設定化** — 新設定 `claudeManager.agents.expandMode`（`all` / `active-branches` / `top-level`、既定 `active-branches`）。
  - `active-branches`: 稼働中エージェント（子を持つ場合）のみ Expanded で初期化、それ以外は Collapsed。

### 🧭 §4-7 オンボーディング

- **`contributes.walkthroughs`** で 5 ステップの `csmGettingStarted` を新設:
  1. Claude Code の確認（`claudeManager.openUsageMenu`）
  2. 取締役を登録（`claudeManager.registerDirector` / `onContext:claudeManager.hasAgents`）
  3. `/csm-ask-agent` スキルをインストール（`claudeManager.installCsmAskAgent`）
  4. エージェント監視を有効化（`claudeManager.enableAgentMonitor` / `onSettingChanged:claudeManager.enableAgentMonitor`）
  5. 組織図を開く（`claudeManager.openOrgChart`）
- 各ステップの `completionEvents` に対応コマンド or 設定変更イベントを紐づけ、実行で自動チェック済みになる。
- 各ステップに Markdown 説明ファイル（`media/walkthrough/step[1-5].md`）を配置。
- `viewsWelcome` を **`claudeSessions` / `claudeMemory` / `claudeOrchestration`** に追加し、空状態から「使い方ガイド / エージェント監視有効化」等の次アクションに誘導。
- `claudeAgents` 既存の viewsWelcome にウォークスルーへのリンクを追記。
- **新規コマンド 2 種**:
  - `claudeManager.enableAgentMonitor`: 設定を書き換えるラッパー（既に有効なら通知のみ）
  - `claudeManager.installCsmAskAgent`: 既存インストーラコマンド（`claudeManager.installAskAgent*` / `setupAskAgent`）を優先的に呼ぶ。存在しない環境では「使い方ガイドを開く」の案内 QuickPick に切替（判断: 環境差を吸収するラッパー）。

### 🗂 §4-8 グルーピング

- **新コマンド `claudeManager.groupAgents`** — QuickPick で 4 モード切替:
  - `org`: 組織図（現行の親子関係）
  - `model`: モデル別（fable / opus / sonnet / haiku…、`MODEL_CATALOG` 順）
  - `status`: 状態別（稼働中 / 待機 / 未紐づけ）
  - `flat`: フラット（名前順）
- **新設定 `claudeManager.agents.defaultGroupMode`** で永続化（既定 `org`）。`onDidChangeConfiguration` で即時反映。
- **`GroupNodeItem`** を新設し、`getChildren(element)` の分岐でグループ配下の `AgentItem` を返す。組織図モードは既存ロジック無変更で下位互換。
- `buildGroupNodes` は純粋関数で、テストしやすい形（判断: 単体テストは package.json 経由の設定確認で代替、TreeView 依存の Cytoscape/vscode モック省略）。

### 🎯 §4-9 Activity Bar 削減 (5 → 4 アイコン)

- **`claude-orchestration` コンテナを撤去**し、`claudeOrchestration` ビューを **`claude-agents` コンテナ内**（エージェント管理・お気に入り・ライブ状態と同列）へ移設。
- Activity Bar が「💬 セッション / 👤 エージェント / 🧠 メモリ / 📁 プロジェクト」の 4 アイコンに整理。
- 判断: 移行期間の互換 `when` 句や旧位置維持は不要（仕様書明示）。CHANGELOG のみで告知する運用。

### 🎨 §4-10 テーマ追従

- **webview 4 枚のモデル色以外の直書き HEX を `var(--vscode-charts-*)` へ寄せる**:
  - `orgChartPanel.ts`: `--accent` を `charts.orange` に変更 + `body.vscode-light` / `body.vscode-high-contrast` セレクタで `--accent-fg` オーバーライド追加。
  - `webviewPanel.ts`: `agent-badge .agent-name` の `#e27e4a` → `charts.orange`。メモリタイプ色（user/feedback/project/reference）を `charts.blue/orange/green/purple` へ。
  - `mainTabPanel.ts`: `.memory-type-*` および `.bookmarked` の `#ffb74d` → `charts.orange`。
  - `projectDetailPanel.ts`: `.memory-type-*` を同様に置換。
- **モデル色は `modelCatalog.generateModelCss()` 由来を維持**（Fable 5 の `#ffd54f` 金など、v0.5.14 以降のブランドカラー要件）。
- **Cytoscape の node 内部 style は HEX のまま維持**（判断: CSS 変数を getComputedStyle で動的解決するとテーマ切替時に再描画が必要で影響範囲が大きい。Sprint D 以降で検討）。

### 🔎 §4-11 組織図検索

- **検索ボックス**を組織図ツールバーに追加（`#org-search`）:
  - 200ms デバウンス
  - `cy.filter` で name / role を lowercase 部分一致検索
  - 一致ノード以外に `cy-node-dimmed`（opacity 0.2）付与
  - 一致ノード群に `cy.animate({ fit, duration: 400 })` でズーム
- **凡例チップ 5 種**（Fable / Opus / Sonnet / Haiku / 稼働中）:
  - クリックでトグル動作。有効時は対応モデル or 稼働中ノードのみを残し、他を半透明化
  - 再クリックでフィルタ解除
  - 検索ボックスと同じ dimmed クラスを流用（クラス競合なし）

### 🧪 テスト

- L1: walkthroughs 5 ステップの構造検証（順序 + `completionEvents` 定義）
- L2: Activity Bar 4 コンテナ化 + `claudeOrchestration` の移設先確認
- L3: `defaultGroupMode` 4 モード enum の存在確認
- L4: `agents.activeOnly` / `agents.expandMode` + 新規 4 コマンドの存在確認
- **46/46 → 50/50 pass**（Sprint C-1 → C-2 の増分 4）

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **50 / 50 pass**。
- テストハーネスは修正済み USERPROFILE 隔離 + fail-fast ガード維持。

### 判断・見送り事項

- **§4-3（1M 上付き数字化）**: Sprint C-1 と同じく保留継続。現行の頭文字統一設計を尊重。
- **Cytoscape 内部 style の HEX**: テーマ変数への動的解決は再描画影響が大きく、別 Sprint（Sprint D）で扱う。
- **installCsmAskAgent の実インストール処理**: 既存インストーラコマンドがある環境ではそれを呼び、なければ案内 QuickPick に切替（環境差の吸収を優先）。
- **buildGroupNodes 単体テスト**: TreeView 依存のため package.json 経由の設定検証で代替。挙動はセッション上での目視検証を推奨。

## v0.5.17 (2026-07-09) — Sprint C-1: UX 改善 5 件（小工数・高効果）

仕様書 `docs/v0.5.x-fable-qa-20260709.md §4` の UX 改善 12 件のうち、費用対効果順トップ 5（§4-1 / §4-2 / §4-5 / §4-6 / §4-12）を本 v0.5.17 に実装。

### ➕ §4-1 エージェント検索

- **新コマンド `claudeManager.searchAgents`** を追加。QuickPick で `name` / `displayName` / `role` / `model` / `parentAgent` をあいまい検索（`matchOnDescription` / `matchOnDetail` 有効）→ 選択で既存の `previewAgentByName` を実行。
- **AgentTreeProvider に `getParent()` 実装** + reveal 用の `getAgentItemByName()` ヘルパー追加。TreeView.reveal でツリーの該当ノードにジャンプ（親を辿って自動展開）。
- **エージェント管理ビューのツールバーに `$(search)` アイコン**追加（`view/title` メニュー: `when: view == claudeAgents, group: navigation`）。
- 判断: 未展開のツリー階層の項目は reveal 対象キャッシュに載っていないケースがあり、その場合は無視して preview 起動のみ行う（実害なし）。

### ➕ §4-2 ステータスバー表示モード + 5d 列の配列駆動化

- **新設定 `claudeManager.usage.statusBarStyle`** (`full` / `compact` / `max-only`、既定 `full`)
  - `full`: 現状維持（例: `5% 4.5h / 7% 7d / S 3% 5d20h / O 20% 5d10h`）
  - `compact`: リセット時刻を省略し % のみ（`5% / 7% / S 3% / O 20%`）
  - `max-only`: 最も逼迫している 1 枠のみ表示（`O 20% 5d10h`）
- 詳細は既存 tooltip / `openUsageMenu`（利用率メニュー）に集約。**ステータスバークリックから「表示スタイルを切替」でモード変更可能**。
- **5d 列を `USAGE_MULTIDAY_COLUMNS: readonly UsageMultiDayColumn[]` として配列駆動化**（`{ key, label, longLabel, getUsage, getReset }`）。`formatUsageText` / tooltip 生成 / 警告色判定 / 通知フラグまわりを配列イテレーションで統一。将来 Fable 5d 枠がヘッダに来た場合、配列に 1 行追加するだけで全経路に自動反映される構造。
- `usageMonitor.refresh()` を `onDidChangeConfiguration('usage.statusBarStyle' | 'usage.show5dColumns')` で即時反映。

### 🌐 §4-5 和英混在ラベルの日本語統一

- `agentTreeProvider.ts`: ライブプレフィックス **`[Open]` → `[対話中]`**（30 秒以内の対話中判定）
- `agentLiveTreeProvider.ts`: **`[running]/[blocked]/[done]` → `[稼働]/[承認待ち]/[完了]`**（内部ステータス enum はそのまま、表示ラベル関数化）
- `orchestrationTreeProvider.ts`: サブエージェントの **`${info.name} (no description)` → `${info.name}（説明なし）`**
- 判断: `claudeAgentsService.ts` のコメント（Claude CLI テキスト出力の仕様サンプル）と、SummaryItem の「JSON API」（Anthropic API ブランド用語）は保持。i18n の `t()` 全面移行は本 Sprint スコープ外（仕様書明示）。

### 🗂 §4-6 セッション一覧の情報密度

- **新設定 `claudeManager.sessions.descriptionFields`**（配列、既定 `['live','agent','originalMsg','time','tags']`）
  - `live` / `agent` / `originalMsg` / `time` / `model` / `tags` の順序・オンオフを制御。
  - モデル短縮名は頭文字（Ｓ/Ｏ 等）と重複するため既定から除外。
  - 内部で `Record<string,string>` によるフィールドマップを構築 → `fields.map(k => fieldMap[k]).filter(Boolean).join(' ')` で連結。
- **新設定 `claudeManager.sessions.expandRecentDateGroupsOnly`**（既定 `true`）
  - `DateGroupItem` の初期展開を「今日 / 昨日」のみに絞る。それ以外は `Collapsed`。
- **新設定 `claudeManager.sessions.showFileSize`** (`always` / `count-sort-only` / `never`、既定 `count-sort-only`)
  - `count-sort-only`: `sortMode === 'count'` のときのみラベル前にファイルサイズ列を表示。
  - `SessionItem._currentSortMode` 静的プロパティで provider の `sortMode` を共有（`setSortMode()` で更新）。
- 設定変更は `onDidChangeConfiguration` で `sessionProvider.refresh()` を発火して即時反映。

### 🎛 §4-12 タブバー非表示化 + アクティブ表示の ThemeColor 化

- **新設定 `claudeManager.ui.showTabBar`**（既定 `true`）
  - `TabBarTreeProvider.getChildren()` が `false` のときタブアイテムを返さず、ステータス行のみ表示（Activity Bar と重複するケース向け）。
- **アクティブタブ表現を `description の ●` から `iconPath の ThemeColor`** に変更
  - アクティブ: `focusBorder`（VS Code 標準の強調色）
  - 非アクティブ: `descriptionForeground`（薄いテーマ色）
  - `TAB_DEFS` の `icon` フィールドは常時使用（アクセシビリティ + iconPath 表現用）。
- **`mainTabPanel.ts` の旧コメント（「3タブ完全実装」）を実態に更新** — 現在は projects ペイン専用の WebviewView であり、セッション / エージェント / メモリはそれぞれ独立の TreeView（別 view container）で提供される旨を明記。過去バージョンで統合表示していた名残の記述を撤去。

### 🧪 テスト

- `K1 formatUsageText`: full / compact / max-only 各スタイルの出力を検証（`O 20% 5d10h` が max-only で単独出力になることまで確認）
- `K2 USAGE_MULTIDAY_COLUMNS`: 配列駆動化の型契約（`getUsage` / `getReset` / `label` / `longLabel` 必須、Sprint C-1 時点で `sonnet-5d` / `opus-5d` の 2 件）を確認
- **44/44 → 46/46 pass**（Sprint B → C-1 の増分 2）

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **46 / 46 pass**。
- テストハーネスは修正済み USERPROFILE 隔離 + fail-fast ガード維持。

### 判断・見送り事項

- **§4-3 モデル表示（1M 上付き数字化）**: `modelCatalog.ts` の一元化は v0.5.14 で完了済み。上付き数字（Ｏ¹/Ｓ¹/Ｆ¹）表示は現状の頭文字統一（Ｓ/Ｏ/Ｆ/Ｈ）と 1M 情報を tooltip/label で担保する設計と衝突するため Sprint C-1 スコープ外。将来対応の候補として保留。
- **§4-4 ライブ視認性（TreeView.badge）**: `TreeView.badge` は VS Code の TreeView.badge API に依存するため別 Sprint で実施。
- **§4-7〜11 (walkthroughs/グルーピング切替/Activity Bar 移設/テーマ追従/組織図検索)**: 中〜大工数のため Sprint C-2 以降。
- **searchAgents の初回検索時に未展開ノードは reveal 対象キャッシュに未登録**: 現状は preview のみ実行して silent fail（reveal は catch）。事前スキャンや遅延展開のため実害は薄く、深掘りは後続 Sprint で対応。

## v0.5.16 (2026-07-09) — Sprint B: MEDIUM/LOW 12 件 + 新規バグ 1 件（ワークスペース内セッション灰色表示）修正

### 🔍 コードレビュー修正ラウンド（Sprint B レビュー時点）

Sprint B 実装後のコードレビュー（CRITICAL/HIGH ゼロ、MEDIUM 2件 + 関連バグ 1件）で検出した以下 3 件を追い込み修正（本 v0.5.16 に含める）。

#### レビュー修正 (1) [MEDIUM/パフォーマンス] — agentUtils の同期 I/O が拡張ホストをブロック

- **症状**: `computeJsonlPathForSession` / `findJsonlByFallbackScan` が `existsSync` / `readdirSync` / `statSync` の完全同期実装。`agentWatcher.update()` から全ライブエージェント分ループで呼ばれるため、direct match が外れ続けるケース（セッション開始直後・エンコード不一致・レガシー小文字ディレクトリ）ではデバウンス更新のたびに `~/.claude/projects` 全走査が複数エージェント分連鎖して拡張ホストがブロックされる。
- **修正**:
  - `agentUtils.ts` に **`FallbackScanCache`** クラスを新設。`getDirs()` は projects/ の readdir 結果を Promise キャッシュ、`findJsonl(sid)` は sid ごとに stat 結果を Map メモ化。
  - **`computeJsonlPathForSessionAsync(sid, cwd, cache?)`** を追加（`fs.promises.stat` ベース、cache 共有で 1 サイクル内の readdir/stat 重複を排除）。
  - `agentWatcher.getJsonlPathAsync(sid, cwd, cache)` を追加、`update()` 冒頭で `const scanCache = new FallbackScanCache()` を宣言し、全エージェント並列ループから共有。既存の同期版 `computeJsonlPathForSession` / `getJsonlPath` は単発呼び出し互換 API として保持（`tryAutoLinkSession` / `orchestrationViewModel` 等）。
- **テスト**: J2b 追加（3 セッション分の並列探索で cache 経由の readdir 1 回 + null キャッシュ副作用なしを確認）。

#### レビュー修正 (2) [MEDIUM/要検証] — encodeCwdToProjectDir の CC 実装追従を実在フォルダで検証

- **検証**: `~/.claude/projects/` の実在 19 フォルダを読み取り専用で列挙し、対応 cwd との突き合わせを実施。判明した CC 実装:
  - **大文字を保持する**（`C:\GDrive` → `C--GDrive`、`c:\GDrive` → `c--GDrive`）。Sprint B 実装は `.toLowerCase()` してから置換していたため、大文字保持で作成された CC フォルダに対して cwd が `C:\...` の場合、`c--...` を探して沈黙していた。
  - 英字（`a-zA-Z`）/ 数字（`0-9`）/ ハイフン以外の**全ての文字を 1 文字 = 1 個の `-`** に置換（実例: `C:\Users\taro\OneDrive - 個人用` → `c--Users-taro-OneDrive-------` の末尾 7 個の `-` は「`\` ` ` `-` ` ` `個` `人` `用`」の 7 文字それぞれ 1 個）。
  - `\` を `/` に事前変換していた実装も CC には無い（`\` そのものが 1 文字 = 1 個の `-`）。
- **修正**:
  - `encodeCwdToProjectDir(cwd)` を `cwd.replace(/[^a-zA-Z0-9-]/g, '-')` に修正（**大文字保持**）。
  - 過去バージョンで小文字化されたレガシーフォルダ（`c--gdrive-forest` など）が実在するため、`encodeCwdToProjectDirLegacyLowercase(cwd)` を新設。
  - `computeJsonlPathForSession` / `computeJsonlPathForSessionAsync` を **primary（大文字保持） → legacy（小文字化） → fallback scan** の 3 段構成に。
  - 関数コメントに実在フォルダ検証結果と CC の非公開 200 文字ハッシュ切り詰め仕様への追従は行っていない旨を明記（未対応記号・大パス長は fallback scan でカバー）。
- **テスト**: J1（大文字保持・日本語 1 文字 = 1 個の `-`・数字保持）/ J1b（legacy 小文字版）/ J2（primary/legacy/fallback 3 段ヒット）追加。J2 の legacy テストは Windows の case-insensitive ファイルシステムでは検証意図を表現できないため POSIX 分岐にした（判断: ユーザ実害はないため）。

#### レビュー修正 (3) [関連バグ] — projectFilter が灰色化バグと同根で灰色 → 全消え

- **症状**: `sessionTreeProvider.ts:158-162` の `projectFilterEnabled` 時の絞り込みが `workspaceFolders[0]` 固定 + `basename` の生 `includes()` 比較。Windows で `\` 区切り fsPath vs JSONL 由来 `/` 区切りが永遠に不一致となり、フィルタ ON で「ワークスペース配下のセッションが一覧から消える」バグ。灰色化バグ（`SessionDecorationProvider`）と全く同根。
- **修正**:
  - `SessionDecorationProvider` 内にあった判定を **`isSessionInAnyWorkspace(project, workspaceFolders)` 共通ヘルパー**として extract（`normalize + isContainedIn` + 全ワークスペースフォルダ走査）。
  - `SessionTreeProvider` の projectFilter も同ヘルパー呼び出しに置換し、`workspaceFolders[0]` 固定を廃止（マルチルート対応）。旧 export 名 `_isSessionInAnyWorkspace` は後方互換で維持。
- **テスト**: J7 追加（Windows: 区切り違い同一パス・サブフォルダ・マルチルートで一致、兄弟で非一致 / POSIX: 同等ケース）。

### 検証（レビュー修正含む v0.5.16 最終）

- `npx tsc --noEmit` クリーン。
- `npm test`: **44 / 44 pass**（Sprint B 41/41 → レビュー修正 J1b / J2b / J7 で +3、内部で J1/J2 拡張）。
- テストハーネスは修正済み USERPROFILE 隔離 + fail-fast ガードの流儀を維持。

### レビュー修正の判断・見送り事項

- **同期版 API の保持**: `computeJsonlPathForSession` / `findJsonlByFallbackScan` の同期版は撤去せず、単発呼び出し（`tryAutoLinkSession`・`orchestrationViewModel`・`hookService.writeOrgInfoToMemory`）用に残した。パフォーマンス上のホットパスは `update()` ループのみで、そこは async + cache 経路に切替済み。
- **CC 側 200 文字ハッシュ切り詰め**: 公式仕様未公開のため引き続き未実装。fallback scan で実務カバー。
- **J2 legacy テストの Windows スキップ**: Windows は case-insensitive fs で `C--Legacy-App` と `c--legacy-app` を同一視するため、legacy 経由でヒットしたのか primary で偶然ヒットしたのかテストで区別不能。ユーザ挙動は同じ（見つかる）ため実害なしと判断。



Sprint B。仕様書 `docs/v0.5.x-fable-qa-20260709.md §3 MEDIUM/LOW` の全 12 件と、新規検出したセッション一覧の灰色化バグを一括で修正した。

### 🐛 【新規バグ最優先】ワークスペース内セッションが灰色（disabledForeground）表示される

- 症状: `SessionDecorationProvider.provideFileDecoration` の一致判定が `currentProject.toLowerCase().includes(project.toLowerCase())` の相互 includes 文字列比較で、Windows では `fsPath` が `\` 区切り、`project`（JSONL 由来）が `/` 区切りのためどれだけ同一パスでも一致せず、ワークスペース配下（サブフォルダ含む）のセッションまで灰色になっていた。
- 修正: `pathUtils.normalize()` + `isContainedIn()` で正規化して包含判定に変更（`cliBuilder.ts:isWorkDirCompatible` と同じ流儀）。`workspaceFolders[0]` 固定を廃止し、全ワークスペースフォルダを走査。マルチルート・サブフォルダも一致扱いにする。
- テスト: J4 追加（isContainedIn のプラットフォーム別ケース）。

### 🐛 M-4 hookService.ts: settings.json 書き込みキュー例外の握りつぶし

- 症状: `settingsWriteQueue.then(...).catch(() => {})` で全例外を握りつぶし、呼び出し元は失敗しても成功したように見え、常に「登録完了」ログを出していた。書き込み後の JSON 検証は「自前 stringify を re-parse」でデッドコード。
- 修正: op ごとの `Promise` を分離し、呼び出し元へ例外を伝播。キュー本体（`settingsWriteQueue`）は失敗しても後続 op を止めないよう `.catch()` は残す。デッドコードの再 parse をディスク読み戻し検証に置換（実際の書き込み内容を検証）。

### 🐛 M-5 hookService.ts: settings.json 不在/破損時の黙殺

- 症状: ENOENT/parse 失敗で全 `ensure*Hook` が黙って no-op（クリーン環境で hook が一切登録されない）。
- 修正: ENOENT は親ディレクトリ作成 + `{}` で続行して新規作成。parse 失敗は明示ログ + 例外送出（バックアップされていない破損 settings.json への上書きを防止）。

### 🐛 M-6 hookService.ts: マーカー部分一致誤ヒット（csm-precompact ⇔ csm-precompact-summary）

- 症状: `hookMatchesMarker(hh, 'csm-precompact')` が `csm-precompact-summary.js` に部分一致し、`ensurePreCompactHook` の自己修復ループがサマリー用エントリを誤って書き換えるリスク。加えてループ内 `return` で後続 entry の点検が打ち切られていた。
- 修正: `hookMatchesScriptName(hh, baseName)` を新設。`baseName + .{js|cjs|mjs|sh}` の**ファイル名境界一致**で判定。`ensurePreCompactHook` はこの新関数に切替、ループ内 `return` はフラグ（`existsNewNodeEntry` / `migratedAny`）に置換して全走査してから集約結果を返す。
- テスト: J3 追加（summary が precompact と誤ヒットしないことを保証）。

### 🐛 M-7 hookService.ts: 旧 bash 版と新 node 版の二重登録

- 症状: SessionStart / Governance hook の登録処理で、既存 node 版があっても migration filter が `command.includes(CSM_MARKER)` の粗い判定で bash も node もまとめて撤去 → その後末尾で無条件 `push` → 二重登録を招くケースがあった。
- 修正: `isOldBashCsmHook(hh, marker)`（マーカー一致 + `.sh` 参照/`bash` コマンド）を新設し bash 版だけを filter で撤去。push 前に `hasNewNodeHook(entries, marker)` で再チェックし、既に node 版があれば push しない（並行呼び出し・他ソース登録への防御）。

### 🐛 M-8 agentWatcher.ts: /model 切替が UI に反映されない

- 症状: `hasChanged(prev)` が `actualModel` / `modelMismatch` を比較しないため、セッション中の `/model` 切替（例: opus→sonnet）が JSONL に反映されても UI（バッジ・アイコン）で陳腐化。
- 修正: `hasChanged` に `actualModel` / `modelMismatch` の比較を追加。

### 🐛 M-9 cwd → プロジェクトフォルダ名エンコードが CC 実装と乖離（`my.app` 系で沈黙）

- 症状: エンコード規則が `/^([a-z]):/ → '$1-'` + `[\s/] → '-'` のみで `.`/`_` などが残っていたため、`my.app` 系のパスで JSONL 逆引きが常に沈黙（実モデル読取・ライブ自動紐づけ無効化）。同一ロジックが 3 か所（`hookService.ts:1125` / `orchestrationViewModel.ts:64-73` / `agentWatcher.ts:198`）に複製。
- 修正: `agentUtils.ts` に単一真実源として以下を新設し、3 か所の複製を集約：
  - **`encodeCwdToProjectDir(cwd)`**: CC 本体互換の「非英数字/ハイフン → `-`」置換。`toLowerCase()` 後に `replace(/[^a-z0-9-]/g, '-')`。
  - **`computeJsonlPathForSession(sessionId, cwd)`**: エンコード規則でパス組み立て → 実在すれば採用 → 見つからなければ `projects/*` を走査してフォールバック（CC の 200 文字ハッシュ切詰・未対応記号への追従漏れをカバー、`scanProjectsForAutoLink` と同じ方式）。
  - **`findJsonlByFallbackScan(sessionId)`**: `projects/*/<sid>.jsonl` の全走査（同期）。
- CC 側の 200 文字超ハッシュ切詰仕様は公式ドキュメント未公開でリスクがあるため実装せず、上記フォールバック走査でカバー（判断）。
- テスト: J1（エンコード規則）/ J2（fallback スキャン）追加。

### 🐛 M-10 agentFormPanel.ts: フォームが effort / permissionMode を黙って注入

- 症状: フォームの effort ラジオが `!v.effort` で自動 high 選択、permissionMode select は既定 acceptEdits selected。既存値が空でもフォームを開いて保存すると `effort:high` / `permissionMode:acceptEdits` が黙って frontmatter に書き込まれ、CSM 起動パス（`agentCommands.ts:149他`）で「毎回確認」→「編集自動許可」への権限拡大が発生していた。
- 修正: effort ラジオに「未設定（継承）」オプションを追加し、既存値が空なら inherit を選択状態にする。permissionMode select も先頭に「未設定（継承）」を追加。`getFormData` で `__inherit__` を `undefined` に変換して送信、`saveAgentConfig` は `undefined` 時に `existing?.effort` / `existing?.permissionMode` を維持する（既存値の意図を尊重）。
- テスト: J5 追加（低 effort / bypassPermissions の既存が未指定保存で維持されることを保証）。

### 🐛 M-11 agentFileManager.ts: thinkingEnabled 消失 + memory:project の黙注入

- 症状: `saveAgentConfig` の def 構築で `thinkingEnabled: config.thinkingEnabled`（existing フォールバックなし）→ フォーム保存のたびに `thinkingEnabled` が消失。`memory: existing?.memory || 'project'` → 新規保存で常に `memory:project` が黙って追加され、グローバルメモリ運用のエージェントを暗黙にプロジェクトメモリに切り替えていた。
- 修正: `thinkingEnabled` に既存値フォールバックを追加、`memory` はデフォルト注入を撤廃（`existing?.memory` のみ、無ければ書かない）。
- テスト: J5（memory デフォルト注入されないこと）/ J6（thinkingEnabled 未指定で既存値維持）追加。

### 🐛 L-12 hookService.ts: supportsExecForm が Windows で恒久 false

- 症状: `spawnSync('claude', ['--version'])` は Windows の `claude.cmd`（バッチファイル）を直接実行できず ENOENT で false 固定 → exec-form 移行が Windows で恒久無効化されていた。
- 修正: 試行順を「直接 → `shell:true` → Windows なら `claude.cmd` を明示」に変更。全て失敗時は `_execFormSupported` にキャッシュせず（次回呼び出しでリトライ可能）ログ出力のみ。

### 🐛 L-13 usageMonitor.ts: Sonnet/Opus 5d 100% 到達で通知なし

- 症状: 5時間/7日枠は 90%/100% で通知するのに Sonnet/Opus 5日枠は色変化のみで沈黙。
- 修正: `notifiedSonnet5d90/100` / `notifiedOpus5d90/100` フラグを追加し、`data.usageSonnet5d/Opus5d >= 0` のときに `checkAndNotify` を実行。`show5d` 設定に関わらず通知する（沈黙リスク回避）。

### 🐛 L-14 agentWatcher.ts: update 実行中のイベント破棄

- 症状: `updateAsync` が `this.updating` チェックで即 return するため、update 実行中に届いたイベントが黙って破棄され、直後の状態変化が反映されないタイムラグが発生。
- 修正: `pendingUpdate` フラグを追加。実行中のイベントは pending マークして、`finally` で `scheduleUpdate()` を再呼び出し（デバウンスで最新変化を集約）。

### 🐛 L-15 agentFileManager.ts: 同名新規登録時の上書き前 .trash 退避なし

- 症状: `writeAgentFile` が既存ファイルを無条件で `writeFile` 上書き。frontmatter parse 失敗経路や、`def.body` 未指定 + 既存 body ありのケースで既存本文が消失。
- 修正: 「(a) parse 失敗（frontmatter 破損）」または「(b) body 未指定 + 既存 body あり + def の role/description 両方欠落（疑わしい上書き）」の場合、上書き前に元ファイルを `.trash/` へ退避。誤爆防止のため (b) の条件は狭く絞ってある。

### 🔧 テスト（Sprint B）

- **35/35 → 41/41 pass** に増加（6 テスト追加、退行なし）。
- 追加: J1〜J6（M-9 エンコード / J2 fallback スキャン / M-6 マーカー完全一致 / 新規バグ isContainedIn / M-10・M-11 の inherit と memory 非注入 / M-11 thinkingEnabled 保持）。
- 全て修正済みハーネス（USERPROFILE 隔離 + fail-fast ガード）の流儀を踏襲し、実 `~/.claude` を汚染しないことを確認済み。

### 🏛️ 共通化・設計改善（副次効果）

- cwd → project フォルダ名エンコードが `agentUtils.encodeCwdToProjectDir` に一元化（旧: 3 か所の複製）。
- 破損 settings.json 上書き事故のリスクを排除（M-5 の parse 失敗時明示ログ + 例外）。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test` 41/41 pass。

### 見送り事項

- **M-9 の CC 側 200 文字ハッシュ切詰追従**: 公式仕様未公開のため未実装。projects/* 走査による fallback で実務は補完（判断）。
- **HIGH-3（sessions/*.json のリッチフィールド未活用 / ロードマップ T6-1.3〜1.5）**: 仕様書上「HIGH」だが Sprint B の指示は MEDIUM/LOW 12 件のみのため対象外。別途 P0 として継続扱い。
- **CC 追従項目**（Sonnet 4.6 表記の陳腐化・/fast 未対応・claudeAgentsService 死蔵・effort 'max' 表記矛盾）: 仕様書 §3 「CC追従（その他）」の内容で Sprint B スコープ外。

## v0.5.15 (2026-07-09) — セッション詳細ビューに「Claudeで開く」ボタン追加

セッションをクリックして開く会話ビュー（`webviewPanel.ts`）のヘッダに **▶ Claudeで開く** ボタンを新設。ワンクリックで新規ターミナルが立ち上がり `claude --resume "<sessionId>"` が実行される。

### ➕ 追加

- **「▶ Claudeで開く」ボタン**: セッション詳細ビューの h2 タイトル横に配置。VS Code のボタンテーマ変数（`--vscode-button-background` / `--vscode-button-foreground` / `--vscode-button-hoverBackground` / `--vscode-focusBorder`）を使い、既存 UI と自然に調和。
- **tooltip**: 「このセッションをClaude Codeで再開します」。cwd 不明時は「（cwd 不明のためワークスペースルートで起動。作成時と cwd が異なると『No conversation found』で失敗する場合があります）」と追記して失敗の可能性を明示。
- **postMessage プロトコル**: webview → 拡張は `{ type: 'openInClaude' }`（他イベントと合わせ `type` フィールド統一）。仕様書の例示は `command: 'openInClaude'` だったが、既存 webview ⇄ 拡張間ハンドラが全て `type` ベースなので既存パターンに揃えた（判断）。

### 🎯 cwd の扱い（最重要ポイント）

`claude --resume` は **セッション作成時と同じ cwd** で起動しないと `No conversation found` で失敗する（本日実証済みの既知問題）。恒久対策として:

- `ParsedSession` に `cwd?: string` フィールドを追加し、`parseSessionFile` / `parseSessionQuick` の両方で JSONL 内 `cwd` フィールド（先頭行から検出）を **加工せず生の値のまま**保持するようにした（従来は `translateWorkDirPath(cwd)` 変換後の `project` にしか渡っていなかった）。
- ターミナル起動時は `translateWorkDirPath(session.cwd)` を通して Windows / dev-lamp（HGFS）配置差を吸収してから `createTerminal({ cwd })` へ渡す（`agentCommands.ts` の既存パターンと同じ）。
- **cwd 不明時（旧セッションで cwd 行が読み取れなかった等）**: ボタンを無効化せず、`vscode.workspace.workspaceFolders?.[0]?.uri.fsPath` で「試行」させる（過剰実装しない）。失敗の可能性は上記 tooltip で明示。

### 🔧 実装詳細

- `types.ts`: `ParsedSession.cwd?: string` を追加。
- `sessionLoader.ts`: `parseSessionFile` / `parseSessionQuick` の返却オブジェクトに `cwd` を含めるように 2 か所修正。
- `webviewPanel.ts`:
  - CSS に `.title-row` / `.header-actions` / `.action-btn` を追加（既存 `.info-main` と同スコープ、テーマ変数のみ使用）。
  - session-info の h2 を `<div class="title-row">` で包み、`.header-actions` にボタンを配置。
  - webview client JS に `openInClaudeBtn` のクリックハンドラを追加。
  - `onDidReceiveMessage` に `openInClaude` 分岐を追加し、`vscode.window.createTerminal({ name, cwd })` + `terminal.show()` + `terminal.sendText('claude --resume "<sid>"')` を実行。
  - ターミナル名は「▶ <セッション表示名 40 文字>」。
  - sessionId は CSM が扱う hex UUID なのでシェルインジェクション懸念は薄いが、念のため二重引用符で括った（PowerShell / bash / zsh 共通で妥当）。

### 検証

- `npx tsc --noEmit` クリーン。
- `npm test`: **35 / 35 pass**（既存テストに退行なし。新機能は VS Code API 依存のため単体テスト対象外・別途手動検証）。

### 見送り事項

- ボタンの表示条件（disposable セッションで隠す等）は未実装。全セッションで表示。
- Claude CLI 未インストール環境向けの検出は未対応（sendText 後に `command not found` が出るだけ。過剰実装不要と判断）。

## v0.5.14 (2026-07-09) — Fable 5 解禁 + normalizeModel 判定順序修正 + フォーム保存バグ修正

Sprint A（Fable QA レポート 2026-07-09 起点）。長期未対応の Fable 5 除外方針を撤回し、Fable モデルの選択・保存経路を第一級として復活。あわせて `normalizeModel` の C-1（`fable[1m]` → `sonnet-1m` 誤変換）と C-2（fable → opus サイレント書き換え）を修正。加えて HIGH-1（description 保存されないバグ）と HIGH-2（allowedTools 固定 12 種問題）を修正した。

### ➕ Fable 5 解禁（オーナー承認 2026-07-09）

- **`fable` / `fable-1m`** を第一級モデルとして追加。表示文字 **Ｆ**、色 **金 #ffd54f**、TreeView は `star-full` + `charts.yellow`。
- effort=`max` を **Opus 系のみ** から **Opus 系 + Fable 系** に拡張（`onModelChange` のグレーアウト連動）。
- 旧「組織方針で非選択」コメント（`agentUtils.ts` / `cliBuilder.ts` / README）を撤廃。

### 🐛 C-1 修正: `normalizeModel` の判定順序

`agentUtils.ts` の判定順序が `[1m] → fable` だったため、`claude-fable-5[1m]` が `sonnet-1m` に化けていた（"opus を含まない" 分岐で誤判定）。フォームで他項目を編集して保存 or セッション紐づけ操作をすると frontmatter が恒久的に `sonnet[1m]` に書き換わっていた。

- 判定順序を **fable → [1m] → opus → haiku → sonnet** に修正（`modelCatalog.ts` に一元化）。
- `agentFormPanel.ts` の `resolveModelName` も同一ロジックに統一（コピペ実装を撤去）。

### 🐛 C-2 修正: `fable → opus` のサイレント書き換え撤廃

`normalizeModel` の `if (lower.includes('fable')) { return 'opus'; }` を削除。過去に CSM 経由で保存済みのファイルは既に opus に書き換わっており復元不能なため、**Fable 利用エージェントはモデル選択を再度おこなってください**。

### 🐛 HIGH-1 修正: description 欄の編集が保存されない

- 症状: `agentFormPanel.getFormData` が description 欄を送信せず、`saveAgentConfig` が `description: config.role || existing?.description` で上書き。翻訳ボタンを押すと英語 description が日本語 role 文に置換され、Claude Code の自動委譲判定を破壊。
- 修正: `getFormData` に `description` フィールドを追加、`AgentConfig` に `description?: string` を拡張、`saveAgentConfig` は「フォームから送られた description を尊重、未送信なら既存値保持、空文字は明示的な消去として尊重」に変更。role とは独立して扱う。

### 🐛 HIGH-2 修正: allowedTools 固定 12 種問題

- 症状: フォームのチェックボックスが固定 12 種で、`AskUserQuestion`（例: director.md）などフォームに無いツールは保存で削除されていた。
- 修正: 固定リストに `AskUserQuestion` を追加。加えて既存 frontmatter に載っているが固定リストにないツールは**動的にチェックボックスを追加**（＋バッジで既存要素を示す）。

### 🏛️ modelCatalog.ts 新設（恒久対策）

モデルリテラルが 13 ファイル以上に分散し、色は 4 ファイルに同色直書き、tagTreeProvider は sessionTreeProvider の完全コピペになっていた問題を解消。`src/models/modelCatalog.ts` を単一真実源として新設し、モデル追加は 1 か所編集で全 UI・CLI・正規化に反映される構造にした（`getModelCliMap`, `getModelChar`, `getModelLabel`, `getModelIconAndColor`, `generateModelCss`）。

### 🎨 CSS 補修（副次修正）

- `webviewPanel.ts`: `.badge-fable` / `.badge-fable-1m` 追加 + 既存欠落バグ（`.badge-opus-1m` / `.badge-sonnet-1m`）を補修。
- `guide.html`: 同上 + モデルリスト・凡例・effort 連動記述を更新。
- `orgChartPanel.ts` / `projectDetailPanel.ts` / `mainTabPanel.ts`: fable 用の色ルールを追加。

### 🧪 テスト（`test/unit/agent-hooks-qa.test.js`）

- G1 を書き換え: `n('fable') === 'fable'` / `n('fable[1m]') === 'fable-1m'` / `n('claude-fable-5[1m]') === 'fable-1m'` を追加（C-1/C-2 検証）。
- G2 を書き換え: `modelCliMap['fable'] === 'fable'` / `modelCliMap['fable-1m'] === 'fable[1m]'` を追加。
- B4 を **拡張**: `fable` / `fable-1m` / `opus-1m` を追加（往復モデル検証。旧・sonnet 系のみ → Fable 系・Opus 1M を含む網羅へ）。
- **G4 / G5 を新規追加**: fable / fable-1m の frontmatter 書き込み → 復元往復テスト。

### 🔧 テストハーネス修正（Windows 隔離バグ）

- `agent-hooks-qa.test.js` / `setAgentSession.test.js` の `loadFresh` / `runHook` が **`process.env.HOME` だけを差し替えていた**ため、Node の `os.homedir()` が Windows で優先的に見る `process.env.USERPROFILE` を経由して実 `~/.claude` を書き換えていた（A/E/G3/C1 系および G4/G5 が実ホーム汚染のリスクで環境依存的に落ちていた）。
- 修正: **`USERPROFILE` も同時に差し替え** + 失敗時に即 throw する fail-fast ガードを追加（隔離漏れを本番環境事故に発展させない）。
- 結果: **35/35 pass**（Sprint A 追加前 baseline 30 → G4/G5 + A9 追加後の baseline 35 が全通過）。

### 📚 ドキュメント

- README / SPEC / CONTRIBUTING / guide.html を更新。旧「Fable 非選択」記述を撤回し、旧フルID表記（`claude-sonnet-4-6[1m]` / `claude-opus-4-6[1m]`）をエイリアス方式（`<model>[1m]`、例: `fable[1m]` / `opus[1m]` / `sonnet[1m]`）に統一。Max effort 対応表を「Opus / Fable 系」に更新。

### 🔍 コードレビュー修正ラウンド（Sprint A レビュー時点）

Sprint A 実装後のセルフレビューで検出した以下 8 件を追い込み修正（本 v0.5.14 に含める）。

- **HIGH (1)**: `toAgentConfig` に `description` マッピング欠落 → 編集経路で `v.description` が undefined になり、フォームプレフィル式が `displayDescription || role` にフォールバックし、保存で英語 description が日本語 role 文に恒久置換されていた（HIGH-1 が編集経路で機能しない）。`description: def.description` を追加。
- **HIGH (2)**: フォーム description の `<textarea>` プレフィルが `v.description ?? v.displayDescription ?? v.role` のフォールバックだった → v.description の欠落を隠して「日本語 role が保存される」状態を成立させていた。`v.description ?? ''` に修正（正しい復元）。
- **HIGH (3)**: `saveAgentConfig` の description 処理を再設計 — 既存更新は「フォームから来た description を尊重（空文字も明示的な消去として尊重）」、**新規作成 & 空の場合のみ role をフォールバックとして書き出す**（CC の自動委譲は description 行が必須のため）。非フォーム経路は既存値を保持。
- **HIGH (4)**: 動的追加チェックボックス（extraTools）の `value` 属性のみエスケープされていた（label テキストは未エスケープ）→ frontmatter に細工されたツール名で XSS 経路になり得る。**value / label 双方に `escapeHtml` 適用**。
- **MEDIUM (5)**: extraTools の重複除去なし → 同名ツールが複数チェックボックスとして描画され得る。`[...new Set(current)].filter(...)` で dedup。
- **LOW (6)**: `guide.html` の「モデルの使い分け」Tip が旧フル ID 表記（`claude-sonnet-4-6[1m]`）だった → エイリアス表記（`<model>[1m]`、例: `fable[1m]` / `opus[1m]` / `sonnet[1m]`）に統一。Fable 5 も「最上位判断」候補として追記。
- **LOW (7)**: モデル頭文字が画面間で不整合（`agentTreeProvider` は `sonnet-1m` → `'１'` を維持していたのに対し `agentPreviewPanel` は catalog char `'Ｓ'` を使用 → 画面間で `sonnet-1m` の頭文字が食い違い）。`agentTreeProvider` / `sessionTreeProvider` / `tagTreeProvider` を **`modelCatalog.getModelChar()` 呼び出しに統一**（1M 情報はラベル / tooltip で担保）。**表示変更**: `sonnet-1m` / `opus-1m` の頭文字が `Ｓ` / `Ｏ` に統一され、以前 `'１'` を表示していた場所も母体モデル頭文字（`Ｆ` / `Ｏ` / `Ｓ` / `Ｈ`）で表示。
- **MEDIUM (8)**: `modelCatalog.ts` の未接続シンボルを配線 — `sessionTreeProvider.getModelIcon` は `getModelIconAndColor` を呼ぶだけの薄いラッパに置換、`agentWatcher.prefixMap` は `MODEL_CATALOG[m].idPrefix` から自動生成、`agentFormPanel` のモデルラジオ HTML は `CSM_MODELS.map` で `MODEL_CATALOG` から動的生成、client-side `allowsMax` 判定は `MODEL_CATALOG[m].allowsMaxEffort=true` の集合を webview に埋め込む方式へ、`webviewPanel` / `mainTabPanel` / `projectDetailPanel` の badge / model / dot CSS は `generateModelCss()` の一括出力に置換。**これで modelCatalog の "1 か所編集で全 UI に反映" が実態と一致**。

### ⚠️ 見送り事項（Sprint A 対象外）

- **§2.4 任意項目**: usageMonitor の Fable 5d 利用率枠（Anthropic ヘッダ実機確認要）、director プリセットの Fable 格上げ、フォーム既定値 `opus` の変更 — Sprint B 以降で判断。
- **MEDIUM 以下（M-4〜M-11 / L-12〜L-15）** — Sprint B 以降で対応。

### 📊 テスト状況（本 v0.5.14 最終）

- `npx tsc --noEmit` クリーン。
- `npm test`: **35 / 35 pass**（Sprint A 追加分の G4 / G5、A9 マイグレーション、B4 拡張、E1〜E4 を含む）。テストハーネス修正（USERPROFILE 差し替え + fail-fast）により Windows 上で `~/.claude` 汚染リスクなしで安定的に全通過することを確認。

## v0.5.13 (2026-06-27) — エージェントフォームに maxTurns を追加（現行 CC 追従）

現行 Claude Code(2.1.19x)のサブエージェント frontmatter に合わせ、`maxTurns` をフォームから設定可能に。

### ➕ maxTurns
- **最大ターン数（maxTurns）** — 数値入力（空=無制限）。暴走・コスト制御用。`AgentConfig`/`AgentDefinition` に追加し、parse/buildFrontmatter/toAgentConfig/saveAgentConfig を整備。
- フォーム権威セマンティクス: 0/空で**クリア**、`>0` で設定。未指定・0以下は frontmatter に書かない。
- test: E4（maxTurns 往復・クリア・未指定）追加。全 33 テスト合格。

### 注記
- モデル/effort/SubagentStart-Stop hook は既に現行 CC に整合（前 commit で README に追従状況を明記）。`initialPrompt` 等の他フィールドは CSM の初期注入と競合しうるため意図的に見送り。

## v0.5.12 (2026-06-01) — 追加分（overage）をステータスバーに別表示

- ステータスバーの利用率（使用量）表示はそのまま、**追加分（overage）を別セグメントで併記**: `… ｜ 追加 0%`。
- データ源は Anthropic API の `anthropic-ratelimit-unified-overage-utilization`（利用率%）/ `-status` / `-reset`。
- ツールチップに `追加分(overage): N% 使用 / <status>・リセットまで …` を追加。
- **ドル金額（残高）は API に存在しない**ため、利用率（%）と状態で表示。$ は claude.ai/settings/usage（Web）で確認（ツールチップに注記）。
- test: I1（formatOverageText）追加。全 32 テスト合格。

## v0.5.11 (2026-06-01) — ステータスバーの%表示を使用量に戻す（残量表示を撤去）

- v0.5.9/v0.5.10 で追加した「残量（残り%）表示」を**撤去**し、ステータスバーの%を**従来どおり使用量（利用率）表示**に戻した（設定 `usage.showRemaining`・切替メニュー・既定ONマイグレーションを削除）。
- 背景: 要望は「%は使用量のまま据え置き、別途『追加分の $ 残高』を表示」だった。残量%は意図と異なったため revert。
- **追加分の $ 残高について**: Anthropic API のレート制限ヘッダには overage（追加分）の**利用率**（`anthropic-ratelimit-unified-overage-utilization` 等）はあるが、**ドル金額のヘッダは存在しない**。$ 残高は claude.ai/settings/usage（Web）でのみ確認可能で、OAuth トークン経由の API からは取得できないことを確認。

## v0.5.10 (2026-06-01) — 残量表示を既定 ON に（更新者も ON）

- `claudeManager.usage.showRemaining` の**既定を ON に変更**（残95% のように残量表示がデフォルト）。
- **更新者向け一度きりマイグレーション** `runUsageShowRemainingMigration`:
  - 未設定ユーザー → 新 default(ON) が自動適用。
  - **明示的に OFF にしているユーザー → 一度だけ ON へ flip**（更新後も ON にする要望に対応）。
  - フラグ（globalState）で再実行を防止 → 以降ユーザーが OFF にしても尊重。
- コード側の get フォールバックも `true` に統一。

## v0.5.9 (2026-06-01) — 利用制限ステータスバーに残量（残り%）表示を追加

ステータスバーの利用制限表示を、利用率（使用%）だけでなく**残量（残り% = 100% − 利用率）**でも表示できるようにした。

### ➕ 残量表示
- 設定 `claudeManager.usage.showRemaining`（既定 false）。ON で「残95% 4.5h / S 残97% 5d20h …」のように残量表示。
- **ステータスバークリックメニューから切替可能**（「残量（残り%）表示に切替 ⇄ 利用率（使用%）表示に切替」）。
- **ツールチップは常に「使用 X% / 残 Y%（リセットまで …）」を併記**。
- 残量は 0% 未満にならないようクランプ。警告色は従来どおり利用率ベースで判定。

### 注記（残高について）
- データ源は Anthropic API のレート制限ヘッダ（5h/7d/Sonnet5d/Opus5d の**利用率**）。**絶対的なクレジット残高（トークン数・金額）のヘッダは提供されない**ため、表示できるのは「残り% + リセットまでの時間」。
- test: I1（残量モードの算出・0% クランプ）を追加。全 32 テスト合格。

## v0.5.8 (2026-06-01) — QA 修正（hook 除去/マイグレーションの取りこぼし・バックアップ世代管理）

v0.5.2〜v0.5.7 を QA（自動ヘルス + コードレビュー + 横断点検）。CRITICAL 0、HIGH 2 + MEDIUM 1 + LOW 1 を修正。
詳細は [docs/v0.5.x-qa-report.md](docs/v0.5.x-qa-report.md)。

### 🐛 修正
- **HIGH**: `removeSessionAgentInjectHook` が `command.includes` 判定で **exec-form hook を除去できなかった** → `hookMatchesMarker` に変更（exec-form 対応）。
- **HIGH**: `ensureSessionAgentInjectHook` が exec-form マイグレーション後に無条件 `return false` で**変更が保存されなかった** → 変更を追跡して `return` に反映。
- **MEDIUM**: settings.json の `.bak.*` が**無制限に蓄積** → `pruneOldSettingsBackups()`（最新 5 件保持）を新設し、`modifySettingsJson` / `removeCsmHooksFromSettings` の書き込み後に世代管理。
- **LOW**: `isForeignOsPath` の Windows 分岐の意図をコメント明記。

### 検証
- `tsc` クリーン・全 **31 テスト**合格（バックアップ世代管理テスト H1 追加）。
- 非バグ/設計許容と判定した指摘（description UI・allowedTools=[]・エラー伝播設計 等）は QA レポートに根拠を記載。

## v0.5.7 (2026-06-01) — 更新内容の整合性修正（opus-1m の取りこぼし解消・ドキュメント追従）

v0.5.2〜v0.5.6 の更新を横断監査し、`opus-1m` 追加で取りこぼしていた箇所を整合させた。

### 🔧 opus-1m 表示・判定の整合
- **モデル表示**: `agentPreviewPanel`（頭文字・ラベル）/ `agentTreeProvider`（頭文字）/ `projectDetailPanel`（バッジ class）/ `orgChartPanel`（ノード色）が opus-1m を未対応で **Sonnet として誤表示**していたのを修正（Opus 系として表示）。
- **モデル不一致検出**（`agentWatcher`）: prefix マップに `opus-1m`（`claude-opus-`）を追加し、`opus-1m ↔ claude-opus-*[1m]` の 1M 判定を追加。`-1m` 付き設定が素の包含判定で誤一致しないようガード。
- **セッションからのモデル解決**（`agentFormPanel.resolveModelName`）: `opus[1m]` を `opus`→`opus-1m` に修正。

### 📝 ドキュメント・表記整合
- README の「主な機能」に v0.5.4（フォーム項目）/ v0.5.5（cwd 修正）/ v0.5.6（Opus 1M・Fable 除外）を追記（v0.5.3 で止まっていた）。
- `AgentConfig.effort` の陳腐化コメント（「max は Opus 4.6 のみ」）を現行に修正（max は全モデル可・セッション限定、Opus 4.8 既定=high）。

### 確認
- 横断 grep でモデル分岐・列挙・コスト/色/ラベル・effort・版表記を点検。`sessionTreeProvider` は `.includes('opus')` 方式のため opus-1m も自動的に拾えることを確認（変更不要）。
- 全 30 テスト合格・`tsc` クリーン。

## v0.5.6 (2026-06-01) — モデル選択を現行 Claude Code に追従（Opus 1M 追加 / Fable 除外）

現行 Claude Code（2.1.158 世代）のモデル構成に合わせてエージェントのモデル選択を更新。

### ➕ Opus 1M を追加
- **Opus 1M（`opus-1m` → CLI `opus[1m]`）** をモデル選択肢に追加。Opus 4.8 + 1M 長文コンテキスト。
  大規模調査・大量ファイル処理向け（従来の Sonnet 1M と対）。
- `AgentConfig` / `AgentDefinition` の model union、`modelCliMap`、`normalizeModel`、フォームラジオ、
  effort `max` の有効化条件（opus ファミリ）を更新。

### 🚫 Fable は選択肢に含めない（組織で無効化）
- 現行 CC には最上位の `fable`（Fable 5）が追加されたが、**組織で無効化されているため CSM の選択肢には出さない**。
- 防御策として `normalizeModel('fable')` は `opus` にフォールバック（禁止モデルを保持・表示しない）。

### 表記更新
- モデルラベルを現行版に更新（Sonnet 4.6 / Haiku 4.5 を明記、Opus は 4.8）。
- test: G1〜G3 を追加（normalizeModel / modelCliMap / opus-1m 往復）。全 30 テスト合格。

## v0.5.5 (2026-06-01) — 新規セッション作成のクロスOS cwd バグ修正

### 🐛 紐づけ「新規セッション作成」失敗を修正
- **症状**: エージェント紐づけで「新規セッションを作成」すると「新規セッション作成に失敗しました」エラー。
- **原因**: `createSessionForAgent` が `claude --agent` を spawn する際、cwd に **エージェント定義の `workDir` を生のまま**使っていた。Windows ホストで設定された `workDir`（例 `c:/xampp/Project/claude-session-manager`）は Linux VM に実体が無く、spawn が ENOENT で即失敗していた（クロス OS で共有された設定の典型）。resume 系は既に `translateWorkDirPath` で変換していたが、新規セッション作成パスだけ未対応だった。
- **修正**: `resolveSpawnCwd()` を新設し、`workDir` を `translateWorkDirPath`（`c:/xampp/Project/… → /mnt/hgfs/Project/…` 等の HGFS マッピング）で変換 + 実在チェック。解決できなければ workspace フォルダ → home にフォールバック。
- agent 定義の `workDir` は Windows パスのまま温存（runtime 変換で両 OS で動作するため、書き換えると Windows ホスト側が壊れる）。
- test: `translateWorkDirPath` の変換マッピングテスト（F1）を追加。全 27 テスト合格。

## v0.5.4 (2026-05-31) — エージェントフォームに現行 CC の subagent 項目を追加

エージェント設定フォームに、現行 Claude Code の subagent frontmatter 項目のうち未対応だった
3 項目を追加。`/workflows`・並列/バックグラウンド運用世代の設定をフォームから編集可能にした。

### ➕ フォーム新項目
- **許可ツール（allowedTools）** — チェックボックスで選択（Read/Write/Edit/Bash/Grep/Glob/Agent/WebFetch/WebSearch/Skill 等）。全部オフ = 全ツール継承（無制限）。従来は既存値の素通しのみで編集不可だった
- **worktree 隔離（`isolation: worktree`）** — 専用ワークツリーで実行するトグル
- **バックグラウンド実行（`background: true`）** — トグル

### 設計
- 3 項目を `AgentConfig` / `AgentDefinition` に追加し、frontmatter の読み書き（parse / buildFrontmatter）・`toAgentConfig` 変換を整備
- **フォーム権威セマンティクス**: フォーム由来の値は「指定があればそれを採用」。空配列（ツール全オフ）や OFF を尊重して**解除も反映**（`config.X !== undefined ? config.X : existing` 方式）。`background: false` / `isolation` なしは frontmatter に書き出さない
- `effort` は low/medium/high/xhigh/max の全段階が既に揃っており現行どおり（`ultracode` は per-agent effort ではなくセッション専用設定のため非対象）

### テスト
- `test/unit/agent-hooks-qa.test.js` に E1〜E3 を追加（isolation/background 往復・AgentConfig 往復・フォーム権威での解除）。全 26 テスト合格

## v0.5.3 (2026-05-31) — Agent作成・紐づけ・Hook の QA + frontmatter クォートバグ修正

エージェント新規作成・セッション紐づけ・hook 周りを QA し、ユニットテストを整備。
QA でフロントマターのクォート不具合を検出し修正した。

### 🐛 frontmatter クォートバグ修正（QA 検出）
- `role` / `displayName` 等のフロントマター値に **`"` と改行**が同時に含まれると、二重引用符
  スカラーに生の改行が入り **YAML が複数行に割れて値が破損**していた（例: `say "hi"\n...` → `say "hi\`）。
- `quoteYamlValue`（agentFileManager）が改行/復帰/タブを `\n`/`\r`/`\t` にエスケープするよう修正。
- パーサ（frontmatterUtils）のダブルクォート復号を**単一パス**化し、`\\` `\"` `\n` `\r` `\t` を
  左→右に原子的に復号（旧 `\\"` 取り違えの潜在バグも解消）。

### ✅ QA テストスイート追加（`test/unit/agent-hooks-qa.test.js`, 20 ケース）
- **binding**: setAgentSession（empty→new / existing→skip / force / `unlinked` 扱い / previousSessionIds・mode 保持）、addAgent⇄getAgents 往復、removeAgent、cleanupSessionData 解除、migrateAgentsToAgentSessions
- **agentFileManager**: パストラバーサル名の拒否、日本語名許可、YAML クォート、モデル往復
- **hook スクリプト（templates 実機実行）**: session-agent-inject の紐づけ解決＋sessionTitle、check-ask-agent の deny/pass、injection-detect の検知、session-stop の historyEnabled ゲート
- **hook クリーンアップ**: filterCsmHooks の CSM 除去・非CSM 温存・旧 bash マーカー除去
- `npm test` を `node --test test/unit/*.test.js` に変更し全テスト（既存3 + 新規20 = 23）を実行。

## v0.5.2 (2026-05-31) — Hook ライフサイクル堅牢化（クロスOS自己修復・アンインストール清掃・内容是正）

VMware（Windows ホスト ⇄ Linux VM）で `~/.claude/settings.json` を共有する環境で、
hook の絶対パスがクロス OS で壊れて「SessionStart startup hook error」等が発生する問題を
中心に、hook の自己修復・内容是正・ライフサイクル整備を行った。

### 🩹 クロスOSパス self-heal + dead-hook prune
- **heal**: Windows ホストで書かれた `C:/Users/.../.claude/...` の CSM hook を、Linux VM 起動時に
  `~/.claude/...` へ自動修復（`healForeignOsHookPaths`）。再構築先が**実在する場合のみ**書き換え。
  `$HOME`/`~` の移植可能形式は温存。CSM 自身の hook 限定。
- **prune**: heal 不能な「別 OS の死んだパス」（現在 OS に実体が無く永久に解決不能な CSM hook、
  例: 旧 `c:/xampp/.../*.sh`）は settings.json から除去。空になった matcher グループ／イベントキーも削除。
- 原因: 従来の冪等判定がマーカー名のみで、登録パスが現在 OS で解決可能か検証していなかった。
- マーカー定義を `csmHookCleanup.CSM_HOOK_MARKERS` に一元化（heal / prune / migrate / removeAll 共通、旧 bash 版含む）。

### 🐛 hook 内容の是正（現行 Claude Code 2.1.158 契約に整合）
- `csm-check-ask-agent.js`: PreToolUse の `permissionDecision: "block"`（無効値でブロック不発）を
  正しい `"deny"` に修正。存在しない `continueOnBlock` フィールドを削除。
- デプロイ方式を統一: `csm-session-agent-inject.js` / `csm-governance-capture.js` を
  「無ければ作る」から「差分があれば上書き」へ（`sessionTitle` 対応などのドリフト解消）。

### 🧹 アンインストール／無効化時のクリーンアップ
- `vscode:uninstall`（`out/uninstall.js`）でアンインストール時に CSM hook を settings.json から
  全除去 + `~/.claude/hooks/csm-*.js` を `.trash/` へ退避。
- 手動コマンド **「すべての CSM フックを削除（アンインストール準備）」**（`claudeManager.removeAllHooks`）を追加。
- 共通コア `src/utils/csmHookCleanup.ts`（vscode 非依存）。ECC 所有の `scripts/csm/` 配下は除去しない。

### 🛡️ csm-injection-detect を CSM 正式所有化
- WebFetch/WebSearch のプロンプトインジェクション検知 hook をテンプレ化 + `ensureInjectionDetectHook`
  で配備・登録（PostToolUse, matcher `WebFetch|WebSearch`）。従来はオーファン（更新・再配備不能）だった。

### 実装ファイル
- `src/services/hookService.ts`（self-heal / removeAllCsmHooks / ensureInjectionDetectHook / デプロイ上書き）
- `src/utils/csmHookCleanup.ts`（新規・vscode 非依存）, `src/uninstall.ts`（新規）
- `templates/csm-check-ask-agent.js`（block→deny）, `templates/csm-injection-detect.js`（新規）
- `src/extension.ts`（配線 + コマンド登録）, `package.json`（`vscode:uninstall` + コマンド）

## v0.5.1 (2026-05-31) — オーケストレーション可視化タブ + Activity Bar 4アイコン化

### 🎼 オーケストレーション可視化 — 5番目の Activity Bar アイコン (T7.1〜T7.6)

Claude Code /workflows・バックグラウンドエージェントのライブ稼働状況を可視化する
専用ビューを Activity Bar に追加。

#### 機能
- **サマリーバー**: `🎼 N セッション / M サブエージェント` を常時表示
- **グループ化**: `🟢 インタラクティブ` / `⚙️ バックグラウンド/ワークフロー` に自動分類
  - ワークフロー判定: `kind=background` OR サブエージェント数 ≥ 3 (ヒューリスティック)
- **セッションノード**: 名前 / cwd / 経過時間 / サブエージェント数 を表示
- **サブエージェントノード**: JSONL 末尾解析で稼働中 Task/Agent を検出・表示
- **5秒ポーリング**: タブ可視時のみ更新 (非可視時停止)
- **データソース優先順**: `claude agents --json` (2.1.145+) → agentWatcher PID/JSONL
- **右クリックメニュー**: Claude で開く / セッション ID コピー

#### 実装ファイル
- `src/services/orchestrationViewModel.ts` (新規): データ収集・ビューモデル構築
- `src/providers/orchestrationTreeProvider.ts` (新規): TreeDataProvider + TreeItem 定義
- `package.json`: `claude-orchestration` Activity Bar コンテナ + `claudeOrchestration` ビュー
- `src/extension.ts`: OrchestrationTreeProvider の初期化・依存注入・コマンド登録

## v0.5.1 (2026-05-31) — Activity Bar 4アイコン化（タブバー廃止）

### UI 刷新: 1アイコン → 4独立アイコン

VS Code 標準の Activity Bar アイコン切替方式に変更。タブバー (TreeView) を廃止し、
Explorer/Git のように左縦アイコンでセクションを切り替える形になった。

#### 変更内容
- `package.json`:
  - `viewsContainers.activitybar`: `claude-manager` 1個 → 4個に分割
    - 💬 `claude-sessions` (comment-discussion)
    - 👤 `claude-agents` (organization)
    - 🧠 `claude-memory` (database)
    - 📁 `claude-projects` (folder-opened)
  - `views`: 旧 `claude-manager` セクションを廃止。4コンテナに分散配置
    - `claudeTabBar` view を削除
    - `when` 句 (`activeTab`/`useNewMainPanel` 条件) を全廃 — コンテナ分離で不要
  - `menus.view/title`: `claudeTabBar && activeTab` 依存の action entries を削除
    → プロジェクトタブ用に `claudeMain` view/title 設定ボタンを追加
- `extension.ts`:
  - `TabBarTreeProvider` インポート・登録・タブ切替ロジックを削除
  - `setContext('claudeManager.activeTab', ...)` 関連コードを削除
  - `tabBarStatusTimer` 削除（不要に）

#### 効果
- タブバー下の余白問題が構造レベルで解消
- 会話タグ (`claudeTags`) の非表示バグが `when` 句廃止で解消
- VS Code 標準ナビゲーション UX に準拠

---

## v0.5.1 (2026-05-31) — 右クリックメニュー再編 v2（重複排除・グループ統一）

### 右クリックメニュー再設計 v2 実装

`docs/v0.5.x-menu-redesign-2.md` に基づき `package.json` の `view/item/context` を再整理。
登録行数: **39 → 32**（エージェント系 18 → 11、重複7件削除）

#### 変更内容

**エージェント系の重複排除（主目的）**
- `previewAgent` / `openAgentInClaude` / `openAgentSession`: `claudeAgents` と `claudeAgentsFavorites` の2行登録を when 句の OR 結合で **1行に統合**
  ```json
  "when": "(view == claudeAgents || view == claudeAgentsFavorites) && viewItem =~ /(agentItemLinked|favoriteAgentLinked)/"
  ```
- `removeAgentFavorite` inline: `claudeAgents` / `claudeAgentsFavorites` 2行を OR 結合で1行に
- `addAgentFavorite` / `removeAgentFavorite` の `2_favorite` グループ登録を完全削除
  → inline の ★ トグルのみ残し、コンテキストメニュー本体への二重表示を解消

**グループ名・順序統一**
- セッション系: `2_agent` → `2_link`（設計書 v2 の命名規約に準拠）
- エージェント系: `0_link` → `2_link`、`2_copy` → `0_open@5/@6`（コピー操作を 0_open に統合）
- 全コマンドに `@N` インデックスを付与（同 group 内の順序を保証）

---

## v0.5.1 (2026-05-30) — modelCliMap エイリアス方式へ移行 (重大バグ修正)

### 重大バグ修正: フロントマターに古いモデルIDが固定される問題

#### 問題
`src/utils/cliBuilder.ts` の `modelCliMap` が具体的なモデルID を保持していたため、
エージェント新規作成・保存時に `model: claude-opus-4-6` 等が frontmatter に書き込まれ、
Opus 4.8 が存在しても古い 4-6 で起動していた。

#### 修正内容 (src/utils/cliBuilder.ts)
- `modelCliMap` をエイリアス方式に変更（案A）:
  - `'opus'` → `'opus'` (旧: `claude-opus-4-6`)
  - `'sonnet'` → `'sonnet'` (旧: `claude-sonnet-4-6`)
  - `'sonnet-1m'` → `'sonnet[1m]'` (旧: `claude-sonnet-4-6[1m]`)
  - `'haiku'` → `'haiku'` (旧: `claude-haiku-4-5`)
- Claude Code 起動時にエイリアスを最新モデルへ解決するため、リリース毎の更新不要

#### modelMismatch 誤検知について
- `agentWatcher.ts` は `agent.model` を `normalizeModel()` 経由で正規化してから比較するため
  `'opus'` vs `'claude-opus-4-8'` のような比較が正しく一致と判定される（修正不要）
- 既存エージェントの `.md` ファイルは変更しない（次回保存時から新方式が適用）

---

## v0.5.1 (2026-05-30) — Opus 4.8 対応・effort ラベル更新 (CC 2.1.154〜2.1.158)

### Claude Code 2.1.154〜2.1.158 対応

#### モデル選択 UI (agentFormPanel.ts)
- **Opus ラジオのサブテキスト** を「Opus 4.8 — 最高度の判断・複雑な開発（デフォルト high effort）」に更新
  - `value="opus"` はそのまま維持（Claude Code 側で opus-4-8 へ解決される）
  - `normalizeModel()` は `includes('opus')` で広くマッチするため変更不要

#### effort ラベル (agentFormPanel.ts)
- **High**: 「深い推論（Opus 4.8 デフォルト・推奨）」
- **XHigh**: 「超高深度（最難タスク向け）」 — バージョン縛り表記 (v2.1.111+) を汎用化

#### README.md
- 推奨 Claude Code バージョン: **2.1.153+** → **2.1.158+**

---

## v0.5.1 (2026-05-28) — Claude Code 2.1.145〜2.1.153 取込み

### claudeAgentsService 復活 — `claude agents --json` 公式 API 対応 (2.1.145+)

Claude Code 2.1.145 で `claude agents --json` が追加されたことを受け、
`ClaudeAgentsService` を JSON API ベースに全面切替えして再有効化。

#### 実機確認済み JSON フォーマット
```json
[
  { "pid": 535218, "cwd": "/path/to/project", "kind": "interactive",
    "startedAt": 1779937055153, "sessionId": "9148962f-24f8-4b19-bed8-e3c0b3aa9947" }
]
```

#### 変更点
- `claudeAgentsService.ts`:
  - 第1選択: `claude agents --json` (2.1.145+) を `execFile` で実行
  - 第2選択: `claude agents` テキスト出力パース（旧バージョン後方互換）
  - `ClaudeAgentEntry` に `pid`, `kind`, `startedAt`, `source` フィールドを追加
  - `source: 'json-api' | 'text-parse'` で取得元を識別
  - `elapsedSec` を `startedAt` から自動計算（JSON API 時）
  - JSON API エントリは全件 `status: 'running'` とみなす（アクティブセッションのみ返す仕様）
  - `ClaudeAgentRawJson` 型を追加（実機フォーマット定義）
- `agentLiveTreeProvider.ts`:
  - `setClaudeAgentsService()` を追加し JSON API を優先データソースに設定
  - availability `unknown` 時はローディング表示
  - `unavailable` / `disabled` 時は `agentWatcher`（PID/JSONL）に自動フォールバック
  - `LiveAgentItem` のツールチップに `pid` / `kind` / 取得元バッジを追加
  - `notifyTabVisible()` を `ClaudeAgentsService.setTabVisible()` に委譲（ポーリング制御）
- `extension.ts`:
  - `ClaudeAgentsService` のコメントアウトを解除して再有効化
  - `agentLiveProvider.setClaudeAgentsService(claudeAgentsService)` で注入
  - `claudeAgentsService.onDidChange` で running セッションを `agentWatcher` に補完（Phase 3）



### 調査・対応サマリー

| 項目 | バージョン | 結果 |
|------|-----------|------|
| /simplify → /code-review リネーム | 2.1.147 | **該当なし** (CSM 内で未使用) |
| MessageDisplay hook | 2.1.152 | hookService.ts に骨組み追加 |
| SessionStart: sessionTitle 出力 | 2.1.152 | csm-session-agent-inject.js に追加 |
| Stop hook: background_tasks / session_crons | 2.1.145 | csm-session-stop.js に追加 |
| 推奨版を 2.1.153+ に更新 | 2.1.153 | README.md 更新 |
| auto mode デフォルト ON | 2.1.152 | **該当なし** (ユーザー向け説明文なし) |

### 変更詳細

#### csm-session-agent-inject.js (SessionStart hook)
- `hookSpecificOutput.sessionTitle` に `[agentName]` を設定
- Claude Code 2.1.152+ でセッションタブのタイトルがエージェント名で自動設定される

#### csm-session-stop.js (Stop hook)
- `input.background_tasks` / `input.session_crons` を読み取り
- 継続中タスクがある場合、HISTORY.md の記録に `(background tasks N 件継続中)` を付記
- Claude Code 2.1.145+ で提供される情報

#### hookService.ts
- `isMessageDisplayHookEnabled()` スタブ関数を追加
- MessageDisplay hook (2.1.152+) の設定キー・input/output 形式をドキュメントコメントで記載
- 実装テンプレートは将来のユーザー拡張向けに予約

#### README.md
- 推奨バージョン: **2.1.144+** → **2.1.153+**

---

## v0.5.1 (2026-05-19) — タブ切り替えパフォーマンス改善

### TreeView ルートノード短期キャッシュ追加

タブを切り替えるたびに `getChildren()` が IO を実行していた問題を改善。

#### 変更内容
- `AgentTreeProvider`: ルートノード結果を 5 秒 TTL でキャッシュ
  - `refresh()` 呼び出し時に即座に無効化するため、データ鮮度は維持
  - バナー判定 4 本（`isCsmAskAgentInstalled` / `isSessionAgentInjectInstalled` / `hasOldAskAgentFiles` / `detectLegacyAgents`）を `Promise.all` で並列化
- `MemoryTreeProvider`: ルートノード結果を 5 秒 TTL でキャッシュ
  - フィルター状態変更時は即時無効化

#### 効果
- キャッシュヒット時: ファイル IO ゼロ → タブ切り替えが体感上即時
- キャッシュミス時: バナー判定が並列化され約 50〜70% 短縮

---

## v0.5.1 (2026-05-19) — Claude Code 2.1.144 取込み

### Claude Code 2.1.142〜2.1.144 対応確認・取込み

#### 項目 1: Stop hook 連続ブロック (2.1.143 仕様追加)
- **調査結果**: 影響なし
- `csm-session-stop.js` は `{}` または `{terminalSequence:...}` のみ出力。`permissionDecision: block` は PreToolUse hook のみ使用であり Stop hook には一切なし。8 回ブロック強制終了の危険なし。

#### 項目 2: 推奨バージョン更新 → 2.1.144+
- README.md の「推奨 Claude Code」を **2.1.139+** から **2.1.144+** に更新
- 旧推奨 (2.1.141+) は「旧推奨」として残置

#### 項目 3: /extra-usage → /usage-credits リネーム (2.1.144)
- **調査結果: 該当なし** — CSM 全体で `/extra-usage` 文字列の使用なし。対応不要。

#### 項目 4: subagent 完了通知 経過時間記録 (2.1.144)
- `csm-session-stop.js` に `input.elapsed_time` フィールドの取込みを追加
- HISTORY.md の自動記録エントリに経過時間を付記: `(セッション終了時自動記録 3h 2m 5s)`
- `input.elapsed_time` が未設定の場合はスキップ（後方互換）

#### 項目 5: --resume bg セッション対応 (2.1.144)
- **調査結果: 既存ロジックでカバー済**
- `buildResumeArgs()` は `--resume <sessionId>` を組み立てるのみで、セッション種別（通常/bg）を問わない
- 2.1.144 で bg セッションが `--resume` 対象に追加されても CSM 側変更不要

---

## v0.5.1 (2026-05-19) — プロジェクトタブ統一: claudeTabBar 常時表示化

### プロジェクトタブ UI 統一

全タブで `claudeTabBar` (TreeView) を常時表示するよう変更し、プロジェクトタブのみ異なる見た目になっていた問題を解消。

#### 変更内容
- `package.json`:
  - `claudeTabBar` の `when` 句から `&& claudeManager.activeTab != 'projects'` を削除
    → 全タブ選択時に `claudeTabBar` TreeView が常時上部に表示される
  - `view/title` でプロジェクトタブ選択時の設定ボタンを追加
- `mainTabPanel.ts` (claudeMain WebviewView):
  - 内部タブバー (`<nav class="tab-bar">`) を完全削除
  - アクション行 (`.tab-action-bar`) を削除
  - セッション・エージェント・メモリのペイン HTML を削除 → **プロジェクト一覧のみ**に
  - 対応するタブ切り替え JS・セッション/エージェント/メモリ JS を削除
  - メッセージハンドラを `projects-data` / `project-tree-data` のみに絞り込み
  - `_sendInitialData()` をプロジェクトデータのみ送信するよう簡略化

---

## v0.5.1 (2026-05-19) — エージェント登録フォームに HISTORY / TODO トグル追加

### エージェント登録フォーム: HISTORY / TODO トグル

エージェント新規登録・編集フォームに HISTORY と TODO の有効化トグルを追加。

#### 変更内容
- `agentFormPanel.ts`:
  - **HISTORY 有効化トグル**: ON/OFF チェックボックス。保存時に HISTORY.md が無ければ自動作成。
  - **HISTORY.md 保存先選択**: 自動（.md と同じスコープ）/ グローバル / プロジェクト。
    HISTORY が OFF のときは非表示。
  - **TODO 有効化トグル**: ON/OFF チェックボックス。保存時に TODO.md が無ければ自動作成。
  - **設定デフォルト反映**: 新規登録時は VS Code 設定
    `claudeManager.agent.defaultHistoryEnabled` / `defaultTodoEnabled` を読み込みデフォルト値に使用。
    編集時は既存エージェントの値を使用。
- `agentCommands.ts` (`claudeManager.addAgent`):
  - `addAgent()` 後に `historyEnabled=true` なら `~/.claude/agents/<name>/HISTORY.md` を作成（未存在時）。
  - `todoEnabled=true` なら `~/.claude/agents/<name>/TODO.md` を作成（未存在時）。
  - テンプレート: HISTORY は「歴代セッション記録」ヘッダ、TODO は「確認待ち / タスク」セクション。

---

## v0.5.1 (2026-05-19) — タブバー WebView → TreeView 化（余白問題解消）

### claudeTabBar: WebviewView → TreeView 置換

**問題:** 他の TreeView（会話ブックマーク・会話タグ等）を折り畳むと、
claudeTabBar の WebviewView 領域が余剰スペースを受け取り大きな空白が生じていた。

**解決策:** WebviewView を TreeView に置換。TreeView はコンテンツ行数分しか高さを取らないため、
他のビューを折り畳んでも余白ゼロを維持する。

#### 変更内容
- `tabBarPanel.ts`: `WebviewViewProvider` → `TabBarTreeProvider` (`TreeDataProvider<TabBarItem>`) に完全置換
  - タブ4行（セッション / エージェント / メモリ / プロジェクト）
  - アクティブタブ: アイコン青色 + `●` description で視覚的に識別
  - ステータス1行（稼働数 / 最終更新 / プロジェクト名）
  - `setActiveTab()` / `setStatusProvider()` / `pushStatusInfo()` API を維持
- `extension.ts`:
  - `registerWebviewViewProvider` → `createTreeView('claudeTabBar')` に変更
  - `tabBarTreeView.onDidChangeSelection` でタブ行クリックを捕捉し `claudeManager.activeTab` を更新
- `package.json`:
  - `claudeTabBar` ビューの `type: "webview"` / `initialSize: 2` を削除（ネイティブ TreeView に）
  - `view/title` にタブ別アクションボタンを追加（sessions/agents/memory/projects それぞれ `when` 句で切替）

---

## v0.5.0 (2026-05-14) — エージェント管理ラベルに [Open]/[経過時間] プレフィックス追加

### エージェント管理ラベル改善

エージェント管理セクションの各エージェント行に稼働状態プレフィックスを追加。

- **動作中かつ最近更新 (30秒以内)** → `[Open] Ｓ エージェント名` — 現在対話中と推定
- **動作中かつ古い** → `[5分] Ｓ エージェント名` — 経過時間表示 (秒/分/時間/日)
- **停止中** → `Ｓ エージェント名` — プレフィックスなし (従来通り)

実装:
- `agentTreeProvider.AgentItem`: `mtimeMs?` パラメータ追加、`formatLiveElapsed()` ヘルパー追加
- `AgentTreeProvider`: `getSessionMtimeFn` コールバック追加
- `extension.ts`: `agentWatcher.getSessionMtime` を `AgentTreeProvider` に注入
- `agentWatcher.onDidChange` → `AgentItem` ラベルも自動更新 (reload 不要)

---

## v0.5.0 (2026-05-14) — ライブ状態セクション PID/JSONL ベースに切替

### ライブ状態セクションのデータソース変更

`claude agents` コマンドが TTY 必須の対話モードコマンドであり、VS Code 拡張から `execFile()` 経由で呼ぶと「is not available in this environment」が返される制約が実機検証で判明。
既存の `agentWatcher` (PID/JSONL 監視) が同等の情報を保持しているため、データソースを切り替え。

- **`agentLiveTreeProvider`**: データ取得元を `ClaudeAgentsService` → `AgentWatcher` に変更
- **`agentWatcher`**: `getLiveSessionCwdMap()` を新規公開（セッション ID → cwd マップ）
- **`extension.ts`**: `ClaudeAgentsService` の初期化を削除。`agentLiveProvider.setAgentWatcher()` に変更
- **`claudeManager.claudeAgentsIntegration.enabled`**: デフォルトを `false` に変更（TTY 非対応の旨を Description に明記）
- エラー表示なしで稼働中エージェントを正常表示

---

## v0.5.0 (2026-05-14) — エージェントタブ 3分割 + セッションタブ並び順統一

### UI 再構成: エージェントタブを3つの独立ビューに分割

#### エージェントタブ
- **`claudeAgentsLive`** (新規): 「ライブ状態」専用ビュー — `claude agents` コマンドの結果を表示
  - 既存 `agentTreeProvider` の `LiveStatusSectionItem` / `LiveAgentItem` を `agentLiveTreeProvider.ts` に分離
  - `AgentLiveTreeProvider` が `ClaudeAgentsService` を直接注入、タブ可視性ポーリングも独立制御
- **`claudeAgentsFavorites`** (新規): 「お気に入りエージェント」専用ビュー — ブックマーク済みフラットリスト
  - 既存 `FavoriteTreeSectionItem` / `FavoriteAgentItem` を `agentFavoritesTreeProvider.ts` に分離
  - `AgentFavoritesTreeProvider` が `agentWatcher` 状態と連動してリフレッシュ
- **`claudeAgents`** (既存): エージェント一覧のみ — Live・Favorite セクションを除去してスリム化

#### セッションタブ並び順統一
- 旧: 一覧 → ブックマーク → タグ
- **新: ブックマーク → タグ → 一覧**（ブックマークを最上位に）

#### 技術的変更
- `agentTreeProvider.ts`: `ClaudeAgentsService` 依存・`getBookmarks` 依存・Live/Favorite クラス群を削除
- `agentLiveTreeProvider.ts`: 新規作成（`LiveAgentItem`, `LiveStatusMessageItem`, `buildLiveAgentViews`）
- `agentFavoritesTreeProvider.ts`: 新規作成（`FavoriteAgentItem` を `AgentItem` のサブクラスとして継承）
- `extension.ts`: 2つの新 TreeView 登録、`claudeAgentsLiveTreeView.onDidChangeVisibility` 配線
- `package.json`: 2つの新 view 定義、セッションビュー並び順変更、お気に入りビューの inline/context メニュー追加

---

## v0.5.0 (2026-05-14) — QA HIGH 修正 (H-1 + H-2)

### セキュリティ・堅牢性修正

#### H-1: `claudeAgentsService` — `exec()` → `execFile()` 置換
- シェル経由の `exec(`claude agents ...`)` を `execFile('claude', [...args])` に変更
- パスに特殊文字が含まれる場合のクォート不全を根本解消
- Windows では `.cmd` シム対応のため `shell: true` を適用
- `shellQuote()` ヘルパー削除

#### H-2: `dataStore.setAgentSession()` — `force` パラメータ + ロギング追加
- `force?: boolean` パラメータ追加: `true` 時は既存 sessionId ガードをバイパス
- `outputChannel?: vscode.OutputChannel` パラメータ追加: スキップ時のログ出力先
- スキップ時: `"[CSM] 既存 sessionId XXX を保持 (force=false)"` をログ出力
- ユニットテスト追加: `test/unit/setAgentSession.test.js` (3ケース: empty→new / existing→skip / force=true→overwrite)

---

## v0.5.0 (2026-05-14)

### ⭐ お気に入りエージェント UI 改善 — 会話風フラットリスト + ★追加ボタン

前回の階層ツリー表示を廃止し、会話ブックマークと同じ見た目のフラットリスト形式に変更。
全エージェント行にインラインの ★/☆ ボタンを追加。

#### 変更内容
- `FavoriteTreeSectionItem`: ラベルを「⭐ お気に入りエージェント (N)」に変更（件数バッジ付き）
- `FavoriteAgentItem`: `neededSet`/`isIntermediateNode` を削除 → フラット専用シンプル実装
- `_buildFavoriteList()`: ブックマーク済みエージェントをアルファベット順でフラット返却
- `AgentItem.contextValue`: `isBookmarked()` 参照で `Bookmarked` フラグを追加
  - `agentItem` / `agentItemLinked` / `agentItemBookmarked` / `agentItemLinkedBookmarked`
- `claudeManager.addAgentFavorite` コマンド追加 — ☆ ボタン (inline@20)
- `claudeManager.removeAgentFavorite` コマンド追加 — ★ ボタン (inline@20)
- 右クリックメニュー `2_favorite` グループにも追加/削除を登録

---

## v0.5.0 (2026-05-14) — claude agents 統合

### TASK-5 Phase 1+2+3: `claude agents` コマンド統合（ライブ状態セクション）

Claude Code 2.1.139+ の `claude agents` コマンドを CSM エージェントタブに統合し、
「🟢 ライブ状態」セクションをエージェントタブ最上部に追加。

#### 新機能
- **🟢 ライブ状態セクション**: `claude agents` の出力を5秒ポーリングでリアルタイム表示
- **ステータス別アイコン**: 🟢 running / 🟡 blocked / ⚪ done をアイコン色で区別
- **CSM マッチング**: sessionId または cwd でエージェント名と自動紐づけ
- **未登録セッション表示**: CSM 未登録セッションも "(未登録)" として表示（設定で非表示化可）
- **タブ可視時のみポーリング**: エージェントタブ非表示中はポーリング停止（CPU 節約）
- **バックオフリトライ**: 連続失敗時に 5s → 30s → 5min と間隔を延長
- **非対応環境検出**: `'claude agents' is not available` を検知してセクションに説明を表示
- **手動リフレッシュ**: `claudeManager.refreshLiveAgents` コマンドで即時更新可能
- **フレキシブルパーサー**: テキスト形式 (A/B/C/D の4フォーマット) + 将来の `--json` に自動対応

#### Phase 3: PID チェック補完 (TASK-5 Phase 3)
- `claude agents` の running セッションを `agentWatcher` の PID ライブセットに補完
- フォールバック: `claude agents` 利用不可時は既存 PID チェックのみで動作（既存機能維持）

#### 設定キー追加
| キー | デフォルト | 説明 |
|---|---|---|
| `claudeManager.claudeAgentsIntegration.enabled` | `true` | ライブ状態セクションを有効化 |
| `claudeManager.claudeAgentsIntegration.pollingIntervalMs` | `5000` | ポーリング間隔（ms） |
| `claudeManager.claudeAgentsIntegration.scopeToWorkspace` | `true` | --cwd でワークスペースに絞り込み |
| `claudeManager.claudeAgentsIntegration.showUnregistered` | `true` | 未登録セッションも表示 |

#### 実装ファイル
- `src/services/claudeAgentsService.ts` (新規): fetch + parse + 可用性検出 + キャッシュ + ポーリング
- `src/providers/agentTreeProvider.ts`: LiveStatusSectionItem / LiveAgentItem / LiveStatusMessageItem 追加
- `src/watchers/agentWatcher.ts`: `supplementLiveFromClaudeAgents()` 追加 (Phase 3)
- `src/commands/agentCommands.ts`: `previewAgentByName` コマンド追加
- `src/extension.ts`: ClaudeAgentsService 初期化 + TreeView 可視性監視
- `package.json`: 設定キー / コマンド追加

### TASK-4: JSONL `attributes` フィールドから agent_id 読み取り強化

OTEL / x-claude-code-agent-id ヘッダー由来の `attributes` フィールドをセッション自動紐づけの
第2手段として追加。

- `agentWatcher.ts`: `readAgentIdFromAttributes()` 追加（先頭 4KB / 10 行を検索）
- 対応キー: `attributes.x-claude-code-agent-id` / `agent_id` / `agentId` / `agent.name`
- フォールバック: `agent-setting` タイプが見つからない場合に自動切り替え
- `scanProjectsForAutoLink` も同様に拡張（バッチスキャン時）

### TASK-7: /goal コマンド連動 PoC

CSM タスクログを `/goal` コマンド用の目標テキストとしてクリップボードに出力する PoC。

- コマンド: `claudeManager.showGoals` — 実行中タスクを番号付きリストでクリップボードへコピー
- Claude Code で `/goal` を実行後に貼り付けて使用する想定

---

### TASK-2: Claude Code 2.1.136 underscore パス修正の影響確認

`--resume` / `--continue` の underscore パスバグ（2.1.136 で修正）の CSM 側影響を調査。

- `getJsonlPath` のエンコーディング `replace(/[\s/]/g, '-')` はアンダースコアを変換しない → Claude Code 2.1.136+ の動作と一致 ✓
- `decodeProjectName` はアンダースコアをそのまま通す ✓
- `scanProjectsForAutoLink` は全ディレクトリスキャン方式でパスエンコードに依存しない ✓
- **CSM 側の修正不要。既存実装で正しく動作している。**

### TASK-3: csm-check-ask-agent.js に continueOnBlock 追加 (Claude Code 2.1.139+)

`templates/csm-check-ask-agent.js` の block レスポンスに `continueOnBlock: true` を追加。

- Claude Code 2.1.139+: ブロック後もターンを継続し、ブロック理由をフィードバックとして受け取れる
- 旧バージョンは `continueOnBlock` フィールドを無視して従来通りの block 動作（後方互換）

### TASK-8: csm-session-stop.js に terminalSequence 通知追加 (Claude Code 2.1.141+)

セッション終了時にデスクトップ通知を発火する `terminalSequence` フィールドを Stop hook に追加。

- 設定キー `claudeManager.hooks.desktopNotification.enabled` (デフォルト: false、opt-in)
- extension.ts 起動時 / 設定変更時に `session-manager.json.hookSettings.desktopNotification` へ同期
- `templates/csm-session-stop.js`: `hookSettings.desktopNotification` が true のとき `terminalSequence` を出力
  - `]2;CSM: {agentName} セッション終了` (xterm window title + BEL)
- `src/models/types.ts`: `CsmHookSettings` インターフェース追加、`ManagerData.hookSettings` フィールド追加
- `src/models/dataStore.ts`: `setHookSetting()` / `getHookSettings()` 追加
- `package.json`: `claudeManager.hooks.desktopNotification.enabled` 設定項目追加

### TASK-10: README.md に推奨バージョン記載

動作要件テーブルを README 冒頭に追加:
- VS Code 1.85.0+ (必須)
- Claude Code 2.1.113+ (必須) / 2.1.139+ (推奨) / 2.1.141+ (全機能)

### ⭐ お気に入りツリー — エージェントタブにブックマーク階層表示を追加

既存のフラットな ★ブックマーク一覧に加え、親子階層を維持したツリー形式でブックマーク済みエージェントを表示するセクションを追加。

#### 動作
- ブックマーク（★）済みエージェントが1件以上あると「⭐ お気に入りツリー」セクションが表示される
- ★ ノードから `parentAgent` を遡り、必要な祖先ノードを自動収集してツリーを再構築
- ★ なしの中間ノードは `(経由)` バッジ + グレーアイコンで区別
- ★ ノードは黄色い星アイコンで強調
- ノードクリックで既存と同様にエージェントプレビューを開く

#### 実装
- `src/providers/agentTreeProvider.ts`:
  - `import { getBookmarks }` 追加
  - `FavoriteTreeSectionItem` クラス追加（折りたたみ可能セクションヘッダ）
  - `FavoriteAgentItem extends AgentItem` クラス追加（★/中間ノード）
  - `_buildFavoriteRoots()` — 祖先パス収集 + ルートノード生成
  - `_makeFavoriteItem()` — 単一ノード生成ヘルパー
  - `getChildren()` に `FavoriteTreeSectionItem` / `FavoriteAgentItem` ハンドラを追加
  - トップレベルでブックマーク1件以上の時に `FavoriteTreeSectionItem` を追加

---

## v0.5.0 (2026-04-27)

### プロジェクト UI 改善 — 詳細別タブ化 / ダイアログ廃止 / エクスプローラで開く

#### 詳細を WebView Editor タブで表示 (改善1)
- `src/panels/projectDetailPanel.ts` を新規作成 (singleton WebviewPanel)
- プロジェクト行クリック → `open-project-detail` → `showProjectDetail()` で Editor タブを開く
- サイドバー内のインライン詳細ペイン (`#project-detail-pane`) を削除
- プロジェクト一覧をコンパクトリスト形式に変更（行ごとに 詳細・エクスプローラ・削除ボタン）
- エージェント割り当て／解除後はパネルを自動更新

#### 別フォルダ確認ダイアログ廃止 (改善2)
- `src/commands/agentCommands.ts`: エージェント/プロジェクトを別ワークスペースで開く際の
  `showWarningMessage` ダイアログを削除
- 代わりに `vscode.openFolder` を `forceNewWindow: true` で即時実行

#### 📂 エクスプローラで開くボタン追加 (改善3)
- プロジェクト詳細パネル・一覧行の両方に 📂 ボタンを追加
- `revealFileInOS` コマンドで OS のファイルマネージャーを起動

### プロジェクトタブで タブバー統合 (試行)

`claudeMain` (WebView) にタブバー + アクション行を内包し、プロジェクトタブ時は
`claudeTabBar` を非表示にすることで、タブボタン → プロジェクト内容 を1枚の連続 WebView として表示。

#### 変更内容
- `mainTabPanel.ts`: タブバー CSS を `tabBarPanel.ts` と統一（高さ 36px、flexbox 整列、アイコン付き）
- `mainTabPanel.ts`: タブ切り替え時に `setContext('claudeManager.activeTab', tab)` を呼ぶ
- `mainTabPanel.ts`: `onDidChangeVisibility` でプロジェクトタブ再表示時に projects ペインにリセット
- `mainTabPanel.ts`: 各タブ別アクション行を追加（`tabBarPanel.ts` と同一ロジック・スタイル）
- `package.json`: `claudeTabBar` の `when` 句に `&& claudeManager.activeTab != 'projects'` を追加

#### 動作フロー
1. ユーザーが `claudeTabBar` でプロジェクトタブをクリック → `activeTab = 'projects'`
2. `claudeTabBar` が非表示、`claudeMain` が表示（タブバー + アクション行 + プロジェクト内容が1枚で見える）
3. `claudeMain` 内の別タブ（セッション等）をクリック → `setContext` で `activeTab` 更新
4. `claudeMain` が非表示、`claudeTabBar` が再表示

### hook を exec-form (args[]) に統一 (Claude Code 2.1.139+ クォート問題解消)

CSM が登録する全 hook を `command: "node"` + `args: [scriptPath, ...]` の exec-form に統一。
シェルを経由しない直接 spawn になるため、スペースを含むパスでのクォート問題が完全に解消される。

#### 変更内容
- `src/services/hookService.ts` に exec-form サポート用ヘルパーを追加:
  - `supportsExecForm()` — `claude --version` でバージョン判定（初回のみ実行・キャッシュ）
  - `buildHookDef(scriptPath, timeout, extraArgs?, extra?)` — 2.1.139+ なら exec-form、未満なら shell-form を返す
  - `hookMatchesMarker(hh, marker)` — shell/exec 両形式でマーカー一致判定
  - `signalHookMatches(hh, marker, action)` — subagent-signal 用 action 付き判定
  - `migrateHookToExecForm(hh)` — shell-form を exec-form に in-place 変換
- `migrateHooksToExecForm(outputChannel)` を export — 起動時に既存設定を一括変換
- 対象 hook: csm-precompact / csm-precompact-summary / csm-session-stop / csm-recap-capture /
  csm-session-agent-inject / csm-governance-capture / csm-check-ask-agent / subagent-signal
- `src/extension.ts`: 起動時に `migrateHooksToExecForm()` を呼び出して既存設定を自動変換
- Claude Code < 2.1.139 ではフォールバックとして従来の shell-form を維持

### isOtherProject クロスプラットフォームパス比較修正

`agentTreeProvider.ts` の `isOtherProject` 関数で、エージェントの `workDir`（Windows パス: `c:\GDrive\Craftwork`）を
Linux の VS Code ワークスペースパス（`/mnt/hgfs/GDrive/craftwork`）と直接比較していたため、
`workDir` 設定済みエージェントが全て「他プロジェクト」として扱われていた問題を修正。

- `agentUtils.ts` に既存の `translateWorkDirPath()` を `agentTreeProvider.ts` の `isOtherProject` でも使用するよう変更
- `workDir` をパス比較前に Linux パスへ変換（`c:/GDrive/` → `/mnt/hgfs/GDrive/`）
- `ruleFile` パスは disk から読み取った絶対 Linux パスのため変換不要（変更なし）

### プロジェクト情報パネル削除（ユーザー意図と相違のため revert）

commit ccbedcf で追加した `claudeProjectInfo` WebView パネルをリバート。
下部空白解消のためのパネル追加はユーザーの意図と異なっていたため削除。
- `src/panels/projectInfoPanel.ts` を削除
- `package.json` から `claudeProjectInfo` ビュー定義を削除
- `src/extension.ts` から import・登録コードを削除

### タブバー動的アクション行 + ステータス行

タブバーのアクション行をタブ別に動的切替し、下部空白を解消するステータス行を追加。

#### 動的アクション行（タブ別）
- **全タブ共通**: 🔄更新 / ⚙️設定
- **セッション**: 🔍検索 (`claudeManager.searchSessions`) を追加
- **エージェント**: ➕新規 / 🌐組織図 / ✅確認待ち (`claudeManager.showPendingTasks`) を追加
- **メモリ**: 🧬メモリ統合 (`claudeManager.mergeMemories`) を追加
- **プロジェクト**: 更新 + 設定のみ
- アクション行は JS 側で動的レンダリング。タブクリック時に即時切り替え。

#### ステータス行（下部空白解消）
- body を `height: 100vh` + flex column にして Webview 全体を埋める
- 最下部に固定のステータス行（22px）を追加:
  - 🟢/⚫ 動作中エージェント数
  - 最終更新時刻（相対表示: "3秒前"/"2分前"）
  - ワークスペースフォルダ名
- Extension から 10 秒ごとに `postMessage` でデータをプッシュ
- `agentWatcher.onDidChange` 時にも即時プッシュ

### タブバー下クイックアクション行 + プロジェクトツリーをデフォルト化

#### タブバー下空白をクイックアクション行で活用
- タブバー (`claudeTabBar`) の下に 4 つのクイックアクションボタンを追加
  - 🔄 **更新** — セッション一覧を即時更新 (`claudeManager.refreshSessions`)
  - ➕ **新規エージェント** — エージェント作成ダイアログを開く (`claudeManager.addAgent`)
  - 🌐 **組織図** — 組織図パネルを表示 (`claudeManager.openOrgChart`)
  - ⚙️ **設定** — 拡張設定を開く (`claudeManager.openSettings`)
- タブバー Webview の高さを 36px → 72px に拡張（タブ行 + アクション行）
- `package.json` の `initialSize` を 1 → 2 に更新

#### プロジェクトタブのデフォルト表示をツリーに変更
- 初回起動時 (`localStorage` 未設定) のデフォルトモードを `'card'` → `'tree'` に変更
- カードモードはトグルボタンで引き続き利用可能

---

### 利用率 StatusBar — クリックで QuickPick メニュー表示

StatusBar の利用率表示をクリックしたとき、再取得のみ行っていた動作を改善。
3 択の QuickPick メニューを表示し、用途に応じた操作を選択できるようにした。

- **$(browser) Claude Code を開く** — `claude-vscode.sidebar.open` を実行（失敗時は `editor.open` にフォールバック）
- **$(link-external) claude.ai/settings/usage をブラウザで開く** — ブラウザで使用量ページを表示
- **$(refresh) 利用率を再取得** — 従来どおり最新データをフェッチ

`claudeManager.refreshUsage` コマンドは既存のキーバインドや設定から引き続き利用可能。
新コマンド `claudeManager.openUsageMenu` を package.json の commands に登録。

### v0.5.0 プロジェクトツリーモード追加 — プロジェクトタブにツリー表示を追加

プロジェクトタブにカード表示とツリー表示を切り替えるモード切替機能を追加。
既存のカードモード (Sprint 2 実装) は温存し、ツリーモードを新規追加。

#### TT1: モード切替トグル UI
- アクションバー右端に [📋 カード] / [🌲 ツリー] トグルボタンを追加
- `localStorage('csm.projectTab.mode')` でモードを永続化（デフォルト: カード）
- 起動時に保存済みモードを自動復元

#### TT2: ツリー構造レンダリング
- `<details>/<summary>` ネイティブ折りたたみでプロジェクトをノード表示
- 各プロジェクトに 3 カテゴリのサブノード:
  - 👤 エージェント — 割当エージェント名一覧
  - 🧠 メモリ — プロジェクトメモリファイル一覧
  - 💬 セッション — 紐づきセッション一覧 (最大 20 件)
- 件数バッジ・▶ 開閉アニメーション・VS Code テーマカラー連動

#### TT3: `getProjectTree` postMessage プロトコル追加
- Webview → Extension: `{ type: 'getProjectTree' }`
- Extension → Webview: `{ type: 'project-tree-data', trees: [...] }`
- バックエンドで `discoverProjects` / `loadAllSessions` / `loadMemoryFiles` を並列取得
- 各プロジェクトに `{ agents, sessions, memories }` をまとめて返送

#### TT4: ノードアクション
- プロジェクトノード「詳細」ボタン → カードモードへ切替後に詳細ペインを開く
- プロジェクトノード「VS Code」ボタン → フォルダを VS Code で開く
- エージェントリーフクリック → エージェントセッション起動
- メモリリーフクリック → ファイルをサイドエディタでプレビュー (`open-memory-file`)
- セッションリーフクリック → セッションプレビューを開く

---

### v0.5.0 自動紐づけ修正 — claude --agent 起動時の sessionId 自動リンク

`claude --agent <name> -p` で子エージェントを起動した際、新規 sessionId が作成されるにもかかわらず  
`session-manager.json` の `agentSessions[<name>].sessionId` が空のままになるバグを修正。

#### TA1+TA2: dataStore.ts — `setAgentSession` 追加

- `setAgentSession(name, sessionId, mode?)` を新規 export
  - `agentSessions[name].sessionId` が空または `"unlinked"` の場合のみ更新（ユーザー操作を尊重）
  - writeQueue で直列化して並列書き込み競合を回避

#### TA2: agentWatcher.ts — リアルタイム自動紐づけ

- `processedAutoLinkSids: Set<string>` フィールドを追加（二重処理防止）
- `readFirstLine(filePath)`: JSONL 先頭 1 KB のみ読み取るユーティリティ
- `tryAutoLinkSession(sessionId, cwd)`: 新規ライブセッション検知時に JSONL 先頭行を解析し、  
  `agent-setting` エントリかつ agents/*.md が存在する場合のみ自動紐づけ
- `update()` 内: `newSessionCwdMap` 確定後に未処理セッションへ `tryAutoLinkSession` を並列実行

#### TA3: agentWatcher.ts + extension.ts — 起動時一括スキャン

- `scanProjectsForAutoLink()`: `~/.claude/projects/**/*.jsonl` を全走査
  - 未紐づけエージェントのみ対象（高速化）
  - 各エージェントの最新 JSONL（mtime 降順）を採用
  - agents/*.md 存在確認 → `setAgentSession` 呼び出し
- `extension.ts`: `agentWatcher.start()` 直後に `scanProjectsForAutoLink()` を非同期呼び出し

---

### v0.5.0 ハイブリッドタブパッチ — タブバー WebView + ネイティブ TreeView

タブバー (小さな WebView 40px) と OS ネイティブ TreeView を組み合わせたハイブリッド構成に変更。
タブ切り替えで各 TreeView の表示/非表示を制御する。

#### TH1: tabBarPanel.ts — 新規タブバー WebView
- `claudeTabBar` WebView View Provider を新規作成
- タブ (sessions / agents / memory / projects) をクリックすると `claudeManager.activeTab` コンテキストキーを更新
- VS Code テーマカラー連動 CSS、アクセシビリティ対応 (`aria-pressed`, `role="tablist"`)
- `claudeManager.ui.lastActiveTab` 設定に最後に選択したタブを永続化

#### TH2: package.json — views when 句改訂
- `claudeTabBar` を `claude-manager` viewContainer 先頭に追加
- `claudeMain` (projects WebView) は `claudeManager.activeTab == 'projects'` 時のみ表示
- `claudeSessions` / `claudeBookmarks` / `claudeTags` は `sessions` タブ時のみ表示
- `claudeAgents` は `agents` タブ時のみ表示
- `claudeMemory` は `memory` タブ時のみ表示
- `useNewMainPanel == false` 時は旧来の5ビュー全表示フォールバックを維持

#### TH3: package.json — defaultTab に "memory" を追加
- `claudeManager.ui.defaultTab` の選択肢に `memory` を追加
- enum: `["sessions", "agents", "memory", "projects"]`

#### TH4: extension.ts — TabBarPanel 登録 + 起動時 setContext
- `TabBarPanel` を import し `claudeTabBar` WebViewViewProvider として登録
- 起動時に `getConfig('ui.defaultTab')` を読んで `setContext('claudeManager.activeTab', defaultTab)` を実行
- defaultTab バリデーション (sessions/agents/memory/projects 以外は sessions にフォールバック)

---

### v0.5.0 Sprint 3 — 自律組織 + 引っ越し + 機能追加UI + 仕上げ

#### T3.1: snippetLibrary.ts — スニペットライブラリサービス

- `loadSnippets()`: `data/snippets/core.json` からスニペット一覧をロード（TTLキャッシュ付き）
- `getByCategory()`: カテゴリ別フィルタ
- `search()`: タイトル/説明/タグの全文検索
- `getById()`: ID指定取得

#### T3.2: data/snippets/core.json — 標準スニペット 10件

- **core-001** TDD ワークフロー (workflow) — RED→GREEN→IMPROVE 手順
- **core-002** セキュリティレビュー手順 (workflow) — コミット前チェックリスト
- **core-003** コードレビュー標準 (workflow) — 品質チェック + 重大度基準
- **core-004** 破壊的操作禁止 (constraint) — rm -rf / force push 等の承認必須化
- **core-005** 他フォルダ編集禁止 (constraint) — workDir スコープ外への書き込み禁止
- **core-006** 報告フォーマット (communication) — タスク完了報告の標準テンプレート
- **core-007** エラー報告手順 (communication) — エラー発生時の即時停止・報告フロー
- **core-008** Read/Edit/Bash ツール注記 (tool-note) — ファイル操作ツールの使い方と注意
- **core-009** Web検索ツール注記 (tool-note) — プロンプトインジェクション対策付き
- **core-010** 完了条件チェックリスト (workflow) — 完了前確認の汎用チェックリスト

#### T3.11: helpFeedbackProvider.ts — Discussions リンク追加

- `ディスカッション` エントリを追加 (`comment-discussion` アイコン)
- URL: `https://github.com/ratorin/claude-session-manager/discussions`

#### T3.21: Help & Feedback 実コンテンツ整備

- GitHub リポジトリ URL を実値で設定済みであることを確認
  - ドキュメント: `https://github.com/ratorin/claude-session-manager#readme`
  - 問題を報告: `https://github.com/ratorin/claude-session-manager/issues/new`
  - ディスカッション: `https://github.com/ratorin/claude-session-manager/discussions`
  - 変更履歴: `https://github.com/ratorin/claude-session-manager/blob/master/CHANGELOG.md`

#### T3.23: CHANGELOG.md Sprint 3 セクション追加

#### T3.24: README.md v0.5.0 新機能追記

---

### v0.5.0 Sprint 2 — プロジェクトタブ + エージェント強化 + 組織図

#### T2.1〜T2.9: プロジェクトタブ完全実装

- **T2.1/T2.2**: プロジェクトカードグリッド（name / パス短縮 / ソース / isCurrent バッジ）、クリックで詳細ペイン展開
- **T2.3**: 詳細ペイン概要セクション（パス / ソース / 登録日）
- **T2.4**: エージェント割当/解除 UI — `~/.claude/csm-project-agents.json` に永続化
- **T2.5**: メモリ管理統合 — タイプ別バッジ付き一覧（project / user / feedback / reference）
- **T2.6**: `progressCalculator.ts` — TODO/HISTORY/確認待ちをエージェントディレクトリから横断スキャン（5秒TTLキャッシュ）
- **T2.7**: 進捗ダッシュボード — TODO残/完了プログレスバー + 直近HISTORY 5件
- **T2.8**: クイックアクション — "VS Codeで開く" / "ターミナルで開く"
- **T2.9**: + 新規プロジェクト追加（フォルダ選択ダイアログ → `registerProject()`）

#### T2.10+T2.11: bookmarkService.ts — エージェントブックマーク + 最終使用日

- `addBookmark()` / `removeBookmark()` / `toggleBookmark()` / `getBookmarks()`
- `recordLastUsed()` / `getLastUsed()` / `getRecentlyUsed(n)` / `relativeTime(ms)`
- 永続化先: `~/.claude/csm-agent-meta.json`

#### T2.12〜T2.15: エージェントタブ強化

- **T2.12**: ★ ブックマークセクション — 行ごとの ★ ボタンでトグル
- **T2.13**: 最終使用日順 Top 5 — `relativeTime()` で相対表記
- **T2.14**: 詳細フィルタ — モデル / スコープ / 親エージェント チップ式AND条件
- **T2.15**: グローバル / プロジェクト分離 — 🌐バッジ / proj バッジ

#### T2.16: showOtherProjects 設定 + 永続化

- `claudeManager.agents.showOtherProjects` (default: true) 設定キー追加
- トグルコマンドが設定を `ConfigurationTarget.Global` に永続保存
- `claudeManager.agents.defaultExpand` 設定キー追加（bookmarks / recent / global / project）

#### T2.17: Cytoscape.js + ELK 導入

- `cytoscape.min.js`, `cytoscape-elk.js`, `elk.bundled.js` を `resources/` に配置
- webview CSP 準拠で `webview.asWebviewUri` 経由で提供

#### T2.18〜T2.20: 組織図 Cytoscape 化

- **T2.18**: `orgChartPanel.ts` を Mermaid から Cytoscape.js + ELK へ全面刷新
- **T2.19**: モード切替 — ツリー (ELK layered) / 関係 (cose force-directed) / グループ (ELK box)
- **T2.20**: フィルタ (モデル/親) + PNG/SVG エクスポート

#### T2.21: プロジェクト詳細にミニ組織図埋め込み

- `buildMiniOrgChartData()` で割当エージェントのみ抽出
- 詳細ペインにコンパクトな Cytoscape ミニ組織図を表示

#### T2.22〜T2.24: 使用率バー Sonnet/Opus 5d 列追加

- **T2.22**: `usageMonitor.ts` — 複数候補ヘッダから Sonnet/Opus 5d 使用率を解析
- **T2.23**: StatusBar 新フォーマット: `5% 4.5h / S 3% 5d20h / O 20% 5d10h`
- **T2.24**: `claudeManager.usage.show5dColumns` 設定追加 (default: true)

---

### v0.5.0 Sprint 1 — 基盤 + 3タブ骨格

#### T1.1: pathUtils.ts — クロスプラットフォームパスユーティリティ

- `expand()`: `~`, `${HOME}`, `${PROJECT_DIR}` プレースホルダー展開
- `contract()`: 絶対パス → `~/...` 短縮
- `normalize()`: スラッシュ統一・末尾スラッシュ除去・Windows大文字統一
- `isContainedIn()`: セパレータ考慮の親子パス判定

#### T1.2: data/i18n/ja/agents.json — エージェント辞書移行

- `data/global-agents-i18n.json` → `data/i18n/ja/agents.json` に移行
- `agentFileManager.ts`: 新パス優先ロード・旧パスフォールバック（後方互換）

#### T1.3–T1.5: data/i18n/ja/{skills,tools,ui}.json — 日本語辞書

- スキル30件・ツール20件・UIテキスト辞書を新設

#### T1.6: i18nService.ts — 辞書ロード + キャッシュ + 翻訳APIスタブ

- `getI18n()`: 辞書キャッシュ付き一括ロード
- `t(key)`: ドット区切りキーでUIテキスト取得
- `agentDisplayName()` / `skillDisplayName()` / `toolDisplayName()` ヘルパー
- `setLocale()` / `translateText()` 拡張スタブ

#### T1.7+T1.8: projectService.ts — プロジェクト検出・登録

- 3ソース検出: workspaceFolders / `~/.claude/projects/` 逆変換 / csm-projects.json
- `registerProject()` / `removeProject()` / `discoverProjects()` API
- `~/.claude/csm-projects.json` スキーマ定義

#### T1.9: mainTabPanel.ts — 3タブ WebviewView 骨格

- `claudeMain` WebviewViewProvider 実装
- セッション / エージェント / プロジェクト タブ切り替え
- プロジェクトタブ: 一覧表示・追加・削除・open

#### T1.10: extension.ts — claudeMain 登録

- `vscode.window.registerWebviewViewProvider('claudeMain', ...)` を追加
- `retainContextWhenHidden: true` でタブ切り替え時の状態維持

#### T1.11+T1.12: セッション/エージェントタブ移行（ポインタ実装）

- 既存 TreeView を維持しつつ、mainTabPanel から各ビューへの導線を設置

#### T1.13: helpFeedbackProvider.ts — Help & Feedback ビュー

- `claudeHelp` TreeView: ドキュメント・問題報告・変更履歴・バージョン情報

#### T1.14: migrationService — v0.5.0 マイグレーション

- `runV05Migration()`: csm-projects.json 初期化 + i18nパス確認

#### T1.15: package.json — viewsContainers/views 更新

- `claudeMain` (webview type) + `claudeHelp` (panel) を追加
- 既存 TreeView は後方互換で継続

#### T1.16: 設定キー追加

- `claudeManager.locale`: UI表示言語（ja / en）
- `claudeManager.ui.defaultTab`: 起動時デフォルトタブ（sessions / agents / projects）

---

## v0.4.7 (2026-04-25)

### CSM × Claude Code 統合強化（Phase 1 + Phase 2）

#### Phase 1-1: PreCompact Summary hook — コンパクション前文脈保持

- **新規テンプレート** `csm-precompact-summary.js` をデプロイし、PreCompact hook として全セッションに登録
- コンパクション直前に JSONL トランスクリプト末尾を走査し、CSM_SUMMARY マーカー付きサマリーを生成
- 保存先: `~/.claude/projects/<encoded_cwd>/csm-compact-summary.md`（SessionStart 時に文脈として読み込み可能）
- bash/python 不要の Node.js 実装（Windows 素環境対応）

#### Phase 1-2: csm-check-ask-agent.js — bash+python → Node.js 移行

- **旧** `check-csm-ask-agent.sh`（bash + python3 依存）を廃止
- **新** `csm-check-ask-agent.js`（Node.js）を自動デプロイ
- `registerCsmAskAgentHook`: 旧 bash エントリを自動検出して node エントリに差し替え
- `installCsmAskAgent` コマンド: `.sh` を `.trash/` に退避してから `.js` をデプロイ

#### Phase 2-1: 名前ベース `--resume <name>` サポート（Claude Code v2.1.101+）

- `AgentConfig` に `useNameResume?: boolean` フィールドを追加
- `cliBuilder.buildCommand`: `sessionId` 未設定かつ `useNameResume: true` の場合に `--resume <name>` を付与
- `agentCommands.openAgentSession`: `buildResumeArgs()` ヘルパーを導入。sessionId → 名前ベース → 新規の優先順でフォールバック
- `csm-ask-agent.command.md` Step 3 を3ケース方式（sessionId指定 / 名前ベース / 新規確認）に更新

#### Phase 2-2: `/recap` 結果自動キャプチャ → HISTORY.md 追記

- **新規テンプレート** `csm-recap-capture.js` をデプロイし、Stop hook として登録
- セッション終了時に JSONL を走査し `/recap` 呼び出しと直後のアシスタント応答を検出
- `historyEnabled: true` かつ HISTORY.md が存在するエージェントセッションのみ追記
- 重複追記防止: コンテンツ先頭50文字でフィンガープリントチェック
- `/recap <引数>` の引数があればサブタイトルとして付記
- 出力先は `csm-session-stop.js` と同じ HISTORY.md（書き込み条件・スコープ解決も同一ロジック）
- `csm-compact-summary.md` とは対象が異なる（重複なし）

---

## v0.4.6 (2026-04-25)

### 緊急パッチ（C-1 〜 C-4 + H-1, H-4）

QAレビューで指摘された Critical / High 計6件を修正。

- **C-1 修正** — `writeOrgInfoToMemory` に cwd 照合を追加。`encodeCwdToProjectDir()` で現在の workspace cwd をエンコードし、`projectsDir` 内のフォルダと照合してから書き込む。**別プロジェクトの MEMORY.md 汚染を防止**
- **C-2 修正** — `csm-precompact.sh` → `csm-precompact.js` に移行。bash / python 不要の Node.js 実装を新規作成。`ensurePreCompactHook` が旧 `.sh` を `.trash/` に退避し `.js` をデプロイ。既存の bash コマンドエントリを node コマンドに自動アップグレード。**Windows 素環境での silent fail を解消**
- **C-3 修正** — `dataStore` の並行書き込み排他を追加。モジュールレベルの writeQueue（Promise チェーン）で `saveData` / `saveLocalData` を全て直列化。**load→mutate→save 間の競合によるデータ消失を防止**
- **C-4 修正** — `getJsonlPath` のエンコードを Claude Code 実装と対称化。`toLowerCase()` でドライブレター小文字化、`/[\s/]/g` で空白も `-` に変換（例: `C:\My Project` → `c--my-project`）。**大文字小文字混在パス・スペース含むパスでのセッション解決失敗を修正**
- **H-1 修正** — dead menu エントリ削除。`package.json` から `editRuleFile/WithRule` の menu 定義を削除（`agentItem` に `WithRule` suffix を付ける実装は存在しないため永久に非表示だった）
- **H-4 修正** — `extensionOutputChannelEarly` のリーク修正。`extension.ts` で `createOutputChannel` 直後に `context.subscriptions.push`。**Extension Host 共有プロセスで拡張無効化後もチャンネルが残るリークを解消**

---

## v0.4.5 (2026-04-20)

### `/csm-ask-agent` スキル指示の刷新（HIGH バグ修正）

- **意図しない新規セッション作成の防止** — 旧指示は「出力が空なら `--resume` を外して再試行」という無条件フォールバックを持っており、workDir のcd抜けによる `No conversation found` エラーで**毎回新規セッションが作られる**問題があった
- **エラーパターンで分岐** — `No conversation found` / 0バイト空出力 / 正常出力 を判定し、workDir 再cd でリトライ。それでも失敗ならユーザーに承認確認
- **`--resume` を勝手に外す運用を明確禁止** — CSMの紐づけと実セッションが分離する原因のため
- 同期先: `~/.claude/commands/` / `<workspace>/.claude/commands/` / `templates/csm-ask-agent.command.md`

詳細: `docs/feedback/2026-04-20-csm-ask-agent-skill-outdated.md`

---

## v0.4.4 (2026-04-18)

### Claude Code v2.1.113 対応

- **ネイティブバイナリ対応** — `cli.js` から `claude.exe` への変更に追従。`resolveClaudeExec` が `bin/claude.exe` / `claude.exe` / `cmdDir/claude.exe` の3候補を順に探索（npm/yarn/pnpm レイアウトに対応、cli.jsフォールバック維持）
- **サブエージェント10分タイムアウト反映** — `taskErrorThreshold` 設定追加。stalled のまま既定30分経過で `error` 扱いに昇格（対話セッションの誤検知回避のため既定値は30分）

### UX改善

- **「Claudeで開く（IDE）」の整合性チェック** — セッション作成時の cwd と現在のVS Codeワークスペースを正規化比較（大文字小文字・区切り文字を吸収）。不一致なら「そのフォルダを開く / ワークスペースに追加 / このまま開く」を提案
- **新規エージェント登録後に紐づけ画面へ誘導** — 自動セッション作成を廃止し、既存セッション紐づけ or 新規作成を選べるピッカーを開く
- **TODO/HISTORY ON時の空メッセージ修正** — トグルONかつファイル未生成時に「OFFの状態です」と誤表示していたのを「ON状態です。まだ空です」に修正

### Stop hook 追加

- **セッション終了時のHISTORY.md追記** — PreCompactに加えてStop hookでも自動記録。テンプレート `csm-session-stop.js` を拡張起動時に自動デプロイ、settings.jsonに登録
- **動作条件**: エージェントの `historyEnabled: true` かつ HISTORY.md 存在時のみ（無関係セッションには無害）

### エラー自動収集（A案）

- **ローカルログ蓄積** — `~/.claude/csm-errors.log`（512KBローテート）に `unhandledRejection` / `uncaughtException` を自動記録
- **コマンド追加**
  - `Claude Session Manager: 不具合を報告（GitHub Issue作成）` — ログ埋め込み済みのIssue URLをブラウザで開く
  - `Claude Session Manager: エラーログを開く`
- 自動送信なし。ユーザーがIssue内容を確認してから送信

---

## v0.4.3 (2026-04-18)

### v0.4.2 レビュー指摘修正（hotfix）

- **H-1 修正** — `csm-ask-agent.py` の `workDir` 逆引きロジックを置換。プロジェクトディレクトリ名のデコード（`-`→`/`）は仕様変更に壊れやすいため、セッションJSONL先頭の `cwd` フィールドを読み取る方式に変更（スペース含むパスも正しく復元）
- **H-2 修正** — `createRenewSession` に `resolved` ガードを追加。タイムアウト後のプロセス正常終了による二重resolveレースを解消（`createSessionForAgent` と同じパターン）
- **CRITICAL 修正** — 空 sessionId または実ファイルが存在しない sessionId を起動時に自動クリーンアップするマイグレーションを追加。タイムアウトバグで保存された壊れた紐づけを v0.4.3 初回起動時に修復
- **UX改善: 新規エージェント登録後に紐づけ画面へ誘導** — 自動セッション作成をやめ、既存セッション紐づけ or 新規作成を選べるピッカーを開く

---

## v0.4.2 (2026-04-17)

### エージェント管理の全面刷新

- **エージェント定義ファイルを CLI 標準に統一** — `~/.claude/agents/<name>.md` に役割本文（body）を直接書き込み。`claude --agent <name>` で起動時に自動適用
- **プロジェクトスコープのエージェント対応** — ワークスペースの `.claude/agents/` に保存・スキャン。複数プロジェクトのエージェントを同時管理
- **追加ディレクトリスキャン** — 設定 `claudeManager.additionalAgentDirs` で任意フォルダのエージェントを読み込み
- **スコープ切り替え時のファイル自動移動** — グローバル↔プロジェクト切り替え時に `.md` と `TODO/HISTORY` フォルダを自動移動
- **ドラッグ&ドロップで親子関係変更** — エージェントツリー上でドラッグして上下関係を編集
- **他プロジェクトのエージェントを灰色表示＋フィルター** — 現在のワークスペース外のエージェントを区別して表示

### ガバナンス・セキュリティ

- **ガバナンス記録統合** — Bash/Edit/Write 操作時に秘密鍵・危険コマンドを検知して `~/.claude/governance-events.jsonl` に記録。セッションプレビューに Actions Log 表示
- **SessionStart hook でエージェント役割を自動注入** — CSM で紐づけたエージェントの役割定義をセッション開始時に自動注入。Claude が起動直後から役割を認識
  - 未有効化ユーザー向けにエージェントツリーにバナー表示
  - 旧 bash 版から Node.js 版へ自動マイグレーション

### コード品質・パフォーマンス

- **extension.ts を 9 ファイルに分割** — 2776 行 → 347 行（87% 削減）。services/・commands/ に機能別分離
- **CLI 呼び出しを `--agent` 方式に統一** — `--model`/`--effort` の個別指定を廃止。フロントマターから自動適用
- **セッション一覧をファイルサイズで表示** — 概算会話数から実サイズ（KB/MB）に変更

### UI 改善

- **メモリ管理フィルター改善** — 初期状態で自プロジェクトのみ表示。フィルター OFF 時に他プロジェクトは折りたたみ
- **エージェント役割 ON/OFF 切り替えバグ修正** — トグル後にセッション名が ID に変わる問題を修正
- **セッション表示に名前と ID を併記**
- **紐づけ画面に「新しいセッションを作成」を追加** — 既存セッション選択の末尾から新規作成可能

### アップデート対応

- **v0.3.x → v0.4.x 自動マイグレーション** — 初回起動時にバックスラッシュ増殖バグを自動修正。バージョン追跡で重複実行を防止
- **Opus 4.7 / xhigh effort 対応** — モデル不一致検知をバージョン番号非依存に改善。`xhigh` effort レベルを追加
- **PreCompact hook** — コンパクション前にセッション要約を HISTORY.md に自動記録

### セッション作成・紐づけ修正

- **Windows `.cmd` EINVAL エラー回避** — Node.js CVE-2024-27980 対応。`claude.cmd` ラッパーを経由せず `cli.js` を `node` で直接起動（`createSessionForAgent` / `createRenewSession` / 要約生成の3箇所）
- **セッション作成の早期 resolve** — `session_id` 取得時点で即完了扱い。プロセス完了待ちのタイムアウト（60秒）で空 sessionId が保存される問題を解消
- **他プロジェクトのセッションタイトル解決** — 他ワークスペースに紐づいたグローバルエージェントで sessionId 断片ではなくタイトルが表示されるよう、`~/.claude/projects/*/` を横断検索（軽量版、60秒キャッシュ）

### `/csm-ask-agent` cwd 対応

- **エージェントの `workDir` で cwd を切り替え** — `claude --resume` は作成時と同じ cwd が必要なため、`cd {workDir}` を必須化。`csm-ask-agent.py` の出力形式を `{sid}|{perm}|{workDir}` に拡張し、`workDir` 未設定時は `~/.claude/projects/` から逆引き

---

## v0.4.2 (2026-04-12)

### エージェントプレビューパネル刷新

- **Webview ベースのプレビュー** — エージェントクリック時にヘッダボタン付きの詳細パネルを表示
  - 配下エージェントツリー・連携先エージェント一覧を表示
  - TODO.md / HISTORY.md をプレビュー内に表示（トグルで ON/OFF 切替可能）
- **TODO チェックボックス切り替え → ファイル反映** — プレビュー内のチェックボックス操作が TODO.md に即時反映
- **HISTORY 下追記方式・最下部スクロール** — HISTORY.md は下追記方式で表示し、最下部に自動スクロール

### 確認待ち横断ビュー

- **チェックリストボタン** — エージェント管理ツリーのタイトルバーにボタンを追加
- **Webview で確認待ち一覧表示** — 全エージェントの未完了 TODO を横断表示
- **チェック ON/OFF → ファイル反映** — 横断ビュー内のチェック操作も各 TODO.md に即時反映

### `/csm-ask-agent` スキル（リネーム）

- **`/ask-agent` → `/csm-ask-agent` にリネーム** — 移行バナー付きで旧名からの自動案内を表示
- **`csm-ask-agent.py` ヘルパー拡張** — `--list` で全エージェント一覧、`--pending` で確認待ちタスク一覧を表示
- **`--resume` 時に `--append-system-prompt-file` 追加** — セッション再開時にルールファイルを自動注入

### Stop フック連携

- **CSM_SUMMARY → HISTORY/TODO 自動追記** — セッション終了時の `<!-- CSM_SUMMARY -->` マーカー内容を HISTORY.md / TODO.md に自動転記

### エージェントフォーム改善

- **displayRole / displayDescription 削除** — `role` / `description` に統一（CLI 標準に合わせて簡素化）
- **Extended Thinking トグル完全削除** — フォームから撤去（CLI 側制御に完全委譲）
- **紐づけ変更時の確認ダイアログ** — セッション紐づけ変更時に既存紐づけの確認を表示

### 親子同期・ルール自動生成

- **CHILDREN ブロックに連携先エージェント自動生成** — 親ルールファイルの配下セクションに連携先エージェント情報を自動追記

### ステータスバー・設定

- **ステータスバー和名表示** — エージェントの日本語名（和名）をステータスバーに表示
- **VS Code 設定追加** — `defaultHistoryEnabled` / `defaultTodoEnabled` を追加（デフォルト OFF）
- **VS Code 設定削除** — `detectionMode` / `defaultRuleFolder` を削除（不要化）

---

## v0.4.1 (2026-04-11)

### セキュリティ修正

- **[CRITICAL] C-1: パストラバーサル防止** — `agentFileManager.ts` にエージェント名バリデーション追加
  - `^[\p{L}\p{N}_\-]+$` パターンで不正な名前（`../../` 等）を拒否
  - `path.resolve()` 後のディレクトリ境界チェックも追加
- **[CRITICAL] C-2: コマンドインジェクション防止** — `extension.ts` の `spawn()` を `shell: false` に変更
  - Windows環境用に `claude.cmd` を自動選択
- **[HIGH] H-4: YAMLインジェクション防止** — `buildFrontmatter()` の全文字列フィールドをダブルクォートで囲む
  - `sanitizeForYaml()` + `quoteYamlValue()` で改行・制御文字・クォート文字をエスケープ
- **[HIGH] H-5: CSPヘッダー追加** — `agentPreviewPanel.ts` / `orgChartPanel.ts` にnonce付きCSPメタタグを追加
  - インラインイベントハンドラ(`onclick`)を `addEventListener` パターンに置換
- **[HIGH] H-6: 任意ファイル読取防止** — `webviewPanel.ts` の `openLink` ハンドラにパス検証を追加
  - ワークスペース・tmp・`~/.claude/` 配下のみファイルを開くことを許可
- **[HIGH] H-1: フロントマターパーサー統合** — `agentFileManager.ts` の重複パーサーを `frontmatterUtils.ts` に統合
  - `parseFrontmatterExtended()` を共通ユーティリティとしてエクスポート

### データマイグレーション

- **agents[] → agentSessions 自動変換** — `activate()` 時に一度だけ実行
  - 旧形式 `agents[]` を `agentSessions` キーに変換し、`agents[]` を除去
  - 既存の `agentSessions` エントリは保持（上書きしない）

### エージェントフォーム改善

- **Extended Thinking トグル削除** — フォームからExtended Thinking ON/OFFスイッチを撤去（CLI側の制御に委譲）
- **役割フィールド複数行対応** — input → textarea (rows=2) に変更し、長い役割記述を入力しやすく
- **日本語表示名フィールド追加** — `displayRole`（日本語役割）・`displayDescription`（日本語説明）を個別入力可能に
  - CLI の `description`（英語）とは別にUI表示用テキストを管理

### `/ask-agent` スキル

- **セッション継続対応** — セッションIDがあれば `--resume` で既存セッションに継続、なければ `--agent` で新規起動
- **`ask-agent.py`** — セッションID・モデル・effort・permissionMode を一括取得するヘルパースクリプト
- 完了報告の自動返却でタスク管理を簡素化

---

## v0.4.0 (2026-04-10)

### アーキテクチャ刷新（リビルド Phase 3〜6）

#### Phase 3: エージェント管理の更新
- **`agentFileManager.ts` 新規作成** — `~/.claude/agents/*.md` をSingle Source of Truthとして読み書き
  - YAML フロントマター拡張パーサー（JSON配列 `tools: ["Read", "Edit"]` 対応）
  - TTLキャッシュ（2秒間有効）でパフォーマンス最適化
  - グローバル（`~/.claude/agents/`）＋プロジェクト（`.claude/agents/`）の両スコープ対応
- **`dataStore.ts` ブリッジ化** — `getAgents()` が agentFileManager 経由に切り替え
  - session-manager.json には `agentSessions`（セッション紐づけ情報）のみ保存
  - 旧形式 `agents[]` からの自動マイグレーション（読み取り専用で後方互換）

#### Phase 4: 検知の簡素化
- **比較エンジン完全削除** — 7方式並列テスト用ウォッチャーを廃止
  - `detectionComparePanel.ts` を削除
  - agentWatcher.ts を1289行→568行に大幅削減
  - 検知モードを `fswatch` 固定に簡素化（polling/signal モード廃止）
  - package.json から `openDetectionCompare` コマンドと detectionMode 設定の選択肢を削除

#### Phase 5: ファイル分割リファクタ
- **ディレクトリ構造を刷新** — 全ソースファイルを機能別サブディレクトリに再配置
  - `models/` — types.ts, dataStore.ts
  - `providers/` — sessionTreeProvider, agentTreeProvider, tagTreeProvider, bookmarkTreeProvider, memoryTreeProvider
  - `watchers/` — agentWatcher, taskTracker
  - `panels/` — agentFormPanel, agentPreviewPanel, orgChartPanel, webviewPanel
  - `utils/` — sessionLoader, cliBuilder, frontmatterUtils, memoryManager, usageMonitor, subagentDetector
  - `agents/` — agentFileManager, agentManager, parentChildSync
  - `commands/` — （今後のコマンド抽出用）
- 全 import パスを新構造に対応

#### Phase 6: session-manager.json 縮小
- `setAgents()` を削除（デッドコード除去）
- `agents[]` を読み取り専用（後方互換マイグレーション用）に変更
- エージェント定義は `~/.claude/agents/*.md` が唯一の情報源に

#### 親子エージェント同期の刷新
- **`parentAgent` ベースの組織階層構築** — agents/*.md の frontmatter `parentAgent` フィールドから組織ツリーを動的生成
  - 旧方式（session-manager.json の agents[].parentAgent）から完全移行
  - 組織図・エージェントツリーの階層表示が agents/*.md のみから構築される
  - 子エージェント追加/削除時の親ルール自動更新も agents/*.md ベースに刷新

#### 検知方式の2方式化
- **fswatch + jsonlMtime に簡素化** — 旧7方式（polling/signal/subagentsFswatch/preToolUseHook等）を廃止
  - fswatch: sessions/ ディレクトリの変更検知（起動/停止）
  - jsonlMtime: JSONL mtime変化（活動中検知 + 子エージェント検知）

### 既知の制限
- `extension.ts` は2182行のまま（コマンド抽出は次バージョンで実施予定）

---

## v0.3.5 (2026-04-10)

### 新機能
- **検知方式比較ビュー: 7方式対応** — 既存5方式に加え、2つの新方式を追加
  - **⑥ subagentsFswatch** — `~/.claude/projects/*/subagents/` ディレクトリを定期スキャンし、サブエージェント（子タスク）の起動を検知。`.meta.json` から agentType + description を読み取りチップに表示。mtime が10秒以上更新されなければ終了と推定
  - **⑦ preToolUseHook** — Claude CLI の PreToolUse(Agent) フックが書き込んだイベントファイルを fs.watch で検知。VS Code バグ(#21736)により CLIモードでのみ動作

---

## v0.3.4 (2026-04-08)

### 新機能
- **検知方式比較ビュー** — polling / fswatch / signal の3方式を並列テストし、レイテンシと累計検知件数をリアルタイム表示
  - コマンドパレット → 「検知方式比較ビューを開く」で起動
  - エージェント検知時に各方式の応答時間（ms）を計測し、最速方式に「← 最速」バッジを表示
  - 各方式の累計検知件数を常時表示
  - レイテンシ比較バー（横棒グラフ）でビジュアル比較
  - CSP対応（nonce-based `default-src 'none'`）

### バグ修正
- タグ追加ボタンのクリックが反応しない問題を修正（CSP対応: `onclick` 属性を `addEventListener` に変更）

---

## v0.3.3 (2026-04-08)

### バグ修正
- タグ追加ボタンのクリックが反応しない問題を修正（CSP対応: `onclick` 属性を `addEventListener` に変更）

---

## v0.3.2 (2026-04-07)

### 親子ルール自動同期
- `parentChildSync.ts` 新設 — 子エージェント追加/削除/変更時に親ルールファイルの配下エージェントセクションを自動更新

### maxThinkingTokens 完全削除
- `maxThinkingTokens` フィールドを AgentConfig・フォーム・CLI Builder・frontmatter から完全削除
- 推論制御は effort に一本化

### エージェント作成時のセッション自動紐づけ
- `spawn` + `stream-json` でセッションを自動作成し、紐づけまでワンステップ完了
- Windows 環境の `spawn ENOENT` を `shell: true` で修正
- セッション初期化メッセージに役割情報を含める
- 自動作成セッションの cwd をワークスペースルートに統一

### バグ修正
- description テンプレートの「を担当する」重複を解消
- `SessionStart` フック重複登録防止（`ensureSubagentHooks` 改善）
- 稼働状態リセットバグ修正（`refreshAll` + `child.close` 時に再スキャン）
- stop シグナルで `liveSessionIds` から即除去
- ステータスバーとツリーの同期修正
- `package.json` 警告修正

### ドキュメント・公開
- agentWatcher 仕様書追加
- VS Code Marketplace + Open VSX に公開

---

## v0.3.1 (2026-04-05)

### YAML Frontmatter 移行
- ルールファイルの自動生成マーカーを `<!-- CSM:AUTO -->` から YAML Frontmatter 形式に移行
- `frontmatterUtils.ts` 新設 — パース・生成・移行ユーティリティ
- AgentConfig フィールドを frontmatter にマッピング（name, model, effort, thinking 等）
- `description` フィールドにリテラルブロックスカラー（`|`）で自動生成テキストを格納
- 旧形式（CSM:AUTO マーカー）は更新時に自動移行
- カスタム記述セクションは一切変更しない

### SubagentStart/Stop フック
- `subagent-signal.js` 新規 — SubagentStart/Stop イベントでシグナルファイル出力
- シグナルディレクトリ: `~/.claude/.csm-signals/`
- `ensureSubagentHooks()` — 取締役セットアップ時に settings.json へフック自動登録
- 5分超の古いシグナルファイルを自動クリーンアップ
- stdin パイプ切断対応 + Promise拒否防止

### マイグレーションバナー
- エージェント管理ツリービュー上部に旧形式ルールファイル検出バナーを表示
- クリックでYAMLフロントマター変換 + フォルダ構造移行を一括実行
- 移行完了後バナーは自動非表示

### SignalWatcher
- agentWatcher.ts に SignalWatcher 追加 — `~/.claude/.csm-signals/` を fs.watch で監視
- シグナルファイル（JSON）を読み取り、start/stop でライブ状態更新、処理後に即削除
- 200ms デバウンス、enableAgentMonitor OFF 時は停止

### 旧Stopエントリ除去
- ensureSubagentHooks() で旧 Stop イベントの csm-signal.js エントリを検出・除去

### renewAgentSession 修正
- 全体をtry/catchで囲み致命的エラー時にエラーメッセージ + OutputChannel表示
- 遺言生成失敗時はデフォルトメッセージで続行
- OutputChannelを起動時に即作成（遅延作成を廃止）

## v0.3.0 (2026-04-04)

### 監視アーキテクチャ刷新
- **AgentWatcher** 統合監視エンジン新設 — PIDベースのライブセッション検出 + JSONL解析によるサブエージェント検出を1モジュールに統合（EventEmitter方式）
- `agentMonitor.ts` を廃止し、`agentWatcher.ts` + `subagentDetector.ts` に分離
- 旧ポーリング方式を `fs.watch` + デバウンスに置換

### タスク管理・状態検知・通知
- **TaskTracker** 新設 — AgentWatcher イベントでタスク状態を自動評価（running / stalled / completed / error）
- タスクログをエージェントの子ノードとしてツリー表示（ステータス別アイコン・経過時間）
- VS Code通知でタスク完了・エラー・応答停止をリアルタイム通知
- 自動クリーンアップ（completed/error: 72h、running/stalled/pending: 168h）
- コマンド5件追加（タスク記録 / 完了 / 削除 / 出力ファイルを開く / 全クリア）
- 設定4件追加（通知ON/OFF / stalled閾値 / 自動削除時間 / 最大ログ数）

### Claude Code 利用制限モニター
- **UsageMonitor** 新設 — Anthropic APIから5時間/7日の利用率を取得しステータスバーに表示
- 80%超で警告色、95%超でエラー色、90%/100%到達で通知
- デフォルトOFF（有効化で軽量APIリクエストが定期発生、月額$0.01未満）

### ローカル/グローバル分離
- **session-manager.local.json** 導入 — プロジェクト固有エージェントをワークスペース内に保存
- `getAgents()` は同名ローカル優先でマージ、スコープ指定保存・移動に対応

### メモリ管理拡張
- グローバルメモリ（`~/.claude/memory/`）をツリーに表示
- 設定ファイルビューワー（`settings.json` / `settings.local.json`）をメモリツリーのトップに表示
- プロジェクトをVS Codeで開く機能追加
- メモリインジケーター改善（空き部分「─」、右端「|」表現）

### エージェントフォーム拡張
- **Effort** 4段階（Low / Medium / High / Max）、MaxはOpus専用でグレーアウト連動
- **Extended Thinking** トグルスイッチ（Haikuではグレーアウト）
- モデル選択に応じたUI連動（グレーアウト自動切替）

### CLI Builder
- `cliBuilder.ts` 新設 — AgentConfig からCLIコマンドを自動構築

### ルールファイル カスタムセクション保持
- `<!-- CSM:AUTO:START -->` / `<!-- CSM:AUTO:END -->` マーカー導入
- 自動生成部分のみ更新し、ユーザーのカスタム記述を保持

### UI改善
- **セッションフィルター** — プロジェクト内のみ / すべてを切替
- **設定を開く** — ビュータイトルバーの歯車アイコンからCSM設定画面を直接オープン
- エージェントソート改善（子を持つエージェントを上位にソート）

### パフォーマンス改善
- 全ソースファイルの同期I/Oを非同期化（`fs.promises` API）
- TTLキャッシュ導入、`fs.watch` + デバウンスでポーリング置換

### セキュリティ改善
- CSM:AUTOマーカーのプロンプトインジェクション対策（エージェント名からマーカー文字列を除去）
- WebviewにContent Security Policy（CSP）追加（nonce-basedで`default-src 'none'`）
- floating promise修正（未処理のPromise rejectを防止）

### 品質改善
- TreeView の Disposable 追跡（createTreeView の返り値を subscriptions に登録）
- 全TreeDataProviderにEventEmitter dispose実装
- dataStore.ts の全I/Oを非同期化（`fs.promises` API、TTLキャッシュ維持）

### 初期セットアップ
- Extension Host分離設定（`extensions.experimental.affinity`）を初回起動時に自動追加

### デフォルト変更
- セッションフィルターのデフォルトを「プロジェクト内のみ」→「すべて」に変更

### セッション引き継ぎ改善
- 遺言生成を2モード化: **簡易（即時）** = JSONL末尾から自動抽出、**詳細（AI要約）** = Claude CLIで要約生成
- 遺言をルールファイルの「歴代セッションの記録」セクションに自動蓄積（直近3世代保持）
- `AgentConfig.previousSessionIds` 追加 — 過去のセッションIDを直近5件保持
- 長さ上限300文字、生成後にInputBoxで編集可能
- 詳細モードのデフォルト推奨モデルをopusに変更
- JSONL読み取りを末尾読み取り（FileHandle API）に最適化（巨大ファイル対策）
- ルールファイル書き込みエラーをOutputChannelにログ出力

### フォルダ構造移行（Phase 1）
- `.agent-rules/` 配下をフラット構造からフォルダ構造に移行対応（`.agent-rules/<name>/<name>.md` + TODO.md + HISTORY.md）
- `resolveRuleFilePath()` がフラット/フォルダ両構造を自動判定（後方互換）
- 移行コマンド `claudeManager.migrateToFolderStructure` 追加（旧ファイルは `.trash/` へ移動）
- HISTORY.md 分離 — ルールファイルの「歴代セッションの記録」セクションを自動抽出

### TODO.md自動管理（Phase 2）
- Stop フックスクリプト `todo-flush.js` 新設 — TodoWrite の最終状態をエージェント別 TODO.md に自動マージ
- パスサニタイズ（パストラバーサル防止）+ ロックファイル排他制御
- 完了タスク10件超過分を HISTORY.md に自動転記

### タスクログUI削除
- 手動タスク記録コマンド5件削除（addTaskLog / completeTaskLog / deleteTaskLog / openTaskOutput / clearTaskLogs）
- 関連メニュー3件削除 — 自動検出（TaskTracker）は引き続き機能

### バグ修正
- ブックマークがプロジェクトフィルターの影響で非表示になる問題を修正
- sessionLoader の fd リーク修正、XSS対策、unsafe type cast 修正

---

## v0.2.8 (2026-04-03)
### ルールファイル管理改善（スコープ分離）
- AgentConfig に `scope: 'global' | 'project'` フィールド追加
- スコープに基づいてルールファイルの保存先フォルダを自動決定
- フォームをスコープ選択ラジオボタンに変更（手動パス入力廃止）
- 取締役ルールファイルに「エージェント操作」セクション追加
- MEMORY.md書き込みをメモリファイル＋ポインタ方式に改善

---

## v0.2.7 (2026-04-03)
### バグ修正: ステータスバー稼働表示が減らない
- JSONL mtime判定をPIDベース（`isLiveSession()`）に変更
- enableAgentMonitor OFF時にactiveAgentNamesもクリア

---

## v0.2.6 (2026-04-02)
### エージェント監視方式をJSONL解析に置換
- tasklist + PIDマッピングファイル方式を完全廃止
- JSONL mtime + sizeキャッシュ、末尾64KB読み取り方式
- 稼働中エージェントが一覧の上に自動ソート

---

## v0.2.5 (2026-04-02)
### ポーリング制御・テンプレート強化
- `enablePolling` 設定追加（デフォルト: false）
- ルールファイルテンプレートにMEMORY.md確認・報告先指示を追加
- 「セッションを新しくする」で自動遺言生成（直近やり取りからサマリー）
- エージェント起動時にruleFile未設定/不存在の場合は警告表示

---

## v0.2.4 (2026-04-02)
### 組織図の軽量化
- 子エージェントカードのライブ状態インジケーター削除
- CSS最小化、不要アニメーション削除、イベント委譲に変更

---

## v0.2.3 (2026-04-02)
### ステータスバー: PIDマッピングファイル方式に移行
- `/c/tmp/agent_*.txt` 方式廃止、`.agent-rules/tmp/.agent_pid_{PID}_{名前}` に変更
- PID生存チェックと自動クリーンアップ

---

## v0.2.2 (2026-04-02)
### バグ修正・改善
- ポーリング間隔が設定変更に追随しない問題を修正
- プレビューパネルのリスナー累積問題を修正
- ウェルカム画面がエージェント登録後も常時表示される問題を修正
- エージェント一覧の状態表示アイコン明確化（🟢/⚪/🟡）
- ステータスバーの動作中表示を背景色で強調

---

## v0.2.1 (2026-04-02)
### アイコンデザイン改善・ソート拡張
- 「Claude Codeで開く」アイコンをオレンジ角丸背景+白抜きスパークデザインに変更
- ソート基準を7種に拡張（「日付」を「作成日」と「更新日」に分割）
- ステータスバーでエージェント名を表示

---

## v0.2.0 (2026-04-02)
### エージェント管理
- サイドバー「エージェント管理」ビュー追加
- Webviewフォームで登録・編集（カード型ラジオ・フォルダ選択・ルールファイル自動生成）
- プレビュー/設定分離、セッション紐づけ、セッションを開く/新しくする
- 取締役をツリー最上位に表示、使い捨て/固定モード
### 組織図
- 取締役トップノード + 階層カード表示
- ✦カスタムアイコン（Claude Codeで開く）/ 🕐アイコン（履歴表示）
### ステータスバー
- 「🟢 N 👥 M」形式（動作中/全数）
### 会話管理
- ソート7種、グループ化4種、セッション削除（.trash/移動）
- パスコピー、プレビューヘッダにエージェントバッジ
### プレビュー
- Markdownレンダリング、リンクのクリック対応、AIの思考過程表示
### 設定画面・ウェルカム画面
- VS Code標準設定UIからCSM設定をカスタマイズ
- 初回起動時に取締役プリセットで即座に開始

---

## v0.1.9 (2026-04-01)
### ライブセッション検出の改善
- PID生存チェック + 5秒間隔フォールバックポーリング

## v0.1.8 (2026-04-01)
### エージェント管理・子エージェントツリー・プレビュー強化
- エージェント登録・役割タグ・ルールファイル編集・ステータスバー・組織図
- `subagents/` フォルダ内の子エージェントをツリー表示
- Markdownレンダリング・リンクのクリック対応・エージェントバッジ
- セッションIDコピー・VS Codeフォーク対応

## v0.1.4 (2026-03-30)
- メモリ管理のOneDrive対応

## v0.1.3 (2026-03-28)
- 両PC変更統合・MEMORY.md表示/編集対応

## v0.1.2 (2026-03-28)
- メモリ管理の各ファイルに行数表示を追加

## v0.1.1 (2026-03-28)
- displayNameに「セッション履歴管理」サブタイトルを追加
- VS Code Marketplace に初回公開

## v0.1.0 (2026-03-28)
初回リリース — 会話管理（日付別分類・ブックマーク・タグ・メモ・リネーム・検索）、ライブセッション検出、メモリ管理（タイプ別バッジ・プログレスバー・統合・抽出）
