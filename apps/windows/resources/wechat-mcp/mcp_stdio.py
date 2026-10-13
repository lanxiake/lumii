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

from wechat_core import EnvError, UnknownTalker

SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS = -32700, -32600, -32601, -32602

# 错误码 → 卡在**哪一道**。与 `wechat-mcp/server.py` 的 `_STAGE_BY_CODE` 同一口径
# （那是主产品的成熟模型），四件套沿用同一套字段，用户装两套时一份提示词能通吃。
STAGE_BY_CODE = {
    "env_not_ready": "env",         # 微信没运行 / 找不到数据目录 / 密钥扫不到
    "target_not_found": "target",   # 会话名对不上
    "bad_args": "args",             # 参数缺失或取值非法
    "not_archived": "data",         # 归档里没有这条（守护当时没跑）
    "internal_error": "internal",   # 兜底：工具自己炸了
}

# 给**用户**看的可操作建议（不是给 Agent 的推理线索）。没命中的码给一句通用的，
# 不返回空——空字段会被读成"没有建议"。
FIX_SUGGESTIONS = {
    "env_not_ready": "微信没就绪。请先打开微信并登录、点开一个会话，然后重试。",
    "target_not_found": "请先用本服务的会话列表工具拿到确切名字，或直接传 wxid / 群号。",
    "bad_args": "请检查参数名与取值；枚举类参数只接受 schema 里列出的那几个值。",
    "not_archived": "这条消息不在归档里。撤回防护要先启动守护（`--daemon`）才会留存历史。",
    "internal_error": "工具内部出错（多半是 bug）。请把 detail 原文反馈给开发者。",
}


def tool_error(code, message, **extra):
    """失败的**统一信封**：`{ok:false, detail, error_code, stage, suggestion}`。

    为什么四个产品都用这一个：四件套最初各写各的（A/C/D 静默返回 0 条、B 报错），形状随
    「错在哪一步」而变，同一份 SKILL 覆盖不了。主产品 `wechat-mcp/server.py` 的 `_fail()`
    已经踩过同一个坑并收敛过一次，这里直接沿用它的字段命名（`detail` 而不是 `error`），
    整套产品线只有一个形状。

    `hint` 是环境类错误特有的**动手步骤**，比 `suggestion` 更具体，有就带上。
    """
    out = {"ok": False, "detail": message, "error_code": code,
           "stage": STAGE_BY_CODE.get(code, "internal"),
           "suggestion": FIX_SUGGESTIONS.get(code, FIX_SUGGESTIONS["internal_error"])}
    out.update(extra)
    return out


def _candidate_note(cands):
    """把近似候选压成一句话（Agent 拿它一句问清是哪一个，而不是卡在"没找到"）。"""
    if not cands:
        return ""
    items = "、".join(f"{c['name']}（{c['talker']}）" if c["name"] != c["talker"] else c["talker"]
                      for c in cands)
    return f"名字相近的会话有：{items}。"


# 追加到每个产品自己的 INSTRUCTIONS 后面（口径统一，别指望四个产品各自记得写）
TOOL_CONVENTIONS = """
工具约定（四件套一致）：
- **失败**一律返回同一形状的 JSON：
  `{"ok": false, "detail": "发生了什么", "error_code": "...", "stage": "...", "suggestion": "该怎么办"}`。
  收到 `ok: false` 就是**没成功**，不要把同一个结果的其它字段当成数据用。
- `error_code` 的含义（据它决定下一步，别去猜 `detail` 的措辞）：
  - `env_not_ready` —— 微信没就绪（没运行 / 找不到数据目录 / 密钥扫不到）。**这不是你的参数问题**，
    照 `detail` + `hint` 告诉用户该做什么（通常是"先打开微信并登录"）。
  - `target_not_found` —— 会话名解析不出**唯一**目标。这**不是**「这个会话没有数据」——别当成
    空结果报给用户。`candidates` 里是名字相近的会话，拿它向用户问清是哪一个。
  - `bad_args` —— 参数缺失或取值非法，按 `detail` 改正后重试。
- 结果里带 `total` 与 `count` 时：`total` 是命中总数，`count` 是本次返回条数，两者不等就说明
  被 `limit` 截断了，别当成"只有这些"。要接着翻用 `offset`。
- 每条工具结果都是**一段 JSON 文本**；`isError=true` 只在工具内部真的炸了（bug）时出现
  （此时 `error_code=internal_error`）。业务性失败（上面那些码）**不**置 `isError`——它们是要你
  读并处置的结构化结果，不是协议层故障；只看 `isError` 会漏掉它们。
"""


# ---- 进度上报 ---------------------------------------------------------------
# 客户端用 `_meta.progressToken` 请求通知；**干重活的模块**（`filecore.archive_files`、
# `exportcore.export_chat`）在长循环里调 `progress("已归档 40/200")`，协议层把槽位接到
# `notifications/progress` 上。做法照抄主产品 `wechat_sender._progress`：worker 持有槽位、
# server 注入回调、**调用结束必须还原**（不还原就会把上一次的 token 泄漏给下一次调用）。
#
# 为什么要有它：归档 200 个文件 / 导出几千条消息要跑几十秒，期间界面上什么都不动，
# 用户只会以为卡死了。
_PROGRESS = {"cb": None, "n": 0}


def set_progress(cb):
    """安装进度回调 `cb(message, progress, total)`（None = 关掉）。返回**旧的**回调，供恢复。

    单进程、stdio 循环里工具调用是同步串行的，所以一个模块级槽位就够，不必线程局部
    （和主产品同一个判断）。
    """
    old = _PROGRESS["cb"]
    _PROGRESS["cb"] = cb
    _PROGRESS["n"] = 0
    return old


def progress(message, total=None, n=None):
    """上报一条进度；**没装回调时是空操作**（所以业务代码可以无脑调，不必判环境）。

    单调性由这里**兜底**：`_PROGRESS["n"] = max(上次+1, n)`——MCP 规范要求 progress 只增不减，
    而一次调用里可能有多个阶段各报各的（先"读记录"再"导媒体"），让每个调用点自己维护一个
    递增序列既啰嗦又容易错。批量任务显式传 `n`（= 已处理条数），阶段式播报省略它即可。
    """
    cb = _PROGRESS.get("cb")
    if not cb:
        return
    _PROGRESS["n"] = max(_PROGRESS["n"] + 1, n) if n is not None else _PROGRESS["n"] + 1
    try:
        cb(message, _PROGRESS["n"], total)
    except Exception:      # 上报失败绝不能影响干活本身
        pass


def log_env_status(name):
    """启动时把**最便宜**的那条环境事实打进 stderr（微信进程在不在）。

    为什么不是一次完整的"前置检查"：MCP 随客户端启动，而用户完全可能**先开客户端、后开微信**，
    启动就拦等于自找假失败；完整探测（找数据目录会扫盘）也不该卡在握手上。
    真正的判断留在**调用时**——那时失败会被归类成 `env_not_ready` 并带上动手步骤。
    这里只留一条"出问题时值得先看"的痕迹，撑支持用。
    """
    try:
        import wxkey4
        pids = wxkey4.find_wechat_pids()
        log(name, f"env: 微信进程 {'运行中 pid=' + str(pids[0][1]) if pids else '**未找到**'}")
    except Exception as e:                         # 探测本身失败不该影响启动
        log(name, f"env: 微信进程探测跳过（{e!r}）")


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

    def emit_progress(self, token, message, n, total=None):
        """发一条 `notifications/progress`。只在客户端**主动带了** `progressToken` 时调用——
        不带 token 的上报是无主的，规范也不允许。"""
        params = {"progressToken": token, "progress": n, "message": message}
        if total is not None:
            params["total"] = total
        self._send({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})

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
        # 客户端带了 `_meta.progressToken` ⇒ 给干重活的模块装上进度槽，界面就能看到
        # 「已归档 40/200」而不是盯着转圈。只读的轻工具没人调 progress，装了也是空转。
        meta = params.get("_meta")
        token = meta.get("progressToken") if isinstance(meta, dict) else None
        installed = False
        if token is not None:
            set_progress(lambda m, n, t=None: self.emit_progress(token, m, n, t))
            installed = True
        try:
            data = handler(args)
        except UnknownTalker as e:
            cands = e.candidates
            log(self.name, "target_not_found", str(e), f"候选={len(cands)}")
            self.reply(mid, self.text_result(tool_error(
                "target_not_found",
                f"会话「{e}」解析不出唯一目标（需与显示名或 wxid/群号完全一致）。"
                + _candidate_note(cands),
                candidates=cands)))
            return
        except EnvError as e:
            # 环境的锅，不是调用方的锅——带上动手步骤，别让人对着堆栈猜。
            # detail 取 `e.message`（不含 hint）：结构化出口里两者分开给，合并会把建议
            # 塞进"发生了什么"里，客户端想单独显示就得再解析一遍文本。
            log(self.name, "env_not_ready", e.message)
            self.reply(mid, self.text_result(
                tool_error("env_not_ready", e.message, hint=e.hint)))
            return
        except Exception as e:                     # 工具内部失败以 isError 结果返回，不拖垮服务
            log(self.name, "error", name, repr(e))
            self.reply(mid, self.text_result(
                tool_error("internal_error", f"{type(e).__name__}: {e}"), is_error=True))
            return
        finally:
            # 装了就必须还原（哪怕原来没有槽位）——否则进度槽会泄漏到下一次调用，
            # 把**上一条请求的 token** 带出去。主产品在同一处踩过，注释也是这么写的。
            if installed:
                set_progress(None)
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


def serve(name, title, version, tools, instructions, dispatch, install=None):
    """跑起来。`--version` 直接打印版本退出（构建脚本的冒烟靠它）。

    `install`：本产品的安装规格（`{name, product, skill, label}`）。给了就多支持
    `--install` / `--uninstall` / `--install-status` 三个命令行开关——**必须在这里拦下**，
    否则它们会被当成"没有参数"而进 MCP 循环，然后挂在那儿等 stdin。
    """
    force_utf8_stdio()
    if "--version" in sys.argv[1:]:
        print(version)
        return 0
    if install:
        import mcp_install
        rc = mcp_install.consume_flags(sys.argv[1:], install)
        if rc is not None:
            return rc                     # 装失败要以非零码退出，脚本里才拦得住
    # 下面这行之后就没人往 stdout 写业务输出了：协议流独占 stdout
    server = StdioServer(name, title, version, tools, instructions, dispatch)
    sys.stdout = sys.stderr
    log(name, f"started v{version} (python {sys.version.split()[0]})")
    log_env_status(name)
    server.loop()
    return 0
