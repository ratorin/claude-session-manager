#!/bin/bash
# CSM PreCompact hook — コンパクション前にセッション要約をHISTORY.mdに追記
# CSM v0.5.0+
# 設計原則: VSIXインストール時に自動デプロイ、csm/プレフィックスで名前空間分離

INPUT_JSON=$(cat)

# セッションIDとトランスクリプトパスを取得
SESSION_ID=$(echo "$INPUT_JSON" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('session_id', ''))
except:
    print('')
" 2>/dev/null)

TRANSCRIPT=$(echo "$INPUT_JSON" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('transcript_path', ''))
except:
    print('')
" 2>/dev/null)

# セッションIDがなければスキップ
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# session-manager.json からエージェント名を特定
SM_FILE="$HOME/.claude/session-manager.json"
if [ ! -f "$SM_FILE" ]; then
  exit 0
fi

AGENT_NAME=$(python -c "
import json, sys
try:
    with open('$SM_FILE', 'r') as f:
        data = json.load(f)
    bindings = data.get('agentSessions', {})
    for name, info in bindings.items():
        if info.get('sessionId') == '$SESSION_ID':
            print(name)
            sys.exit(0)
except:
    pass
print('')
" 2>/dev/null)

# エージェントに紐づいていなければスキップ
if [ -z "$AGENT_NAME" ]; then
  exit 0
fi

# HISTORY.mdのパス
HISTORY_FILE="$HOME/.claude/agents/$AGENT_NAME/HISTORY.md"
if [ ! -f "$HISTORY_FILE" ]; then
  exit 0
fi

# トランスクリプトから直近のやり取りを要約（簡易方式: 末尾から抽出）
SUMMARY=$(python -c "
import sys, json, os

transcript = '$TRANSCRIPT'
if not transcript or not os.path.exists(transcript):
    sys.exit(0)

try:
    # 末尾64KBを読む
    size = os.path.getsize(transcript)
    read_size = min(65536, size)
    with open(transcript, 'rb') as f:
        f.seek(max(0, size - read_size))
        tail = f.read().decode('utf-8', errors='replace')

    lines = [l for l in tail.split('\n') if l.strip()]
    if len(lines) > 1:
        lines = lines[1:]  # 先頭行は途中切れの可能性

    parts = []
    for line in lines[-20:]:
        try:
            entry = json.loads(line)
            if entry.get('type') == 'user' and entry.get('message', {}).get('role') == 'user':
                content = entry['message'].get('content', '')
                if isinstance(content, str) and content:
                    parts.append('[User] ' + content[:100])
            elif entry.get('type') == 'assistant' and entry.get('message', {}).get('role') == 'assistant':
                content = entry['message'].get('content', '')
                if isinstance(content, str) and content:
                    parts.append('[Asst] ' + content[:150])
                elif isinstance(content, list):
                    text = ''.join(b.get('text', '') for b in content if b.get('type') == 'text')
                    if text:
                        parts.append('[Asst] ' + text[:150])
        except:
            pass

    if parts:
        print('\n'.join(parts[-4:]))
except:
    pass
" 2>/dev/null)

# 要約があればHISTORY.mdに追記
if [ -n "$SUMMARY" ]; then
  DATE_STR=$(date +%Y-%m-%d)
  TIME_STR=$(date +%H:%M)
  {
    echo ""
    echo "### $DATE_STR $TIME_STR (compact前自動記録)"
    echo "$SUMMARY"
  } >> "$HISTORY_FILE"
fi

# コンパクションを許可（ブロックしない）
exit 0
