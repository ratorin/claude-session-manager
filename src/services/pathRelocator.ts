/**
 * pathRelocator.ts — v0.5.0 T3.16 / T3.17 / T3.19
 * クロスプラットフォーム引っ越しサービス (F9-c/d/f)
 *
 * 機能:
 *   - relinkProject(oldPath, newPath)  JSONL/設定の旧パス → 新パスへの再リンク
 *   - linkDir(src, dest, mode)         symlink / hardlink / copy フォールバック
 *   - checkIntegrity()                 起動時に projects.json の rootPath 存在確認
 *   - buildOldProjectKey / buildNewProjectKey  Claude Code プロジェクトキー変換
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { normalize, isContainedIn } from '../utils/pathUtils';

// -------------------------------------------------------------------
// 型定義
// -------------------------------------------------------------------

export type LinkMode = 'symlink' | 'hardlink' | 'copy';

export interface RelocateResult {
    success: boolean;
    oldPath: string;
    newPath: string;
    linkedSessions: number;
    linkedFiles: number;
    errors: string[];
    mode: LinkMode;
}

export interface IntegrityCheckResult {
    missing: string[];
    valid: string[];
}

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CSM_PROJECTS_FILE = path.join(CLAUDE_DIR, 'csm-projects.json');

// -------------------------------------------------------------------
// パスキー変換ユーティリティ
// -------------------------------------------------------------------

/**
 * 絶対パスを ~/.claude/projects/ 配下のディレクトリキーに変換する。
 * 例: /home/user/projects/foo → -home-user-projects-foo
 *     C:/xampp/Project/foo   → c--xampp-project-foo
 */
export function buildProjectKey(absPath: string): string {
    const norm = normalize(absPath);
    if (process.platform === 'win32') {
        // C:/foo/bar → c--foo-bar
        return norm.replace(/^([a-z]):\//, '$1--').replace(/\//g, '-');
    }
    // /home/user/foo → -home-user-foo
    return norm.replace(/\//g, '-');
}

/**
 * プロジェクトキーから元の絶対パスを復元する（逆変換）。
 * 注意: "-" が元のパスにも含まれる場合は曖昧になるため参考用途のみ。
 */
export function reverseProjectKey(key: string): string {
    if (process.platform === 'win32') {
        // c--foo-bar → C:/foo/bar
        const m = key.match(/^([a-z])--(.+)$/);
        if (m) {
            return `${m[1].toUpperCase()}:/${m[2].replace(/-/g, '/')}`;
        }
    }
    // -home-user-foo → /home/user/foo
    return '/' + key.replace(/^-/, '').replace(/-/g, '/');
}

// -------------------------------------------------------------------
// リンク作成（symlink > hardlink > copy フォールバック）
// -------------------------------------------------------------------

/**
 * ソースディレクトリを宛先にリンクまたはコピーする。
 * フォールバック順: symlink → hardlink（ディレクトリ不可のためcopyに）→ copy
 */
export async function linkDir(
    src: string,
    dest: string,
    preferredMode: LinkMode = 'symlink'
): Promise<{ mode: LinkMode; error?: string }> {
    // 宛先が既存の場合はスキップ
    if (fs.existsSync(dest)) {
        return { mode: preferredMode };
    }

    // 親ディレクトリ作成
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (preferredMode === 'symlink') {
        try {
            // Windows: シンボリックリンクは junction（ディレクトリ用）を使用
            const symlinkType = process.platform === 'win32' ? 'junction' : undefined;
            if (symlinkType) {
                fs.symlinkSync(src, dest, symlinkType);
            } else {
                fs.symlinkSync(src, dest);
            }
            return { mode: 'symlink' };
        } catch {
            // symlink 失敗 → copy にフォールバック
            return await linkDir(src, dest, 'copy');
        }
    }

    if (preferredMode === 'hardlink') {
        // ディレクトリのハードリンクは不可 → copy にフォールバック
        return await linkDir(src, dest, 'copy');
    }

    // copy モード
    try {
        await copyDir(src, dest);
        return { mode: 'copy' };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { mode: 'copy', error: msg };
    }
}

/** ディレクトリを再帰コピー */
async function copyDir(src: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

// -------------------------------------------------------------------
// プロジェクト引っ越しコア (T3.16)
// -------------------------------------------------------------------

/**
 * 旧パスから新パスへのプロジェクト引っ越しを実行する。
 * 対象:
 *   1. ~/.claude/projects/<oldKey>/ → ~/.claude/projects/<newKey>/ (symlink/copy)
 *   2. csm-projects.json 内のパス更新
 *   3. エージェント設定の workDir 更新（同プロジェクト配下のみ）
 */
export async function relinkProject(
    oldAbsPath: string,
    newAbsPath: string
): Promise<RelocateResult> {
    const errors: string[] = [];
    let linkedSessions = 0;
    let linkedFiles = 0;
    let usedMode: LinkMode = 'copy';

    const oldNorm = normalize(oldAbsPath);
    const newNorm = normalize(newAbsPath);

    // 旧プロジェクトキー → ~/.claude/projects/<key>/
    const oldKey = buildProjectKey(oldNorm);
    const newKey = buildProjectKey(newNorm);
    const oldProjectDir = path.join(CLAUDE_PROJECTS_DIR, oldKey);
    const newProjectDir = path.join(CLAUDE_PROJECTS_DIR, newKey);

    // 1. ~/.claude/projects/<oldKey>/ が存在する場合、<newKey>/ へリンク/コピー
    if (fs.existsSync(oldProjectDir)) {
        const result = await linkDir(oldProjectDir, newProjectDir, 'symlink');
        usedMode = result.mode;
        if (result.error) {
            errors.push(`プロジェクトディレクトリのリンク失敗: ${result.error}`);
        } else {
            // リンクしたJSONL数をカウント
            try {
                const files = fs.readdirSync(
                    fs.lstatSync(newProjectDir).isSymbolicLink()
                        ? fs.realpathSync(newProjectDir)
                        : newProjectDir
                );
                linkedSessions = files.filter(f => f.endsWith('.jsonl')).length;
                linkedFiles = files.length;
            } catch { /* カウント失敗は無視 */ }
        }
    }

    // 2. csm-projects.json の rootPath を更新
    try {
        if (fs.existsSync(CSM_PROJECTS_FILE)) {
            const raw = fs.readFileSync(CSM_PROJECTS_FILE, 'utf-8');
            const projects = JSON.parse(raw) as { projects?: Array<{ path?: string; rootPath?: string }> };
            let updated = false;
            if (Array.isArray(projects.projects)) {
                for (const p of projects.projects) {
                    if (p.path && normalize(p.path) === oldNorm) {
                        p.path = newAbsPath;
                        updated = true;
                    }
                    if (p.rootPath && normalize(p.rootPath) === oldNorm) {
                        p.rootPath = newAbsPath;
                        updated = true;
                    }
                }
            }
            if (updated) {
                fs.writeFileSync(CSM_PROJECTS_FILE, JSON.stringify(projects, null, '\t'), 'utf-8');
            }
        }
    } catch (err) {
        errors.push(`csm-projects.json 更新失敗: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. エージェント workDir を更新（旧パス配下のもののみ）
    try {
        await updateAgentWorkDirs(oldNorm, newAbsPath);
    } catch (err) {
        errors.push(`エージェント workDir 更新失敗: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
        success: errors.length === 0,
        oldPath: oldAbsPath,
        newPath: newAbsPath,
        linkedSessions,
        linkedFiles,
        errors,
        mode: usedMode,
    };
}

/** エージェントの workDir のうち旧パス配下のものを新パスに更新する */
async function updateAgentWorkDirs(oldNorm: string, newAbsPath: string): Promise<void> {
    const agentsDirs: string[] = [
        path.join(CLAUDE_DIR, 'agents'),
    ];
    // プロジェクトスコープ agents
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsFolder) {
        agentsDirs.push(path.join(wsFolder, '.claude', 'agents'));
    }

    for (const agentsDir of agentsDirs) {
        if (!fs.existsSync(agentsDir)) { continue; }
        const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const filePath = path.join(agentsDir, file);
            try {
                let content = fs.readFileSync(filePath, 'utf-8');
                // フロントマターの workDir を探して置換
                const workDirMatch = content.match(/^workDir:\s*["']?(.+?)["']?\s*$/m);
                if (workDirMatch) {
                    const currentWorkDir = workDirMatch[1].trim();
                    const expanded = currentWorkDir.replace(/^~/, os.homedir());
                    if (isContainedIn(normalize(expanded), oldNorm)) {
                        const relative = normalize(expanded).slice(oldNorm.length);
                        const newWorkDir = newAbsPath + relative;
                        content = content.replace(
                            /^(workDir:\s*["']?)(.+?)(["']?\s*)$/m,
                            `$1${newWorkDir}$3`
                        );
                        fs.writeFileSync(filePath, content, 'utf-8');
                    }
                }
            } catch { /* ファイルごとのエラーは無視 */ }
        }
    }
}

// -------------------------------------------------------------------
// 起動時整合性チェック (T3.19)
// -------------------------------------------------------------------

/**
 * csm-projects.json の全 rootPath が実際に存在するかチェックする。
 * 欠損がある場合は VS Code 警告通知を出す。
 */
export async function checkIntegrity(): Promise<IntegrityCheckResult> {
    const missing: string[] = [];
    const valid: string[] = [];

    if (!fs.existsSync(CSM_PROJECTS_FILE)) {
        return { missing, valid };
    }

    try {
        const raw = fs.readFileSync(CSM_PROJECTS_FILE, 'utf-8');
        const projects = JSON.parse(raw) as { projects?: Array<{ path?: string; rootPath?: string; name?: string }> };
        if (!Array.isArray(projects.projects)) { return { missing, valid }; }

        for (const p of projects.projects) {
            const rootPath = p.rootPath ?? p.path;
            if (!rootPath) { continue; }
            if (fs.existsSync(rootPath)) {
                valid.push(rootPath);
            } else {
                missing.push(rootPath);
            }
        }
    } catch {
        return { missing, valid };
    }

    // 欠損がある場合は通知
    if (missing.length > 0) {
        const detail = missing.slice(0, 3).join('\n') + (missing.length > 3 ? `\n...他 ${missing.length - 3} 件` : '');
        vscode.window.showWarningMessage(
            `⚠️ CSM: ${missing.length} 件のプロジェクトパスが見つかりません。`,
            { detail: `見つからないパス:\n${detail}\n\n「プロジェクトを移動しましたか？」コマンドで修正できます。` },
            '引っ越しウィザードを開く'
        ).then(choice => {
            if (choice === '引っ越しウィザードを開く') {
                vscode.commands.executeCommand('claudeManager.relocateProject');
            }
        });
    }

    return { missing, valid };
}

// -------------------------------------------------------------------
// 引っ越しウィザード コマンドハンドラ (T3.18 のバックエンド)
// -------------------------------------------------------------------

/**
 * VS Code の UI を使って引っ越しウィザードを実行する。
 * UI ウィザード部分は csm-ui が担当するが、コアロジックはここに集約。
 */
export async function runRelocateWizard(): Promise<void> {
    // 旧パスの入力
    const oldPathInput = await vscode.window.showInputBox({
        title: 'プロジェクト引っ越しウィザード — ステップ 1/2',
        prompt: '移動前のプロジェクトパスを入力してください',
        placeHolder: '/old/path/to/project',
        ignoreFocusOut: true,
    });
    if (!oldPathInput) { return; }

    // 新パスの選択
    const newPathUris = await vscode.window.showOpenDialog({
        title: 'プロジェクト引っ越しウィザード — ステップ 2/2: 新しい場所を選択',
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'この場所に引っ越す',
    });
    if (!newPathUris || newPathUris.length === 0) { return; }

    const newPath = newPathUris[0].fsPath;

    // 確認
    const confirm = await vscode.window.showInformationMessage(
        `プロジェクトを引っ越ししますか？`,
        {
            modal: true,
            detail: `移動前: ${oldPathInput}\n移動後: ${newPath}\n\nセッション JSONL のリンクと設定が更新されます。`,
        },
        '実行',
        'キャンセル'
    );
    if (confirm !== '実行') { return; }

    // 実行
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'プロジェクト引っ越し中...',
            cancellable: false,
        },
        async () => {
            const result = await relinkProject(oldPathInput, newPath);
            if (result.success) {
                vscode.window.showInformationMessage(
                    `✅ 引っ越し完了 (${result.mode}) — セッション ${result.linkedSessions} 件をリンクしました。`
                );
            } else {
                vscode.window.showErrorMessage(
                    `⚠️ 引っ越し完了（エラーあり）: ${result.errors.join(' / ')}`
                );
            }
        }
    );
}
