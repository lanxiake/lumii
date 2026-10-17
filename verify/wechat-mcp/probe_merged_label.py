# -*- coding: utf-8 -*-
"""合并转发**在读路径上到底渲染成什么**：全库扫 `<recorditem`，逐条打印
`describe_nontext(49, raw)` + `merged_forward(raw)` 条数 + 真实原始 XML 的头尾。

怀疑点：`describe_nontext` 的 `is_refer = "<refermsg" in raw` 是**裸子串匹配**，
而 `<recorditem>` 的 CDATA 里转发进来的内容本身就可能含 `<refermsg>`/`<type>`
⇒ kind 被翻成「引用」、`_tag(raw,"type")` 可能读到 CDATA 里的 `<type>`。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_merged_label.py
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

    n = 0
    stats = {}
    for shard in sorted(r for k, r in rels.items() if re.match(r"^message_\d+\.db$", k)):
        con = sqlite3.connect("file:%s?mode=ro" % plain(km, root, shard).replace("\\", "/"), uri=True)
        for t, in con.execute("select name from sqlite_master where type='table' and name like 'Msg_%'"):
            for (content,) in con.execute('select message_content from "%s"' % t):
                raw = wc.decode(content) if not isinstance(content, str) else content
                if "<recorditem" not in raw:
                    continue
                n += 1
                out = wc.describe_nontext(49, raw)
                items = wc.merged_forward(raw)
                has_refer = "<refermsg" in raw
                sub = wc._num(raw, "type")                          # noqa: SLF001
                stats[(sub, has_refer)] = stats.get((sub, has_refer), 0) + 1
                if has_refer and sub == 19:                    # 被误标成「引用」的那一类
                    m = re.search(r"<refermsg", raw)
                    print("=" * 78)
                    print("  _num(raw,'type') = %r ｜ 含 '<refermsg' = %s ｜ 真展开 %d 条"
                          % (sub, has_refer, len(items)))
                    print("  describe_nontext → %s" % out)
                    print("  refermsg 首次出现在第 %d 字符（全串长 %d）" % (m.start(), len(raw)))
                    print("  ↓ refermsg 前后 500 字符：")
                    print(raw[max(0, m.start() - 300):m.start() + 500])
        con.close()
    print("\n共 %d 条含 recorditem；分布 (type, 含refermsg) → 条数：" % n)
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print("   %s → %d" % (k, v))


def search_check():
    """**后果验证**：只出现在合并转发内部的话，检索得到吗？（`search_messages` 只匹配 `_render`）"""
    for kw in ("自助服务终端", "你刚才说的移动端", "地图鱼"):
        r = wc.search_messages(kw, limit=5)
        print("  搜 %-12s → %d 条 %s" % (kw, r["count"],
              [m["text"][:40] for m in r["messages"][:2]]))


if __name__ == "__main__":
    main()
    print("\n=== 检索（只匹配 _render 的结果）===")
    search_check()
