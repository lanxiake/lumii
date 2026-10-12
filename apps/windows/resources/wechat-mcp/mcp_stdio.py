# -*- coding: utf-8 -*-
"""四件套共用的 MCP stdio 协议层（+ 工具边界约定）。

**为什么单独一个文件**：这段协议循环原先在四个 `server.py` 里**逐字复制了四份**——diff 下来
只差 `serverInfo.title` 一行。协议层是基础设施，复制四份 = 加一个方法要动四处、协议版本升一次
要改四遍，而且漂移是无声的：手搓 JSON-RPC 已经踩过 `serverInfo`→`server_info`、`isError` 缺省
（都是 SDK 能过、手搓对不上的形态）。

**分工**：本模块只管**协议 + 工具边界约定**；`wechat_core` 管读取，各产品的 `*core.py` 管业务。
现有 `wechat-mcp/server.py` 有自己的分派与授权档位，不在本次收敛范围内（免得动到已发布的产品）。

**统一错误口径**：业务层抛 `wechat_core.UnknownTalker` 会被翻成
`{"error": ..., "error_code": "target_not_found"}`。四个产品曾经三种口径（B 报错，A/C/D 静默
返回 0 条），而**静默 0 条与"真没数据"在 JSON 里长得一模一样**——这是本套工具最容易骗过模型的
失败形态，所以收在一个地方，不给第二次漂移的机会。
"""
import json
import sys

from wechat_core import UnknownTalker

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

# 追加到每个产品自己的 INSTRUCTIONS 后面（口径统一，别指望四个产品各自记得写）
TOOL_CONVENTIONS = """
工具约定（四件套一致）：
- 会话参数（`talker` / `room`）解析不出**唯一**目标时返回
  `{"error": ..., "error_code": "target_not_found"}`。这**不是**「没有数据」——别当成空结果，
  改用确切会话名 / wxid / 群号，或先向用户问清是哪一个。
- 结果里带 `total` 与 `count` 时：`total` 是命中总数，`count` 是本次返回条数，两者不等就说明
  被 `limit` 截断了，别当成"只有这些"。
- 每条工具结果是**一段 JSON 文本**；服务端异常时 `isError=true` 且文本以 `ERROR:` 开头。
"""


def force_utf8_stdio():
    """钉住三个标准流编码为 UTF-8（Windows 重定向时默认是 ANSI 代码页）。"""
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def log(name, *a):
    """业务日志一律走 stderr——stdout 是协议流，多一个字符就毁掉整条会话。"""
    print(f"[{name}]", *a, file=sys.stderr, flush=True)


class StdioServer:
    """一次 stdio 会话：读一行 JSON-RPC 请求 → 派发 → 写一行结果。单线程、顺序处理。"""

    def __init__(self, name, title, version, tools, instructions, dispatch):
        self.name, self.version = name, version
        self.tools, self.dispatch = tools, dispatch
        self.instructions = (instructions or "").rstrip() + "\n" + TOOL_CONVENTIONS
        self.title = title
        self._out = sys.stdout

    # ---- 写 ----
    def _send(self, message):
        self._out.write(json.dumps(message, ensure_ascii=False) + "\n")
        self._out.flush()

    def reply(self, mid, result):
        self._send({"jsonrpc": "2.0", "id": mid, "result": result})

    def reply_error(self, mid, code, message):
        self._send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})

    def text_result(self, data, is_error=False):
        text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
        return {"content": [{"type": "text", "text": text}], "isError": bool(is_error)}

    # ---- 协议方法 ----
    def initialize(self, params):
        req = params.get("protocolVersion")
        return {
            "protocolVersion": req if req in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": self.name, "title": self.title, "version": self.version},
            "instructions": self.instructions,
        }

    def tools_call(self, mid, params):
        name = params.get("name")
        args = params.get("arguments") or {}
        handler = self.dispatch.get(name)
        if handler is None:
            self.reply_error(mid, INVALID_PARAMS, f"Unknown tool: {name}")
            return
        if not isinstance(args, dict):
            self.reply_error(mid, INVALID_PARAMS, "arguments 必须是对象")
            return
        log(self.name, "call", name)
        try:
            data = handler(args)
        except UnknownTalker as e:
            log(self.name, "target_not_found", str(e))
            self.reply(mid, self.text_result({
                "error": f"会话「{e}」解析不出唯一目标——请用确切的会话名、或 wxid/群号",
                "error_code": "target_not_found"}))
            return
        except Exception as e:                     # 工具内部失败以 isError 结果返回，不拖垮服务
            log(self.name, "error", name, repr(e))
            self.reply(mid, self.text_result(f"ERROR: {e}", is_error=True))
            return
        self.reply(mid, self.text_result(data))

    def handle(self, msg):
        if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
            self.reply_error(msg.get("id") if isinstance(msg, dict) else None,
                             INVALID_REQUEST, "Invalid Request")
            return
        method = msg.get("method")
        if not isinstance(method, str) or "id" not in msg:
            return                                 # 通知不回应
        mid, params = msg.get("id"), msg.get("params")
        if not isinstance(params, dict):
            params = {}
        if method == "initialize":
            self.reply(mid, self.initialize(params))
        elif method == "ping":
            self.reply(mid, {})
        elif method == "tools/list":
            self.reply(mid, {"tools": self.tools})
        elif method == "tools/call":
            self.tools_call(mid, params)
        else:
            self.reply_error(mid, METHOD_NOT_FOUND, f"Method not found: {method}")

    def loop(self):
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception:
                self.reply_error(None, PARSE_ERROR, "Parse error")
                continue
            try:
                self.handle(msg)
            except Exception as e:                 # 单条请求炸了不能带走整条会话
                log(self.name, "internal error", repr(e))


def serve(name, title, version, tools, instructions, dispatch):
    """跑起来。`--version` 直接打印版本退出（构建脚本的冒烟靠它）。"""
    force_utf8_stdio()
    if "--version" in sys.argv[1:]:
        print(version)
        return 0
    # 下面这行之后就没人往 stdout 写业务输出了：协议流独占 stdout
    server = StdioServer(name, title, version, tools, instructions, dispatch)
    sys.stdout = sys.stderr
    log(name, f"started v{version} (python {sys.version.split()[0]})")
    server.loop()
    return 0
