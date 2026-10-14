# -*- coding: utf-8 -*-
"""端到端：把**真含合并转发/引用**的那个会话真导一次，看 md/html 里到底出没出内容。

只读（导出到临时目录）；跑法：
PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_forward_export.py
"""
import os
import re
import shutil
import sqlite3
import sys
import tempfile

RES = r"C:\myself\projects\my\open-source\lumii\apps\windows\resources"
sys.path.insert(0, os.path.join(RES, "wechat-mcp"))
sys.path.insert(0, os.path.join(RES, "wechat-export-mcp"))

import exportcore as E                                              # noqa: E402
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

    # 哪个 Msg_<md5> 表里有合并转发 / 引用 → 反查是哪个会话
    by_tbl = {}
    for shard_rel in sorted(r for k, r in rels.items()
                            if re.match(r"^message_\d+\.db$", k)):
        con = sqlite3.connect("file:%s?mode=ro" % plain(km, root, shard_rel).replace("\\", "/"), uri=True)
        for t, in con.execute("select name from sqlite_master where type='table' and name like 'Msg_%'"):
            for (c,) in con.execute('select message_content from "%s"' % t):
                raw = wc.decode(c)
                if "<recorditem" in raw or "<refermsg>" in raw:
                    by_tbl.setdefault(t, [0, 0])
                    by_tbl[t][0 if "<recorditem" in raw else 1] += 1
        con.close()
    print("含转发/引用的表：%s" % by_tbl)
    if not by_tbl:
        print("本机没有可验的样本"); return

    names = wc.names()
    tbl2u = {wc.tbl_of(u): u for u in names}
    for tbl, (nf, nq) in sorted(by_tbl.items(), key=lambda x: -(x[1][0] + x[1][1]))[:4]:
        u = tbl2u.get(tbl)
        if not u:
            print("  %s → 反查不到会话" % tbl); continue
        disp = names.get(u, u)
        out = tempfile.mkdtemp(prefix="fwd_")
        try:
            res = E.export_chat(disp, out_dir=out, format="md", split="none")
            md = open(os.path.join(out, res["files_written"][0]), encoding="utf-8").read()
            res2 = E.export_chat(disp, out_dir=out, format="html", split="none")
            html = open(os.path.join(out, res2["files_written"][0]), encoding="utf-8").read()
            print("=" * 74)
            print("会话 %s（%s）：%d 条消息 ｜ 表内 转发=%d 引用=%d" % (disp, u, res["messages"], nf, nq))
            print("  md  含「转发的聊天记录」= %s ｜ 含「←」引用行 = %s"
                  % ("转发的聊天记录" in md, " ← " in md))
            print("  html 含 class=fw = %s ｜ 含 「←」 = %s"
                  % ('class="fw"' in html, " ← " in html))
            for line in md.splitlines():
                if "转发的聊天记录" in line or " ← " in line:
                    print("     %s" % line[:100])
                    for nxt in md.splitlines()[md.splitlines().index(line) + 1:][:3]:
                        print("       %s" % nxt[:100])
                        if not nxt.startswith(">"):
                            break
                    break
        finally:
            shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    main()
