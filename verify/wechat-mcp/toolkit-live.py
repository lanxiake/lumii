# -*- coding: utf-8 -*-
"""活体探针：四件套 MCP（file/export/recall/crm）的**已打包 exe** 能不能被真客户端驱动。

和各自目录里的 `test_*.py` 的分工：那边查逻辑（纯函数 + 源码直连），这边查**接线**——
exe 有没有落后于源码、`initialize` 握手协议版对不对、工具参数校验会不会拒掉正常调用。
改完 py 重新打包后跑一次，全绿才算这次部署有效。

客户端用的是**官方 MCP SDK**（`mcp.client.stdio`），不是手搓 JSON-RPC——即真实宿主
（Claude Code 等）走的那条路。手搓的那版只验帧格式，验不出 SDK 的字段/协议兼容性。

跑法（需要 uv；PATH 里的 python 是 Store 占位）：
    uv run --no-project --python 3.11 --with mcp python verify/wechat-mcp/toolkit-live.py

副作用：只读微信库 + 写临时目录（导出/归档落盘到 tempfile，跑完不清理，方便翻产物）。
recall 会先 `--once` 打底一次，归档库走**临时目录**（`LUMII_WECHAT_RECALL_DB`），
不碰你自己的 `~/.lumii/wechat-recall/archive.db`。
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
OUT = []          # 每行 {server, tool, ok, summary}


def exe(pkg):
    p = os.path.join(RES, pkg, "dist", pkg + ".exe")
    if not os.path.isfile(p):
        sys.exit(f"缺 exe：{p}\n先跑 pnpm --filter ./apps/windows build:{pkg}")
    return p


def rec(server, tool, ok, summary):
    OUT.append({"server": server, "tool": tool, "ok": ok, "summary": summary})
    print(f"{'PASS' if ok else 'FAIL'}  {server:<15} {tool:<16} {summary}")


def text_of(result):
    for c in result.content:
        if getattr(c, "type", None) == "text":
            return c.text
    return ""


async def run(server, path, calls, env=None):
    """握手 + 列工具 + 逐个调用；任一步抛异常都记 FAIL，不中断其余服务。"""
    params = StdioServerParameters(command=path, args=[], env=env)
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            init = await s.initialize()
            tools = await s.list_tools()
            rec(server, "<initialize>", init.server_info.name == server,
                f"{init.server_info.name} v{init.server_info.version}")
            rec(server, "<tools/list>", True, ",".join(t.name for t in tools.tools))
            for name, args in calls:
                try:
                    res = await s.call_tool(name, args)
                    body = text_of(res)
                    data = json.loads(body) if body.strip().startswith("{") else body
                    rec(server, name, not getattr(res, "isError", False), summarize(name, data))
                except Exception as e:                      # noqa: BLE001
                    rec(server, name, False, f"EXC {type(e).__name__}: {e}")


def summarize(name, d):
    """把各工具的关键计数挑出来——探针要的是「数对不对」，不是完整 body。"""
    if not isinstance(d, dict):
        return str(d)[:80]
    if name == "list_files":
        return f"count={d.get('count')} missing={d.get('missing')} ok={d.get('ok')}"
    if name == "archive_files":
        return (f"total={d.get('total')} copied={d.get('copied')} "
                f"missing={d.get('missing')} dry_run={d.get('dry_run')}")
    if name == "list_sessions":
        return f"count={d.get('count')} 首={d.get('sessions', [{}])[0].get('name', '')[:10]}"
    if name == "export_chat":
        return f"msgs={d.get('messages')} files={d.get('files_written')} bytes={d.get('bytes')}"
    if name == "daemon_status":
        return (f"archived={d.get('archived')} talkers={d.get('talkers')} "
                f"backfilled={d.get('backfilled')} alive={d.get('alive')}")
    if name in ("list_recalls", "archive_gap"):
        return f"count={d.get('count')}"
    if name == "list_contacts":
        return f"count={d.get('count')} kind={d.get('contacts', [{}])[0].get('kind')}"
    if name == "contact_stats":
        return (f"count={d.get('count')} me={d.get('from_me')} "
                f"other={d.get('from_other')} silent={d.get('silent_days')}")
    if name == "interaction_rank":
        r0 = (d.get("ranking") or [{}])[0]
        return f"top1={r0.get('name', '')[:10]} {r0.get('count')}条"
    return json.dumps(d, ensure_ascii=False)[:80]


async def main():
    exp = tempfile.mkdtemp(prefix="toolkit_export_")
    arch = tempfile.mkdtemp(prefix="toolkit_arch_")
    rdb = tempfile.mkdtemp(prefix="toolkit_recall_")
    renv = dict(os.environ, LUMII_WECHAT_RECALL_DB=os.path.join(rdb, "archive.db"))

    # recall 断言建立在前置打底上（没打底 archive_gap 也报 0，会假绿）
    subprocess.run([exe("wechat-recall-mcp"), "--once"], env=renv,
                   capture_output=True, timeout=300)

    await run("wechat-file", exe("wechat-file-mcp"),
              [("list_files", {"only_missing": True}),
               ("archive_files", {"out_dir": arch, "types": ["pdf"], "dry_run": True})])
    await run("wechat-export", exe("wechat-export-mcp"),
              [("list_sessions", {}),
               ("export_chat", {"talker": "文件传输助手", "out_dir": exp, "format": "md"})])
    await run("wechat-recall", exe("wechat-recall-mcp"),
              [("daemon_status", {}), ("list_recalls", {}), ("archive_gap", {})], env=renv)
    await run("wechat-crm", exe("wechat-crm-mcp"),
              [("list_contacts", {"scope": "group"}),
               ("contact_stats", {"talker": "文件传输助手"}),
               ("interaction_rank", {"top": 5})])

    nfail = sum(1 for o in OUT if not o["ok"])
    print(f"\nRESULT={'PASS' if nfail == 0 else 'FAIL'} ({len(OUT) - nfail}/{len(OUT)} 项通过)")
    return nfail


if __name__ == "__main__":
    try:
        sys.exit(1 if asyncio.run(main()) else 0)
    except Exception:
        traceback.print_exc()
        sys.exit(1)
