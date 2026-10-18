# -*- coding: utf-8 -*-
"""密钥查找与残缺缓存（不需要微信、不扫内存）。

跑法：`python test_key_lookup.py`

盯梢日志里反复出现的 `ERROR:` 来自两件事叠在一起：
1. 用 `next()` 找密钥，找不到时 `StopIteration` 的 `str()` 是空串；
2. 微信刚启动时扫到的残缺密钥表被缓存 10 分钟，于是每拍都撞同一个空错误。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402
import server  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    """打印一条断言；失败记下来，一轮看完。"""
    print(("  [ok] " if cond else "  [!!] ") + name + (f"  —— {detail}" if detail and not cond else ""))
    if not cond:
        FAILS.append(name)


def test_lookup_does_not_raise_stopiteration():
    km = {"salt": ("abc", "message/message_0.db")}
    check("斜杠不同仍能对上", core.lookup_db_key(km, "message\\message_0.db") == "abc")
    check("没有这个库返回 None", core.lookup_db_key(km, "contact/contact.db") is None)
    check("空表返回 None", core.lookup_db_key({}, "message/message_0.db") is None)
    try:
        next(x for x in [])
    except StopIteration as e:
        check("StopIteration 的文案是空的（这就是 ERROR: 的来源）", str(e) == "")


def test_incomplete_scan_is_not_cached():
    root = "test-root-incomplete"
    core._key_cache.pop(root, None)
    cached = core.remember_keys(root, {"a": ("k", "message/message_0.db")}, {"deadbeef"})
    check("还有库没扫到就不进缓存", cached is False and root not in core._key_cache)
    cached = core.remember_keys(root, {"a": ("k", "message/message_0.db")}, set())
    check("扫全了才进缓存", cached is True and root in core._key_cache)
    core._key_cache.pop(root, None)


def test_format_tool_error_never_blank():
    text = server.format_tool_error(StopIteration())
    check("空异常也带类型名", text.startswith("ERROR: StopIteration:"), text)
    check("文案不是单独的 ERROR:", text.strip() != "ERROR:")
    text2 = server.format_tool_error(RuntimeError("密钥没了"))
    check("有文案的异常保留原文", "密钥没了" in text2, text2)


if __name__ == "__main__":
    test_lookup_does_not_raise_stopiteration()
    test_incomplete_scan_is_not_cached()
    test_format_tool_error_never_blank()
    if FAILS:
        print("FAILED", len(FAILS))
        sys.exit(1)
    print("ok")
