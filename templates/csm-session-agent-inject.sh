#!/bin/bash
# CSM SessionStart hook — 紐づけられたエージェント定義をセッション開始時に注入
# CSM v0.5.0+
# 設計原則: VSIXインストール時に自動デプロイ、csm/プレフィックスで名前空間分離
#
# 入力(stdin): { session_id, transcript_path, cwd, hook_event_name: "SessionStart", ... }
# 出力(stdout): { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }

python -c "
import sys, json, os

def main():
    try:
        input_data = json.load(sys.stdin)
    except Exception:
        print('{}')
        return

    session_id = input_data.get('session_id', '')
    if not session_id:
        print('{}')
        return

    # session-manager.json からエージェント名を特定
    sm_file = os.path.join(os.path.expanduser('~'), '.claude', 'session-manager.json')
    if not os.path.isfile(sm_file):
        print('{}')
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
        print('{}')
        return

    if not agent_name:
        print('{}')
        return

    # エージェント定義ファイルを探す（グローバル→追加ディレクトリ順）
    agent_file = ''
    candidates = [
        os.path.join(os.path.expanduser('~'), '.claude', 'agents', agent_name + '.md'),
    ]
    # cwd配下も候補（プロジェクトスコープ）
    cwd = input_data.get('cwd', '')
    if cwd:
        candidates.append(os.path.join(cwd, '.claude', 'agents', agent_name + '.md'))

    for candidate in candidates:
        if os.path.isfile(candidate):
            agent_file = candidate
            break

    if not agent_file:
        print('{}')
        return

    # エージェント定義ファイルの内容を読む（フロントマター含む全体）
    try:
        with open(agent_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception:
        print('{}')
        return

    # 注入するコンテキストを構築
    context = (
        '【CSM自動注入: エージェント役割定義】\n'
        'あなたはこのセッションで ' + agent_name + ' として動作します。\n'
        'CSM (Claude Session Manager) により以下のエージェント定義が紐づけられています。\n'
        'セッション開始時にこの定義を読み込み、役割・行動規範・制約に従って応答してください。\n\n'
        '---\n'
        + content + '\n'
        '---\n'
    )

    output = {
        'hookSpecificOutput': {
            'hookEventName': 'SessionStart',
            'additionalContext': context
        }
    }
    print(json.dumps(output, ensure_ascii=False))

main()
" 2>/dev/null

exit 0
