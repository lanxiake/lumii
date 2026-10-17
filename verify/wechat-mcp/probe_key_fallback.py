# -*- coding: utf-8 -*-
"""密钥链路 A/B：**强制关掉快路径**，看无偏移兜底能不能自己把密钥挖出来。

为什么要单独做这个：`wxkey4._blob_keys_from_node` 的快路径按 4.1.15 实测布局读
（`node+0x28` → 对象 `+0x88` → `{ptr@+0x8,len@+0x10}`），后面跟一段"无偏移兜底"
（逐个 qword 当指针试，判据是 `verify_enc_key` 验签）。源码注释写着兜底**没在第二个
微信版本上验证过**——那"换版本"的正确性就全押在它身上。

**同一个版本上就能验**：把 `_FAST_NODE_PTR_OFF` 拨成越界值 ⇒ 快路径必然落空 ⇒ 只剩兜底。
A/B 两次都拿到密钥，才说明兜底是活的（而不是从来没被执行过的一段死代码）。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_key_fallback.py
只读：只 PROCESS_VM_READ，不注入、不写微信任何东西。
"""
import sys
import time

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402
import wxkey4                                                       # noqa: E402


def run(tag, force_generic, root):
    """跑一遍密钥扫描 → `(密钥数, stats 累加, 耗时)`；`force_generic` 时关掉快路径。"""
    saved = wxkey4._FAST_NODE_PTR_OFF                               # noqa: SLF001
    if force_generic:
        # 拨到必然越界的值：`0x10000 <= config_ptr < MAX_USER_ADDRESS` 过不去 → 直落兜底
        wxkey4._FAST_NODE_PTR_OFF = 0x8                             # noqa: SLF001
    try:
        files, s2d = wxkey4.collect_db_files(root)
        km, rem = {}, set(s2d)
        agg = {"nodes": 0, "candidates": 0, "verified": 0, "generic_hits": 0, "needles": 0}
        t0 = time.time()
        for _m, pid in wxkey4.find_wechat_pids():
            if not rem:
                break
            st = wxkey4.scan_pid(pid, files, s2d, km, rem)
            for k in agg:
                agg[k] += st.get(k, 0)
        dt = time.time() - t0
        print("[%s] 密钥 %d/%d  耗时 %.1fs  字样=%d 节点=%d 候选=%d 通过=%d 兜底命中=%d"
              % (tag, len(km), len(s2d), dt, agg["needles"], agg["nodes"],
                 agg["candidates"], agg["verified"], agg["generic_hits"]))
        return km, agg
    finally:
        wxkey4._FAST_NODE_PTR_OFF = saved                           # noqa: SLF001


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    v = wc.wechat_version()
    print("微信 %s（verified=%s）" % (v["version"], v["verified"]))
    root = wc.db_root()
    print("数据目录 %s" % root)
    km_fast, _ = run("A 快路径", False, root)
    km_gen, agg = run("B 强制兜底", True, root)
    # 判据：两条路得到的密钥必须**逐字节相同**，且兜底那次确实走了兜底代码
    ok_same = {k: v[0] for k, v in km_fast.items()} == {k: v[0] for k, v in km_gen.items()}
    print("两条路密钥一致：%s ｜ 兜底命中 %d 次" % (ok_same, agg["generic_hits"]))
    assert ok_same, "快路径与兜底给出的密钥不一致——必有一条是错的"
    assert km_gen, "兜底路径一条密钥都没挖出来 ⇒ 它救不了换版本"
    assert agg["generic_hits"] > 0, "兜底代码根本没被执行 ⇒ 这次 A/B 什么也没验到"
    print("PASS：无偏移兜底在本版本上自证可用（换版本正确性的前提成立）")


if __name__ == "__main__":
    main()
