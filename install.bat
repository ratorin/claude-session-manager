@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo.
echo ========================================
echo  Claude Session Manager インストーラー
echo  v0.4.0
echo ========================================
echo.

REM === 1. VS Code 確認 ===
echo [1/5] VS Code の確認...
where code >nul 2>&1
if %errorlevel% neq 0 (
    echo [エラー] VS Code が見つかりません。
    echo   VS Code をインストールしてから再実行してください。
    echo   https://code.visualstudio.com/
    goto :error_exit
)
for /f "tokens=*" %%i in ('code --version 2^>nul') do (
    set VSCODE_VER=%%i
    goto :got_version
)
:got_version
echo   VS Code: %VSCODE_VER%

REM === 2. .vsix ファイル検出 ===
echo.
echo [2/5] .vsix ファイルの検出...
set "SCRIPT_DIR=%~dp0"
set "VSIX_FILE="

REM 最新の .vsix を探す（カレントディレクトリ優先）
for /f "delims=" %%f in ('dir /b /o-n "%SCRIPT_DIR%claude-session-manager-*.vsix" 2^>nul') do (
    if not defined VSIX_FILE set "VSIX_FILE=%SCRIPT_DIR%%%f"
)

if not defined VSIX_FILE (
    REM local/ ディレクトリも探す
    for /f "delims=" %%f in ('dir /b /o-n "%SCRIPT_DIR%local\claude-session-manager-*.vsix" 2^>nul') do (
        if not defined VSIX_FILE set "VSIX_FILE=%SCRIPT_DIR%local\%%f"
    )
)

if not defined VSIX_FILE (
    echo [エラー] .vsix ファイルが見つかりません。
    echo   先に `npm run package` でビルドしてください。
    goto :error_exit
)
echo   検出: %VSIX_FILE%

REM === 3. 既存バージョン確認・インストール ===
echo.
echo [3/5] 拡張機能のインストール...

REM 既存インストールの確認
set "ALREADY_INSTALLED=0"
for /f "tokens=*" %%i in ('code --list-extensions 2^>nul ^| findstr /i "ratorin.claude-session-manager"') do (
    set "ALREADY_INSTALLED=1"
)

if "%ALREADY_INSTALLED%"=="1" (
    echo   既存バージョンを検出。アップデートします...
)

code --install-extension "%VSIX_FILE%" --force >nul 2>&1
if %errorlevel% neq 0 (
    echo [エラー] インストールに失敗しました。
    echo   VS Code を閉じてから再実行してください。
    goto :error_exit
)
echo   インストール完了

REM === 4. インストール検証 ===
echo.
echo [4/5] インストールの検証...
set "VERIFIED=0"
for /f "tokens=*" %%i in ('code --list-extensions 2^>nul ^| findstr /i "ratorin.claude-session-manager"') do (
    set "VERIFIED=1"
)
if "%VERIFIED%"=="0" (
    echo [警告] 拡張機能の検証に失敗しました。
    echo   VS Code を再起動後に確認してください。
) else (
    echo   検証OK: ratorin.claude-session-manager
)

REM === 5. 初期設定 ===
echo.
echo [5/5] 初期設定...

REM session-manager.json の確認
set "CONFIG_DIR=%USERPROFILE%\.claude"
set "CONFIG_FILE=%CONFIG_DIR%\session-manager.json"

if not exist "%CONFIG_DIR%" (
    mkdir "%CONFIG_DIR%"
    echo   ディレクトリ作成: %CONFIG_DIR%
)

if not exist "%CONFIG_FILE%" (
    echo   初期設定ファイルを作成します...
    (
        echo {
        echo 	"bookmarks": [],
        echo 	"tags": {},
        echo 	"customNames": {},
        echo 	"notes": {},
        echo 	"agentSessions": {}
        echo }
    ) > "%CONFIG_FILE%"
    echo   作成完了: %CONFIG_FILE%
) else (
    echo   設定ファイル: 既存の設定を使用します
)

REM check-dispatch.sh の確認（hooks設定の案内）
echo.
echo   [フック設定の確認]
set "SETTINGS_FILE=%CONFIG_DIR%\settings.json"
if exist "%SETTINGS_FILE%" (
    findstr /c:"check-dispatch" "%SETTINGS_FILE%" >nul 2>&1
    if %errorlevel% equ 0 (
        echo   check-dispatch フック: 登録済み
    ) else (
        echo   check-dispatch フック: 未登録
        echo   ※ dispatch機能を使用する場合は、Claude Code設定で
        echo     フックを手動登録してください。
    )
) else (
    echo   settings.json が見つかりません。
    echo   Claude Code を一度起動してから設定してください。
)

REM === 完了 ===
echo.
echo ========================================
echo  インストール完了！
echo ========================================
echo.
echo  次のステップ:
echo   1. VS Code を再起動してください
echo   2. サイドバーに Claude Session Manager アイコンが表示されます
echo   3. Claude Code のセッション履歴を管理できます
echo.
echo  アンインストール方法:
echo   方法1: VS Code の拡張機能パネルからアンインストール
echo   方法2: コマンドラインで実行:
echo     code --uninstall-extension ratorin.claude-session-manager
echo   設定の削除（任意）:
echo     del "%CONFIG_FILE%"
echo.
echo ========================================
goto :eof

:error_exit
echo.
echo インストールを中断しました。
exit /b 1
