# -*- coding: utf-8 -*-
"""Lumii「本机微信」插件的 Python 侧车：**JSONL over stdin/stdout**，不是 MCP。

为什么要这层壳（而不是直接把 `app.py` 当 MCP 服务启动）：App 内部调用不需要 MCP 的
JSON-RPC 外壳——工具是原生注册进 Agent 的（`bridge.installWechatTools()`），协议层只负责
把「调用 + 参数」送进来、把「内容块」送出去。少一层协议就少一处能漂移的形态。

**与 `app.py` 的分工**：`app.py` 里那 32 个工具、`DISPATCH`、`_fail` 错误信封、`version_warning`
门全部原样复用——业务逻辑一行不抄。本文件只做三件事：读写行、把 `progress` 接成帧、
把 `_mcp_content` 交出去。

**协议**（每行一个 UTF-8 JSON）：

    请求  {"id": 1, "method": "initialize"}
          {"id": 2, "method": "call", "tool": "list_sessions", "args": {...}, "progressToken": "..."}
          {"id": 3, "method": "ping"}
          {"id": 4, "method": "shutdown"}
    应答  {"id": 1, "ok": true, "data": {"tools": [...], "instructions": "...", "version": "..."}}
          {"id": 2, "ok": true, "content": [{"type": "text", "text": "..."}, ...]}
          {"id": 2, "ok": false, "isError": true, "content": [{"type": "text", "text": "ERROR: ..."}]}
    进度  {"id": 2, "type": "progress", "message": "已定位输入框", "progress": 3, "total": 5}

**`content` 就是 pi-agent-core 的 `AgentToolResult.content` 形状**（`TextContent | ImageContent`），
TS 侧原样透传即可——`read_image` 的 base64 位图因此不必在 TS 里再拼一遍。

**stdout 纪律**：写协议前先锁住真 stdout，然后把 `sys.stdout` 指向 stderr。业务代码里任何
`print()`（以及第三方库的）都进 stderr，不会把一行 JSON 切成两半——这是 `app.py:main()`
同一套做法，抄过来而不是重新发明。
"""
import json
import sys
import traceback
import os

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import app as _app                                    # noqa: E402
import wechat_core as core                            # noqa: E402
import wechat_health                                  # noqa: E402

SERVER_VERSION = _app.SERVER_VERSION

# `transcribe_voice` 依赖 `wechat_asr` + `pilk` + sherpa-onnx，这三个没随侧车打包。
# 留着它 = 给 Agent 一个「点了必炸」的工具（`tool_transcribe` 里 `import wechat_asr`
# 没有 try 保护）。整条摘掉，工具列表里就没有这个能力——能力缺失要显式，不要静默报错。
_UNAVAILABLE_TOOLS = {"transcribe_voice"}

TOOLS = [t for t in _app.TOOLS if t["name"] not in _UNAVAILABLE_TOOLS]
DISPATCH = {k: v for k, v in _app.DISPATCH.items() if k not in _UNAVAILABLE_TOOLS}

# 有阶段可播报的工具（与 app.py 同一份口径：只有发送路径装进度槽）
_PROGRESS_TOOLS = _app._PROGRESS_TOOLS

log = _app.log


def force_utf8_stdio():
    """钉住三流编码（Windows 管道默认 ANSI）。"""
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


_PROTOCOL_OUT = None


def _send(message):
    _PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def _text(text):
    return [{"type": "text", "text": text}]


def _ok(mid, content):
    _send({"id": mid, "ok": True, "content": content})


def _fail(mid, text):
    _send({"id": mid, "ok": False, "isError": True, "content": _text(text)})


def _emit_progress(mid, message, progress, total=None):
    frame = {"id": mid, "type": "progress", "message": message, "progress": progress}
    if total is not None:
        frame["total"] = total
    _send(frame)


def handle_initialize(mid):
    _send({"id": mid, "ok": True, "data": {
        "tools": TOOLS,
        "instructions": _app.INSTRUCTIONS,
        "version": SERVER_VERSION,
    }})


def handle_call(mid, req):
    """一次工具调用。与 `app.handle_tools_call` 同序：记账 → 装进度 → 切账号 → 执行 → 收尾。"""
    name = req.get("tool")
    args = req.get("args")
    if args is None:
        args = {}
    handler = DISPATCH.get(name)
    if handler is None:
        _fail(mid, f"ERROR: UnknownToolError: 侧车没有工具 {name!r}")
        return
    if not isinstance(args, dict):
        _fail(mid, "ERROR: BadArgsError: arguments 必须是对象")
        return
    if wechat_health.running():
        log("call", name)

    token = req.get("progressToken")
    progress_installed = False
    m_sender = None
    if token is not None and name in _PROGRESS_TOOLS:
        import wechat_sender as m_sender
        m_sender.set_progress(
            lambda message, progress, total=None: _emit_progress(mid, message, progress, total))
        progress_installed = True
    try:
        # 多开：先切到目标账号（缺省=自动挑最新），读/发都落在同一个号上。
        account = args.get("account")
        core.set_account(account if isinstance(account, str) else None)
        data = handler(args)
        # `read_image` 交出的是现成的 content 列表（内联位图）；其余是 dict → 一条 text 块。
        blocks = data.pop("_mcp_content", None) if isinstance(data, dict) else None
        # 版本门：不在真机验证范围内的微信版本，告警跟着每个结果出去（只写在 check_env 里
        # 等于没有——Agent 不会每次先调它）。
        _vw = core.version_warning()
        if _vw and isinstance(data, dict):
            data["version_warning"] = _vw
        _ok(mid, blocks if blocks is not None
            else _text(json.dumps(data, ensure_ascii=False)))
    except core.EnvError as e:
        if wechat_health.running():
            log("env_not_ready", name, getattr(e, "message", str(e)))
        _fail(mid, _app.format_tool_error(e))
    except Exception as e:
        log("error", name, traceback.format_exc())
        _fail(mid, _app.format_tool_error(e))
    finally:
        # 装了就必须还原，否则进度槽泄漏到下一次调用，把上一条请求的 id 带出去。
        if progress_installed and m_sender is not None:
            m_sender.set_progress(None)


def handle(req):
    """分发一条请求。返回 False 表示该退出。"""
    mid = req.get("id")
    method = req.get("method")
    if method == "initialize":
        handle_initialize(mid)
    elif method == "ping":
        _send({"id": mid, "ok": True, "data": {}})
    elif method == "call":
        handle_call(mid, req)
    elif method == "shutdown":
        _send({"id": mid, "ok": True, "data": {}})
        return False
    else:
        _fail(mid, f"ERROR: UnknownMethodError: {method!r}")
    return True


def main():
    global _PROTOCOL_OUT
    force_utf8_stdio()
    _PROTOCOL_OUT = sys.stdout
    sys.stdout = sys.stderr                    # 从此以后 stdout 只归协议流
    log(f"sidecar started v{SERVER_VERSION} (python {sys.version.split()[0]})")
    # 每分钟自检微信进程，只在「运行 ↔ 未运行」切换时写日志。
    wechat_health.start_watcher(log)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            log("parse error", line[:200])
            continue
        try:
            if not handle(req):
                return 0
        except Exception:
            # 单条请求炸了不能带走整条会话
            log("internal error", traceback.format_exc())
            mid = req.get("id") if isinstance(req, dict) else None
            _fail(mid, "ERROR: InternalError: 侧车内部错误（细节见 stderr）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
