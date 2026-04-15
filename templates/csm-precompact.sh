#!/bin/bash
# CSM PreCompact hook — コンパクション前にセッション要約をHISTORY.mdに追記
# CSM v0.5.0+
# 設計原則: VSIXインストール時に自動デプロイ、csm/プレフィックスで名前空間分離

# 全処理をPythonに委譲（シェル変数のインライン展開によるインジェクションを防止）
python -c "
import sys, json, os
from datetime import datetime

def main():
    # stdinからhook入力を読み取り
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        return

    session_id = input_data.get('session_id', '')
    transcript_path = input_data.get('transcript_path', '')
    if not session_id:
        return

    # session-manager.json からエージェント名を特定
    sm_file = os.path.join(os.path.expanduser('~'), '.claude', 'session-manager.json')
    if not os.path.isfile(sm_file):
        return

    agent_name = ''
    try:
        with open(sm_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        bindings = data.get('agentSessions', {})
        for name, info in bindings.items():
            if info.get('sessionId') == session_id:
                agent_name = name
                break
    except Exception:
        return

    if not agent_name:
        return

    # HISTORY.mdのパス
    history_file = os.path.join(os.path.expanduser('~'), '.claude', 'agents', agent_name, 'HISTORY.md')
    if not os.path.isfile(history_file):
        return

    # トランスクリプトから直近のやり取りを要約
    if not transcript_path or not os.path.exists(transcript_path):
        return

    try:
        size = os.path.getsize(transcript_path)
        read_size = min(65536, size)
        with open(transcript_path, 'rb') as f:
            f.seek(max(0, size - read_size))
            tail = f.read().decode('utf-8', errors='replace')

        lines = [l for l in tail.split('\n') if l.strip()]
        if len(lines) > 1:
            lines = lines[1:]  # 先頭行は途中切れの可能性

        parts = []
        for line in lines[-20:]:
            try:
                entry = json.loads(line)
                msg = entry.get('message', {})
                if entry.get('type') == 'user' and msg.get('role') == 'user':
                    content = msg.get('content', '')
                    if isinstance(content, str) and content:
                        parts.append('[User] ' + content[:100])
                elif entry.get('type') == 'assistant' and msg.get('role') == 'assistant':
                    content = msg.get('content', '')
                    if isinstance(content, str) and content:
                        parts.append('[Asst] ' + content[:150])
                    elif isinstance(content, list):
                        text = ''.join(b.get('text', '') for b in content if b.get('type') == 'text')
                        if text:
                            parts.append('[Asst] ' + text[:150])
            except (json.JSONDecodeError, KeyError, TypeError):
                pass

        if not parts:
            return

        # HISTORY.mdに追記
        now = datetime.now()
        date_str = now.strftime('%Y-%m-%d')
        time_str = now.strftime('%H:%M')
        summary = '\n'.join(parts[-4:])

        with open(history_file, 'a', encoding='utf-8') as f:
            f.write(f'\n### {date_str} {time_str} (compact前自動記録)\n{summary}\n')
    except Exception:
        pass

main()
" 2>/dev/null

# コンパクションを許可（ブロックしない）
exit 0
