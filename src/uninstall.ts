// uninstall.ts — package.json の "vscode:uninstall" から実行されるクリーンアップスクリプト。
//
// VS Code が拡張のアンインストール時に `node ./out/uninstall.js` を実行する。
// このスクリプトは VS Code API（vscode モジュール）を一切使えない素の Node 環境で動くため、
// vscode 非依存の csmHookCleanup のみを使う。
//
// 役割: ~/.claude/settings.json から CSM の hook 登録を全除去し、
//       ~/.claude/hooks/csm-*.js を .trash/ へ退避する。
// 失敗してもアンインストール自体は妨げない（例外は握りつぶす）。

'use strict';

import * as os from 'os';
import { cleanupAllCsm } from './utils/csmHookCleanup';

try {
	const result = cleanupAllCsm(os.homedir());
	process.stderr.write(
		`[CSM uninstall] hooks removed: ${result.settings.removed}, scripts trashed: ${result.scripts.moved}\n`
	);
} catch (err) {
	process.stderr.write(`[CSM uninstall] cleanup skipped: ${err instanceof Error ? err.message : String(err)}\n`);
}
