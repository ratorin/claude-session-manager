#!/usr/bin/env python
"""
/ask-agent 用スタンドアロンスクリプト

使い方:
  python ask-agent.py <agent-name>    セッションID・モデル・effort・permissionModeを取得
  python ask-agent.py --list          全エージェント一覧（名前|displayName|role|parentAgent）
"""
import json
import re
import os
import sys
import glob
import io

# Windows cp932 エンコードエラー防止
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')


def read_frontmatter(filepath):
    """agents/*.md のフロントマターを辞書で返す"""
    data = {}
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            in_fm = False
            for line in f:
                stripped = line.strip()
                if stripped == "---":
                    if in_fm:
                        break
                    in_fm = True
                    continue
                if in_fm:
                    m = re.match(r'^(\w+):\s*["\']?([^"\']*)', line)
                    if m:
                        data[m.group(1).strip()] = m.group(2).strip()
    except Exception:
        pass
    return data


def get_agent_info(agent_name):
    """エージェント名からセッションID・モデル・effort・permissionModeを取得"""
    agent_file = os.path.expanduser(f"~/.claude/agents/{agent_name}.md")
    if not os.path.exists(agent_file):
        print(f"ERROR: Agent file not found: {agent_file}", file=sys.stderr)
        sys.exit(1)

    fm = read_frontmatter(agent_file)
    model = fm.get("model", "opus")
    effort = fm.get("effort", "high")
    perm = fm.get("permissionMode", "acceptEdits")

    # session-manager.json からセッションID取得
    sm_file = os.path.expanduser("~/.claude/session-manager.json")
    sid = ""
    try:
        with open(sm_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        binding = data.get("agentSessions", {}).get(agent_name, {})
        sid = binding.get("sessionId", "")
    except Exception:
        pass

    print(f"{sid}|{model}|{effort}|{perm}")


def list_agents():
    """全エージェント一覧を出力（名前|displayName|role|parentAgent）"""
    agents_dir = os.path.expanduser("~/.claude/agents")
    if not os.path.isdir(agents_dir):
        print("ERROR: agents directory not found", file=sys.stderr)
        sys.exit(1)

    agents = []
    for filepath in sorted(glob.glob(os.path.join(agents_dir, "*.md"))):
        fm = read_frontmatter(filepath)
        name = fm.get("name", os.path.splitext(os.path.basename(filepath))[0])
        display = fm.get("displayName", "")
        role = fm.get("role", fm.get("description", ""))
        parent = fm.get("parentAgent", "")
        agents.append(f"{name}|{display}|{role}|{parent}")

    for line in agents:
        print(line)


def list_pending():
    """全エージェントのTODO.mdから「確認待ち」の未チェック項目を抽出"""
    agents_dir = os.path.expanduser("~/.claude/agents")
    if not os.path.isdir(agents_dir):
        return

    for entry in sorted(os.listdir(agents_dir)):
        todo_path = os.path.join(agents_dir, entry, "TODO.md")
        if not os.path.isfile(todo_path):
            continue
        try:
            with open(todo_path, "r", encoding="utf-8") as f:
                in_pending = False
                for line in f:
                    stripped = line.strip()
                    # 「確認待ち」セクション検出
                    if stripped.startswith("## 確認待ち"):
                        in_pending = True
                        continue
                    # 次のセクションで終了
                    if in_pending and stripped.startswith("## "):
                        break
                    # 未チェック項目を出力
                    if in_pending and stripped.startswith("- [ ]"):
                        item = stripped[6:].strip()
                        print(f"{entry}|{item}")
        except Exception:
            pass


def main():
    if len(sys.argv) < 2:
        print("Usage: python ask-agent.py <agent-name>", file=sys.stderr)
        print("       python ask-agent.py --list", file=sys.stderr)
        print("       python ask-agent.py --pending", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--list":
        list_agents()
    elif sys.argv[1] == "--pending":
        list_pending()
    else:
        get_agent_info(sys.argv[1])


if __name__ == "__main__":
    main()
