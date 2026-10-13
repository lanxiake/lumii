# -*- coding: utf-8 -*-
"""四件套共用的**授权门禁**：验签、机器绑定、按产品分 scope。

**复用 `licensing.py`**（主产品那套，已经被 `test_licensing.py` 钉过：验签 / 指纹命中 / 到期 /
时钟回拨 / 内置豁免）。这里只加三件它没有的：

1. **分产品的 scope**。主产品是「pro/lite 双档，授权把 lite 升成 pro」，而降级总还能用；
   四件套是**单档要卖**，语义不同：**未授权就是不给用**。所以 scope 要能区分
   `wechat-file-mcp` / … / 打包的 `wechat-toolkits`。
2. **落点区分**：主产品的授权读 `~/.lumii/wechat-mcp/license.json`；四件套读
   `~/.lumii/wechat-toolkits/license.json`。走的正是 `licensing` 自己留下的
   `LUMII_WECHAT_LICENSE_DIR` 覆盖口（它的注释写的就是"测试与**多份授权并存**的场景要用"），
   所以**不必改 `licensing.py` 一行**。
3. **给用户看的出口**：`--license-status`，以及 MCP 侧的 `not_licensed`。
   （**没有 `--machine-id`**：新密钥不绑机器，机器码在四件套里已是死概念。）

**为什么门禁放在"工具调用"而不是"拒绝启动"**：服务器连不上，用户和 Agent 看到的只是
"这个 MCP 挂了"，没有任何可操作信息；而结构化地拒绝每一次工具调用，Agent 能把
「没有授权文件、授权文件该放哪、怎么拿机器码」原话转达给用户。所以 `initialize` 照常，
只在 `instructions` 里写明，工具调用处拦。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 四件套的授权与状态落点（与主产品分开：一份打包授权能覆盖四个，各产品也能单独签）
DATA_DIRNAME = os.path.join(".lumii", "wechat-toolkits")

# 一份授权能解锁的范围写在这里。除产品自己的 id 外，允许这两个"打包"写法。
BUNDLE_SCOPES = ("wechat-toolkits", "all")


def data_dir():
    return os.path.join(os.path.expanduser("~"), DATA_DIRNAME)


def _bind_env():
    """把授权落点指到四件套自己的目录，**然后**才 import `licensing`。

    `licensing._data_dir()` 是调用时读环境的，所以顺序无所谓；用 `setdefault` 是为了
    让用户/测试还能用同一个环境变量把它掰到别处（与 `licensing` 的约定一致）。
    """
    os.environ.setdefault("LUMII_WECHAT_LICENSE_DIR", data_dir())


_bind_env()
import licensing  # noqa: E402


def license_path():
    return licensing.license_path()


def status(scope):
    """本产品的授权状态 → `licensing.check()` 的结果，另加 `scope_ok` / `scope_want`。

    `licensing.check()` 不认 scope（主产品只有一档），所以这里补上。
    """
    st = dict(licensing.check())
    want = (scope,) + BUNDLE_SCOPES
    got = (st.get("scope") or "").strip()
    st["scope_want"] = " 或 ".join(want)
    if st.get("ok"):
        st["scope_ok"] = got in want
    else:
        st["scope_ok"] = False          # 没通过校验就不必谈 scope
    st["ok"] = bool(st.get("ok")) and st["scope_ok"]
    return st


def describe(st):
    """一行给人看的说明（`licensing.describe` 上再补 scope 那一句）。"""
    line = licensing.describe(st)
    if st.get("scope_ok") is False and st.get("reason") == "ok":
        line += f"，但这张授权的 scope 是「{st.get('scope') or '空'}」，不含本产品"
    return line


def how_to_fix(st):
    """给用户看的**动手步骤**（Agent 原话转达这个）。"""
    env = licensing.LICENSE_KEY_ENV
    if st.get("reason") == "missing" or (st.get("scope_ok") is False
                                         and st.get("reason") == "ok"):
        return (f"在 MCP 客户端配置里给本服务加环境变量：\"env\": {{\"{env}\": \"<发行方给的授权密钥>\"}}，"
                f"保存后重启该 MCP 服务。\n"
                f"    （旧版授权文件仍兼容，位置：{license_path()}）\n"
                f"    这份授权要覆盖本产品，scope 需为 {st.get('scope_want')}。")
    return {
        "bad_key": f"环境变量 {env} 的值不是合法的授权密钥（复制不全或多了字符？）。"
                   f"重新完整粘贴发行方给的密钥后重启该 MCP 服务。",
        "bad_signature": "授权签名不合法（被改过？）。重新向发行方要一份。",        "expired": "授权已过期。向发行方续期。",
        "clock_rollback": "系统时间被回拨过（本产品据此防绕过到期）。把时间调准后重试。",
        "machine_mismatch": "这张授权绑定的不是这台机器。用本机机器码重新签发。",
        "bundled": "",
    }.get(st.get("reason"), f"授权异常（{st.get('reason')}）。见 {license_path()}")


def instruction_block(scope):
    """未授权时塞进 `initialize.instructions` 的一段话。

    为什么要走 `instructions`：那是 Agent **在调任何工具之前**就会读到的位置。
    光靠工具报错的话，Agent 会先白调一次、甚至把 `not_licensed` 当成别的问题。
    """
    st = status(scope)
    if st["ok"]:
        return ""
    return (
        "\n⚠️ 本服务**尚未授权**，任何工具调用都会被拒绝（error_code=not_licensed）。\n"
        f"   状态：{describe(st)}\n"
        f"   {how_to_fix(st)}\n"
        "   环境变量只在服务启动时读取，配好后需重启该 MCP 服务。\n"
        "   先把上面这段原话转达给用户，别反复重试工具。\n"
    )


def gate_error(scope):
    """未授权时的工具返回（与四件套统一的失败信封同形）。"""
    st = status(scope)
    if st["ok"]:
        return None
    return {
        "ok": False,
        "detail": f"本服务未授权：{describe(st)}",
        "error_code": "not_licensed",
        "stage": "license",
        "suggestion": "把 hint 里的步骤转达给用户；授权是用户的事，重试工具不会有用。",
        "hint": how_to_fix(st),
        "license_key_env": licensing.LICENSE_KEY_ENV,
        "license_path": license_path(),
    }
