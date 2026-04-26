#!/usr/bin/env python
"""
/csm-ask-agent 用スタンドアロンスクリプト

使い方:
  python csm-ask-agent.py <agent-name>    セッションID・permissionModeを取得
  python csm-ask-agent.py --list          全エージェント一覧
  python csm-ask-agent.py --pending       確認待ち一覧
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

def is_path_contained_in(child, parent):
    """child が parent 配下（または一致）か判定する (T3.20 / F7)"""
    if not child or not parent:
        return False
    # 正規化: 末尾スラッシュ除去・小文字化
    child_norm = os.path.normpath(child).lower().replace("\\", "/").rstrip("/")
    parent_norm = os.path.normpath(parent).lower().replace("\\", "/").rstrip("/")
    if child_norm == parent_norm:
        return True
    parent_with_sep = parent_norm.rstrip("/") + "/"
    return child_norm.startswith(parent_with_sep)


def check_workdir_compatible(work_dir, workspace_cwd=None):
    """
    workDir が ワークスペースと互換性があるか確認する (F7 workDir 緩和)。
    新仕様: is_contained_in(workspace, workDir) or is_contained_in(workDir, workspace)
    環境変数 CSM_ALLOW_ANY_WORKDIR=1 でチェックをスキップ。
    workspace_cwd が None の場合は os.getcwd() を使用。
    """
    if os.environ.get("CSM_ALLOW_ANY_WORKDIR", "0") == "1":
        return True
    if not work_dir:
        return True  # workDir 未設定 → 制限なし
    workspace = workspace_cwd or os.getcwd()
    return (
        is_path_contained_in(work_dir, workspace) or
        is_path_contained_in(workspace, work_dir)
    )


def translate_path(p):
    """Translate Windows paths to local filesystem on Linux (dev-lamp HGFS).
    Pass through unchanged on Windows/host."""
    if not p:
        return p
    # Normalize backslashes
    p = p.replace("\\\\", "/").replace("\\", "/")
    # On Windows (os.sep == "\\"), keep as-is
    if os.sep == "\\":
        return p
    # On Linux, translate c:/... or C:/... to /mnt/hgfs/...
    m = re.match(r"^[cC]:/(.+)$", p)
    if m:
        rest = m.group(1)
        # Known mappings (order matters: most specific first)
        mappings = [
            ("workspace/", "/mnt/hgfs/workspace/"),
            ("xampp/Project/", "/mnt/hgfs/Project/"),
            ("xampp/Project", "/mnt/hgfs/Project"),
            ("xampp/", "/mnt/hgfs/Project/"),
            ("xampp", "/mnt/hgfs/Project"),
            ("GDrive/", "/mnt/hgfs/GDrive/"),
            ("GDrive", "/mnt/hgfs/GDrive"),
        ]
        for prefix, new_prefix in mappings:
            if rest.startswith(prefix):
                return new_prefix + rest[len(prefix):]
    return p



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
    """エージェント名からセッションID・permissionModeを取得
    model/effortは --agent モードでフロントマターから自動適用されるため不要"""
    agent_file = os.path.expanduser(f"~/.claude/agents/{agent_name}.md")
    if not os.path.exists(agent_file):
        print(f"ERROR: Agent file not found: {agent_file}", file=sys.stderr)
        sys.exit(1)

    fm = read_frontmatter(agent_file)
    perm = fm.get("permissionMode", "acceptEdits")
    # workDirはYAMLで \\ エスケープされている場合があるので正規化
    work_dir = translate_path(fm.get("workDir", ""))

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

    # セッションファイルが実在するプロジェクトディレクトリからcwdを逆引き（--resume成功のため）
    # agent.workDir が無い場合のフォールバックとして使用
    resume_cwd = work_dir
    if sid and not resume_cwd:
        projects_dir = os.path.expanduser("~/.claude/projects")
        if os.path.isdir(projects_dir):
            for proj in os.listdir(projects_dir):
                if os.path.isfile(os.path.join(projects_dir, proj, f"{sid}.jsonl")):
                    # Reverse derive cwd from project folder name
                    # -mnt-hgfs-... → /mnt/hgfs/... (Linux HGFS)
                    # -home-vus26-... → /home/vus26/... (Linux home)
                    # c--workspace-CMS-CurtainNext → c:/workspace/CMS/CurtainNext (Windows)
                    if proj.startswith("-"):
                        resume_cwd = "/" + proj[1:].replace("-", "/")
                    elif proj.lower().startswith("c--"):
                        resume_cwd = "c:/" + proj[3:].replace("-", "/")
                    # Apply HGFS translation if needed
                    resume_cwd = translate_path(resume_cwd)
                    break

    # On Linux, ensure the session file is reachable from the Linux-derived
    # project key. Sessions originally created on Windows live under
    # c--xampp-Project-... but `claude --resume` from Linux looks under
    # -mnt-hgfs-Project-... — bridge with a symlink so resume works.
    if os.sep == "/" and sid and resume_cwd:
        try:
            projects_dir = os.path.expanduser("~/.claude/projects")
            # Compute expected Linux-style project key from resume_cwd
            expected_key = resume_cwd.replace("/", "-")
            if expected_key.startswith("-"):
                expected_proj = os.path.join(projects_dir, expected_key)
                expected_jsonl = os.path.join(expected_proj, f"{sid}.jsonl")
                if not os.path.exists(expected_jsonl):
                    # Find the actual file across all project dirs
                    actual_jsonl = ""
                    if os.path.isdir(projects_dir):
                        for proj in os.listdir(projects_dir):
                            cand = os.path.join(projects_dir, proj, f"{sid}.jsonl")
                            if os.path.isfile(cand):
                                actual_jsonl = cand
                                break
                    if actual_jsonl:
                        os.makedirs(expected_proj, exist_ok=True)
                        try:
                            os.symlink(actual_jsonl, expected_jsonl)
                        except (OSError, NotImplementedError):
                            # Fallback: hard link or copy if symlink unsupported
                            try:
                                os.link(actual_jsonl, expected_jsonl)
                            except OSError:
                                import shutil
                                shutil.copy2(actual_jsonl, expected_jsonl)
        except Exception:
            pass  # Best-effort; failure is non-fatal

    # T3.20 F7: workDir 互換チェック
    # workspace_cwd は呼び出し元から環境変数で渡される（未設定なら getcwd）
    workspace_cwd = os.environ.get("CSM_WORKSPACE_CWD", "") or os.getcwd()
    if work_dir and not check_workdir_compatible(work_dir, workspace_cwd):
        print(
            f"ERROR: workDir({work_dir}) is outside workspace({workspace_cwd}). "
            "Set claudeManager.askAgent.allowAnyWorkDir=true to disable check.",
            file=sys.stderr
        )
        sys.exit(1)

    print(f"{sid}|{perm}|{resume_cwd}")


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
