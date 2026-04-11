#!/usr/bin/env bash
set -euo pipefail

# ========================================
#  Claude Session Manager インストーラー
#  v0.4.0
# ========================================

# 色定義
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[警告]${NC} $*"; }
error() { echo -e "${RED}[エラー]${NC} $*"; }

echo ""
echo "========================================"
echo " Claude Session Manager インストーラー"
echo " v0.4.0"
echo "========================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# === 1. VS Code 確認 ===
info "[1/5] VS Code の確認..."
if ! command -v code &>/dev/null; then
    error "VS Code が見つかりません。"
    echo "  VS Code をインストールしてから再実行してください。"
    echo "  https://code.visualstudio.com/"
    exit 1
fi
VSCODE_VER=$(code --version 2>/dev/null | head -1)
ok "VS Code: ${VSCODE_VER}"

# === 2. .vsix ファイル検出 ===
echo ""
info "[2/5] .vsix ファイルの検出..."
VSIX_FILE=""

# 最新の .vsix を探す（プロジェクトルート優先）
if ls "${SCRIPT_DIR}"/claude-session-manager-*.vsix 1>/dev/null 2>&1; then
    VSIX_FILE=$(ls -t "${SCRIPT_DIR}"/claude-session-manager-*.vsix 2>/dev/null | head -1)
fi

# local/ ディレクトリのフォールバック
if [ -z "${VSIX_FILE}" ] && ls "${SCRIPT_DIR}"/local/claude-session-manager-*.vsix 1>/dev/null 2>&1; then
    VSIX_FILE=$(ls -t "${SCRIPT_DIR}"/local/claude-session-manager-*.vsix 2>/dev/null | head -1)
fi

if [ -z "${VSIX_FILE}" ]; then
    error ".vsix ファイルが見つかりません。"
    echo "  先に 'npm run package' でビルドしてください。"
    exit 1
fi
ok "検出: ${VSIX_FILE}"

# === 3. 既存バージョン確認・インストール ===
echo ""
info "[3/5] 拡張機能のインストール..."

if code --list-extensions 2>/dev/null | grep -qi "ratorin.claude-session-manager"; then
    info "既存バージョンを検出。アップデートします..."
fi

if ! code --install-extension "${VSIX_FILE}" --force >/dev/null 2>&1; then
    error "インストールに失敗しました。"
    echo "  VS Code を閉じてから再実行してください。"
    exit 1
fi
ok "インストール完了"

# === 4. インストール検証 ===
echo ""
info "[4/5] インストールの検証..."
if code --list-extensions 2>/dev/null | grep -qi "ratorin.claude-session-manager"; then
    ok "検証OK: ratorin.claude-session-manager"
else
    warn "拡張機能の検証に失敗しました。"
    echo "  VS Code を再起動後に確認してください。"
fi

# === 5. 初期設定 ===
echo ""
info "[5/5] 初期設定..."

CONFIG_DIR="${HOME}/.claude"
CONFIG_FILE="${CONFIG_DIR}/session-manager.json"

if [ ! -d "${CONFIG_DIR}" ]; then
    mkdir -p "${CONFIG_DIR}"
    info "ディレクトリ作成: ${CONFIG_DIR}"
fi

if [ ! -f "${CONFIG_FILE}" ]; then
    info "初期設定ファイルを作成します..."
    cat > "${CONFIG_FILE}" <<'JSON'
{
	"bookmarks": [],
	"tags": {},
	"customNames": {},
	"notes": {},
	"agentSessions": {}
}
JSON
    ok "作成完了: ${CONFIG_FILE}"
else
    ok "設定ファイル: 既存の設定を使用します"
fi

# check-dispatch.sh フックの確認
echo ""
info "[フック設定の確認]"
SETTINGS_FILE="${CONFIG_DIR}/settings.json"
if [ -f "${SETTINGS_FILE}" ]; then
    if grep -q "check-dispatch" "${SETTINGS_FILE}" 2>/dev/null; then
        ok "check-dispatch フック: 登録済み"
    else
        warn "check-dispatch フック: 未登録"
        echo "  ※ dispatch機能を使用する場合は、Claude Code設定で"
        echo "    フックを手動登録してください。"
    fi
else
    warn "settings.json が見つかりません。"
    echo "  Claude Code を一度起動してから設定してください。"
fi

# === 完了 ===
echo ""
echo "========================================"
echo -e " ${GREEN}インストール完了！${NC}"
echo "========================================"
echo ""
echo " 次のステップ:"
echo "  1. VS Code を再起動してください"
echo "  2. サイドバーに Claude Session Manager アイコンが表示されます"
echo "  3. Claude Code のセッション履歴を管理できます"
echo ""
echo " アンインストール方法:"
echo "  方法1: VS Code の拡張機能パネルからアンインストール"
echo "  方法2: コマンドラインで実行:"
echo "    code --uninstall-extension ratorin.claude-session-manager"
echo "  設定の削除（任意）:"
echo "    rm \"${CONFIG_FILE}\""
echo ""
echo "========================================"
