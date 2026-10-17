"""filecore 纯函数单测（不碰微信、秒级）。运行：python test_filecore.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0），
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 测试**假失败**
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import filecore as F

# 真机样本（2026-10-12 从本机库取出的原始 XML，缩短了 cdnattachurl）
SAMPLE = (
    '<msg><appmsg><title>绿色圣诞.md</title><type>6</type>'
    '<appattach><totallen>4262</totallen><fileext>md</fileext></appattach>'
    '</appmsg></msg>'
)
# 标题里带 HTML 实体（真实出现过：&#x20;）
SAMPLE_ENTITY = (
    '<msg><appmsg><title>四川省天府分部2000元&#x20;(3).pdf</title><type>6</type>'
    '<appattach><totallen>154974</totallen><fileext>pdf</fileext></appattach></appmsg></msg>'
)
QUOTE = '<msg><appmsg><title>某人: 你好</title><type>57</type><refermsg><content>你好</content></refermsg></appmsg></msg>'
PLAIN = '在吗'


def _idx(tmp):
    """在临时目录里造几个真文件，走**真** build_index（含日期前缀别名）。"""
    import tempfile
    root = tempfile.mkdtemp(dir=tmp)
    layout = {
        "2026-09": {"绿色圣诞.md": b"a" * 10},
        "2026-08": {"报告.pdf": b"b" * 100, "20260812 证书.pdf": b"c" * 999},
        "2026-10": {"报告.pdf": b"d" * 200},
    }
    paths = {}
    for sub, fs in layout.items():
        os.makedirs(os.path.join(root, sub))
        for name, data in fs.items():
            p = os.path.join(root, sub, name)
            with open(p, "wb") as fh:
                fh.write(data)
            paths[name] = p
    return F.build_index(root), paths

def test_parse_file():
    fm = F.parse_file_msg(SAMPLE)
    assert fm == {"title": "绿色圣诞.md", "size": 4262, "ext": "md"}, fm
    assert F.parse_file_msg(QUOTE) is None, "引用(57)不是文件"
    assert F.parse_file_msg(PLAIN) is None, "纯文本不是文件"
    print("ok parse_file")


def test_parse_entity():
    fm = F.parse_file_msg(SAMPLE_ENTITY)
    assert fm["title"] == "四川省天府分部2000元 (3).pdf", fm
    assert fm["size"] == 154974 and fm["ext"] == "pdf"
    print("ok parse_entity")


def test_match(tmp):
    idx, _ = _idx(tmp)
    assert F.match_file(idx, "绿色圣诞.md", 10) == (idx["绿色圣诞.md"][0][1], "ok")
    # 同名不同大小 → 取大小命中的那一个
    assert F.match_file(idx, "报告.pdf", 200)[0] == idx["报告.pdf"][1][1]
    # 同名但给的大小都不符 → size_mismatch（另一版本），仍给出一个路径
    p, st = F.match_file(idx, "报告.pdf", 999999)
    assert st == "size_mismatch" and p, (p, st)
    # 日期前缀：消息标题没有前缀，磁盘有 → 别名命中
    assert F.match_file(idx, "证书.pdf", 999)[1] == "ok"
    # 磁盘没有 → missing
    assert F.match_file(idx, "不存在.zip", 1) == (None, "missing")
    print("ok match")


def test_dest_path():
    used = set()
    rec = {"title": "a/b:c.pdf", "ext": "pdf", "name": "客户群", "talker": "x", "ts": 111}
    d1 = F._dest_path(r"D:\out", rec, "by_session", used)
    # `by_session` 必须与导出**同一棵树**（`<会话名>/files/`），且会话目录由 `session_subdir` 定
    # ——这里对着那个函数断言，而不是对着字面量：谁单方面改了目录结构，这条就红。
    assert os.path.dirname(d1) == os.path.join(F.E.session_subdir(r"D:\out", "客户群"), "files"), d1
    assert d1.endswith("a_b_c.pdf"), d1
    # 同目录同名 → 加时间戳消歧
    d2 = F._dest_path(r"D:\out", rec, "by_session", used)
    assert "(111)" in d2, d2
    assert F._dest_path(r"D:\out", rec, "by_type", set()).startswith(os.path.join(r"D:\out", "pdf"))
    assert F._dest_path(r"D:\out", rec, "flat", set()) == os.path.join(r"D:\out", "a_b_c.pdf")
    print("ok dest_path")


def test_index_has_no_stale_cache(tmp):
    """索引**不复用**上一次的结果：归档后微信又下了一个文件，必须看得见。

    曾经按 root 永久缓存 → 「报 8 条过期 → 用户去下载 → 再跑还报过期」，而"过期预警 →
    下载 → 归档"正是本产品的卖点路径。
    """
    root = os.path.join(tmp, "no_stale")
    os.makedirs(root)
    open(os.path.join(root, "a.pdf"), "wb").write(b"a" * 10)
    assert "a.pdf" in F.build_index(root)
    open(os.path.join(root, "b.pdf"), "wb").write(b"b" * 20)   # 模拟"之后新下载的"
    assert "b.pdf" in F.build_index(root), "新落盘的文件必须能被下一次扫描看到"
    print("ok index_no_stale_cache")


def test_archive_never_overwrites(tmp):
    """同名不同版本 → 另存带时间戳的名字，**不覆盖**上次归档的那份。"""
    dest = os.path.join(tmp, "out")
    os.makedirs(dest)
    old = os.path.join(tmp, "old.pdf")
    new = os.path.join(tmp, "new.pdf")
    open(old, "wb").write(b"x" * 100)
    open(new, "wb").write(b"x" * 999)
    rec = {"title": "a.pdf", "ext": "pdf", "name": "客户群", "talker": "x", "ts": 111,
           "local_path": new}
    assert F._sizes_equal(old, old) and not F._sizes_equal(old, new)
    assert not F._conflict(os.path.join(dest, "还不存在.pdf"), new), "目标不存在不算冲突"
    assert not F._conflict(new, new), "同一份不算冲突"
    assert F._conflict(old, new), "同名不同大小 = 冲突"

    target = os.path.join(dest, "客户群", "files", "a.pdf")
    os.makedirs(os.path.dirname(target))
    with open(target, "wb") as f:
        f.write(b"x" * 100)                                    # 上次归档的那一版（100 字节）
    assert F._conflict(target, new), "盘上已有一份且不是同一份 → 要换名"
    d = F._dest_path(dest, rec, "by_session", set())
    assert d != target and "(111)" in d, d
    with open(old, "rb") as f:
        assert f.read() == b"x" * 100, "上次归档的内容不该被动过"
    print("ok archive_never_overwrites")


def test_disk_usage_accounting(tmp):
    """`disk_usage` 的分账要**对得上账**：独占 + 共享 + 无主 == msg/file 总量。

    这是本工具唯一容易骗人的地方：同一份文件被多个会话引用时，"按会话求和"会把它数不止一遍
    （真机实测求和 1039 MB > 磁盘 896 MB）。要是拿这个数去说"删了它就能省 400 MB"，就是假话。
    """
    acct = os.path.join(tmp, "acct")
    froot = os.path.join(acct, "msg", "file")
    for sub in ("2026-09", "2026-10"):
        os.makedirs(os.path.join(froot, sub))
    os.makedirs(os.path.join(acct, "msg", "video"))
    os.makedirs(os.path.join(acct, "db_storage"))
    sizes = {(("2026-09", "a.pdf")): 100, (("2026-09", "shared.bin")): 300,
             (("2026-10", "orphan.zip")): 7}
    for (sub, name), n in sizes.items():
        open(os.path.join(froot, sub, name), "wb").write(b"x" * n)
    open(os.path.join(acct, "msg", "video", "v.mp4"), "wb").write(b"v" * 50)

    def fake_recs():
        return [
            {"local_path": os.path.join(froot, "2026-09", "a.pdf"), "name": "会话A",
             "ts": 1757000000, "ext": "pdf"},
            {"local_path": os.path.join(froot, "2026-09", "shared.bin"), "name": "会话A",
             "ts": 1757000000, "ext": "bin"},
            {"local_path": os.path.join(froot, "2026-09", "shared.bin"), "name": "会话B",
             "ts": 1757000000, "ext": "bin"},
            {"local_path": None, "name": "会话B", "ts": 1757000000, "ext": "zip"},  # 缺失的跳掉
        ]

    old_db, old_froot, old_lf = F.core.db_root, F.core.files_root, F.list_files
    F.core.db_root = lambda: os.path.join(acct, "db_storage")
    F.core.files_root = lambda: froot
    F.list_files = fake_recs
    try:
        d = F.disk_usage()
    finally:
        F.core.db_root, F.core.files_root, F.list_files = old_db, old_froot, old_lf

    by = {s["name"]: s for s in d["sessions"]}
    assert by["会话A"]["own_bytes"] == 100 and by["会话A"]["own_files"] == 1, by["会话A"]
    assert by["会话B"]["own_bytes"] == 0, "B 没有独占文件"
    assert by["会话A"]["shared_bytes"] == 300 and by["会话B"]["shared_bytes"] == 300, by
    assert d["shared_bytes"] == 300, "共享体积按**去重**算，不是每见一次加一遍"
    assert d["sessions"][0]["name"] == "会话A", "按引用量排序"
    assert d["file_unattributed"] == {"bytes": 7, "files": 1}, d["file_unattributed"]
    own = sum(s["own_bytes"] for s in d["sessions"])
    assert own == d["file_own_bytes"], "会话没被截断时，求和应等于给的总量"
    assert d["file_own_bytes"] + d["shared_bytes"] + d["file_unattributed"]["bytes"] == d["file_bytes"], \
        f"对不上账：{d['file_own_bytes']} + {d['shared_bytes']} + " \
        f"{d['file_unattributed']['bytes']} != {d['file_bytes']}"
    assert d["file_bytes"] == 407 and d["file_files"] == 3, (d["file_bytes"], d["file_files"])
    # 另两块大头只报小计，别假装能归属
    assert {t["path"] for t in d["msg_trees"]} == {"file", "video"}, d["msg_trees"]
    assert d["total_bytes"] > d["file_bytes"], "账号总量含 db_storage 等"
    print("ok disk_usage（独占/共享/无主 对得上账）")


def test_disk_usage_real():
    """真机只读冒烟（无微信库时跳过）：真实数据上那条不变式也得成立。"""
    try:
        root = F.core.db_root()
    except Exception as e:                              # noqa: BLE001
        print(f"skip disk_usage 冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip disk_usage 冒烟（无数据目录）")
        return
    d = F.disk_usage()
    total = d["file_own_bytes"] + d["shared_bytes"] + d["file_unattributed"]["bytes"]
    assert total == d["file_bytes"], f"真机也对不上账：{total} != {d['file_bytes']}"
    # 会话榜是截断的（默认前 20）：**别拿它求和去验账**，这一条本机实测差 9.6 KB
    assert sum(s["own_bytes"] for s in d["sessions"]) <= d["file_own_bytes"]
    trees = {t["path"]: t["bytes"] for t in d["msg_trees"]}
    print(f"ok disk_usage 真机：账号 {d['total_bytes']/1048576:.0f} MB，"
          f"其中 msg/file {d['file_bytes']/1048576:.0f} MB"
          f"（独占 {d['file_own_bytes']/1048576:.0f} + 共享 {d['shared_bytes']/1048576:.0f} + "
          f"无主 {d['file_unattributed']['bytes']/1048576:.0f}），"
          f"video {trees.get('video', 0)/1048576:.0f} MB，{d['session_count']} 个会话有文件")


def test_needs_wechat():
    """真机只读冒烟（无微信库时跳过，不算失败）。"""
    try:
        core_root = F.core.db_root()
    except Exception as e:                              # noqa: BLE001
        print(f"skip 真机冒烟（取不到库: {e}）")
        return
    if not core_root or not os.path.isdir(core_root):
        print("skip 真机冒烟（无数据目录）")
        return
    recs = F.list_files()
    ok = sum(1 for r in recs if r["status"] != "missing")
    print(f"ok 真机冒烟：文件消息 {len(recs)} 条，可定位 {ok} 条，缺失 {len(recs) - ok} 条")


def test_talker_by_display_name():
    """真机只读冒烟（无微信库时跳过）：**会话显示名**必须能筛，解析不出必须报错。

    这是 P0 的回归。修之前 `list_files(talker="文件传输助手")` = **0 条**（显示名被喂给
    `tbl_of` = md5(username)，算出张不存在的表），而 `list_files(talker="filehelper")` = 13 条
    ——工具描述里教用户的恰恰是显示名那个用法，而且返回的是**成功**的空结果。
    """
    try:
        root = F.core.db_root()
    except Exception as e:                              # noqa: BLE001
        print(f"skip 显示名冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 显示名冒烟（无数据目录）")
        return
    name = F.core.names().get("filehelper")
    if not name:
        print("skip 显示名冒烟（本机没有文件传输助手）")
        return
    by_name = F.list_files(talker=name)
    by_id = F.list_files(talker="filehelper")
    assert by_name and by_name == by_id, f"显示名与 username 必须等价：{len(by_name)} vs {len(by_id)}"
    try:
        F.list_files(talker="绝对不存在的会话xyz")
    except F.core.UnknownTalker:
        pass
    else:
        raise AssertionError("解析不出的会话名必须抛 UnknownTalker，不能静默返回 0 条")
    print(f"ok 显示名等价：{name} == filehelper（{len(by_name)} 条），不存在的名字会被拒")


if __name__ == "__main__":
    import tempfile
    _tmp = tempfile.mkdtemp()
    try:
        test_parse_file()
        test_parse_entity()
        test_match(_tmp)
        test_dest_path()
        test_index_has_no_stale_cache(_tmp)
        test_archive_never_overwrites(_tmp)
        test_disk_usage_accounting(_tmp)
        test_disk_usage_real()
        test_needs_wechat()
        test_talker_by_display_name()
    finally:
        import shutil as _sh
        _sh.rmtree(_tmp, ignore_errors=True)
    print("ALL PASS")
