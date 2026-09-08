#!/usr/bin/env python
# CSM-TEMPLATE-VERSION: 2
"""
/csm-ask-agent 用スタンドアロンスクリプト

使い方:
  python csm-ask-agent.py <agent-name>    セッションID・permissionModeを取得
  python csm-ask-agent.py --list          全エージェント一覧
  python csm-ask-agent.py --pending       確認待ち一覧
  python csm-ask-agent.py --where <name>  解決結果の診断表示のみ

出力（stdout）: {sessionId}|{permissionMode}|{workDir}
ログ（stderr）: INFO: で始まる診断行。エラーは ERROR: で始まり終了コード 1。

v0.6.0 の変更（docs/agent-invocation-architecture.md R1/R2）:
  - R1: エージェント定義をプロジェクトスコープ→ユーザースコープの順で探索する。
        従来はユーザースコープ (~/.claude/agents) 固定だったため、プロジェクト側にしか
        定義が無いエージェントを呼べず、呼び出し側が Agent ツール（使い捨て実行・CSM から
        不可視）にフォールバックする誘導が起きていた。
  - R2: --resume 用の cwd をセッション JSONL の "cwd" フィールドから取得する。
        従来はプロジェクトフォルダ名（スラグ）の逆引きだったが、スラグは
        区切り文字とパス中のハイフンを区別できず非可逆:
            c--xampp-htdocs-yosuga-xs   → c:/xampp/htdocs/yosuga/xs  (誤)
            C--xampp-Project-...        → 大文字で判定漏れ → 空
        導出できない場合は空文字を返さずエラー終了する。黙って空を返すと呼び出し側が
        cd せずに --resume し、新規セッションが作られて CSM の紐づけと実体が分離する。
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

# セッション JSONL の先頭から cwd を探す際の上限（巨大セッション対策）
CWD_SCAN_MAX_LINES = 64
CWD_SCAN_MAX_BYTES = 4 * 1024 * 1024
# 祖先ディレクトリを遡る上限
ANCESTOR_LIMIT = 12


def log_info(msg):
    """診断ログ。stdout の解析結果を汚さないよう stderr に出す。"""
    print(f"INFO: {msg}", file=sys.stderr)


def fail(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


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
                if not in_fm:
                    continue
                m = re.match(r'^([A-Za-z_][\w-]*):\s*(.*)$', line.rstrip("\r\n"))
                if not m:
                    continue
                key = m.group(1).strip()
                val = m.group(2).strip()
                if val[:1] in ('"', "'"):
                    quote = val[0]
                    end = val.find(quote, 1)
                    val = val[1:end] if end > 0 else val[1:]
                else:
                    # 引用符なしの値は行末コメント（ ... # コメント）を落とす
                    val = re.split(r'\s+#', val, 1)[0].strip()
                data[key] = val
    except Exception:
        pass
    return data


# ---------------------------------------------------------------------------
# R1: エージェント定義の探索（プロジェクトスコープ → ユーザースコープ）
# ---------------------------------------------------------------------------

def ancestors(start):
    """start とその祖先ディレクトリを上に向かって列挙する"""
    if not start:
        return []
    out = []
    cur = os.path.abspath(start)
    for _ in range(ANCESTOR_LIMIT):
        out.append(cur)
        parent = os.path.dirname(cur)
        if not parent or parent == cur:
            break
        cur = parent
    return out


def candidate_agent_roots(session_cwd=""):
    """エージェント定義ディレクトリを優先度順（プロジェクト優先）で返す

    Claude Code 本体の慣習に合わせ、呼び出し元に近いプロジェクトスコープを先に見る。
    戻り値: [(dir, scope), ...]  scope は "project" / "global"
    """
    roots = []
    seen = set()

    def add(directory, scope):
        if not directory:
            return
        norm = os.path.normpath(directory)
        key = norm.lower()
        if key in seen:
            return
        seen.add(key)
        roots.append((norm, scope))

    # 1. 明示指定（CSM_AGENT_DIRS: os.pathsep 区切り）
    #    ".../.claude/agents" そのものでも、その親プロジェクトルートでも受け付ける
    for raw in (os.environ.get("CSM_AGENT_DIRS") or "").split(os.pathsep):
        raw = raw.strip()
        if not raw:
            continue
        if os.path.basename(os.path.normpath(raw)).lower() == "agents":
            add(raw, "project")
        else:
            add(os.path.join(raw, ".claude", "agents"), "project")

    # 2. 呼び出し元 cwd とその祖先
    workspace = os.environ.get("CSM_WORKSPACE_CWD", "") or os.getcwd()
    for base in ancestors(workspace):
        add(os.path.join(base, ".claude", "agents"), "project")

    # 3. 紐づけセッションの cwd とその祖先
    #    （今回の事故ケース: 定義は c:/GDrive/.claude/agents にあり、呼び出し元 cwd は
    #      c:/GDrive/craftwork だった。セッション cwd 側からも辿れるようにする）
    if session_cwd:
        for base in ancestors(session_cwd):
            add(os.path.join(base, ".claude", "agents"), "project")

    # 4. ユーザースコープ
    add(os.path.join(os.path.expanduser("~"), ".claude", "agents"), "global")

    return roots


def resolve_agent_file(agent_name, session_cwd=""):
    """エージェント定義ファイルを探索する。戻り値: (path, scope, searched_dirs)"""
    searched = []
    for directory, scope in candidate_agent_roots(session_cwd):
        searched.append(directory)
        candidate = os.path.join(directory, f"{agent_name}.md")
        if os.path.isfile(candidate):
            return candidate, scope, searched
    return "", "", searched


# ---------------------------------------------------------------------------
# R2: --resume 用 cwd の導出（セッション JSONL の cwd フィールドが正）
# ---------------------------------------------------------------------------

def lookup_session_id(agent_name):
    """session-manager.json の agentSessions からセッションIDを引く"""
    sm_file = os.path.expanduser("~/.claude/session-manager.json")
    try:
        with open(sm_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("agentSessions", {}).get(agent_name, {}).get("sessionId", "")
    except Exception:
        return ""


def is_safe_sid(sid):
    """sid をパス結合に使う前の検証（パストラバーサル防止）"""
    return bool(sid) and bool(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", sid))


def find_session_file(sid):
    """~/.claude/projects/*/<sid>.jsonl を探す"""
    if not is_safe_sid(sid):
        return ""
    projects_dir = os.path.expanduser("~/.claude/projects")
    if not os.path.isdir(projects_dir):
        return ""
    try:
        entries = os.listdir(projects_dir)
    except OSError:
        return ""
    for proj in entries:
        candidate = os.path.join(projects_dir, proj, f"{sid}.jsonl")
        if os.path.isfile(candidate):
            return candidate
    return ""


def session_cwd_from_jsonl(path):
    """セッション JSONL の "cwd" フィールドを読む

    プロジェクトフォルダ名（スラグ）の逆引きと違い、これは可逆・確実。
    先頭数行は queue-operation など cwd を持たない行があるので少し読み進める。
    巨大セッション（数百 MB）対策として行数・バイト数の両方で上限を掛ける。
    """
    if not path:
        return ""
    try:
        read_bytes = 0
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                read_bytes += len(line)
                if i >= CWD_SCAN_MAX_LINES or read_bytes > CWD_SCAN_MAX_BYTES:
                    break
                if '"cwd"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except Exception:
                    continue
                cwd = entry.get("cwd")
                if cwd:
                    return cwd.replace("\\\\", "/").replace("\\", "/")
    except Exception:
        pass
    return ""


def resolve_resume_cwd(sid, work_dir):
    """--resume に使う cwd を決める

    sid がある場合はセッション実体の cwd が絶対的に正しい。
    `claude --resume` は cwd から算出したプロジェクトキーでセッションを探すため、
    フロントマターの workDir がズレていると "No conversation found" になり、
    そのまま新規セッションが作られてしまう（今回の事故の類型）。
    したがって sid がある場合はセッション cwd をフロントマターより優先する。
    """
    if not sid:
        return work_dir, "frontmatter" if work_dir else "none"

    session_file = find_session_file(sid)
    if not session_file:
        fail(
            f"session file not found for sessionId={sid}. "
            "CSM の紐づけが実体を失っています（Claude の自動削除の可能性）。"
            "CSM で紐づけを解除するか復元してください。"
        )

    cwd = translate_path(session_cwd_from_jsonl(session_file))
    if not cwd:
        fail(
            f"could not determine cwd from session file: {session_file}. "
            "--resume は cwd 依存のため、cwd 不明のまま起動すると新規セッションが作られます。"
        )

    if work_dir and os.path.normpath(work_dir).lower() != os.path.normpath(cwd).lower():
        log_info(
            f"frontmatter workDir({work_dir}) はセッション cwd({cwd}) と異なるため "
            "セッション cwd を採用しました（--resume は cwd 完全一致が必要）"
        )
    return cwd, "session-jsonl"


def get_agent_info(agent_name):
    """エージェント名からセッションID・permissionMode・resume 用 cwd を取得

    model/effort は --agent モードでフロントマターから自動適用されるため不要。
    """
    # セッションIDはエージェント定義に依存しないので先に取る。
    # 得られた cwd を定義ファイル探索のヒント（R1 の探索経路 3）にも使う。
    sid = lookup_session_id(agent_name)

    session_hint = translate_path(session_cwd_from_jsonl(find_session_file(sid))) if sid else ""

    agent_file, scope, searched = resolve_agent_file(agent_name, session_hint)
    if not agent_file:
        listed = "\n  - ".join(searched)
        fail(f"Agent file not found: {agent_name}.md\n  searched:\n  - {listed}")
    log_info(f"agent definition: {agent_file} (scope={scope})")

    fm = read_frontmatter(agent_file)
    perm = fm.get("permissionMode", "acceptEdits")
    # workDir は YAML で \\ エスケープされている場合があるので正規化
    work_dir = translate_path(fm.get("workDir", ""))

    resume_cwd, cwd_source = resolve_resume_cwd(sid, work_dir)
    if resume_cwd:
        log_info(f"resume cwd: {resume_cwd} (source={cwd_source})")
        if os.environ.get("CSM_SKIP_CWD_CHECK", "0") != "1" and not os.path.isdir(resume_cwd):
            fail(
                f"resume cwd does not exist: {resume_cwd}. "
                "cd できないディレクトリでは --resume が失敗し新規セッションになります。"
            )
    elif sid:
        # resolve_resume_cwd が sid ありで空を返すことは無いが、防御的に。
        fail(f"could not determine resume cwd for sessionId={sid}")

    # T3.20 F7: workDir 互換チェック
    # workspace_cwd は呼び出し元から環境変数で渡される（未設定なら getcwd）
    # v0.6.0: 実際に cd する先は resume_cwd なのでそちらも同じ基準で検査する。
    workspace_cwd = os.environ.get("CSM_WORKSPACE_CWD", "") or os.getcwd()
    for label, target in (("workDir", work_dir), ("resume cwd", resume_cwd)):
        if target and not check_workdir_compatible(target, workspace_cwd):
            fail(
                f"{label}({target}) is outside workspace({workspace_cwd}). "
                "Set claudeManager.askAgent.allowAnyWorkDir=true to disable check."
            )

    print(f"{sid}|{perm}|{resume_cwd}")


def list_agents():
    """全エージェント一覧を出力（名前|displayName|role|parentAgent|scope）

    scope は v0.6.0 で追加。既存の 4 フィールド前提の読み取りを壊さないよう末尾に足す。
    同名はプロジェクトスコープ優先（先勝ち）。
    """
    seen = set()
    rows = []
    roots = candidate_agent_roots()
    for directory, scope in roots:
        if not os.path.isdir(directory):
            continue
        for filepath in sorted(glob.glob(os.path.join(directory, "*.md"))):
            fm = read_frontmatter(filepath)
            name = fm.get("name", os.path.splitext(os.path.basename(filepath))[0])
            if name in seen:
                continue
            seen.add(name)
            display = fm.get("displayName", "")
            role = fm.get("role", fm.get("description", ""))
            parent = fm.get("parentAgent", "")
            rows.append(f"{name}|{display}|{role}|{parent}|{scope}")

    if not rows:
        fail("agents directory not found: " + ", ".join(d for d, _ in roots))

    for line in sorted(rows):
        print(line)


def list_pending():
    """全エージェントのTODO.mdから「確認待ち」の未チェック項目を抽出"""
    seen = set()
    for directory, _scope in candidate_agent_roots():
        if not os.path.isdir(directory):
            continue
        try:
            entries = sorted(os.listdir(directory))
        except OSError:
            continue
        for entry in entries:
            if entry in seen:
                continue
            todo_path = os.path.join(directory, entry, "TODO.md")
            if not os.path.isfile(todo_path):
                continue
            seen.add(entry)
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


def where(agent_name):
    """診断用: 探索対象ディレクトリと解決結果を表示するだけ（副作用なし）

    get_agent_info と同じ経路（セッション cwd をヒントに含む）を再現する。
    ここが本番と食い違うと診断の意味が無い。
    """
    sid = lookup_session_id(agent_name)
    session_hint = translate_path(session_cwd_from_jsonl(find_session_file(sid))) if sid else ""
    print(f"agent: {agent_name}")
    print(f"sessionId: {sid or '(なし)'}")
    print(f"session cwd: {session_hint or '(不明)'}")
    print("search order:")
    for directory, scope in candidate_agent_roots(session_hint):
        mark = "*" if os.path.isfile(os.path.join(directory, f"{agent_name}.md")) else " "
        exists = "" if os.path.isdir(directory) else "  (no such dir)"
        print(f"  {mark} [{scope}] {directory}{exists}")


def append_collab_log(sender, recipient):
    """v0.5.23: /csm-ask-agent の送信履歴を ~/.claude/csm-collab-log.jsonl に 1 行 append する。

    仕様:
      - フォーマット: {"ts": epoch_ms, "from": <sender>, "to": <recipient>}
      - sender は環境変数 CSM_AGENT_NAME（呼び出し元エージェント名）を優先、無ければ "director"（近似）
      - ログ書き込み失敗（権限・IO エラー等）は本処理に影響させず**サイレント**に握りつぶす
    """
    try:
        import time
        home = os.path.expanduser("~")
        log_path = os.path.join(home, ".claude", "csm-collab-log.jsonl")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        entry = {
            "ts": int(time.time() * 1000),
            "from": sender or "director",
            "to": recipient or "",
        }
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass  # 追記失敗は本処理に影響させない（サイレント）


def main():
    if len(sys.argv) < 2:
        print("Usage: python csm-ask-agent.py <agent-name>", file=sys.stderr)
        print("       python csm-ask-agent.py --list", file=sys.stderr)
        print("       python csm-ask-agent.py --pending", file=sys.stderr)
        print("       python csm-ask-agent.py --where <agent-name>", file=sys.stderr)
        sys.exit(1)

    if sys.argv[1] == "--list":
        list_agents()
    elif sys.argv[1] == "--pending":
        list_pending()
    elif sys.argv[1] == "--where":
        if len(sys.argv) < 3:
            fail("--where requires an agent name")
        where(sys.argv[2])
    else:
        agent_name = sys.argv[1]
        # v0.5.23: 連携ログを append（本処理より先に実行してサイレント）
        sender = os.environ.get("CSM_AGENT_NAME") or "director"
        append_collab_log(sender, agent_name)
        get_agent_info(agent_name)


if __name__ == "__main__":
    main()
