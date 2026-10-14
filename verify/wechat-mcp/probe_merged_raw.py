# -*- coding: utf-8 -*-
"""合并转发（appmsg type=19）的**取字段**验尸：`_num(raw,"type")` 到底读出几。

怀疑点：`_attr` 是裸 `re.search('type="..."')`，而 `<recorditem>` 里的
`<dataitem datatype="1">` 含子串 `type="1"`。若 `<type>19</type>`（元素）之前没有
任何 `type="` 属性，`_num` 就会先命中 `datatype`，把 type=19 读成 1 —— 于是合并转发
被标成 `[链接]`、我新加的「（N 条）」分支永不触发。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_merged_raw.py
只读：只复制到临时镜像再解密，不碰微信原始文件。
"""
import os
import re
import shutil
import sqlite3
import sys

MCP = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp"
sys.path.insert(0, MCP)

import wechat_core as wc                                            # noqa: E402


def plain(km, root, rel):
    try:
        return wc._plain(km, root, rel)                             # noqa: SLF001
    except PermissionError:
        shutil.rmtree(wc.MIRROR_DIR, ignore_errors=True)
        os.makedirs(wc.MIRROR_DIR, exist_ok=True)
        return wc._plain(km, root, rel)                             # noqa: SLF001


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    root = wc.db_root()
    km = wc.keys(root)
    rels = {os.path.basename(r).lower(): r.replace("\\", "/") for _k, r in km.values()}
    main_rel = next(r for k, r in rels.items() if k.startswith("message_") and k[8:-3].isdigit())
    con = sqlite3.connect("file:%s?mode=ro" % plain(km, root, main_rel).replace("\\", "/"), uri=True)

    n19 = n57 = n3 = 0
    for t, in con.execute("select name from sqlite_master where type='table' and name like 'Msg_%'"):
        for (content,) in con.execute('select message_content from "%s"' % t):
            raw = wc.decode(content) if not isinstance(content, str) else content
            if not raw:
                continue
            if "<img " in raw and n3 < 3:
                n3 += 1
                old = (re.search('length="([^"]*)"', raw) or [None, ""])[1]
                print("=" * 70)
                print("img 原始：\n%s" % raw[:400])
                print("  旧 _attr(length) = %r（命中 cdnthumblength 才是缩略图）" % old)
                print("  新 _attr(length) = %r" % wc._attr(raw, "length"))
                print("  describe_nontext(3) = %s" % wc.describe_nontext(3, raw))
            elif "<recorditem" in raw and n19 < 3:
                n19 += 1
                print("=" * 70)
                print("原始前 700 字符：\n%s" % raw[:700])
                print("-" * 70)
                print("  _attr(raw,'type') = %r" % wc._attr(raw, "type"))
                print("  _tag(raw,'type')  = %r" % wc._tag(raw, "type"))
                print("  _num(raw,'type')  = %r" % wc._num(raw, "type"))
                print("  describe_nontext  = %s" % wc.describe_nontext(49, raw))
                items = wc.merged_forward(raw)
                print("  merged_forward    = %d 条" % len(items))
                for it in items[:4]:
                    print("     %s" % it)
            elif "<refermsg>" in raw and "<type>57</type>" in raw and n57 < 2:
                n57 += 1
                print("=" * 70)
                print("57 原始前 500 字符：\n%s" % raw[:500])
                print("  → %s" % wc.describe_nontext(49, raw))
    con.close()
    print("\n样本：type19=%d type57=%d" % (n19, n57))


if __name__ == "__main__":
    main()
