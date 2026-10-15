# -*- coding: utf-8 -*-
"""好友↔标签映射在哪：`contact_label` 只有标签名，找 `contact` 里哪个字段带标签 id。

只打印**结构与计数**，样例里的名字只截前两个字，避免把通讯录原样落进终端记录。
"""
import os
import shutil
import sqlite3
import sys

sys.path.insert(0, r"C:\myself\projects\my\open-source\lumii\apps\windows\resources\wechat-mcp")
import wechat_core as wc                                            # noqa: E402


def mirror(rel):
    """刷新并返回某个库的明文镜像路径（镜像被占用时清空重建一次）。"""
    try:
        m = wc._mirror(rel)                                         # noqa: SLF001
        m.refresh()
        return m.out
    except PermissionError:
        shutil.rmtree(wc.MIRROR_DIR, ignore_errors=True)
        os.makedirs(wc.MIRROR_DIR, exist_ok=True)
        m = wc._mirror(rel)                                         # noqa: SLF001
        m.refresh()
        return m.out


def varint(buf, i):
    """读一个 protobuf varint，返回 `(值, 下一个位置)`。"""
    v = s = 0
    while True:
        b = buf[i]
        i += 1
        v |= (b & 0x7F) << s
        if b < 0x80:
            return v, i
        s += 7


def fields(buf):
    """把一段 protobuf 粗解成 `[(field_no, wire_type, value)]`；解不动返回 None。"""
    out, i = [], 0
    try:
        while i < len(buf):
            key, i = varint(buf, i)
            fn, wt = key >> 3, key & 7
            if wt == 0:
                v, i = varint(buf, i)
            elif wt == 2:
                n, i = varint(buf, i)
                v = bytes(buf[i:i + n])
                i += n
            elif wt == 5:
                v = bytes(buf[i:i + 4]); i += 4
            elif wt == 1:
                v = bytes(buf[i:i + 8]); i += 8
            else:
                return None
            if fn == 0:
                return None
            out.append((fn, wt, v))
        return out
    except IndexError:
        return None


def main():
    """打印 contact 表结构、contact_label 全量、extra_buffer 各字段的分布。"""
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    db = mirror("contact/contact.db")
    con = sqlite3.connect("file:%s?mode=ro" % db.replace(os.sep, "/"), uri=True)
    print("--- 表 ---")
    for (n,) in con.execute("select name from sqlite_master where type='table'"):
        cols = [r[1] for r in con.execute('pragma table_info("%s")' % n)]
        print("  %-28s %s" % (n, cols))
    print("--- contact_label ---")
    for r in con.execute("select * from contact_label"):
        print("   %r" % (r,))

    cols = [r[1] for r in con.execute('pragma table_info("contact")')]
    blob_cols = [c for c in cols if "buf" in c.lower() or "label" in c.lower()]
    print("contact 里疑似列：", blob_cols)
    for c in cols:
        if "label" in c.lower():
            print("--- %s 非空样例 ---" % c)
            for r in con.execute('select username, "%s" from contact where "%s" is not null '
                                 'and "%s" <> \'\' limit 10' % (c, c, c)):
                print("   %r" % (r,))

    stat = {}
    n = 0
    samples = {}
    for u, buf in con.execute("select username, extra_buffer from contact where extra_buffer is not null"):
        n += 1
        fs = fields(buf or b"")
        if not fs:
            continue
        for fn, wt, v in fs:
            stat.setdefault((fn, wt), 0)
            stat[(fn, wt)] += 1
            if wt == 2 and (fn, wt) not in samples and v:
                samples[(fn, wt)] = v[:40]
    print("--- extra_buffer 字段分布（%d 行）---" % n)
    for k in sorted(stat):
        print("   field %-3d wt %d  rows %-5d  sample %r" % (k[0], k[1], stat[k], samples.get(k, "")))
    con.close()


if __name__ == "__main__":
    main()
