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
    return F.build_index(root, {}), paths


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
    assert d1 == os.path.join(r"D:\out", "客户群", "a_b_c.pdf"), d1
    # 同目录同名 → 加时间戳消歧
    d2 = F._dest_path(r"D:\out", rec, "by_session", used)
    assert "(111)" in d2, d2
    assert F._dest_path(r"D:\out", rec, "by_type", set()).startswith(os.path.join(r"D:\out", "pdf"))
    assert F._dest_path(r"D:\out", rec, "flat", set()) == os.path.join(r"D:\out", "a_b_c.pdf")
    print("ok dest_path")


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


if __name__ == "__main__":
    import tempfile
    _tmp = tempfile.mkdtemp()
    try:
        test_parse_file()
        test_parse_entity()
        test_match(_tmp)
        test_dest_path()
        test_needs_wechat()
    finally:
        import shutil as _sh
        _sh.rmtree(_tmp, ignore_errors=True)
    print("ALL PASS")
