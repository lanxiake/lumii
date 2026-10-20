# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pycryptodome>=3.20",
#     "zstandard>=0.22",
#     "pilk>=0.2",
#     "sherpa-onnx>=1.10",
#     "numpy>=1.24",
# ]
# ///
"""微信 MCP Server（MCP stdio 传输，JSON-RPC 2.0）—— 任意 MCP 客户端可用。

启动方式（二选一）：
- `uv run server.py`：按上方 PEP 723 元数据自动准备隔离环境与依赖，零配置；
- `python server.py`：需先 `pip install -r requirements.txt`。

**三个档位**（`EDITION`，构建期决定，见下方 import 处注释）：
- `pro`（高级版，默认）：19 个工具 —— 基础读写发送 + 媒体解析（图片路径 / 语音转写）+ 用户蒸馏；
- `lite`（基础版）：12 个工具 —— 只保留基础读写发送，且**连 image_path/voice_path 都不给**
  （见 `_strip_media`），消息只剩 `[图片 17KB]`/`[语音 3.2 秒]` 摘要。
- `plus`（增强版）：与 pro 同工具集，**发送优先走 hook**（`wechat_hook.py`：不抢前台、毫秒级、
  多微信实例按 talker 自动匹配）；hook 不可用时自动回退窗口投递。读消息仍走 SQLCipher。

工具（详见 TOOLS）：list_sessions / read_history / poll_new / search_messages / list_unread /
check_env / locate_db / repair_env / send_text / send_file / send_batch / reply_to，以及 **pro/plus 追加**的
read_image / transcribe_voice / wechat_digest / wechat_distill_state / wechat_distill_clear /
wechat_profile_save / wechat_profile_get。
其中 read_image 返回的是 MCP 的 **image 内容块**（内联 base64 位图），其余工具返回 text。

发送前依次校验：环境 → 目标会话（数据库锚点）→ 输入落地 → 发送生效；任一不过即中止（fail-closed）。
只读部分不改动任何微信文件；pro/lite 的发送走「OCR 定位 + SendInput」（零注入），plus 优先走 hook。

协议约定：
- 支持协议版本见 SUPPORTED_PROTOCOL_VERSIONS，`initialize` 时按客户端请求协商；
- stdout 只输出换行分隔的 JSON-RPC 消息；业务代码里的 print 一律被重定向到 stderr；
- 依赖缺失时仍能完成握手与 tools/list，调用相关工具时返回带安装命令的错误，`check_env` 报告依赖状态。
"""
import json
import sys
import os
import traceback

SERVER_NAME = "wechat-local"
SERVER_VERSION = "0.9.0"
# 新 → 旧；客户端请求的版本在列表中则原样回应，否则回应最新版（由客户端决定是否断开）
SUPPORTED_PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

# JSON-RPC 2.0 标准错误码
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 档位：pro（高级版，默认）/ lite（基础版）。
#
# 两版**同一份源码**，差异只由构建期决定：构建脚本（build-wechat-mcp.mjs）把源码整个拷到
# 临时目录，再往里写一个 `edition.py`（lite 版内容为 `EDITION = "lite"`）。工作区里**不落**
# 这个文件，所以「跑源码 = pro」，不会被运行期环境变量改档、也不会出现"改了源码忘了改回来"。
try:
    from edition import EDITION as _BUILT_EDITION
except ImportError:
    _BUILT_EDITION = "pro"

import builtin_expiry as _expiry  # noqa: E402

# 运行期档位 == 构建档位。授权（pro→lite 降级）已移除，档位不再被运行期状态改。
EDITION = _BUILT_EDITION
# plus = pro 的全部能力 + hook 发送（见 wechat_hook.py）。除了发送路由，所有
# 「pro 有、lite 没有」的判断都走这里，别再写 `EDITION == "pro"`。
_IS_PRO = EDITION in ("pro", "plus")

import wechat_core as core  # noqa: E402


def log(*a):
    print("[wechat-mcp]", *a, file=sys.stderr, flush=True)


def format_tool_error(exc):
    """工具异常收成一行非空的 `ERROR:` 文本。

    不能只写 `ERROR: {exc}`：`StopIteration` 的 `str()` 是空串，客户端只能看到 `ERROR:`，
    盯梢每拍都无法判断该等微信还是该修代码。类型名永远在，空文案再退回 `repr`。
    """
    name = type(exc).__name__
    detail = str(exc).strip()
    if not detail:
        detail = repr(exc)
    return f"ERROR: {name}: {detail}"


def force_utf8_stdio():
    """把三个标准流的编码钉成 UTF-8。

    为什么必须显式钉：Windows 上**重定向/管道时 Python 用 ANSI 代码页**（本机 cp936），
    于是带中文的输出（`--expiry-status` 的 human 字段）出来是 GBK 字节，
    任何按 UTF-8 读的下游（jq、Node、别的 MCP 客户端）都会解析失败。
    实测两个打包产物在 CLI 路径上都是这样——**与打包器无关**，是 `main()` 里那句 reconfigure
    只在 stdio 主循环路径上生效、而 `--xxx` 那几个诊断开关在它之前就打印了。
    """
    for stream in (sys.stdout, sys.stderr, sys.stdin):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass


def _resolve(talker):
    if not talker:
        return None
    return core.resolve_talker(talker)


def _resolve_or_error(talker):
    """解析会话；失败时给出**近似候选 + 可选清单**（避免宽松匹配发错人）。返回 (talker|None, error|None)。

    为什么要截断可选清单：本机 287 个会话时，一次失败会把**全部会话**塞进错误文本
    （实测 39KB），Agent 的上下文直接被这一句占满。相似候选留 5 个、可选清单留 12 个，
    剩下的让 Agent 用 `list_sessions(query=…)` 自己查。
    """
    if not talker:
        return None, "talker 为空（需要会话显示名或 wxid/群号）；先用 list_sessions 拿确切名字"
    t = _resolve(talker)
    if t:
        return t, None
    try:
        near = core.suggest_talkers(talker)[:5]
    except Exception:
        near = []
    near_s = "；".join(f"{r['name']}({r['talker']})" for r in near) if near else ""
    try:
        opts_all = core.sessions()
    except Exception:
        opts_all = []
    opts = "；".join(f"{s['name']}({s['talker']})" for s in opts_all[:12])
    if len(opts_all) > 12:
        opts += f"；…另有 {len(opts_all) - 12} 个（用 list_sessions(query=…) 查）"
    if not opts:
        opts = "（会话列表读取失败）"
    head = (f"「{talker}」不能唯一确定（相似会话：{near_s}）——请从里面挑**确切的一个**"
            if near_s else f"未找到会话「{talker}」")
    return None, (f"{head}。本工具**严格匹配**（需与显示名或 wxid/群号完全一致），"
                  f"歧义或部分匹配一律拒绝以免发错人。可选会话：{opts}")


def _get_fix_suggestion(error_code):
    """根据错误码返回可操作的修复建议（P0-B 增强）。"""
    suggestions = {
        "env_not_ready": "环境没就绪：微信没运行、或主窗口不可见（收进托盘）。窗口**最小化**时工具已会"
                         "自己恢复一次（不动）；**收进托盘不强显**——那是用户自己收的，不去把它弹出来。"
                         "这条已经自动排队，发送门恢复后盯梢回路自己补发。"
                         "**锁屏不再拦 send_text / send_file / send_batch**（都走窗口消息投递，锁屏照发）；"
                         "只有 reply_to（引用回复）还走模拟键鼠，锁屏期间确实发不出去——"
                         "别自己去点、也别叫用户去点，解锁后发送门自己恢复、积压由盯梢回路自动补发。",
        "target_unconfirmed": "没能确认目标会话（发送层 fail-closed：**一个字都没输入**，不会发错、也不会重复）。"
                              "这条已经自动排队、盯梢回路会自己补发——不用改内容，也不用转人工。",
        "target_not_found": "未找到目标会话，请先用 list_sessions 确认会话名称或 talker ID。",
        "busy": "另一个微信操作正在进行（发送/读取有互斥锁）。等几秒后重试即可，不用做别的。",
        "input_not_landed": "输入框定位失败。建议：1) 确保微信窗口完全可见；2) 稍后重试；3) 检查微信版本（推荐 4.x）。",
        "send_unconfirmed": "回车/点发送后输入框仍有文字，消息没发出去。输入框已在下次尝试时清空，可直接重试。",
        "send_not_confirmed": "已按回车但读库没看到新消息——可能真发出去了、只是还没落库，也可能发到了别处。"
                              "**不要自动重发**：先 read_history 看一眼该会话，或请用户人工确认。",
        "quote_not_found": "未找到要引用的消息。建议：1) 确认引用文字准确；2) 该消息在聊天区可见；3) 使用消息原文而非摘要。",
        "verification_failed": "目标会话校验失败。建议：1) 确认微信已打开正确的会话；2) 会话中有足够的历史消息用于校验。",
        "attachment_not_landed": "附件没能进输入框（文件对话框没弹、或路径没写进去）。重试一次；仍失败则改用 send_text 告知用户手动发。",
        "attachment_missing": "本地文件不存在或不可读，请核对绝对路径后重试。",
        "clipboard_failed": "写剪贴板失败（偶发被其它程序占用）。等几秒重试即可。",
        "bad_args": "参数错误，请检查输入参数是否完整且格式正确。",
        "not_found": "没找到这条消息：核对 talker 与 local_id（要用 read_history/poll_new 返回的那个），"
                     "必要时把该消息的 ts 一并传入精确定位。",
        "not_image": "这条 local_id 指向的不是图片消息；图片消息要用 read_history 返回的 type=3 那条。",
        "image_key_missing": "图片 AES 密钥还没抓过：让用户先在微信里点开一张图（大图界面），"
                             "再跑一次 `wechat-mcp.exe --image-key`（抓一次即可，账号级）。",
        "image_missing": "图没落到本地（原图与中图都缺，微信清过的图永久缺失）。如实告诉用户取不到，别编内容。",
        "voice_unavailable": "这条语音的音频本地已经没有了（微信清理过），永久缺失；"
                             "如实告诉用户听不到，**不要编内容**。",
        "asr_unavailable": "本地语音转写没就绪：装依赖（pip install pilk sherpa-onnx numpy）"
                           "或用 `wechat-mcp.exe --download-asr-model` 下载模型。",
        "asr_failed": "转写过程出错，可重试一次；连续失败则检查模型文件是否完整。",
    }
    return suggestions.get(error_code, "请检查微信窗口状态并重试，或查看 detail 字段了解详情。")


def _fail(error_code, message, **extra):
    """失败的**统一信封**——所有工具的任何失败出口都必须走这里。

    为什么要有它：以前十几处「参数校验不过就提前返回」各写各的，形状是
    `{"ok": False, "error_code": ..., "error": ...}`——字段叫 `error` 而不是 `detail`，
    而且**少了 `stage` 和 `suggestion`**。对照发送路径的失败返回（有 `detail`/`stage`/`suggestion`），
    Agent 拿到的形状随「错在哪一步」而变，同一份提示词没法覆盖，只能靠猜。

    现在统一成一条契约：任何失败都返回
    `{ok: false, detail, error_code, stage, suggestion}`（+ 调用方自己的字段）。
    """
    out = {"ok": False, "detail": message, "error_code": error_code,
           "stage": _stage_of(error_code), "suggestion": _get_fix_suggestion(error_code)}
    out.update(extra)
    return out


def _code_of(detail):
    """把发送层的中文 detail 归一到**稳定错误码**（Agent 据此决策，不必字符串匹配）。

    码表与 `wechat_sender.py` 实际返回的 detail 文案一一对应——改发送层文案时必须同步改这里，
    改错不会报错、只会静默退化成 `unknown`（Agent 就不再重试了）。

    """
    d = detail or ""
    if "环境前置检查" in d or "窗口前置检查" in d or "找不到微信主窗口" in d:
        return "env_not_ready"
    if "busy" in d or "正在进行" in d:
        return "busy"
    if "未找到要引用的消息" in d:
        return "quote_not_found"
    if "菜单里未找到" in d:
        return "menu_not_found"
    if "剪贴板写入失败" in d:
        return "clipboard_failed"
    if "文件不存在" in d:
        return "attachment_missing"
    if "附件未落地" in d or "文件对话框" in d or "「发送文件」" in d or "参考系" in d:
        # 附件后台化后的新文案（点「发送文件」→ 驱动文件对话框那条路）都归到同一个码：
        # 它们的语义就是「附件没能进输入框」，且都是可重试的临时 UI 故障，不必新开码。
        return "attachment_not_landed"
    if "输入未落地" in d or "投递输入失败" in d:
        return "input_not_landed"
    if "目标会话未确认" in d:
        return "target_unconfirmed"
    if "更像其它会话" in d or "校验失败" in d or "不通过" in d:
        return "verification_failed"
    if "输入框未清空" in d:
        return "send_unconfirmed"
    if "未见新消息" in d:
        return "send_not_confirmed"
    if "为空" in d:
        return "bad_args"
    if "未找到" in d:
        return "not_found"
    return "unknown"


# 错误码 → 发送前状态机的**档位**：让 Agent 一眼看出卡在「环境/窗口/目标/输入/发送」哪一道。
# 与 `wechat_sender.preflight` 的 stage 一致（proc/window/restore/size/foreground 归到 env/window）。
_STAGE_BY_CODE = {
    "env_not_ready": "env",        # 进程未运行 / 窗口不可用 / 还原失败 / 前台切不到
    "target_unconfirmed": "target",
    "target_not_found": "target",
    "verification_failed": "target",
    "input_not_landed": "input",
    "send_unconfirmed": "input",
    "attachment_not_landed": "attachment",
    "attachment_missing": "attachment",
    "send_not_confirmed": "send",
    "ui_unresponsive": "send",     # UI 冻结（已自动恢复）
    "busy": "lock",
    # 媒体读取（read_image / transcribe_voice）
    "not_found": "media",
    "not_image": "media",
    "image_key_missing": "media",
    "image_missing": "media",
    "voice_unavailable": "media",
    "asr_unavailable": "media",
    "asr_failed": "media",
}


def _stage_of(code):
    return _STAGE_BY_CODE.get(code or "", "unknown")


def _send_with_retry(send_fn, max_retries=2, retry_delay=0.5):
    """发送重试包装器（P0-B 增强）。

    策略：只重试「**确实没发出去**」的临时性失败——发送层的 `_type_and_check` 每次都会
    先 Ctrl+A/Delete 清空输入框，所以重来一遍不会把文字粘两遍。语义存疑的
    `send_not_confirmed`（已回车、库里没看到）**绝不自动重试**：可能已经发出去、
    重试就是给好友发第二遍。

    返回：(ok, detail, attempts) 元组
    """
    import time

    RETRIABLE_CODES = {"input_not_landed", "send_unconfirmed", "attachment_not_landed",
                       "busy", "clipboard_failed", "verification_failed"}
    NON_RETRIABLE_CODES = {"env_not_ready", "target_unconfirmed", "quote_not_found",
                           "menu_not_found", "bad_args", "send_not_confirmed",
                           "attachment_missing", "not_found", "target_not_found"}

    last_ok, last_detail = False, ""
    for attempt in range(1, max_retries + 1):
        ok, detail = send_fn()
        last_ok, last_detail = ok, detail

        if ok:
            suffix = f"（第 {attempt} 次尝试成功）" if attempt > 1 else ""
            return True, detail + suffix, attempt

        error_code = _code_of(detail)
        if error_code in NON_RETRIABLE_CODES:
            return False, detail + f"（不可重试的错误：{error_code}）", attempt
        if error_code not in RETRIABLE_CODES:
            return False, detail + "（未知错误类型，不自动重试）", attempt

        if attempt < max_retries:
            log(f"发送失败（{error_code}），{retry_delay}s 后重试（{attempt}/{max_retries}）...")
            try:                       # 重试也要让界面看得见（否则用户只看到卡片一直转）
                import wechat_sender as _ws
                _ws._progress(f"发送未成功（{error_code}），准备第 {attempt + 1}/{max_retries} 次尝试")
            except Exception:
                pass
            time.sleep(retry_delay)

    return False, last_detail + f"（已重试 {max_retries} 次，仍失败）", max_retries


def tool_sessions(args):
    """列出会话；带 query 时按关键词过滤（让 Agent 在发送前就能拿到**确切名字/talker**）。

    过滤**大小写不敏感**：与 `core.resolve_talker` 同一口径——用户敲 `loop` 也得能
    查出 `Loop`，否则「先查再发」这条最自然的路会在第一步就断掉。
    """
    rows = core.sessions()
    q = str((args or {}).get("query") or "").strip().lower()
    if q:
        rows = [r for r in rows
                if q in r["name"].lower() or q in r["talker"].lower()
                or q in (r.get("last") or "").lower()]
    return rows


def tool_history(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    return _strip_media(core.history(talker, int(args.get("limit") or 10), int(args.get("before_ts") or 0)))


# `read_image` 取不到图时**逐因给话**。原先四种情形压成一句「不是图片 / 图没落到本地 /
# 原始图与中图都缺」——而最常见的那个（**图片 AES key 还没抓过**）根本没在里面，调用方照着
# 那句话只会去查不存在的文件缺失。每句都要能落到「下一步做什么」。
_IMAGE_WHY = {
    "not_found": "这个会话里没有这条 local_id（会话选错了？local_id 要用 read_history/poll_new 返回的那个）",
    "not_image": "这条是图片消息才能取图，该 local_id 指向的不是图片",
    "no_key": ("取不到：**图片 AES 密钥还没抓过**（图片是加密落盘的，key 不在消息里、也不在配置文件里，"
               "只能从微信进程内存里扫出来）。跑一次 `wechat-mcp.exe --image-key` 即可——先在微信里"
               "点开一张图片（大图界面）再跑，抓一次之后所有图都能解"),
    "no_file": "图没落到本地：原图与中图都缺（微信清过的图，缺失是永久的）",
}
# 取图失败 → 稳定错误码（Agent 按码决策，不必读中文 detail）
_IMAGE_CODE = {"not_found": "not_found", "not_image": "not_image",
               "no_key": "image_key_missing", "no_file": "image_missing"}


def tool_image(args):
    """取一张图片消息的**内容**（解密后的位图，base64 内联返回）。

    为什么要它（2026-10-11）：`read_history` 只给 `image_path`（本地路径）。**同机** Agent
    能自己读文件，但**跨机 / 通用 MCP 客户端**读不到——而 MCP 本来就支持工具结果内联图片
    （`{"type":"image","data":<base64>,"mimeType"}`），这一步以前整个缺失。微信原图是加密
    `.dat`，但服务端解密早已完成、`image_path` 指向的就是明文位图，这里只是把它端上来。

    返回两个 content 块：[image（位图）, text（元信息：实际取到的是 原图还是缩略图、字节数）]。
    元信息块是必要的——`image_file` 会在原图没落盘时静默退到缩略图，不看这一块就分不清
    「图模糊」是模型的锅还是只拿到了 83×180 的缩略图。
    """
    import base64
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    m, why = core.image_message(talker, args.get("local_id"), ts=int(args.get("ts") or 0))
    if not m:
        return _fail(_IMAGE_CODE.get(why, "image_missing"), _IMAGE_WHY.get(why, "取不到这张图"))
    p = m.get("image_path") or ""
    try:
        with open(p, "rb") as f:
            raw = f.read()
    except OSError as e:
        return _fail("image_missing", f"读取解密后的图片失败：{e}")
    mime = "image/png" if p.lower().endswith(".png") else "image/jpeg"
    meta = {"talker": talker, "local_id": m.get("local_id"), "ts": m.get("ts"),
            "path": p, "bytes": len(raw),
            "variant": "thumb" if os.path.basename(p).startswith("thumb_") else "hd"}
    return {"_mcp_content": [
        {"type": "image", "data": base64.b64encode(raw).decode(), "mimeType": mime},
        {"type": "text", "text": json.dumps(meta, ensure_ascii=False)},
    ]}


def tool_transcribe(args):
    """把一条语音消息转成文字（**本地 ASR，全本地、不外传**）。

    Agent 先在 read_history/poll_new 里看见语音消息的 `local_id`，再用它单独转写——
    不做成"自动内联转写"：模型加载与推理有成本，只转真正要看的那几条。
    """
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    m = core.voice_message(talker, args.get("local_id"), ts=int(args.get("ts") or 0))
    if not m:
        return _fail("voice_unavailable",
                     "取不到这条语音的音频：不是语音消息 / 找不到该 local_id / "
                     "VoiceInfo 里没有音频（较老的语音数据会被微信清掉，缺失是永久的）")
    import wechat_asr
    ok, why = wechat_asr.available()
    if not ok:
        return _fail("asr_unavailable", why)
    import time as _t
    t0 = _t.perf_counter()
    try:
        text = wechat_asr.transcribe(m["voice_path"])
    except Exception as e:
        return _fail("asr_failed", f"转写失败：{type(e).__name__}: {e}")
    return {"ok": True, "talker": talker, "name": _display_name(talker),
            "local_id": m.get("local_id"), "time": m.get("time"), "text": text,
            "elapsed_ms": round((_t.perf_counter() - t0) * 1000),
            "model": "paraformer-zh-small（sherpa-onnx，本地）"}


def tool_poll(args):
    return _strip_media(core.poll(int(args.get("since_ts") or 0)))


def _current_account():
    try:
        return core.self_wxid()
    except Exception:
        return None


def _display_name(talker):
    try:
        return core.names().get(talker) or talker
    except Exception:
        return talker


def _hook_send(kind, talker, value, account=None):
    """plus 档优先走 hook。返回 None = 没走 hook（调用方回退窗口投递）。

    只有「hook 完全不可用」才回退；一旦请求发出去，失败结果原样返回——
    再回退一次窗口投递就可能给好友发第二遍。
    """
    if EDITION != "plus":
        return None
    try:
        import wechat_hook
        res = (wechat_hook.try_send_text(talker, value, account=account) if kind == "text"
               else wechat_hook.try_send_file(talker, value, account=account))
    except Exception as e:                      # hook 模块坏了不该拖死发送
        log(f"hook 不可用，回退窗口投递：{type(e).__name__}: {e}")
        return None
    if not res or res.get("_fallback"):
        return None
    return res


def tool_send(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    text = args.get("text") or ""
    if not text:
        return _fail("bad_args", "text 为空")
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    account = (args.get("account") or "").strip() or None

    with wechat_sender.target(account):
        hook = None if dry else _hook_send("text", talker, text, account=account)
        if hook is not None:
            ok, detail, attempts = hook["ok"], hook["detail"], 1
        elif not dry:
            # P0-B 增强：真实发送时启用重试
            ok, detail, attempts = _send_with_retry(
                lambda: wechat_sender.send_text(text, talker, dry_run=False),
                max_retries=2
            )
            # P1 增强：标记工具内部是否已重试
            if attempts > 1:
                wechat_sender._record_diagnostics(retry_attempted=True)
        else:
            # dry_run 不重试
            ok, detail = wechat_sender.send_text(text, talker, dry_run=True)
            attempts = 1

    out = {"ok": ok, "detail": detail, "talker": talker, "name": _display_name(talker),
           "target_account": account or _current_account(),
           "dry_run": dry, "text": text[:120], "via": "hook" if hook else "uia"}
    if hook and hook.get("account"):
        out["account"] = hook["account"]
    if attempts > 1:
        out["attempts"] = attempts  # 标记重试次数
    if not ok:
        out["error_code"] = (hook or {}).get("error_code") or _code_of(detail)
        out["stage"] = _stage_of(out["error_code"])
        if hook is None:
            out["shot"] = wechat_sender.last_shot()
            # P1 增强：附加结构化诊断数据
            diag = wechat_sender.last_diagnostics()
            if diag:
                out["diagnostics"] = diag
        # P0-B 增强：失败时给出可操作的修复建议
        out["suggestion"] = _get_fix_suggestion(out["error_code"])
    return out


def tool_send_file(args):
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    path = args.get("path") or ""
    if not path:
        return _fail("bad_args", "path 为空")
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    account = (args.get("account") or "").strip() or None
    with wechat_sender.target(account):
        hook = None if dry else _hook_send("file", talker, path, account=account)
        if hook is not None:
            ok, detail = hook["ok"], hook["detail"]
        else:
            ok, detail = wechat_sender.send_attachment(path, talker, dry_run=dry)
    out = {"ok": ok, "detail": detail, "talker": talker, "name": _display_name(talker),
           "target_account": account or _current_account(),
           "dry_run": dry, "path": path, "via": "hook" if hook else "uia"}
    if hook and hook.get("account"):
        out["account"] = hook["account"]
    if not ok:
        out["error_code"] = (hook or {}).get("error_code") or _code_of(detail)
        out["stage"] = _stage_of(out["error_code"])
        out["suggestion"] = _get_fix_suggestion(out["error_code"])
        if hook is None:
            out["shot"] = wechat_sender.last_shot()
    return out


def tool_send_batch(args):
    """批量发送：对多个目标**逐条独立**解析 / 校验 / 发送，互不影响（一个失败不拖累其余）。

    默认 dry_run=true。每个目标都走 send_text 的完整闸门（环境 → 目标会话 → 输入落地 → 读库确认）。
    """
    items = args.get("messages") or []
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    if not isinstance(items, list) or not items:
        return _fail("bad_args", "messages 为空（需 [{talker, text}, ...]）")
    import wechat_sender
    results = []
    for it in items:
        it = it or {}
        # 逐条切账号：不同 item 可以来自不同微信号，会话名/联系人必须按各自账号解析
        account = (it.get("account") or args.get("account") or "").strip() or None
        core.set_account(account)
        raw, text = it.get("talker"), (it.get("text") or "")
        talker, err = _resolve_or_error(raw)
        if err:
            results.append(_fail("target_not_found", err, talker=raw))
            continue
        if not text:
            results.append(_fail("bad_args", "text 为空", talker=talker))
            continue
        with wechat_sender.target(account):
            hook = None if dry else _hook_send("text", talker, text, account=account)
            if hook is not None:
                ok, detail = hook["ok"], hook["detail"]
            else:
                ok, detail = wechat_sender.send_text(text, talker, dry_run=dry)
        r = {"ok": ok, "detail": detail, "talker": talker,
             "name": _display_name(talker), "target_account": account or _current_account(),
             "dry_run": dry, "text": text[:120],
             "via": "hook" if hook else "uia"}
        if not ok:
            r["error_code"] = (hook or {}).get("error_code") or _code_of(detail)
            r["stage"] = _stage_of(r["error_code"])
            r["suggestion"] = _get_fix_suggestion(r["error_code"])
            if hook is None:
                r["shot"] = wechat_sender.last_shot()
        results.append(r)
    sent = sum(1 for r in results if r["ok"])
    return {"ok": sent == len(results), "total": len(results), "sent": sent,
            "dry_run": dry, "results": results}


def tool_reply(args):
    """引用回复：引用聊天区里含 `quote` 的那条消息，再发出 `text`。"""
    talker, err = _resolve_or_error(args.get("talker"))
    if err:
        return _fail("target_not_found", err)
    quote = args.get("quote") or ""
    text = args.get("text") or ""
    if not text:
        return _fail("bad_args", "text 为空")
    if not quote:
        return _fail("bad_args", "quote 为空（要引用那条消息的文字，用于定位）")
    dry = args.get("dry_run")
    dry = True if dry is None else bool(dry)
    import wechat_sender
    account = (args.get("account") or "").strip() or None
    with wechat_sender.target(account):
        ok, detail = wechat_sender.reply_text(quote, text, talker, dry_run=dry)
    out = {"ok": ok, "detail": detail, "talker": talker, "name": _display_name(talker),
           "target_account": account or _current_account(),
           "dry_run": dry, "quote": quote[:60], "text": text[:120]}
    if not ok:
        out["error_code"] = _code_of(detail)
        out["stage"] = _stage_of(out["error_code"])
        out["suggestion"] = _get_fix_suggestion(out["error_code"])
        out["shot"] = wechat_sender.last_shot()
    return out


def tool_search(args):
    talker = args.get("talker")
    if talker:
        talker, err = _resolve_or_error(talker)
        if err:
            return _fail("target_not_found", err)
    return _strip_media(core.search_messages(str(args.get("keyword") or ""), talker,
                                              int(args.get("since") or 0), int(args.get("until") or 0),
                                              int(args.get("limit") or 50)))


def tool_unread(_args):
    return _strip_media(core.unread())


def tool_digest(args):
    """用户/好友知识与行为蒸馏（确定性、只读、本地）：返回统计 + 代表性样本。"""
    talker = args.get("talker")
    if talker:
        talker, err = _resolve_or_error(talker)
        if err:
            return _fail("target_not_found", err)
    return core.digest(talker, int(args.get("limit") or 0), since=int(args.get("since") or 0))


def tool_distill_state(args):
    """蒸馏水位（增量蒸馏用）：`action=set` 传 `ts` 写入；默认读取。"""
    if (args.get("action") or "get") == "set":
        return core.set_distill_state(args.get("scope") or "self", int(args.get("ts") or 0))
    return core.distill_state(args.get("scope") or None)


def tool_distill_clear(args):
    """一键清除蒸馏产物（隐私约束）。"""
    raw = args.get("scope")
    if raw is None or not str(raw).strip():
        return core.distill_clear(None, everything=bool(args.get("everything")))
    scope, err = _resolve_scope(raw)
    if err:
        return _fail("target_not_found", err)
    return core.distill_clear(scope, everything=bool(args.get("everything")))


def _resolve_scope(scope):
    """画像 scope → core 的键：空/self/me/我/本人 → **`"self"`**（用户本人）；否则解析成会话 talker。

    ⚠️ 本人这一档**必须返回 "self"，不能返回 None**。`core.profile_get(None)` 的语义是
    「列出已产出的画像文件」，所以 `wechat_profile_get(scope="self")` 会静默返回目录清单——
    调用方（`bridge.ts` 每轮注入画像）拿不到 `exists`/`content`，就把这一整块丢掉。
    后果不是「画像质量差」而是**「关于我（本人）」这份画像从来没进过代聊的提示词**：模型按
    工作流去查，每次都得到"没有"，于是每轮重新蒸馏重建一遍（`self.md` 反复被覆盖、
    水位停在 0）。2026-10-09 实测：注入 `chars=444`，正文里只有 `## 关于这个人`。
    """
    if not scope or str(scope).strip() in ("self", "me", "我", "本人"):
        return "self", None
    t = _resolve(scope)
    if t:
        return t, None
    return None, f"未找到会话「{scope}」"


def tool_profile_save(args):
    """把提炼好的画像落本地（用户画像 / 某会话画像）。"""
    scope, err = _resolve_scope(args.get("scope"))
    if err:
        return _fail("target_not_found", err)
    content = args.get("content") or ""
    if not content.strip():
        return _fail("bad_args", "content 为空（画像正文）")
    p = core.profile_save(scope, content)
    return {"ok": True, "scope": scope or "self", "path": p}


def tool_profile_get(args):
    """读画像：`scope="self"`（或 me/我/本人）→ **用户本人**画像；给会话名/wxid → 该好友/群画像；
    **完全不给 scope** → 只列出已产出的画像文件（清单，不含正文）。"""
    raw = args.get("scope")
    if raw is None or not str(raw).strip():
        return core.profile_get(None)          # 列清单
    # 显式给了 scope（含 "self"）→ 必须读回正文，不能走上面那条列清单的分支
    scope, err = _resolve_scope(raw)
    if err:
        return _fail("target_not_found", err)
    return core.profile_get(scope)


def tool_status(args):
    import wechat_sender
    account = (args.get("account") or "").strip() or None
    try:
        pid = int(args.get("pid")) if args.get("pid") else None
    except (TypeError, ValueError):
        pid = None
    st = wechat_sender.check_env(account=account, pid=pid)
    # 数据目录探测（单独一栏，来源可归因）：换机/自定义目录时，这一栏是排查的第一落点
    try:
        root, src = core.db_root_info()
        st["db_root"], st["db_source"], st["db_ok"] = root, src, True
    except Exception as e:
        st["db_root"], st["db_source"], st["db_ok"], st["db_hint"] = None, None, False, str(e)
    # 语音转写（仅 pro 版有此工具）：模型缺了要在这里就看得出来，别等调用时才炸
    if _IS_PRO:
        try:
            import wechat_asr
            _ok, _why = wechat_asr.available()
            st["asr"] = {**wechat_asr.deps(), "model_dir": wechat_asr.model_dir(),
                         "ready": _ok, "hint": _why}
        except Exception as e:
            st["asr"] = {"ok": False, "ready": False, "hint": f"{type(e).__name__}: {e}"}
    # 图片解密（仅 pro 版有 read_image）：前置是**账号级的图片 AES key**，抓一次落盘。
    # 缺了它 `read_image` 只会说「图没落到本地」那一类话（key 在消息里、配置文件里都没有，
    # 只能扫微信进程内存），所以自查这一栏必须能一眼看出来。
    if _IS_PRO:
        try:
            import wechat_image
            _k = wechat_image.cached_aes_key()
            st["image_key"] = {"cached": bool(_k), "hint": "" if _k else
                               "还没抓过图片密钥：先在微信里点开一张图（大图界面），"
                               "再跑一次 `wechat-mcp.exe --image-key`"}
        except Exception as e:
            st["image_key"] = {"cached": False, "hint": f"图片模块不可用：{type(e).__name__}: {e}"}
    # hook 发送后端（仅 plus）：端点没起来时发送会自动回退窗口投递，这里是唯一的可见处
    if EDITION == "plus":
        try:
            import wechat_hook
            eps = wechat_hook.endpoints()
            st["hook"] = {"available": bool(eps), "endpoints": eps,
                          "hint": "" if eps else
                          "没有发现 hook 端点：发送会回退到窗口投递（via=uia）。"
                          "注入 DLL 后无需重启本服务。"}
        except Exception as e:
            st["hook"] = {"available": False, "hint": f"hook 模块不可用：{type(e).__name__}: {e}"}
    # 微信版本：这套代码只在少数版本上真机验过，未知版本要**明确报出来**而不是装作没事
    try:
        st["wechat_version"] = core.wechat_version()
    except Exception as e:
        st["wechat_version"] = {"version": "", "verified": False, "hint": f"版本探测失败：{e}"}
    st["can_send"] = bool(st["ok"])
    st["hint"] = ("可以发送" if st["ok"] else
                  "发送功能不可用：" + (st.get("reason") or "") +
                  "。最小化时发送会自己恢复一次（不用管）；其余情况请先把微信主窗口调到可见且在前台，再重试。")
    return st


def tool_locate_db(_args):
    """定位本机微信 4.x 数据目录（只读诊断）。

    探测源见 `wechat_core.detect_xwechat_dirs()`：env → ini（4.x 自定义目录的权威来源）
    → 注册表 → 默认路径 → 固定盘有界扫描。返回命中的 root 与来源，以及所有候选账号，
    方便换机后一眼看出「数据目录在哪、是从哪找到的」。
    """
    try:
        root, src = core.db_root_info()
        err = None
    except Exception as e:
        root, src, err = None, None, str(e)
    try:
        import wxinstances
        accts = wxinstances.accounts_detailed()
        instances = wxinstances.instances()
    except Exception:
        accts, instances = core.list_accounts(), []
    out = {
        "found": bool(root),
        "root": root,
        "source": src,
        "accounts": [{"wxid": a["wxid"], "dir": a["dir"], "root": a["root"],
                      "source": a.get("source"), "running": a.get("running", False),
                      "pid": a.get("pid"), "hwnd": a.get("hwnd")}
                     for a in accts],
        "instances": instances,
    }
    try:
        out["wechat"] = core.wechat_version()
    except Exception as e:
        out["wechat"] = {"version": "", "verified": False, "hint": f"版本探测失败：{e}"}
    if err:
        out["error"] = err
        out["hint"] = ("未自动找到微信数据目录。可在微信「设置 → 文件管理」查看当前数据目录；"
                       "仍找不到时设置环境变量 "
                       "LUMII_WECHAT_DB=<数据目录>\\xwechat_files\\<账号>_<4位>\\db_storage，再重连本 MCP。")
    elif root:
        out["wxid"] = core.self_wxid(root)
    return out


def tool_accounts(_args):
    """多开账号清单：每个账号是否在跑、对应哪个 PID/窗口。"""
    import wxinstances
    try:
        active = core.self_wxid()
    except Exception:
        active = None
    return {
        "active": active,
        "accounts": wxinstances.accounts_detailed(),
        "instances": wxinstances.instances(),
    }


def tool_repair_env(_args):
    """确定性环境修复：还原微信窗口 + 规范化到预设尺寸 + 重探数据目录。

    只做可逆/无副作用操作（ShowWindow/MoveWindow/重探目录），不点微信内部任何东西。
    返回修复前后对比（`before`/`after`/`db`/`actions`），供初始化自检与设置卡片展示。
    """
    import wechat_sender
    return wechat_sender.repair_env()



# 服务级引导：客户端把这段注入给 Agent，帮助它正确使用这些工具。
# 按档位拼接：通用段 + 媒体段（分档）+ 盯梢段 + 蒸馏段（仅 pro）——见文件末尾的 INSTRUCTIONS。
_CORE = """\
本服务让 Agent 以【用户本人】身份读微信、并按需发消息（零注入：窗口消息投递 + UI Automation 读数；不改微信数据）。

工具选择：
- 只读（不需要微信窗口）：list_sessions 列会话 / read_history 读历史 / poll_new 读增量新消息 / search_messages 检索 / list_unread 未读。
- 发送：send_text 发**文本**、send_file 发**图片/文件/视频/音频**、send_batch **群发给多个目标**（逐目标独立校验）—— 这三个都**不需要前台，锁屏也能发**（走窗口消息投递，不移动光标、不动剪贴板、不搬窗口、不打断用户操作）。reply_to **带引用的回复**是唯一还需要微信窗口可见且在前台的。
- 发送前可先调 check_env 确认环境（微信是否运行、窗口是否可见/最小化）；只有 reply_to 需要它在**前台**。
- **多账号/多开**：先调 `list_accounts` 看本机有哪些账号、哪些在跑（含 pid/hwnd）。
  读工具都可以带 `account=<wxid>`；`poll_new` 返回的**每条消息带 `account`**。
  **回复时必须把同一个 `account` 传给 send_text / send_file / reply_to**，否则可能从另一个微信号发出去。
  省略 `account` 时使用当前选中的账号（自动挑最新活跃的）。

附件说明（send_file）：
- path 传本地绝对路径；**不按扩展名分流**，一律走微信「发送文件」入口（图片/视频也照此投递，
  最终渲染成图片气泡还是文件卡片由微信自己决定）。
- 微信「语音消息」是按住录音、**无法自动化**——语音只能把音频文件当附件发。
- 用户说「发给我」但没给路径时，先问清文件路径，不要猜。

发送纪律（重要）：
1. 默认 dry_run=true —— 只校验、不发送。**只有用户明确要求真发时才传 dry_run=false**。
2. 内容以用户本人身份发出、且**不可撤回**。含义模糊或有风险的内容，先草拟给用户确认。
3. send_text / send_file / send_batch **不需要前台**：走窗口消息投递，锁屏、窗口在后台都照发，
   不移动光标、不动剪贴板、不搬窗口、不打断用户正在做的事（唯一可感的副作用：投递字符的一瞬
   微信会把自己顶到前台约 0.1–0.3 秒，工具会自动把前台还回去）。只有 reply_to 需要窗口可见且在前台：
   窗口**最小化**时会自己 SW_SHOWNOACTIVATE 还原一次（可逆，不用管也不用去点）；若仍 ok=false
   （微信没运行 / 主窗口不可见 / 锁屏），别自己去点、也别叫用户去点，解锁后发送门自己恢复、
   代聊那条积压由盯梢回路自动补发。
4. talker 用 list_sessions 返回的 name（如「文件传输助手」「TOOLAN」「TOOLAN、韩玉」）或 wxid/群号最稳。
5. 一次发一条；失败会在 detail 里说明卡在哪一道校验，可据此调整或提示用户。

耗时预期（**别提前判失败**）：
- 单次 send_text / send_file 正常 **7–15 秒**；目标会话**不在当前打开的那个**时要先切会话，最长 **36 秒**；
  界面卡死被自动探到还会多花 5–10 秒恢复。调用方预设超时已给到 **5 分钟**，等它把话说完。
- **超时 ≠ 失败**：真发生超时时消息很可能已经发出去了（服务端会自报 ok、库里能查到）。
  这时**不要重发**，改用 read_history 确认到底发出去没有。

失败与重试（**先看 error_code，别一律重试**）：
- 返回里的 `ok` / `error_code` / `stage` / `suggestion` / `attempts` 就是给你决策用的：
  `stage` 说明卡在「环境 / 目标 / 输入 / 发送 / 附件」哪一道，`suggestion` 是该码对应的处置建议，
  `attempts > 1` 表示**工具内部已经重试过**（最多 2 轮），你不要再叠一层重试。
- **工具已自动重试、别自己重发**：临时性的 UI 故障（`input_not_landed` / `busy` /
  `attachment_not_landed` / `clipboard_failed`）工具内部已经重试两轮了。
- **绝不重试**（重发就是给对方发第二遍）：
  - `send_not_confirmed` —— 回车已按、库里没看到。可能真发出去了。先 read_history 看，或问用户。
  - `target_unconfirmed` —— 没确认成目标会话（fail-closed：**一个字都没输入**，不会发错）。
    已自动排队，盯梢回路会自己补发；**不用改内容、不用转人工、更不要换个写法再发一遍**。
  - `target_not_found` / `bad_args` —— 参数或名字不对，重试一百次也一样。
- **换做法，而不是重试**：`target_not_found` → 先 list_sessions 拿到确切名字/talker 再发；
  `env_not_ready` → 微信没运行或窗口收进托盘，已自动排队等发送门恢复；
  `attachment_missing` → 路径不对，问用户要正确路径。
- 同一内容**最多只发两次**（第二次是因为工具报的临时故障，不是让你手动补发）。

读取建议：先用 list_sessions 找目标会话名，再用 read_history 拉上下文，然后据此起草回复。
起草回复时**默认读 10 条**（`read_history(limit=10)`）——够看清一轮来回，又不至于把上下文撑爆；
要更早的用返回的 `cursor` 配 `before_ts` 翻页（翻页不会丢同秒消息，见 `core._pad_page`）。
"""

# 媒体消息的读法**按档位不同**：lite 只有摘要，pro 给解密后的本地路径与转写。
# 分档是必要的——lite 版返回里根本没有 image_path/voice_path，留着 pro 的写法只会教模型去调不存在的字段。
_MEDIA_PRO = """\
非文本消息怎么看：
- 历史里除了文本，还会有这些**摘要**：`[图片 17KB]`、`[语音 3.2 秒]`、`[视频 38 秒]`、
  `[表情]`、`[位置] 成都市武侯区…`、`[链接] 标题 (url)`、`[名片] 昵称`、`[通话] 通话时长 02:41`、
  以及系统消息（「X 撤回了一条消息」）。**位置/链接/撤回这些本身就有信息**，直接拿来用。
- **语音**：消息里的 `voice_path` 是本地 SILK 文件。用 `transcribe_voice(talker, local_id, ts)` 取转写
  文字（`ts` 用消息自带的那个——`local_id` 跨时间分片会撞号，带上才能精确锁定），**别去猜语音内容**。监控回路在**叫醒你之前**也可能已经转写过一遍，文字会以
  「（上面这条是语音，本地转写的文字是：…）」的形式**直接摆在【本次触发】里**——有就用，那才是对方说的话。
- **图片**：消息里的 `image_path` 指向的是**已解密的明文位图**（微信原图是加密 `.dat`，解密这步
  服务端早已完成，你拿到的不是密文）。同机直接读那个文件即可；**跨机 / 客户端读不到本地文件时**，
  调 `read_image(talker, local_id, ts)` 让它以 **image 块**内联返回（`ts` 用消息自带的那个：
  `local_id` 跨时间分片会撞号，带上才能精确锁定）。
  ⚠️ `image_path` 指向的**可能只是缩略图**（原图没落盘时会静默退到中图/缩略图，小到 83×180、字看不清）——
  分不清「图模糊是模型的锅还是只拿到缩略图」时，看 `read_image` 返回的 `variant`(hd/thumb) 与 `bytes`。
- 用户主动贴了文字描述、或把图另存到本地给了路径，才能谈图片内容；**读不到就别编画面内容**。
- **视频**：消息里的 `video_path` 是**已下载到本机**的那份明文 mp4（不需要 key、不需要模型，拿到就能播）。
  **绝大多数视频从没在微信里点开过 ⇒ 没下载 ⇒ 没有路径**（本机实测 48 条视频消息、只有 8 条能定位），
  在微信里点开一次之后**再搜就有了**。所以：
  - 用户说「找那段视频」→ `search_messages("视频")` 或 `read_history`，命中的 `video_path` 就是能不能给的答案；
  - **没有路径 ≠ 视频不存在**：消息在、时长在、就是本地没那份字节——如实说「本机没下载过，
    在微信里点开一次我就能拿到」，**别编文件名、也别拿别的视频顶上**。
"""

_MEDIA_LITE = """\
非文本消息怎么看：
- 历史里除了文本，还会有这些**摘要**：`[图片 17KB]`、`[语音 3.2 秒]`、`[视频 38 秒]`、
  `[表情]`、`[位置] 成都市武侯区…`、`[链接] 标题 (url)`、`[名片] 昵称`、`[通话] 通话时长 02:41`、
  以及系统消息（「X 撤回了一条消息」）。**位置/链接/撤回这些本身就有信息**，直接拿来用。
- ⚠️ **本档（基础版）不解析图片与语音**：消息里**没有** `image_path` / `voice_path` / `video_path`，也没有转写，
  只有上方的摘要。用户问「我刚发的图你看了吗」「他说了句什么语音」时：**如实说看不到内容**，
  可以复述它是什么时候发的、多大，并请用户用文字说一下。
  凭 `[图片]`/`[语音]` 编造内容是**最严重的那类错误**。
"""

_WATCH = """\
实时盯消息（监控回路）：
- 增量用 poll_new(since_ts)：每条消息带 `from_me`/`sender`，**自己发的也会返回**——用户可能自己在手机上
  回过了，你要据此判断「还要不要开口」；返回的 `next_since_ts` 就是下一轮的 `since_ts`（别用墙上时钟的 now，
  同秒消息会漏）。它只解密新增的 WAL 帧、只扫有变化的会话表，**很便宜**，几秒一次也没负担。
- 回路姿势：定时（cron/循环）→ poll_new → 没有 `from_me=false` 的新消息就静默结束（别发 NO_REPLY 给用户看），
  有才起草回复；send_text / send_file 不需要前台（锁屏也能发），直接用；只有 reply_to 才需先 check_env 确认窗口在前台，不在就把 hint 转给用户，不要自己去点。
- 「有哪些没回」用 list_unread；「这个会话刚才聊到哪」用 read_history。
"""

_DISTILL = """\
蒸馏（用户/好友知识与行为）：要提炼「我的表达习惯 / 与谁联系最多 / 活跃时段 / 某会话里对方是谁」时，用 wechat_digest——
它做**本地确定性统计 + 代表性样本**（覆盖微信全部时间分片，**不外传**），你再据此写成画像；
用 wechat_profile_save 存成画像（scope 留空=用户本人），wechat_profile_get 读回。画像存本地白盒 Markdown，可编辑可删。
**增量**：蒸馏完用 wechat_distill_state(action=set) 记水位，下次 wechat_digest(since=水位)
就只看那段之后的新样本（**统计仍是全量**，见下）。
**回答与微信/某联系人相关的问题前，先 wechat_profile_get 看有没有现成画像**（有就用，别重复蒸馏）。
**风格那一栏要按实测数字 + 真实对子写，别目测**：`wechat_digest` 返回的 `self.style` 里有
`punct_rate_by_len`（**按消息长度分层的标点使用率**）——**短句不用标点、长句才用**是常态，
只看总比例或只看几条样本都会得出「几乎不加标点」那种错结论（实测踩过：本机 1-5 字 7%、
13 字以上 71–88%，写成「几乎不加标点」后代聊照着模仿，用户一眼看出不对）。
`delim_long` 是**断句方式**：长句里有人**用空格代顿号**（本机实测 9%），那部分不算中文标点，
别把它归进「无标点」。
`emoji_rate` 同理——**没量过就不要断言「爱用/不用表情」**。
**写口吻优先用 `exchange_pairs`**：那是**真实对子**（对方说了什么 → 我回了什么），
和代聊每轮面对的题面**是同一道题**；它自带长度匹配、标点习惯、该不该发表情，比任何描述句都直接。
（已按「我回话的长度」分层，两侧都过滤过粘贴内容。）`self.style_samples` 是补充。

**增量蒸馏不会丢历史**：`since` 只收窄 `samples_*`（「这次有什么新的」），
**统计（`self` / `contacts` / `top_words` / `style`）永远是全量的**（`stats_scope: "all"`）。
所以增量跑完照样可以整体覆盖画像，不必手工合并。

**隐私**：画像全在本地、不外传；用户要删时用 wechat_distill_clear（删单个给 scope，清空全部须 everything=true）。
"""

_HOOK = """\
发送后端（增强版专属）：
- 本档的 send_text / send_file / send_batch **优先走 hook**（微信进程内的本地 HTTP 服务）：
  不抢前台、毫秒级返回、可同时服务多个微信实例。结果里的 `via` 字段会注明 `hook` 还是 `uia`。
- **多账号自动匹配**：按 talker 去各实例的联系人表里找，命中唯一的那个才发；找不到或有歧义会
  报 `target_not_found`，这时先用 list_sessions 拿到确切 wxid，再发。**不要改成广播重发**。
- `via: "hook"` 的成功结果不需要再读库确认；`send_not_confirmed` 仍然适用「先 read_history 看，别重发」。
- hook 端点没起来（没注入 / 版本不匹配）时自动回退到原来的窗口投递，`via` 会是 `uia`；
  想确认当前有没有 hook，看 `check_env` 返回的 `hook` 字段。
"""

# 基础版没有蒸馏与媒体解析，对应段落整段去掉——留着只会教模型去调不存在的工具。
INSTRUCTIONS = (_CORE + (_MEDIA_PRO if _IS_PRO else _MEDIA_LITE) + _WATCH
                + (_DISTILL if _IS_PRO else "")
                + (_HOOK if EDITION == "plus" else "")
                # 过期时在**引导词**里就说清：那是 Agent 调任何工具之前就会读到的位置
                + _expiry.instruction_block())

TOOLS = [
    {"name": "list_sessions",
     "description": "【何时用】用户要看你**本机微信**有哪些会话、或找某个好友/群（拿到它的 talker/name）时。【别用】别人通过 Bot 找这个助手时；——那是渠道(`weixin`)的 Bot 收件箱，与本工具无关。列出**用户本人微信**的会话（显示名 + talker 标识 + 最新消息预览），先用它确定目标会话。",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "可选：按名字/talker/最新消息关键词过滤，用来快速定位目标会话"}},
         "required": []}},
    {"name": "read_history",
     "description": ("【何时用】要读**用户本人微信**里某个好友/群的聊天记录、或据此起草回复时。【别用】想读渠道(Bot)会话时；——那是渠道(`weixin`)的 Bot 收件箱，与本工具无关。读取**用户本人微信**指定会话的历史消息（按时间正序）。"
                     "talker 可传 list_sessions 返回的 name 或 wxid/群号/filehelper。"
                     "消息多时可**翻页**：返回带 `cursor`（本页最老一条 ts）与 `has_more`；要读更早的一页再调一次并传 `before_ts=cursor`（翻页不丢消息：那一页会把边界那一秒补齐，所以可能比 limit 略多几条）。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "limit": {"type": "integer", "description": "条数，默认 10"},
         "before_ts": {"type": "integer", "description": "可选：只返回该 Unix 秒**之前**的消息（翻页用，传上一页返回的 cursor）"}},
         "required": ["talker"]}},
    {"name": "read_image",
     "description": ("【何时用】要看**用户本人微信**里某张图片的**内容**时——read_history/poll_new 返回的图片消息带 `local_id`，用它取。"
                     "【别用】文本消息（read_history 已给全文）；也别拿它当 read_history 的替代。"
                     "返回 MCP 的 **image 内容块**（base64 位图），**不是路径**——客户端可直接送进多模态模型，跨机也不用碰文件系统。"
                     "图是**服务端已解密的明文位图**（微信原图是加密 `.dat`，解密这步早已完成，别以为拿到的是密文）。"
                     "⚠️ 原图没落盘时会自动退到中图/缩略图（可能只有 83×180，截图里的字看不清）——"
                     "随图返回的 text 块里有 `variant`（hd/thumb）和 `bytes`，据此判断看到的是不是高清图。"
                     "体积：原图 base64 后可到数 MB，只取真要看的那些张。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "local_id": {"type": "integer", "description": "read_history/poll_new 返回的该条图片消息的 local_id"},
         "ts": {"type": "integer", "description": "可选：该条消息的 ts（read_history 返回）。local_id 跨时间分片会撞号，给了 ts 才能精确锁定"}},
         "required": ["talker", "local_id"]}},
    {"name": "transcribe_voice",
     "description": ("【何时用】要**听懂一条语音**时——read_history/poll_new 里语音消息带 `local_id`，用它取文字。"
                     "【别用】文本消息（已给全文）；也别拿它当 read_history 的替代。"
                     "**全本地转写**（本地 ASR 模型，音频不外传）；运行前会确认模型就位，"
                     "没有则返回 `asr_unavailable` 并说明怎么装（`wechat-mcp.exe --download-asr-model`）。"
                     "没有自动内联：只在真正要看这条语音时才调它。"
                     "⚠️ 较老的语音**音频可能已被微信清掉**（本机 47 条里 36 条还在），"
                     "这时返回 `voice_unavailable`——**不要据此编内容**，如实告诉用户听不到。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "local_id": {"type": "integer", "description": "read_history/poll_new 返回的该条语音消息的 local_id"},
         "ts": {"type": "integer", "description": "可选：该条消息的 ts（read_history 返回）。local_id 跨时间分片会撞号，给了 ts 才能精确锁定"}},
         "required": ["talker", "local_id"]}},
    {"name": "poll_new",
     "description": ("【何时用】要**实时/增量**盯用户本人微信的新消息时（定时轮询、收到回复后等下文）。"
                     "【别用】渠道(Bot)收件——那是渠道的事；也别用它读历史（用 read_history）。"
                     "返回 `create_time > since_ts` 的消息（正序），每条带 `from_me`/`sender`："
                     "**自己发的也会返回**——用户可能自己在手机上回过了，据此判断还要不要回。"
                     "群消息若 @ 了用户本人，该条带 `at_me: true`（按被 @ 的 wxid 判定，不看昵称）；"
                     "其余消息没有这个字段。"
                     "返回值里的 `next_since_ts` 就是下次该传的 `since_ts`（**不要传墙上时钟的 now**："
                     "同一秒内的消息会被跳过）；首轮起点取 read_history 最后一条的 `ts`。"
                     "本工具是增量快路径（只解密新增的 WAL 帧、只扫有变化的会话表），可以高频调用。"),
     "inputSchema": {"type": "object", "properties": {
         "since_ts": {"type": "integer", "description": "Unix 秒；返回 create_time 严格大于它的消息"}},
         "required": ["since_ts"]}},
    {"name": "check_env",
     "description": ("【何时用】发**引用回复**（reply_to，唯一还需要前台的工具）前，或想诊断微信自动化环境时，自检本机微信（是否运行/窗口可见/最小化/在前台/尺寸·DPI）与数据目录（db_root/db_source）。【别用】与渠道无关。"
                     "**send_text / send_file / send_batch 都不需要它**——它们走投递、不依赖前台。返回 ok=false 时把 hint 转告用户。"),
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "locate_db",
     "description": ("【何时用】换机部署后微信数据读不到、或想确认本机微信数据目录在哪时。只读定位微信 4.x 数据目录："
                     "探测源 = 环境变量 LUMII_WECHAT_DB → 配置 %APPDATA%/Tencent/xwechat/config/*.ini（4.x 自定义目录的权威来源）"
                     "→ 注册表 → 默认路径 → **固定盘有界扫描**（数据目录可能在别的盘）。"
                     "返回 root / source（从哪找到的）/ accounts（所有候选账号）。【别用】发送消息。"),
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "repair_env",
     "description": ("【何时用】check_env / locate_db 报环境异常（窗口最小化收进托盘 / 尺寸漂移 / 前台切不到 / "
                     "数据目录找不到）后，试试一键修复。只做可逆操作：还原微信窗口、把窗口规范化到预设可操作尺寸 "
                     "（1280×820）、重探数据目录。【别用】发送消息（用 send_text）。返回修复前后对比便于判断是否奏效。"),
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "send_text",
     "description": ("【何时用】用户说「给我微信里的某人/某群发条消息」时（**以用户本人身份**，不可撤回）。【别用】回渠道(Bot)消息；那走渠道回执。"
                     "**不需要前台、锁屏也能发**：走窗口消息投递，不移动光标、不动剪贴板、不打断用户操作。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "发送前依次校验：环境 → 目标会话（数据库锚点匹配）→ 输入落地 → 发送生效；"
                     "任一不通过即中止，绝不盲发。失败时 detail 会说明卡在哪一步。"
                     "**text 里不要塞换行**：微信输入框收不下 CR/LF，会被压成一个空格（detail 会如实说明）"
                     "——要发多段就分多次调用，每段一次。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "text": {"type": "string", "description": "要发送的文本（不含换行；多段请分多次调用）"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "text"]}},
    {"name": "send_file",
     "description": ("【何时用】用户说「把这个文件/图片发给微信里的某人/某群」时（**以用户本人身份**，不可撤回）。【别用】渠道附件。"
                     "path 传本地文件**绝对路径**。**不按扩展名分流**：一律走微信的「发送文件」入口"
                     "（驱动文件对话框），图片/视频也照此投递——最终渲染成图片气泡还是文件卡片由微信自己决定。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "注意：微信「语音消息」是按住录音、无法自动化——音频只能**当文件**发。"
                     "**不需要前台、锁屏也能发**（不碰剪贴板/光标/窗口）；"
                     "失败时 detail 会说明卡在哪一步。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "path": {"type": "string", "description": "本地文件的绝对路径"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "path"]}},
    {"name": "send_batch",
     "description": ("【何时用】用户要**把消息发给多个好友/群**（群发、通知、逐个转发同一条）时（**以用户本人身份**，不可撤回）。"
                     "【别用】只发一个目标时——直接用 send_text 更清晰。**默认 dry_run=true 只校验不发送**；"
                     "仅当用户明确要求真发时才传 dry_run=false。对**每个目标独立**走完整校验（环境 → 目标会话 → 输入落地 → 读库确认），"
                     "一个目标失败**不拖累**其余；逐个返回结果与 error_code，便于你向用户汇报哪些成功、哪些没发。"
                     "每条 text **不要塞换行**（微信输入框收不下 CR/LF，会被压成空格）：多段就拆成多条 item。"),
     "inputSchema": {"type": "object", "properties": {
         "messages": {"type": "array", "description": "要逐条发送的项，每项 {talker, text}",
                      "items": {"type": "object", "properties": {
                          "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
                          "text": {"type": "string", "description": "不含换行（微信输入框收不下 CR/LF）；多段拆成多条"}}, "required": ["talker", "text"]}},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["messages"]}},
    {"name": "reply_to",
     "description": ("【何时用】用户说「**引用/回复某条消息**」（带引用的回复）时（**以用户本人身份**，不可撤回）。"
                     "【别用】普通发一条新消息——用 send_text。"
                     "quote 传**要引用那条消息的文字**（在聊天区定位它）；text 是要发的正文。"
                     "**默认 dry_run=true 只校验不发送**；仅当用户明确要求真发时才传 dry_run=false。"
                     "流程：定位该消息 → 右键 → 菜单「引用」→ 输入正文 → 发送；失败会说明卡在哪一步。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "会话显示名或 wxid/群号/filehelper"},
         "quote": {"type": "string", "description": "要引用那条消息的文字（用于在聊天区定位它）"},
         "text": {"type": "string", "description": "要发送的正文"},
         "dry_run": {"type": "boolean", "description": "默认 true（只校验不发送）；真发传 false"}},
         "required": ["talker", "quote", "text"]}},
    {"name": "search_messages",
     "description": ("【何时用】要在**用户本人微信**里按**关键词/时间**找旧消息时（「上周谁提过 X」「张三说过什么」）。"
                     "【别用】渠道(Bot)会话。跨会话检索；给 talker 则只搜该会话。"
                     "每个会话只扫最近 `scanned_per_talker` 条；结果里的 `truncated=true` 表示**有会话被这个上限截断、"
                     "更老的还没扫**——那时别把 0 命中当成「没有」，缩小 `since/until` 再搜一次。"),
     "inputSchema": {"type": "object", "properties": {
         "keyword": {"type": "string"}, "talker": {"type": "string", "description": "可选：限定会话"},
         "since": {"type": "integer", "description": "可选：Unix 秒下界（严格大于）"}, "until": {"type": "integer",
                                                                                    "description": "可选：Unix 秒上界（严格小于）"},
         "limit": {"type": "integer"}}, "required": ["keyword"]}},
    {"name": "list_unread",
     "description": "【何时用】用户问「有哪些没回/没看」、要**批量处理未读**时（返回未读会话 + 最近一条预览）。【别用】渠道(Bot)。",
     "inputSchema": {"type": "object", "properties": {}, "required": []}},
    {"name": "wechat_digest",
     "description": ("【何时用】要**蒸馏用户/好友的画像与行为**时（「我平常怎么说话」「我和谁联系最多」「这个群/这个人大概是谁」「什么时段我活跃」）："
                     "返回**本地确定性统计**（消息量、我发的/对方发的、消息类型分布、活跃时段、最常联系的人、高频词、"
                     "**`self.style` 打字风格实测值**、**`exchange_pairs` 真实对子**、按长度分层的原文）"
                     "＋**代表性样本**，你再据此提炼画像。"
                     "【别用】只想读几条消息（用 read_history）。"
                     "**全本地、只读、不外传**；覆盖微信**所有时间分片**。talker 可选（限定某会话），不给则全局。"
                     "⚠️ 写「口吻/沟通风格」那一栏**优先用 `exchange_pairs`**："
                     "它是**真实对子**（`{them, me}`＝对方说了什么 → 我回了什么），和代聊每轮面对的题面是同一道，"
                     "自带长度匹配/标点习惯/要不要发表情；已按「我回话的长度」分层、两侧都过滤过粘贴内容。"
                     "**必须用 `self.style` 里的实测数字**（`punct_rate_by_len` 尤其要紧），"
                     "**不许拿几条样本目测**——样本以短句居多，目测会得出「几乎不加标点」这种错结论"
                     "（2026-10-10 实测：短句 7% 带标点、13 字以上 71–88% 带，完全不是一回事）。"
                     "`delim_long` 是**断句方式**——长句里**用空格代顿号**的不算标点（本机实测 9%），别归进「无标点」。"
                     "**还要看 `self.style_samples`**——它按长度分层给了原文，26+ 那档就是长句的真实写法。"
                     "写**联系人**画像时同理：`talker` 给了就有 `self.style_from_them` / "
                     "`style_samples_from_them`（**对方**的风格实测），别再目测那几条 `sample_from_them`。"),
     "inputSchema": {"type": "object", "properties": {
         "talker": {"type": "string", "description": "可选：限定某个会话（name 或 wxid/群号）"},
         "limit": {"type": "integer", "description": "每个会话最多扫描条数；默认 0 = **全量**（推荐）。**设了就变有损**：超过它的会话在返回里的 capped_talkers 里列出来，别拿被截断的统计当真值"},
         "since": {"type": "integer", "description": "可选：只统计该 Unix 秒之后的消息（增量蒸馏用）"}},
         "required": []}},
    {"name": "wechat_distill_state",
     "description": ("【何时用】做**增量蒸馏**时：蒸馏完把水位（处理到的最新 ts）用 `action=set` 记下；"
                     "下次先默认读回水位，再用 `wechat_digest(since=水位)` 只处理新消息。【别用】一次全量蒸馏（不需要水位）。"
                     "`scope`：self(默认) / all / 会话名。"),
     "inputSchema": {"type": "object", "properties": {
         "action": {"type": "string", "description": "get（默认）读取 | set 写入"},
         "scope": {"type": "string", "description": "水位键：self（默认）/ all / 会话名"},
         "ts": {"type": "integer", "description": "action=set 时的水位（Unix 秒）"}}, "required": []}},
    {"name": "wechat_distill_clear",
     "description": ("【何时用】用户要**删除蒸馏产物**（隐私 / 一键清除）时：给 `scope`（self 或会话名）删该画像（含备份与水位）；"
                     "**清空全部须显式 `everything=true`**（防误清）。【别用】清无关文件——它**只动** `~/.lumii/wechat-distill/`，不碰微信库。"),
     "inputSchema": {"type": "object", "properties": {
         "scope": {"type": "string", "description": "要删的画像：self 或会话名/wxid（不给则须 everything=true）"},
         "everything": {"type": "boolean", "description": "清空整个产出目录（须显式传 true）"}}, "required": []}},
    {"name": "wechat_profile_save",
     "description": ("【何时用】**把你从 wechat_digest + read_history 提炼出的画像存下来**，供以后复用（「我平常怎么说话」「某人/某群是谁」）。"
                     "content 传 **Markdown 画像正文**（结构建议：身份/关系 · 常聊话题 · 沟通风格 · 关键事实（尽量带时间））。"
                     "scope 留空=**用户本人画像**；给出会话名/wxid 则是**该好友/群的画像**。"
                     "**全本地**写入 `~/.lumii/wechat-distill/`（白盒、可编辑、可删）。【别用】存原始聊天记录。"),
     "inputSchema": {"type": "object", "properties": {
         "scope": {"type": "string", "description": "留空=用户本人；或会话名/wxid/群号（对该会话画像）"},
         "content": {"type": "string", "description": "Markdown 画像正文"}},
         "required": ["content"]}},
    {"name": "wechat_profile_get",
     "description": ("【何时用】要**读回已蒸馏的画像**（「我是谁」「某个好友是谁」）时。"
                     "`scope=\"self\"`（或 me/我/本人）读**用户本人**那份；给会话名/wxid 读该好友/群那份。"
                     "【别用】还没有画像时——应先 wechat_digest + 提炼，再 wechat_profile_save。"
                     "**完全不给 scope** 才只**列出**已产出的画像文件（清单，没有正文）。"),
     "inputSchema": {"type": "object", "properties": {
         "scope": {"type": "string", "description": "self=用户本人；或会话名/wxid/群号；留空=只列出有哪些画像"}}, "required": []}},
]

# 多开：这些工具都接受 `account`（wxid）。省略时沿用进程级选中的账号。
_ACCOUNT_PROP = {
    "type": "string",
    "description": "可选：多开时指定账号 wxid（先用 list_accounts 查）。省略则用当前选中的账号。",
}
_ACCOUNT_TOOLS = {
    "list_sessions", "read_history", "read_image", "transcribe_voice", "poll_new",
    "search_messages", "list_unread", "wechat_digest", "wechat_profile_save",
    "wechat_profile_get", "wechat_distill_state", "wechat_distill_clear",
    "send_text", "send_file", "send_batch", "reply_to", "check_env", "locate_db",
}
for _tool in TOOLS:
    if _tool["name"] in _ACCOUNT_TOOLS:
        _props = _tool.setdefault("inputSchema", {}).setdefault("properties", {})
        _props["account"] = _ACCOUNT_PROP
    if _tool["name"] == "send_batch":
        _tool["inputSchema"]["properties"]["messages"]["items"]["properties"]["account"] = _ACCOUNT_PROP
    if _tool["name"] == "check_env":
        _tool["inputSchema"]["properties"]["pid"] = {
            "type": "integer", "description": "可选：直接指定微信主进程 PID（多开时用它精确锁定实例）",
        }

TOOLS.append({
    "name": "list_accounts",
    "description": ("【何时用】多开/多账号时，先看本机有哪些微信账号、哪些正在运行、对应哪个进程与窗口。"
                    "【别用】只想读会话（用 list_sessions，可带 account）。"
                    "返回每个账号的 wxid / 数据目录 / 是否 running / pid / hwnd，以及当前默认选中的账号。"),
    "inputSchema": {"type": "object", "properties": {}, "required": []},
})

DISPATCH = {"list_sessions": tool_sessions, "read_history": tool_history,
            "list_accounts": tool_accounts,
            "read_image": tool_image, "transcribe_voice": tool_transcribe,
            "poll_new": tool_poll, "check_env": tool_status, "locate_db": tool_locate_db,
            "repair_env": tool_repair_env,
            "send_text": tool_send, "send_file": tool_send_file,
            "send_batch": tool_send_batch, "reply_to": tool_reply,
            "search_messages": tool_search, "list_unread": tool_unread,
            "wechat_digest": tool_digest,
            "wechat_distill_state": tool_distill_state,
            "wechat_distill_clear": tool_distill_clear,
            "wechat_profile_save": tool_profile_save, "wechat_profile_get": tool_profile_get}

# 工具行为提示（MCP tool annotations）：客户端据此决定是否需要用户确认
_READ_ONLY_TOOLS = {"list_sessions", "read_history", "read_image", "poll_new", "check_env", "locate_db",
                    "search_messages", "list_unread", "wechat_digest", "wechat_profile_get"}
# 以用户本人身份对外发出、不可撤回，或删除本地画像
_DESTRUCTIVE_TOOLS = {"send_text", "send_file", "send_batch", "reply_to", "wechat_distill_clear"}
_OPEN_WORLD_TOOLS = {"send_text", "send_file", "send_batch", "reply_to"}


def _annotate_tools(tools):
    """给每个工具补上 annotations（readOnly / destructive / idempotent / openWorld 提示）。"""
    for t in tools:
        name = t["name"]
        read_only = name in _READ_ONLY_TOOLS
        t["annotations"] = {
            "readOnlyHint": read_only,
            "destructiveHint": name in _DESTRUCTIVE_TOOLS,
            "idempotentHint": read_only or name in ("wechat_profile_save", "wechat_distill_state", "repair_env"),
            "openWorldHint": name in _OPEN_WORLD_TOOLS,
        }
    return tools


_annotate_tools(TOOLS)

# --- 档位切分（EDITION 见文件头） -------------------------------------------
# pro = lite + 媒体解析（解密后的图片路径 / 语音转写）+ 用户蒸馏。
# 这里只管「工具列不列得出来」；**拦住直接调用**在 handle_tools_call，
# 两处都得有——只从 TOOLS 删掉的话，模型照样能按名字直接调。
PRO_ONLY_TOOLS = {
    "read_image", "transcribe_voice",
    "wechat_digest", "wechat_distill_state", "wechat_distill_clear",
    "wechat_profile_save", "wechat_profile_get",
}
_GATED_MSG = "该工具属于高级版（pro），当前运行的是基础版（lite）"
_EDITION_LABEL = {"pro": "高级版", "lite": "基础版", "plus": "增强版"}


def _strip_media(payload):
    """基础版返回前剥掉媒体路径，只留 `[图片 17KB]`/`[语音 3.2 秒]` 摘要。

    pro 版原样返回。**在 server 层裁、不动 wechat_core**——core 的职责是把解密后的路径挂上，
    「给不给模型看」是档位策略，不该渗进读取层。
    `video_path` 一并剥（2026-10-14）：档位口径是「路径类的媒体信息 = pro」，
    视频虽是明文 mp4、不需要 key 也不需要模型，但半开半闭更费解——而 `video_md5`/`video_len`
    这类**摘要字段**留着（它们不是路径，和 `image_md5` 同类）。
    """
    if _IS_PRO or not isinstance(payload, dict):
        return payload
    for m in payload.get("messages") or []:
        if isinstance(m, dict):
            m.pop("image_path", None)
            m.pop("voice_path", None)
            m.pop("video_path", None)
    return payload


if not _IS_PRO:
    TOOLS = [t for t in TOOLS if t["name"] not in PRO_ONLY_TOOLS]

# 协议输出通道：启动时锁定真实 stdout，随后把 sys.stdout 指向 stderr，
# 防止业务代码或第三方库的 print 混进 JSON-RPC 流导致客户端解析失败
_PROTOCOL_OUT = sys.stdout


def _send(message):
    """向客户端写一条 JSON-RPC 消息（单行 UTF-8 JSON）。"""
    _PROTOCOL_OUT.write(json.dumps(message, ensure_ascii=False) + "\n")
    _PROTOCOL_OUT.flush()


def reply(mid, result):
    """回应成功结果。"""
    _send({"jsonrpc": "2.0", "id": mid, "result": result})


def reply_error(mid, code, message):
    """回应 JSON-RPC 协议级错误（工具执行失败不走这里，而是 isError=true 的结果）。"""
    _send({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}})


def negotiate_protocol_version(requested):
    """协议版本协商：支持则原样回应，否则回应本服务支持的最新版本。"""
    if requested in SUPPORTED_PROTOCOL_VERSIONS:
        return requested
    return SUPPORTED_PROTOCOL_VERSIONS[0]


def handle_initialize(params):
    """处理 initialize：协商版本，声明 tools 能力与服务信息。"""
    return {
        "protocolVersion": negotiate_protocol_version(params.get("protocolVersion")),
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": SERVER_NAME, "title": f"本机微信（{_EDITION_LABEL[EDITION]}）",
                       "version": SERVER_VERSION, "edition": EDITION},
        "instructions": INSTRUCTIONS,
    }


def _emit_progress(token, message, progress, total=None):
    """向客户端发一条 `notifications/progress`（MCP 规范：progress 单调递增、带原始 token）。

    只在客户端**主动带了** `progressToken` 时调用——不带 token 的上报是无主的，规范也不允许。
    """
    params = {"progressToken": token, "progress": progress, "message": message}
    if total is not None:
        params["total"] = total
    _send({"jsonrpc": "2.0", "method": "notifications/progress", "params": params})


# 有阶段可播报的工具（发送路径才有；只读工具没必要、也不该为它去 import wechat_sender）
_PROGRESS_TOOLS = {"send_text", "send_file", "send_batch", "reply_to"}


def handle_tools_call(mid, params):
    """处理 tools/call：未知工具/参数非法属协议错误；工具内部异常以 isError 结果返回给模型。"""
    name = params.get("name")
    args = params.get("arguments")
    if args is None:
        args = {}
    gate = _expiry.gate_error()
    if gate is not None:                       # 过了内置有效期：不干活，只把"该做什么"端出去
        log("expired", name)
        reply(mid, {"content": [{"type": "text", "text": json.dumps(gate, ensure_ascii=False)}],
                    "isError": False})
        return
    if not _IS_PRO and name in PRO_ONLY_TOOLS:
        reply_error(mid, INVALID_PARAMS, _GATED_MSG)
        return
    handler = DISPATCH.get(name)
    if handler is None:
        reply_error(mid, INVALID_PARAMS, f"Unknown tool: {name}")
        return
    if not isinstance(args, dict):
        reply_error(mid, INVALID_PARAMS, "arguments 必须是对象")
        return
    log("call", name)
    import time as _t
    _t0 = _t.perf_counter()
    # 进度：客户端带了 `_meta.progressToken` 时，把发送层的阶段/重试上报出去（界面据此显示实时状态）
    meta = params.get("_meta")
    token = meta.get("progressToken") if isinstance(meta, dict) else None
    progress_installed = False
    m_sender = None
    if token is not None and name in _PROGRESS_TOOLS:
        import wechat_sender as m_sender
        m_sender.set_progress(
            lambda message, progress, total=None: _emit_progress(token, message, progress, total))
        progress_installed = True
    try:
        # 多开：每次工具调用先切到目标账号（缺省=自动挑最新），读/发就都落在同一个号上。
        account = args.get("account")
        core.set_account(account if isinstance(account, str) else None)
        data = handler(args)
        _dt = (_t.perf_counter() - _t0) * 1000
        if _dt > 1000:
            # 观测用：读取侧正常几十毫秒。客户端报「请求超时」时，比对这一行就能分清
            # 是**工具本身慢**（这里也慢）还是**子进程被饿着/主进程卡住**（这里很快、那边很慢）
            log(f"slow: {name} 用了 {_dt:.0f}ms")
        # 绝大多数工具返回 dict → 序列化成一条 text 块。`read_image` 例外：它要内联位图，
        # 用 `_mcp_content` 直接交出 content 列表（MCP 规范里 image 块就该这么返回，
        # 客户端可原样送进多模态模型，无需碰文件系统）。
        blocks = data.pop("_mcp_content", None) if isinstance(data, dict) else None
        # 版本门落点（**唯一**一处，见 §9.9）：不在真机验证范围内的微信版本，把这句告警跟着
        # 每个结果出去——只写进 check_env 等于没有，Agent 不会每次先调它，而"静默给错数据"
        # 是这套代码最坏的失败形态（内存偏移/窗口类名/AutomationId 都是硬绑版本的假设）。
        _vw = core.version_warning()
        if _vw and isinstance(data, dict):
            data["version_warning"] = _vw
        reply(mid, {"content": blocks if blocks is not None
                    else [{"type": "text", "text": json.dumps(data, ensure_ascii=False)}],
                    "isError": False})
    except Exception as e:
        # 栈写进 stderr（客户端握手后仍保留尾部），返回值里带类型名，避免空的 `ERROR:`
        log("error", name, traceback.format_exc())
        reply(mid, {"content": [{"type": "text", "text": format_tool_error(e)}], "isError": True})
    finally:
        # 装了就必须还原（哪怕原来没有回调）——否则进度槽会泄漏到下一次调用，
        # 把上一条请求的 token 带出去。
        if progress_installed and m_sender is not None:
            m_sender.set_progress(None)


def handle_message(msg):
    """分发单条 JSON-RPC 消息；通知（无 id）不回应，未知请求回 Method not found。"""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        reply_error(msg.get("id") if isinstance(msg, dict) else None, INVALID_REQUEST, "Invalid Request")
        return
    method = msg.get("method")
    if not isinstance(method, str):
        # 客户端发来的响应（本服务不发请求）或畸形消息：有 id 才回错误
        if "id" in msg and "result" not in msg and "error" not in msg:
            reply_error(msg.get("id"), INVALID_REQUEST, "Invalid Request")
        return
    is_notification = "id" not in msg
    mid = msg.get("id")
    params = msg.get("params")
    if not isinstance(params, dict):
        params = {}

    if is_notification:
        # notifications/initialized、notifications/cancelled 等：按规范不回应
        return
    if method == "initialize":
        reply(mid, handle_initialize(params))
    elif method == "ping":
        reply(mid, {})
    elif method == "tools/list":
        reply(mid, {"tools": TOOLS})
    elif method == "tools/call":
        handle_tools_call(mid, params)
    else:
        reply_error(mid, METHOD_NOT_FOUND, f"Method not found: {method}")


# 一键安装的规格（`--install` / `--uninstall` / `--install-status`，实现见共享层 mcp_install.py）。
# `product` 是**两档各自的标识**（台账目录名 / 技能包在 exe 里的目录名）——**两档必须不同**：
# pro 与 lite 是两份独立分发，同名会互相覆盖。它**不再**等于"部署目录名"：装的时候不拷贝 exe，
# 注册进客户端的就是用户手上这份 exe 的当前位置（`mcp_install.own_exe()`）。
# `version`：四件套走 `mcp_stdio.serve()`，那边会自己把版本填进 spec；**主产品没走那条路**，
# 所以曾经漏了这个键——后果是"重装时看不到 v 旧 → v 新"、状态里也读不出装的是哪版。填上。
# `skill` 是源码模式下的技能包源；冻结后技能包**打进 exe**（构建脚本把 `skills/wechat-mcp-<档位>`
# 映射成 `skills/<product>`），由 mcp_install.skill_source 从 `sys._MEIPASS` 取。
INSTALL_SPEC = {
    "name": SERVER_NAME,
    "product": {"pro": "wechat-mcp", "lite": "wechat-mcp-lite",
                "plus": "wechat-mcp-plus"}[EDITION],
    "version": SERVER_VERSION,
    "skill": os.path.join(HERE, "skills", f"wechat-mcp-{EDITION}"),
    "label": f"本机微信（{_EDITION_LABEL[EDITION]}）",
}


def _exit_with_parent():
    """打成单文件 exe 后随父进程退出。

    PyInstaller onefile 是「引导进程 → Python 子进程」两层，MCP 客户端停服务只杀得到引导进程；
    子进程若正卡在一次长发送里，就会残留下来占着 exe 文件（部署更新换不掉）和微信 UI 操作锁。
    实测：杀掉引导进程后子进程照常存活。这里起一个守护线程等父进程句柄，父进程一没就立即退出。
    """
    if not getattr(sys, "frozen", False) or os.name != "nt":
        return
    import ctypes
    import threading
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    k32.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
    handle = k32.OpenProcess(0x00100000, False, os.getppid())  # SYNCHRONIZE
    if not handle:
        return

    def wait_parent():
        k32.WaitForSingleObject(handle, 0xFFFFFFFF)
        os._exit(0)

    threading.Thread(target=wait_parent, name="parent-watch", daemon=True).start()


def main():
    """stdio 主循环：逐行读取 JSON-RPC 消息，直到 stdin 关闭。"""
    global _PROTOCOL_OUT
    _exit_with_parent()
    force_utf8_stdio()
    _PROTOCOL_OUT = sys.stdout
    sys.stdout = sys.stderr
    log(f"started v{SERVER_VERSION} (python {sys.version.split()[0]})")
    log("expiry:", _expiry.describe(_expiry.status()))
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            reply_error(None, PARSE_ERROR, "Parse error")
            continue
        try:
            handle_message(msg)
        except Exception as e:  # 兜底：单条消息出错不能拖垮整个服务
            log("internal error", repr(e))
            if isinstance(msg, dict) and "id" in msg and msg.get("method"):
                reply_error(msg.get("id"), -32603, f"Internal error: {e}")


def cmd_image_key(args):
    """`--image-key`：抓一次图片 AES key 并落盘。返回进程退出码（0 成功 / 1 没扫到）。

    图片 AES key 的**唯一用户入口**（对照 `--download-asr-model`：都是一次性的慢准备）。
    为什么非得给 exe 一个开关：`read_image` 是 pro 的招牌工具，而 key 不在消息里、也不在
    任何配置文件里，只能扫微信进程内存（只读、不注入）。没有这个开关时，**装好的 exe
    永远读不出图**——devcli 只在源码树里，宿主 App 也没有这个界面。
    慢（本机约 50 秒）且必须在**微信里点开过一张图**之后跑，所以只做显式触发、绝不自动。
    """
    import wechat_image
    refresh = "--refresh" in args
    k = wechat_image.image_aes_key(refresh=refresh)
    if not k:
        print(json.dumps({"ok": False, "hint": "扫不到：先在微信里点开一张图片（大图界面），再跑一次"},
                         ensure_ascii=False))
        return 1
    print(json.dumps({"ok": True, "path": wechat_image._key_path(), "refreshed": refresh,
                      "hint": "已抓取并落盘，之后 read_image 不用再抓（key 是账号级的）"},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    # 诊断开关在 main() 之前就打印，编码得先钉住——否则中文输出是控制台代码页（见函数注释）
    force_utf8_stdio()
    if "--version" in sys.argv[1:]:
        print(SERVER_VERSION)
        sys.exit(0)
    if "--edition" in sys.argv[1:]:
        # 构建冒烟用：这份 exe 是哪一档。现在运行期档位 == 构建档位（授权降级已移除），
        # 但**照旧报构建档位**：冒烟的判据该是"打的是什么"，不该被构建机上任何状态影响。
        print(_BUILT_EDITION)
        sys.exit(0)
    if "--image-key" in sys.argv[1:]:
        sys.exit(cmd_image_key(sys.argv[1:]))
    if "--download-asr-model" in sys.argv[1:]:
        # 显式下载，不做成"首次调用自动下"：78MB 悄悄下会让人以为卡死，离线环境还会白等
        import wechat_asr
        wechat_asr.download_model()
        sys.exit(0)
    if "--expiry-status" in sys.argv[1:]:
        # 排障用：有效期状态 + 生效档位（过了有效期以非零码退出，脚本里拦得住）
        _st = _expiry.status()
        print(json.dumps({"effective_edition": EDITION, "status": _st,
                          "human": _expiry.describe(_st)}, ensure_ascii=False, indent=2))
        sys.exit(0 if _st["ok"] else 1)
    # 一键安装（`--install` / `--uninstall` / `--install-status`，实现见共享层 mcp_install.py）。
    # **必须在这之前拦下**，否则它们会被当成"没有参数"而进 MCP 循环，然后挂在那儿等 stdin。
    import mcp_install
    _rc = mcp_install.consume_flags(sys.argv[1:], INSTALL_SPEC)
    if _rc is not None:
        sys.exit(_rc)
    # 没给任何开关，而 stdin 是**终端** ⇒ 用户是双击（或在终端里直接敲）来的，
    # 面对的是一个人，不是 MCP 客户端。给他走安装向导，别让黑窗口干挂着。
    if mcp_install.is_interactive():
        sys.exit(mcp_install.interactive(INSTALL_SPEC))
    main()
