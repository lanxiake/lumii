# -*- coding: utf-8 -*-
"""内置有效期：产物在**构建时**钉死一个到期时刻，到期后拒绝一切工具调用。

授权（授权密钥 / RSA 验签 / 按产品分 scope / 灵栖内置豁免 / pro→lite 降级）已于
2026-10-13 整体移除——交付一张需要用户往 MCP 配置里贴的密钥，摩擦比它挡住的东西大。
现在整条产品线（主产品 wechat-mcp + 四件套）只有一条规则：

    **这份 exe 是哪天打的，就能用到哪天。**

到期时刻由**构建脚本**注入：往打包的源码副本里写一个 `expiry.py`（`BUILT_EXPIRY = <unix 秒>`，
见 `apps/windows/scripts/build-wechat-mcp.mjs` 与四件套的四个构建脚本），工作区**不落**这个文件。
所以跑源码（`python server.py`）不判到期——那是开发/测试场景，与"构建期注入"是同一个口子。

为什么还要防时钟回拨：有效期是**唯一**的约束，把系统时间调回去是最省事的绕过方式（10 秒的事）。
`<数据根>/.state.json` 记「见过的最大时间」，当前时间明显倒退即按到期处理。
它挡不住改代码 / 改二进制——那从来不是这个机制的职责（见 README 的诚实说明）。
"""
import json
import os
import time

# 时钟回拨容差：允许的"倒退"秒数（时区 / 夏令时 / 小幅 NTP 校正不该判死）
CLOCK_SKEW_TOLERANCE = 86400


def _data_dir():
    """状态落点（用户级，与 exe 目录分离）。

    整条产品线共用一个——授权时代按产品分目录是因为 scope 不同，现在没有 scope 了。
    可用 `LUMII_WECHAT_EXPIRY_DIR` 覆盖（测试用）。
    """
    override = os.environ.get("LUMII_WECHAT_EXPIRY_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".lumii", "wechat-mcp")


def _state_path():
    return os.path.join(_data_dir(), ".state.json")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def built_expiry():
    """构建期注入的到期时刻；源码运行（没有 `expiry.py`）返回 0 = 不判。"""
    try:
        from expiry import BUILT_EXPIRY      # 构建期生成，工作区里没有这个文件
        return int(BUILT_EXPIRY)
    except Exception:                        # noqa: BLE001 —— 缺文件/写坏了都当"没注入"
        return 0


def status(now=None):
    """完整状态 → `{ok, reason, exp, days_left}`。`reason` 用于排障与提示。"""
    now = int(now if now is not None else time.time())
    exp = built_expiry()
    if not exp:
        return {"ok": True, "reason": "dev", "exp": 0, "days_left": None}

    # 防时钟回拨：记「见过的最大时间」，当前时间明显倒退即判到期
    state = _read_json(_state_path()) or {}
    max_seen = int(state.get("max_seen") or 0)
    if now < max_seen - CLOCK_SKEW_TOLERANCE:
        return {"ok": False, "reason": "clock_rollback", "exp": exp, "days_left": 0}
    if now > max_seen:
        state["max_seen"] = now
        _write_json(_state_path(), state)

    days_left = int((exp - now) // 86400)
    if now > exp:
        return {"ok": False, "reason": "expired", "exp": exp, "days_left": days_left}
    return {"ok": True, "reason": "ok", "exp": exp, "days_left": days_left}


def describe(st):
    """一行状态（也用在 `--expiry-status` 与工具返回里）。"""
    if st["reason"] == "dev":
        return "源码运行（不判有效期）"
    when = time.strftime("%Y-%m-%d", time.localtime(st["exp"]))
    if st["reason"] == "expired":
        return f"已过有效期（到期 {when}）"
    if st["reason"] == "clock_rollback":
        return f"系统时间被回拨，按过期处理（到期 {when}）"
    return f"有效期内（到期 {when}，剩 {st['days_left']} 天）"


def how_to_fix(st):
    """给用户看的**动手步骤**（Agent 原话转达这个）。"""
    if st["reason"] == "expired":
        return "这份 exe 的有效期已到（到期 %s）。向发行方索取新版本，重新装一次就能继续用。" % (
            time.strftime("%Y-%m-%d", time.localtime(st["exp"])))
    if st["reason"] == "clock_rollback":
        return "系统时间被回拨过（本产品据此判到期）。把时间校准后重试。"
    return ""


def instruction_block():
    """到期时塞进 `initialize.instructions` 的一段话。

    为什么要走 `instructions`：那是 Agent **在调任何工具之前**就会读到的位置。
    光靠工具报错的话，它会先白调一次、甚至把 `expired` 当成别的问题。
    """
    st = status()
    if st["ok"]:
        return ""
    return (
        "\n⚠️ 本服务**已过有效期**，任何工具调用都会被拒绝（error_code=expired）。\n"
        f"   状态：{describe(st)}\n"
        f"   {how_to_fix(st)}\n"
        "   先把上面这段原话转达给用户，别反复重试工具。\n"
    )


def gate_error():
    """到期时的工具返回（与四件套统一的失败信封同形）。"""
    st = status()
    if st["ok"]:
        return None
    return {
        "ok": False,
        "detail": f"本服务已停用：{describe(st)}",
        "error_code": "expired",
        "stage": "expiry",
        "suggestion": "把 hint 里的步骤转达给用户；这是产物本身到期了，重试工具不会有用。",
        "hint": how_to_fix(st),
    }


if __name__ == "__main__":
    # 排障入口：`python builtin_expiry.py` 打印有效期状态
    st = status()
    print(json.dumps({"status": st, "human": describe(st)}, ensure_ascii=False, indent=2))
