# -*- coding: utf-8 -*-
"""内置有效期的自测（不需要微信、不碰真数据，秒级）。

跑法：`python test_expiry.py`（本机可用 `%USERPROFILE%\\.lumii\\runtimes\\python-embed\\python.exe`）。

为什么这门测试必须存在：失效方式是**静默放行**——`builtin_expiry` 取不到注入的到期时刻就
当 0（= 不判），于是过期产物照样全功能可用、还不报错。源码运行恰好也走这条路，
所以"在源码里跑一遍没问题"**证明不了任何事**，必须显式把到期时刻注入进去再验。

注入方式与构建期一致：往 `sys.modules` 塞一个 `expiry` 模块（构建脚本写的是同名文件）。
"""
import os
import sys
import tempfile
import time
import types

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import builtin_expiry as E  # noqa: E402

FAILS = []
DAY = 86400


def check(name, cond, detail=""):
    """打印一条断言结果；失败记进 FAILS（不中断，一轮看完所有问题）。

    标记用 ASCII：Windows 控制台代码页是 GBK，一个 `✅` 就够让整轮测试抛 UnicodeEncodeError
    ——而那是"测试挂了"，会被读成"代码有问题"。同门那套 `test_*` 也都是纯文本。
    """
    print(("  [ok] " if cond else "  [!!] ") + name + (f"  —— {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def use_expiry(exp):
    """注入构建期那个 `expiry.py` 的效果。`exp=None` = 撤掉（回到源码运行）。"""
    if exp is None:
        sys.modules.pop("expiry", None)
        return
    mod = types.ModuleType("expiry")
    mod.BUILT_EXPIRY = exp
    sys.modules["expiry"] = mod


def use_statedir(d):
    os.environ["LUMII_WECHAT_EXPIRY_DIR"] = d


def read_state(d):
    """读回状态文件（看 max_seen 有没有被写进去）。"""
    import json
    p = os.path.join(d, ".state.json")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    tmp = tempfile.mkdtemp(prefix="expiry-test-")
    use_statedir(tmp)
    now = int(time.time())

    print("=== 源码运行（没有注入到期时刻）===")
    use_expiry(None)
    st = E.status(now)
    check("不判到期", st["ok"] and st["reason"] == "dev", str(st))
    check("exp = 0", st["exp"] == 0, str(st))
    check("不拦工具", E.gate_error() is None)
    check("引导词里不插话", E.instruction_block() == "")
    check("describe 说清是源码运行", "源码运行" in E.describe(st), E.describe(st))

    print("=== 有效期内 ===")
    use_expiry(now + 30 * DAY)
    st = E.status(now)
    check("放行", st["ok"] and st["reason"] == "ok", str(st))
    check("剩余天数 ≈ 30", st["days_left"] == 30, str(st["days_left"]))
    check("不拦工具", E.gate_error() is None)
    expect_when = time.strftime("%Y-%m-%d", time.localtime(now + 30 * DAY))
    check("describe 带到期日", expect_when in E.describe(st) and "剩 30 天" in E.describe(st),
          E.describe(st))

    print("=== 已过期 ===")
    use_expiry(now - 2 * DAY)
    st = E.status(now)
    check("判过期", not st["ok"] and st["reason"] == "expired", str(st))
    gate = E.gate_error()
    check("门禁是失败信封", isinstance(gate, dict) and gate.get("ok") is False, str(gate))
    check("error_code = expired", gate.get("error_code") == "expired", str(gate))
    check("stage = expiry", gate.get("stage") == "expiry", str(gate))
    check("带了动手步骤", bool(gate.get("hint")) and "新版本" in gate["hint"], str(gate.get("hint")))
    check("带了处置建议", bool(gate.get("suggestion")), str(gate.get("suggestion")))
    block = E.instruction_block()
    check("引导词里先写明", "已过有效期" in block and "expired" in block, block[:80])

    print("=== 时钟回拨 ===")
    # 先让状态文件记住「现在」，再报一个明显倒退的时刻
    use_expiry(now + 365 * DAY)
    E.status(now)
    back = E.status(now - 30 * DAY)
    check("回拨判过期", not back["ok"] and back["reason"] == "clock_rollback", str(back))
    check("回拨的提示是校准时间", "校准" in E.how_to_fix(back), E.how_to_fix(back))
    # 容差之内（时区/夏令时/小幅 NTP）不该判死
    E.status(now)
    skew = E.status(now - 60)
    check("小幅倒退仍在容差内", skew["ok"], str(skew))
    # `gate_error()` 读的是**真实当前时间**，所以"回拨"这条路走不到——除非水位被推到未来。
    # 这正是要验的：真被回拨的机器上，门禁必须真的拦（光判 status 不算数）。
    use_statedir(tempfile.mkdtemp(prefix="expiry-future-"))
    E.status(now + 100 * DAY)                              # 水位 = 未来 100 天
    gate_back = E.gate_error()
    check("回拨也拦工具", gate_back is not None and gate_back["error_code"] == "expired",
          str(gate_back))

    print("=== 状态文件 ===")
    use_expiry(now + 10 * DAY)
    fresh = tempfile.mkdtemp(prefix="expiry-state-")
    use_statedir(fresh)
    E.status(now)
    check("max_seen 落盘", read_state(fresh).get("max_seen") == now, str(read_state(fresh)))
    E.status(now - 100)                                    # 再往前一点点：不该把水位改小
    check("水位只增不减", read_state(fresh).get("max_seen") == now, str(read_state(fresh)))
    check("落盘失败也不崩", _state_write_failure_is_survivable(tmp))

    print("=== describe 的表要覆盖所有 reason ===")
    # 表里少一档，用户会看到裸的 reason 码；多一档，后来的人会以为那条路还在。
    seen = set()
    # 第 4 条要先把水位推到 `prime`，否则每次全新的状态目录都判不出回拨
    for exp, when, prime in ((None, now, None), (now + DAY, now, None),
                             (now - DAY, now, None), (now + DAY, now - 30 * DAY, now)):
        use_expiry(exp)
        use_statedir(tempfile.mkdtemp(prefix="expiry-r-"))
        if prime is not None:
            E.status(prime)
        stt = E.status(when)
        seen.add(stt["reason"])
        check(f"describe({stt['reason']}) 不是裸码",
              E.describe(stt) != stt["reason"], E.describe(stt))
    check("四种 reason 都被走到", seen == {"dev", "ok", "expired", "clock_rollback"}, str(seen))

    print("=== 真实模块不依赖工作区里有 expiry.py ===")
    check("工作区没有 expiry.py 这个文件",
          not os.path.exists(os.path.join(HERE, "expiry.py")),
          "构建期生成的文件不该落进工作区")

    print()
    print("结果：" + ("全部通过" if not FAILS else f"{len(FAILS)} 项失败 -> {FAILS}"))
    return 1 if FAILS else 0


def _state_write_failure_is_survivable(_tmp):
    """状态目录不可写时，`status()` 仍要给出结论（不能因为记不下水位就崩）。"""
    bad = os.path.join(tempfile.mkdtemp(prefix="expiry-bad-"), "not-a-dir")
    open(bad, "w").close()                                 # 拿一个**文件**当目录用 → makedirs 必失败
    use_statedir(bad)
    try:
        return E.status(int(time.time()))["ok"] is True
    except Exception:                                      # noqa: BLE001
        return False
    finally:
        os.environ.pop("LUMII_WECHAT_EXPIRY_DIR", None)


if __name__ == "__main__":
    sys.exit(main())
