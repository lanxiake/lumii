# -*- coding: utf-8 -*-
"""五个微信 MCP exe 的单工具回归测试器：实时打印 stderr / 进度通知，结束后打印 metrics 增量与新截图。

在 mcp_one.py 基础上扩展：
- `--exe` 支持别名 pro / lite / export / crm / recall（取 dist 下带版本号的那个）；
- `--env K=V` 注入环境变量（画像隔离用 LUMII_WECHAT_DISTILL）；
- `--list` 只做 initialize + tools/list，记录 serverInfo、工具清单与 stderr 里的 expiry 行；
- 参数文件可以是对象（单次调用），也可以是 `[{"tool","args","label"}]` 列表（同进程顺序调用，测冷/热耗时）；
- 每次调用有超时（`--timeout`，默认 240s），超时或结束时只结束本测试器自己拉起的进程树；
- 屏幕输出做脱敏（长字符串截断、列表只展示前 2 项），完整原文只写到 %TEMP% 下的原始日志，不进仓库；
- 每次调用追加一行到 `results.jsonl`，供汇总报告使用。

运行：python -u regress_one.py --exe crm [--label 说明] [--env K=V] <tool> @args.json
      python -u regress_one.py --exe pro --list
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
RES = os.path.join(ROOT, "apps", "windows", "resources")
WORK = os.path.join(tempfile.gettempdir(), "lumii-wechat-mcp")
METRICS = os.path.join(WORK, "metrics.jsonl")
OUT = os.path.join(tempfile.gettempdir(), "lumii-regress-20261015")
RAW_DIR = os.path.join(OUT, "raw")
SHOT_DIR = os.path.join(OUT, "shots")
RESULTS = os.path.join(HERE, "results.jsonl")
ALIASES = {
    "pro": ("wechat-mcp", os.path.join("wechat-mcp", "dist", "pro", "wechat-mcp-*.exe")),
    "lite": ("wechat-mcp-lite", os.path.join("wechat-mcp", "dist", "lite", "wechat-mcp-lite-*.exe")),
    "export": ("wechat-export-mcp", os.path.join("wechat-export-mcp", "dist", "wechat-export-mcp-*.exe")),
    "crm": ("wechat-crm-mcp", os.path.join("wechat-crm-mcp", "dist", "wechat-crm-mcp-*.exe")),
    "recall": ("wechat-recall-mcp", os.path.join("wechat-recall-mcp", "dist", "wechat-recall-mcp-*.exe")),
}
T0 = time.time()
STDERR_LINES = []


def stamp(tag, text):
    """带相对时间戳打印一行（实时刷出），同时记入原始日志缓冲。"""
    line = f"[{time.time() - T0:6.1f}s] {tag:8} {text}"
    print(line, flush=True)
    STDERR_LINES.append(line)


def pump_stderr(pipe):
    """后台线程：server 的 stderr 日志逐行实时打印。"""
    for raw in iter(pipe.readline, b""):
        stamp("stderr", raw.decode("utf-8", "replace").rstrip())


def redact(obj, depth=0):
    """脱敏摘要：字符串截到 24 字、列表只留前 2 项并标注总数、嵌套过深直接省略。"""
    if depth > 4:
        return "…"
    if isinstance(obj, str):
        return obj if len(obj) <= 24 else f"{obj[:24]}…({len(obj)}字)"
    if isinstance(obj, list):
        head = [redact(x, depth + 1) for x in obj[:2]]
        return head + ([f"…共{len(obj)}项"] if len(obj) > 2 else [])
    if isinstance(obj, dict):
        return {k: redact(v, depth + 1) for k, v in obj.items()}
    return obj


def summarize(data, content):
    """把一次结果压成一行：失败码 / 关键计数 / 顶层键（与 mcp_e2e_all.summarize 口径一致）。"""
    kinds = [c.get("type") for c in content]
    if "image" in kinds:
        img = next(c for c in content if c.get("type") == "image")
        return f"image {img.get('mimeType')} {len(img.get('data', '')) * 3 // 4}B; " + \
            summarize(data, [c for c in content if c.get("type") != "image"])
    if isinstance(data, list):
        return f"list[{len(data)}]"
    if not isinstance(data, dict):
        return str(data)[:80]
    if data.get("ok") is False:
        return f"FAIL {data.get('error_code')}: {str(data.get('detail'))[:80]}"
    if "error" in data:
        return f"ERROR: {str(data['error'])[:80]}"
    parts = []
    for k in ("total", "count", "messages", "sessions", "contacts", "labels", "archived", "alive",
              "files_written", "csv_path", "pdf_error", "truncated", "planned", "copied", "bytes",
              "status", "dry_run", "sent", "elapsed_ms"):
        if k in data:
            v = data[k]
            parts.append(f"{k}={v if not isinstance(v, (list, dict)) else len(v)}")
    return (" ".join(parts) + f"  [{','.join(list(data)[:10])}]").strip()


def resolve_exe(name):
    """别名 → dist 下带版本号的 exe 绝对路径；也接受直接给路径。"""
    if name in ALIASES:
        hits = [h for h in glob.glob(os.path.join(RES, ALIASES[name][1])) if any(ch.isdigit() for ch in
                                                                                os.path.basename(h))]
        if not hits:
            raise SystemExit(f"找不到 {name} 的 exe")
        return name, sorted(hits)[-1]
    return os.path.basename(name), os.path.abspath(name)


def kill_tree(pid):
    """只结束本测试器拉起的进程树（taskkill /T），不碰其他 wechat-mcp 实例。"""
    subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)], capture_output=True)


def main():
    """解析参数 → 拉起 exe → initialize/tools/list → 顺序 tools/call → 打印结果与日志增量 → 落结果行。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(SHOT_DIR, exist_ok=True)
    args = sys.argv[1:]
    opts = {"exe": "pro", "label": "", "timeout": "240"}
    env_extra = {}
    list_only = False
    while args and args[0].startswith("--"):
        k = args.pop(0)[2:]
        if k == "list":
            list_only = True
        elif k == "env":
            kv = args.pop(0)
            env_extra[kv.split("=", 1)[0]] = kv.split("=", 1)[1]
        else:
            opts[k] = args.pop(0)
    product, exe = resolve_exe(opts["exe"])
    calls = []
    if not list_only:
        tool = args[0]
        raw = args[1] if len(args) > 1 else "{}"
        if raw.startswith("@"):                # PowerShell 传中文参数给原生程序会截坏，走文件
            raw = open(raw[1:], encoding="utf-8-sig").read()
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            calls = [(c.get("tool", tool), c.get("args", {}), c.get("label", opts["label"])) for c in parsed]
        else:
            calls = [(tool, parsed, opts["label"])]
    m_size = os.path.getsize(METRICS) if os.path.isfile(METRICS) else 0

    stamp("start", f"{os.path.basename(exe)}  env={env_extra}  calls={[c[0] for c in calls]}")
    p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=dict(os.environ, PYTHONIOENCODING="utf-8", **env_extra),
                         cwd=OUT)
    stamp("pid", str(p.pid))
    threading.Thread(target=pump_stderr, args=(p.stderr,), daemon=True).start()
    raw_log = []
    mid = [0]

    def send(obj):
        p.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        p.stdin.flush()

    def rpc(method, params, timeout):
        """发请求并等同 id 回包；进度通知实时打印；超时则抛 TimeoutError。"""
        mid[0] += 1
        send({"jsonrpc": "2.0", "id": mid[0], "method": method, "params": params})
        box = {}

        def reader():
            while True:
                line = p.stdout.readline()
                if not line:
                    box["err"] = "exe 提前退出"
                    return
                msg = json.loads(line)
                if msg.get("id") == mid[0]:
                    box["msg"] = msg
                    return
                if msg.get("method") == "notifications/progress":
                    pr = msg.get("params", {})
                    stamp("progress", f"{pr.get('progress')}/{pr.get('total', '')} {pr.get('message', '')}")
                else:
                    stamp("notify", json.dumps(msg, ensure_ascii=False)[:200])

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            raise TimeoutError(f"{method} 超过 {timeout}s 无回包")
        if "err" in box:
            raise RuntimeError(box["err"])
        return box["msg"]

    rows = []
    try:
        init = rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                  "clientInfo": {"name": "regress_one", "version": "1"}}, 60)
        info = init["result"]["serverInfo"]
        stamp("init", json.dumps(info, ensure_ascii=False))
        send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        tools = rpc("tools/list", {}, 60)["result"]["tools"]
        names = [t["name"] for t in tools]
        stamp("tools", f"{len(names)}: {', '.join(names)}")
        if list_only:
            time.sleep(1.0)
            expiry = [ln for ln in STDERR_LINES if "expir" in ln.lower()]
            with open(os.path.join(OUT, f"tools_{product}.json"), "w", encoding="utf-8") as f:
                json.dump({"exe": exe, "serverInfo": info, "tools": names, "expiry_lines": expiry,
                           "schemas": tools}, f, ensure_ascii=False, indent=1)
            rows.append({"product": product, "tool": "(initialize+tools/list)", "label": "握手", "ok": True,
                         "ms": int((time.time() - T0) * 1000),
                         "summary": f"{info.get('name')} {info.get('version')} edition={info.get('edition')} "
                                    f"tools={len(names)} expiry={expiry[:1]}"})
        for tool, targs, label in calls:
            stamp("call", f"{tool} [{label}] {json.dumps(redact(targs), ensure_ascii=False)}")
            t1 = time.time()
            try:
                msg = rpc("tools/call", {"name": tool, "arguments": targs,
                                         "_meta": {"progressToken": f"tk{mid[0] + 1}"}}, int(opts["timeout"]))
            except TimeoutError as e:
                stamp("timeout", str(e))
                rows.append({"product": product, "tool": tool, "label": label, "ok": False,
                             "ms": int((time.time() - t1) * 1000), "summary": f"TIMEOUT {e}", "is_error": True})
                break
            ms = int((time.time() - t1) * 1000)
            res = msg.get("result") or {}
            content = res.get("content") or []
            data = None
            for c in content:
                if c.get("type") == "text":
                    try:
                        data = json.loads(c["text"])
                    except ValueError:
                        data = {"_text": c["text"]}
                    break
            is_err = bool(res.get("isError")) or "error" in msg
            biz_fail = isinstance(data, dict) and (data.get("ok") is False or "error" in data)
            summ = summarize(data, content)
            stamp("done", f"{ms} ms  isError={is_err}  {summ}")
            print(json.dumps(redact(data), ensure_ascii=False, indent=1)[:3000], flush=True)
            raw_log.append({"tool": tool, "label": label, "args": targs, "ms": ms, "msg": msg})
            rows.append({"product": product, "tool": tool, "label": label, "ok": not (is_err or biz_fail),
                         "ms": ms, "summary": summ, "is_error": is_err,
                         "error_code": data.get("error_code") if isinstance(data, dict) else None})
    finally:
        try:
            p.stdin.close()
            p.wait(timeout=15)
        except Exception:                                           # noqa: BLE001
            pass
        if p.poll() is None:
            stamp("kill", f"进程 {p.pid} 未自行退出，结束其进程树")
        kill_tree(p.pid)
        time.sleep(0.5)

    metrics_new = []
    if os.path.isfile(METRICS) and os.path.getsize(METRICS) > m_size:
        with open(METRICS, "rb") as f:
            f.seek(m_size)
            metrics_new = f.read().decode("utf-8", "replace").splitlines()
        print("--- metrics.jsonl 新增 ---")
        for line in metrics_new:
            print("  ", line[:300])
    shots = []
    for s in sorted((s for s in glob.glob(os.path.join(WORK, "*.png")) if os.path.getmtime(s) >= T0),
                    key=os.path.getmtime):
        dst = os.path.join(SHOT_DIR, f"{time.strftime('%H%M%S')}_{os.path.basename(s)}")
        try:
            import shutil
            shutil.copy(s, dst)
        except OSError:
            dst = s
        shots.append(dst)
        print("--- 新截图:", s, "→", dst)

    tag = time.strftime("%H%M%S")
    first = calls[0][0] if calls else "list"
    raw_path = os.path.join(RAW_DIR, f"{tag}_{product}_{first}.json")
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump({"exe": exe, "env": env_extra, "stderr": STDERR_LINES, "calls": raw_log,
                   "metrics": metrics_new, "shots": shots}, f, ensure_ascii=False, indent=1)
    with open(RESULTS, "a", encoding="utf-8") as f:
        for r in rows:
            r.update({"at": time.strftime("%Y-%m-%d %H:%M:%S"), "raw": os.path.basename(raw_path),
                      "metrics": [m[:200] for m in metrics_new][-6:], "shots": [os.path.basename(s) for s in shots]})
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("--- 原始日志:", raw_path)


if __name__ == "__main__":
    main()
