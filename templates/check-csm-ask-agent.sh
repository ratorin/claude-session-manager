#!/bin/bash
# PreToolUse(Bash) の hook
# claude -p が --agent/--resume なしで実行されたら警告

# stdin から JSON を読み取る
INPUT_JSON=$(cat)

# python で判定を一括処理（改行を含むコマンドも正しく処理）
RESULT=$(echo "$INPUT_JSON" | python -c "
import sys, json, re

try:
    d = json.load(sys.stdin)
    cmd = d.get('tool_input', {}).get('command', '')
except:
    print('pass')
    sys.exit(0)

# claude を含まないコマンドはスルー
if 'claude' not in cmd:
    print('pass')
    sys.exit(0)

# claude -p または claude --print を含むかチェック
if re.search(r'claude\s.*(-p|--print)', cmd):
    # --agent または --resume を含むかチェック
    if re.search(r'--agent|--resume', cmd):
        print('pass')
    else:
        print('block')
else:
    print('pass')
" 2>/dev/null)

if [ "$RESULT" = "block" ]; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "block",
    "permissionDecisionReason": "claude -p を --agent/--resume なしで実行しようとしています。正しい形式: claude --agent <name> -p または claude --resume <sessionId> -p。/csm-ask-agent スキルを使ってください。"
  }
}
EOF
else
  echo '{}'
fi

exit 0
