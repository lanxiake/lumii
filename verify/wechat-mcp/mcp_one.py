# -*- coding: utf-8 -*-
"""单工具实测 + 实时日志：拉起 pro 版 exe，只调一个工具，边跑边打印进度通知与 stderr 日志。

运行：python verify/wechat-mcp/mcp_one.py <tool> '<json args>' [--exe 路径]
结束后再打印本次新增的 metrics.jsonl 记录与新截图，便于对照分析。
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = os.path.join(tempfile.gettempdir(), "lumii-wechat-mcp")
METRICS = os.path.join(WORK, "metrics.jsonl")
T0 = time.time()


def stamp(tag, text):
    """带相对时间戳打印一行（实时刷出）。"""
    print(f"[{time.time() - T0:6.1f}s] {tag:8} {text}", flush=True)


def pump_stderr(pipe):
    """后台线程：server 的 stderr 日志逐行实时打印。"""
    for raw in iter(pipe.readline, b""):
        stamp("stderr", raw.decode("utf-8", "replace").rstrip())


def main():
    """解析参数 → 拉起 exe → initialize → tools/call（带 progressToken）→ 打印结果与日志增量。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = sys.argv[1:]
    exe = None
    if "--exe" in args:
        i = args.index("--exe")
        exe = args[i + 1]
        del args[i:i + 2]
    exe = exe or sorted(glob.glob(os.path.join(
        ROOT, "apps", "windows", "resources", "wechat-mcp", "dist", "pro", "wechat-mcp-*.exe")))[-1]
    tool = args[0]
    raw = args[1] if len(args) > 1 else "{}"
    if raw.startswith("@"):                    # PowerShell 传中文参数给原生程序会截坏，走文件
        raw = open(raw[1:], encoding="utf-8-sig").read()
    targs = json.loads(raw)
    m_size = os.path.getsize(METRICS) if os.path.isfile(METRICS) else 0

    stamp("start", f"{os.path.basename(exe)}  {tool} {json.dumps(targs, ensure_ascii=False)}")
    p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=dict(os.environ, PYTHONIOENCODING="utf-8"))
    threading.Thread(target=pump_stderr, args=(p.stderr,), daemon=True).start()

    def send(obj):
        p.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        p.stdin.flush()

    def wait_id(mid):
        while True:
            line = p.stdout.readline()
            if not line:
                raise RuntimeError("exe 提前退出")
            msg = json.loads(line)
            if msg.get("id") == mid:
                return msg
            if msg.get("method") == "notifications/progress":
                pr = msg.get("params", {})
                stamp("progress", f"{pr.get('progress')}/{pr.get('total', '')} {pr.get('message', '')}")
            else:
                stamp("notify", json.dumps(msg, ensure_ascii=False)[:200])

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                         "clientInfo": {"name": "mcp_one", "version": "1"}}})
        info = wait_id(1)["result"]["serverInfo"]
        stamp("init", json.dumps(info, ensure_ascii=False))
        send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        t1 = time.time()
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
              "params": {"name": tool, "arguments": targs, "_meta": {"progressToken": "tk1"}}})
        res = wait_id(2).get("result") or {}
        stamp("done", f"{(time.time() - t1) * 1000:.0f} ms  isError={res.get('isError', False)}")
        for c in res.get("content") or []:
            if c.get("type") == "text":
                try:
                    print(json.dumps(json.loads(c["text"]), ensure_ascii=False, indent=1)[:4000])
                except ValueError:
                    print(c["text"][:4000])
            else:
                print(f"<{c.get('type')} {c.get('mimeType', '')} {len(c.get('data', ''))} chars base64>")
    finally:
        try:
            p.stdin.close()
            p.wait(timeout=10)
        except Exception:                                           # noqa: BLE001
            p.kill()
        time.sleep(0.3)

    if os.path.isfile(METRICS) and os.path.getsize(METRICS) > m_size:
        with open(METRICS, "rb") as f:
            f.seek(m_size)
            print("--- metrics.jsonl 新增 ---")
            for line in f.read().decode("utf-8", "replace").splitlines():
                print("  ", line[:300])
    new_shots = sorted((s for s in glob.glob(os.path.join(WORK, "*.png")) if os.path.getmtime(s) >= T0),
                       key=os.path.getmtime)
    for s in new_shots:
        print("--- 新截图:", s)


if __name__ == "__main__":
    main()
