"""只读实测：**合并后**的 wechat-export-mcp（记录面 + 文件面）——驱动**冻结的 exe** 走标准 MCP 协议。

为什么起 exe 而不是 import 源码：合并后要证明的是**发出去的那个产物**里有 5 个工具、
文件面的归档真的落在与记录面同一棵树里。源码能跑不代表打进包了。

跑法（本机没有 PATH 里的 python，用托管解释器）：
    PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe verify/wechat-mcp/probe_export_analysis.py

产出：临时目录里的真文件 + 屏幕上的数字（写进 brochure / README 的就是这些数）。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

EXE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "apps", "windows",
                   "resources", "wechat-export-mcp", "dist", "wechat-export-mcp.exe")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def call(exe, tool, args, rid=1):
    """起一次 exe，initialize + tools/call，返回工具结果（解析成 dict）。"""
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": tool, "arguments": args}},
    ]
    p = subprocess.run([exe], input="\n".join(json.dumps(r) for r in reqs) + "\n",
                       capture_output=True, encoding="utf-8", timeout=600)
    out = {}
    for line in (p.stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        m = json.loads(line)
        if m.get("id") == 2:
            out = m
    content = (out.get("result") or {}).get("content") or [{}]
    return json.loads(content[0].get("text") or "{}")


def size(p):
    return os.path.getsize(p) if os.path.isfile(p) else 0


def tree(out):
    for dp, _ds, fs in os.walk(out):
        depth = os.path.relpath(dp, out).count(os.sep)
        rel = os.path.relpath(dp, out)
        print("   " + "  " * depth + ("." if rel == "." else os.path.basename(dp)) + "/"
              + (f"  [{len(fs)} 个文件]" if fs else ""))


def main():
    exe = os.path.abspath(EXE)
    p = subprocess.run([exe], input="\n".join(json.dumps(r) for r in ([
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}])) + "\n",
        capture_output=True, encoding="utf-8", timeout=120)
    tl = [json.loads(x) for x in p.stdout.splitlines() if x.strip().startswith("{")]
    names = [t["name"] for t in [m for m in tl if m.get("id") == 2][0]["result"]["tools"]]
    print(f"exe={os.path.basename(exe)}（{size(exe):,} B）｜ 工具 {names}")

    out = tempfile.mkdtemp(prefix="probe_export_")
    print(f"输出目录：{out}")
    t0 = time.time()
    ss = call(exe, "list_sessions", {"query": "文件"})
    print(f"① list_sessions(query=文件)：{ss['count']} 个 → {[s['name'] for s in ss['sessions']]}")

    # ② 记录面：json 带 stats + 独立的 stats.json
    E = call(exe, "export_chat", {"talker": "文件传输助手", "out_dir": out, "format": "json"})
    sdir = E["dir"]
    jp = os.path.join(sdir, "chat.json")
    st = E["stats"]
    print(f"② export_chat(json)：{E['messages']} 条 → chat.json {size(jp):,} B ｜ "
          f"stats.json {size(os.path.join(sdir, 'stats.json')):,} B")
    print(f"   stats：我 {st['from_me']} / 对方 {st['from_other']} ｜ 类型 "
          f"{[(t['type'], t['count']) for t in st['types']]} ｜ 跨 {st['span_days']} 天"
          f"（活跃 {st['active_days']}）｜ {st['first']} ~ {st['last']}")

    # ③ 文件面：列清单
    L = call(exe, "list_files", {"talker": "文件传输助手", "limit": 0})
    print(f"③ list_files：total {L['total']} ｜ ok {L['ok']} / missing {L['missing']} / "
          f"size_mismatch {L['size_mismatch']}")

    # ④ 文件面：归档 dry_run → 真拷（**落点必须与记录面同一棵树**）
    A = call(exe, "archive_files", {"out_dir": out, "talker": "文件传输助手", "dry_run": True})
    print(f"④ archive_files(dry_run=true)：total {A['total']} ｜ 将拷贝 {A['copied']} / "
          f"去重 {A['dedup']} / 已存在 {A['exists']} / 过期 {A['missing']} ｜ 此刻落盘 "
          f"{len([f for f in A['files'] if size(f.get('dest') or '')])} 个")
    B = call(exe, "archive_files", {"out_dir": out, "talker": "文件传输助手", "dry_run": False})
    print(f"   archive_files(dry_run=false)：拷了 {B['copied']} 个 → {B['out_dir']}")
    want = os.path.join(sdir, "files")
    landed = [f for f in B["files"] if f["status"] != "missing"]
    same = all(os.path.dirname(f["dest"]) == want for f in landed)
    print(f"   与导出同一棵树？{same}（{len(landed)} 个都落在 {want}）")

    # ⑤ 文件面：占用
    D = call(exe, "disk_usage", {})
    mm = {t["path"]: t["bytes"] for t in D["msg_trees"]}
    print(f"⑤ disk_usage：账号 {D['total_bytes'] / 1048576:.0f} MB / {D['total_files']} 个文件 ｜ "
          f"msg/file {D['file_bytes'] / 1048576:.0f} MB（独占 "
          f"{D['file_own_bytes'] / 1048576:.0f} + 共享 {D['shared_bytes'] / 1048576:.0f} + 无主 "
          f"{D['file_unattributed']['bytes'] / 1048576:.0f}）｜ video {mm.get('video', 0) / 1048576:.0f} MB"
          f" ｜ {D['session_count']} 个会话有文件")
    print(f"   Σ 对账：独占+共享+无主 == file 总量？"
          f"{D['file_own_bytes'] + D['shared_bytes'] + D['file_unattributed']['bytes'] == D['file_bytes']}")

    # ⑥ 只导命中 + 全库搜
    K = call(exe, "export_chat", {"talker": "文件传输助手", "out_dir": out, "keyword": "图", "limit": 3})
    print(f"⑥ export_chat(keyword=图, limit=3)：全量 {K['scanned']} → 导 {K['messages']} 条 ｜ "
          f"truncated={K['truncated']}")
    kw = sys.argv[1] if len(sys.argv) > 1 else "图片"
    t1 = time.time()
    # 不给 talker + 给 keyword = 全库搜（分发到 export_many）
    M = call(exe, "export_chat", {"out_dir": out, "keyword": kw, "max_sessions": 2, "limit": 50})
    print(f"   全库搜「{kw}」：扫 {M['sessions_scanned']} → 命中 {M['sessions_matched']} → "
          f"导 {M['sessions_exported']}（跳过 {M['sessions_skipped']}）｜ {time.time() - t1:.1f}s ｜ "
          f"index={M['index']}")

    print("⑦ 目录结构（记录面与文件面共用 `files/`）：")
    tree(out)
    print(f"总耗时 {time.time() - t0:.1f}s")
    shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    main()
