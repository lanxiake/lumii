# -*- coding: utf-8 -*-
"""活体探针：四件套 MCP（file/export/recall/crm）的**已打包 exe** 能不能被真客户端驱动。

和各自目录里的 `test_*.py` 的分工：那边查逻辑（纯函数 + 源码直连），这边查**接线**——
exe 有没有落后于源码、`initialize` 握手协议版对不对、工具参数校验会不会拒掉正常调用，
以及**跨调用的等价性**（比如"显示名"与 username 必须筛出同一批东西）。

客户端用的是**官方 MCP SDK**（`mcp.client.stdio`），不是手搓 JSON-RPC——即真实宿主
（Claude Code 等）走的那条路。手搓的那版只验帧格式，验不出 SDK 的字段/协议兼容性。

跑法（需要 uv；PATH 里的 python 是 Store 占位）：
    uv run --no-project --python 3.11 --with mcp python verify/wechat-mcp/toolkit-live.py

副作用：只读微信库 + 写临时目录（导出/归档落盘到 tempfile，跑完不清理，方便翻产物）。
recall 会先 `--once` 打底一次，归档库走**临时目录**（`LUMII_WECHAT_RECALL_DB`），
不碰你自己的 `~/.lumii/wechat-recall/archive.db`。

**参数选择是有讲究的**：会话参数一律用「**显示名**」（文件传输助手），不是 username
（filehelper）。这条路上曾经有一个静默 bug——传显示名算出张不存在的表、返回 `count=0`
且 `isError=false`，而当时的探针恰好全都用 username，于是 18 项全绿也照样漏掉。
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import traceback

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0）
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from mcp import ClientSession, StdioServerParameters   # noqa: E402
from mcp.client.stdio import stdio_client              # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RES = os.path.join(ROOT, "apps", "windows", "resources")
SHARED = os.path.join(RES, "wechat-mcp")
DISPLAY_NAME = "文件传输助手"        # filehelper 的显示名——会话参数一律用它
USERNAME = "filehelper"
BOGUS = "绝对不存在的会话xyz"
OUT = []          # 每行 {server, tool, ok, summary, args, data}


def exe(pkg):
    p = os.path.join(RES, pkg, "dist", pkg + ".exe")
    if not os.path.isfile(p):
        sys.exit(f"缺 exe：{p}\n先跑 pnpm --filter ./apps/windows build:{pkg}")
    return p


def rec(server, tool, ok, summary, args=None, data=None, prog=None):
    OUT.append({"server": server, "tool": tool, "ok": ok, "summary": summary,
                "args": args or {}, "data": data, "prog": prog or []})
    print(f"{'PASS' if ok else 'FAIL'}  {server:<15} {tool:<18} {summary}")


def text_of(result):
    for c in result.content:
        if getattr(c, "type", None) == "text":
            return c.text
    return ""


def stale(pkg):
    """exe 落后于源码没有（含共享层）——"改了 py 忘了重打包"的唯一在场判据。"""
    dist = os.path.join(RES, pkg, "dist", pkg + ".exe")
    newest = 0.0
    for d in (os.path.join(RES, pkg), SHARED):
        for f in os.listdir(d):
            if f.endswith(".py") and not f.startswith(("test_", "devcli")):
                newest = max(newest, os.path.getmtime(os.path.join(d, f)))
    return os.path.getmtime(dist) < newest


async def run(server, path, calls, env=None, label=None):
    """握手 + 列工具 + 逐个调用；任一步抛异常都记 FAIL，不中断其余服务。

    `label`（默认同 server）：同一个 exe 要用不同环境跑第二遍时，结果得记在**另一个名下**
    ——`got()` 是按 (server, tool, args 子集) 找的，同名同参会被第一遍盖住，新加的用例就查了个寂寞。
    """
    tag = label or server
    params = StdioServerParameters(command=path, args=[], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            init = await s.initialize()
            tools = await s.list_tools()
            rec(tag, "<initialize>", init.server_info.name == server,
                f"{init.server_info.name} v{init.server_info.version}")
            rec(tag, "<tools/list>", True, ",".join(t.name for t in tools.tools))
            for name, args in calls:
                prog = []
                try:
                    res = await s.call_tool(name, args, progress_callback=_mk_prog(prog))
                    body = text_of(res)
                    data = json.loads(body) if body.lstrip().startswith(("{", "[")) else body
                    rec(tag, name, not getattr(res, "isError", False),
                        summarize(name, data), args, data, prog)
                except Exception as e:                      # noqa: BLE001
                    rec(tag, name, False, f"EXC {type(e).__name__}: {e}", args, None, prog)


def summarize(name, d, args=None):
    """把各工具的关键计数挑出来——探针要的是「数对不对」，不是完整 body。"""
    if not isinstance(d, dict):
        return str(d)[:80]
    if d.get("error_code"):                            # 错误码是被正常返回的（isError=false），得看得见
        return f"error_code={d['error_code']}"
    if name == "list_files":
        return f"total={d.get('total')} count={d.get('count')} missing={d.get('missing')}"
    if name == "archive_files":
        return (f"total={d.get('total')} copied={d.get('copied')} exists={d.get('exists')} "
                f"missing={d.get('missing')} dry_run={d.get('dry_run')}")
    if name == "list_sessions":
        return f"count={d.get('count')} 首={d.get('sessions', [{}])[0].get('name', '')[:10]}"
    if name == "export_chat":
        if d.get("error_code"):
            return f"error_code={d['error_code']}"
        return f"msgs={d.get('messages')} files={d.get('files_written')} bytes={d.get('bytes')}"
    if name == "daemon_status":
        return (f"archived={d.get('archived')} talkers={d.get('talkers')} "
                f"db={d.get('db_bytes')}B oldest={d.get('oldest')}")
    if name == "list_recalls":
        return f"total={d.get('total')} count={d.get('count')}"
    if name == "archive_gap":
        return f"count={d.get('count')}"
    if name == "list_contacts":
        return f"total={d.get('total')} count={d.get('count')} kind={d.get('contacts', [{}])[0].get('kind')}"
    if name == "contact_stats":
        if d.get("error_code"):
            return f"error_code={d['error_code']}"
        return (f"count={d.get('count')} me={d.get('from_me')} "
                f"other={d.get('from_other')} silent={d.get('silent_days')}")
    if name == "interaction_rank":
        r0 = (d.get("ranking") or [{}])[0]
        return f"top1={r0.get('name', '')[:10]} {r0.get('count')}条"
    return json.dumps(d, ensure_ascii=False)[:80]


def got(*, server=None, tool=None, **args):
    """取回某一次调用的原始结果（跨调用比对用）；没有/不是对象就回空 dict。"""
    for o in OUT:
        if (server is None or o["server"] == server) and o["tool"] == tool \
                and all(o["args"].get(k) == v for k, v in args.items()):
            return o["data"] if isinstance(o["data"], dict) else {}
    return {}


def got_prog(*, server=None, tool=None, **args):
    """取回某一次调用期间收到的 `notifications/progress` 列表（`got` 的进度版）。"""
    for o in OUT:
        if (server is None or o["server"] == server) and o["tool"] == tool \
                and all(o["args"].get(k) == v for k, v in args.items()):
            return o.get("prog") or []
    return []


def _mk_prog(sink):
    """SDK 的 progress 回调签名是 `(progress, total, message)`，收进 sink 供断言。"""
    async def _cb(progress, total, message):
        sink.append({"progress": progress, "total": total, "message": message})
    return _cb


def cross_checks():
    """单看一条结果看不出来的东西：**等价性与错误码**。

    这里才是 P0 的判据——`list_files(talker=显示名)` 曾静默回 0 条，而单条结果看不出
    那是"没有"还是"没找着"。
    """
    tot = got(server="wechat-file", tool="list_files", talker=USERNAME).get("total")
    byname = got(server="wechat-file", tool="list_files", talker=DISPLAY_NAME).get("total")
    rec("wechat-file", "<显示名等价>", bool(tot) and tot == byname,
        f"{DISPLAY_NAME}={byname} vs {USERNAME}={tot}")

    miss = got(server="wechat-file", tool="list_files", talker=BOGUS)
    rec("wechat-file", "<不存在的会话>", miss.get("error_code") == "target_not_found",
        f"error_code={miss.get('error_code')}（不能是 count=0）")

    ok = got(server="wechat-export", tool="export_chat", talker=USERNAME).get("messages")
    byname = got(server="wechat-export", tool="export_chat", talker=DISPLAY_NAME).get("messages")
    rec("wechat-export", "<显示名等价>", bool(ok) and ok == byname,
        f"{DISPLAY_NAME}={byname} vs {USERNAME}={ok}")

    bad = got(server="wechat-export", tool="export_chat", talker=BOGUS)
    rec("wechat-export", "<不存在的会话>", bad.get("error_code") == "target_not_found",
        f"error_code={bad.get('error_code')}")

    bad = got(server="wechat-export", tool="export_chat", media="image")
    rec("wechat-export", "<非法 media>", bad.get("error_code") == "bad_args",
        f"error_code={bad.get('error_code')}（不能静默不出媒体）")

    # 统一错误信封：四个服务的**任何**失败都得长成同一个形状。缺一个键就是漂了——
    # 而"形状随错在哪一步而变"正是四件套最初的老毛病（A/C/D 静默返回 0 条、B 报错）。
    ENVELOPE = {"ok", "detail", "error_code", "stage", "suggestion"}
    shape_bad, stages = [], []
    for srv, tool, kw, want_stage in (("wechat-file", "list_files", {"talker": BOGUS}, "target"),
                                      ("wechat-export", "export_chat", {"talker": BOGUS}, "target"),
                                      ("wechat-recall", "list_recalls", {"talker": BOGUS}, "target"),
                                      ("wechat-crm", "contact_stats", {"talker": BOGUS}, "target")):
        d = got(server=srv, tool=tool, **kw)
        lacking = ENVELOPE - set(d)          # 别叫 miss：上面那个 miss 是 dict，重名会把后面用它的断言打挂
        if lacking:
            shape_bad.append(f"{srv} 少 {sorted(lacking)}")
        elif d["ok"] is not False or not d["detail"] or not d["suggestion"]:
            shape_bad.append(f"{srv} 字段值不对：{d}")
        else:
            stages.append(d["stage"])
    rec("<四服务>", "<错误信封一致>", not shape_bad,
        "；".join(shape_bad) if shape_bad else f"ok/detail/error_code/stage/suggestion 齐")
    rec("<四服务>", "<stage 归位>", stages == ["target"] * 4,
        f"4 个 target_not_found 的 stage={stages}（应为 target×4）")

    # 近似候选要**看得见**（"找不到"不可操作，把候选列出来才可操作）。
    # 这里只验**字段在场**（本机的 BOGUS 名没有相近会话，候选自然是空）——"候选真有内容"
    # 由 test_mcp_stdio 的合成用例覆盖，那条不依赖本机通讯录。
    n_cand = len(miss.get("candidates") or [])
    rec("wechat-file", "<候选字段在场>", "candidates" in miss,
        f"candidates 字段在场（本例 {n_cand} 个）")

    # 环境没就绪要**分类** + 带动手步骤，而不是甩一句原始异常让用户猜
    envd = got(server="wechat-file-坏环境", tool="list_files")
    rec("wechat-file-坏环境", "<env_not_ready>", envd.get("error_code") == "env_not_ready",
        f"error_code={envd.get('error_code')}（不能是 target_not_found / count=0）")
    rec("wechat-file-坏环境", "<env 带 hint 与 stage>",
        envd.get("stage") == "env" and bool(envd.get("hint")),
        f"stage={envd.get('stage')} hint={str(envd.get('hint'))[:36]}…")

    # 进度通知：批量工具必须**边干边报**——几百个文件/几千条消息要跑几十秒，界面上什么都不动，
    # 用户只会以为卡死了。progress 必须严格递增（规范要求，客户端拿它算比例）。
    aprog = got_prog(server="wechat-file", tool="archive_files", talker=DISPLAY_NAME)
    aseq = [p["progress"] for p in aprog]
    rec("wechat-file", "<归档边干边报>", len(aprog) >= 2 and aseq == sorted(set(aseq)),
        f"{len(aprog)} 条通知 progress={aseq}（须严格递增）")
    rec("wechat-file", "<进度是人话>", bool(aprog) and all(p.get("message") for p in aprog),
        f"示例：{aprog[-1].get('message') if aprog else '（一条都没有）'}")

    eprog = got_prog(server="wechat-export", tool="export_chat", talker=DISPLAY_NAME)
    rec("wechat-export", "<导出边干边报>", len(eprog) >= 2,
        f"{len(eprog)} 条：{[p.get('message') for p in eprog][:2]}")

    # 归档也要走显示名（它和 list_files 是两个工具，别只验一个）
    plan = got(server="wechat-file", tool="archive_files", talker=DISPLAY_NAME)
    rec("wechat-file", "<归档用显示名>", plan.get("total") == tot and plan.get("dry_run") is True,
        f"total={plan.get('total')} 应等于 list_files 的 {tot}")

    # C/D 同类 P0：显示名必须筛出同样的东西
    a = got(server="wechat-crm", tool="contact_stats", talker=USERNAME).get("count")
    b = got(server="wechat-crm", tool="contact_stats", talker=DISPLAY_NAME).get("count")
    rec("wechat-crm", "<显示名等价>", bool(a) and a == b, f"{DISPLAY_NAME}={b} vs {USERNAME}={a}")

    a = got(server="wechat-recall", tool="list_recalls", talker=USERNAME).get("total")
    b = got(server="wechat-recall", tool="list_recalls", talker=DISPLAY_NAME).get("total")
    rec("wechat-recall", "<显示名等价>", a is not None and a == b,
        f"{DISPLAY_NAME}={b} vs {USERNAME}={a}")

    # 通讯录默认掐到 200：`total` 必须说实话，不然调用方以为"我就 200 个好友"
    page = got(server="wechat-crm", tool="list_contacts", scope="friend")
    rec("wechat-crm", "<通讯录分页>",
        page.get("count") == 200 and (page.get("total") or 0) > 200,
        f"total={page.get('total')} count={page.get('count')}（默认掐 200）")


def issue_test_license(lic_dir):
    """给探针签一张**本机、覆盖四件套、7 天**的授权 → `(license.json 路径 | None, 说明)`。

    为什么要签：门禁之后未授权的 exe **一个工具都调不动**——不签的话整轮探针全是
    `not_licensed`，等于什么都没验。用仓库外的私钥（`~/.wechat-mcp-keys/private.pem`）签，
    只落到临时目录，**不碰用户真实的授权文件**。

    私钥不在（比如 CI）→ 返回 None，调用方**明说跳过**并计数，不假装通过。
    """
    exe_path = exe("wechat-file-mcp")
    try:
        mid = subprocess.run([exe_path, "--machine-id"], capture_output=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None, "--machine-id 超时"
    fp = mid.stdout.decode("utf-8", "replace").strip()
    if not fp.startswith("{"):
        return None, f"--machine-id 没给出 JSON：{fp[:80]!r}"
    key = os.path.join(os.path.expanduser("~"), ".wechat-mcp-keys", "private.pem")
    if not os.path.isfile(key):
        return None, f"本机没有签发私钥（{key}）——授权相关的断言本轮跳过"
    out = os.path.join(lic_dir, "license.json")
    signer = os.path.join(SHARED, "tools", "sign-license.py")
    try:
        r = subprocess.run(["uv", "run", "--no-project", "--with", "pycryptodome", "python",
                            signer, "--fp", fp, "--scope", "wechat-toolkits", "--days", "7",
                            "--out", out], capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        return None, "签发超时"
    if r.returncode != 0 or not os.path.isfile(out):
        return None, (r.stderr or b"").decode("utf-8", "replace").strip()[:140]
    return out, fp


async def main():
    exp = tempfile.mkdtemp(prefix="toolkit_export_")
    arch = tempfile.mkdtemp(prefix="toolkit_arch_")
    rdb = tempfile.mkdtemp(prefix="toolkit_recall_")
    lic_dir = tempfile.mkdtemp(prefix="toolkit_lic_")
    empty_lic = tempfile.mkdtemp(prefix="toolkit_nolic_")
    renv = dict(os.environ, LUMII_WECHAT_RECALL_DB=os.path.join(rdb, "archive.db"))

    # 授权要先签：门禁之后，未授权的 exe **一个工具都调不动**，不签整轮全是 not_licensed
    lic, fp_or_why = issue_test_license(lic_dir)
    rec("<授权>", "<签出测试授权>", bool(lic), fp_or_why[:110])
    lenv = dict(os.environ, LUMII_WECHAT_LICENSE_DIR=lic_dir)
    nolic_env = dict(os.environ, LUMII_WECHAT_LICENSE_DIR=empty_lic)

    for pkg in ("wechat-file-mcp", "wechat-export-mcp", "wechat-recall-mcp", "wechat-crm-mcp"):
        old = stale(pkg)
        rec(pkg[:-4], "<exe 未落后于源码>", not old, "exe 比源码旧——先重打包" if old else "ok")
        # 安装/授权开关必须被 `serve()` 拦下并**立即退出**。没拦的话它会被当成"没有参数"
        # 而进 MCP 循环、挂在那儿等 stdin —— 这里就会超时。用**只读**的开关验，
        # **不跑 --install**（那会真改用户的客户端配置，探针不该有这种副作用）。
        try:
            r = subprocess.run([exe(pkg), "--install-status"], capture_output=True, timeout=120)
            rec(pkg[:-4], "<--install-status 可用>", r.returncode == 0, f"exit={r.returncode}")
        except subprocess.TimeoutExpired:
            rec(pkg[:-4], "<--install-status 可用>", False, "超时——开关没被拦下，进了 MCP 循环")
        # `--license-status`：已授权退出 0、未授权退出 1（脚本里好判）
        try:
            r = subprocess.run([exe(pkg), "--license-status"], capture_output=True, timeout=180,
                               env=lenv)
            rec(pkg[:-4], "<--license-status 已授权>", r.returncode == 0, f"exit={r.returncode}")
        except subprocess.TimeoutExpired:
            rec(pkg[:-4], "<--license-status 已授权>", False, "超时")

    # **未授权必须被拦**。用空授权目录跑一次——验的是真 exe 的真门禁，不是本进程里的假件。
    await run("wechat-file", exe("wechat-file-mcp"),
              [("list_files", {})], env=nolic_env, label="wechat-file-未授权")
    d = got(server="wechat-file-未授权", tool="list_files")
    rec("wechat-file-未授权", "<工具被拒>", d.get("error_code") == "not_licensed",
        f"error_code={d.get('error_code')}（不能给出数据，也不能是别的错）")
    rec("wechat-file-未授权", "<拒绝里带了怎么办>",
        bool(d.get("hint")) and "license" in str(d.get("license_path", "")),
        f"hint={str(d.get('hint'))[:60]}…")

    # recall 断言建立在前置打底上（没打底 archive_gap 也报 0，会假绿）
    renv_lic = dict(renv, LUMII_WECHAT_LICENSE_DIR=lic_dir)
    subprocess.run([exe("wechat-recall-mcp"), "--once"], env=renv_lic,
                   capture_output=True, timeout=300)

    await run("wechat-file", exe("wechat-file-mcp"),
              [("list_files", {"talker": USERNAME}),
               ("list_files", {"talker": DISPLAY_NAME}),
               ("list_files", {"talker": BOGUS}),
               ("archive_files", {"out_dir": arch, "talker": DISPLAY_NAME, "dry_run": True})],
              env=lenv)
    await run("wechat-export", exe("wechat-export-mcp"),
              [("list_sessions", {}),
               ("export_chat", {"talker": USERNAME, "out_dir": exp, "format": "md"}),
               ("export_chat", {"talker": DISPLAY_NAME, "out_dir": exp, "format": "md"}),
               ("export_chat", {"talker": BOGUS, "out_dir": exp, "format": "md"}),
               ("export_chat", {"talker": USERNAME, "out_dir": exp, "media": "image"})],
              env=lenv)
    await run("wechat-recall", exe("wechat-recall-mcp"),
              [("daemon_status", {}), ("list_recalls", {}), ("archive_gap", {}),
               ("list_recalls", {"talker": USERNAME}),
               ("list_recalls", {"talker": DISPLAY_NAME}),
               ("list_recalls", {"talker": BOGUS})], env=renv_lic)
    await run("wechat-crm", exe("wechat-crm-mcp"),
              [("list_contacts", {"scope": "group"}),
               ("list_contacts", {"scope": "friend"}),
               ("contact_stats", {"talker": USERNAME}),
               ("contact_stats", {"talker": DISPLAY_NAME}),
               ("contact_stats", {"talker": BOGUS}),
               ("interaction_rank", {"top": 5})], env=lenv)

    # 环境没就绪：指一个**不存在**的账号 → 读取层抛 EnvError → 必须翻成 `env_not_ready` + hint。
    # 本机微信正常运行着，这是唯一能**真造出**环境失败又不动用户环境的姿势
    # （显式清掉 LUMII_WECHAT_DB，否则它会短路掉账号检查，用例就白跑了）。
    badenv = {k: v for k, v in os.environ.items() if k != "LUMII_WECHAT_DB"}
    badenv["LUMII_WECHAT_ACCOUNT"] = "不存在的账号_xyz"
    await run("wechat-file", exe("wechat-file-mcp"), [("list_files", {})],
              env=badenv, label="wechat-file-坏环境")

    cross_checks()

    nfail = sum(1 for o in OUT if not o["ok"])
    print(f"\nRESULT={'PASS' if nfail == 0 else 'FAIL'} ({len(OUT) - nfail}/{len(OUT)} 项通过)")
    return nfail


if __name__ == "__main__":
    try:
        sys.exit(1 if asyncio.run(main()) else 0)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
