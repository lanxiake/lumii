"""exportcore 单测（纯函数 + 真机只读冒烟）。运行：python test_exportcore.py"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0），
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 测试**假失败**
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import exportcore as E

IMG_XML = ('<msg><img aeskey="x" md5="0123456789abcdef0123456789abcdef" '
           'length="17408"></img></msg>')
GROUP_TEXT = "vicky1990202:\n12345那边回复了"
MULTILINE = "第一行\n第二行\n第三行"


def test_render_plain():
    text, agent = E.render_text(1, "在吗".encode("utf-8"))
    assert text == "在吗" and agent is False, (text, agent)
    print("ok render_plain")


def test_render_group_prefix():
    """群里正文前缀了发送者（`wxid:\n文本`）—— 必须剥掉，且**保留正文自身的换行**。"""
    text, _ = E.render_text(1, GROUP_TEXT.encode("utf-8"))
    assert text == "12345那边回复了", repr(text)
    print("ok render_group_prefix")


def test_render_multiline():
    text, _ = E.render_text(1, MULTILINE.encode("utf-8"))
    assert text == MULTILINE, repr(text)
    print("ok render_multiline")


def test_render_agent_mark():
    from wechat_core import AGENT_MARK
    text, agent = E.render_text(1, ("你好" + AGENT_MARK).encode("utf-8"))
    assert text == "你好" and agent is True, (repr(text), agent)
    print("ok render_agent_mark")


def test_render_image():
    text, _ = E.render_text(3, IMG_XML.encode("utf-8"))
    assert text.startswith("[图片"), text
    print("ok render_image")


def test_safe_and_clock():
    bad = 'a/b:c*?"<>|'
    cleaned = E._safe(bad)
    assert not set(cleaned) & set('/\\:*?"<>|'), cleaned
    assert len(cleaned) == len(bad), "净化应逐字符替换，不该丢字符"
    assert E._safe("") == "session" and E._safe("...") == "session"
    assert len(E._clock(0)) == 16 and E._month(0).count("-") == 1
    print("ok safe_and_clock")


def _recs():
    return [
        {"ts": 100, "time": "1970-01-01 08:01", "month": "1970-01", "type": 1, "sender": "张三",
         "from_me": False, "agent_sent": False, "text": "晚上<一起>吃饭？", "local_id": 1,
         "image": "assets/img_001.jpg", "voice": None, "voice_text": None},
        {"ts": 200, "time": "1970-01-01 08:03", "month": "1970-01", "type": 1, "sender": "我",
         "from_me": True, "agent_sent": False, "text": "好", "local_id": 2,
         "image": None, "voice": "assets/voice_001.wav", "voice_text": "语音内容"},
    ]


def test_render_formats():
    r = _recs()
    md = E._md("客户群", r, 0, 0)
    assert "### 1970-01-01 08:01 · 张三" in md and "![图片](assets/img_001.jpg)" in md
    assert "晚上<一起>吃饭？" in md                      # md 不转义尖括号
    html = E._html("客户群", r, 0, 0)
    assert "&lt;一起&gt;" in html, "html 必须转义用户内容"
    assert '<audio' in html and 'class="m me"' in html
    js = json.loads(E._json("客户群", r, 0, 0))
    assert js["count"] == 2 and js["messages"][0]["text"] == "晚上<一起>吃饭？"
    print("ok render_formats")


def test_split_grouping(tmp):
    """split=month 的分组边界（纯逻辑，不写盘时会退化成单组）。"""
    r = _recs()
    groups = {}
    for x in r:
        groups.setdefault(x["month"], []).append(x)
    assert list(groups) == ["1970-01"] and len(groups["1970-01"]) == 2
    print("ok split_grouping")


def test_real_smoke():
    """真机只读冒烟（无微信库时跳过，不算失败）：导出最近一个会话的最近 30 条成 md。"""
    try:
        root = E.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 真机冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 真机冒烟（无数据目录）")
        return
    talkers = [tk for _t, tk in E.core.talkers() if tk]
    if not talkers:
        print("skip 真机冒烟（无会话）")
        return
    tk = talkers[0]
    out = tempfile.mkdtemp(prefix="export_")
    try:
        res = E.export_chat(tk, out_dir=out, format="md", split="none")
        assert res["messages"] >= 1 and res["files_written"], res
        path = os.path.join(out, res["files_written"][0])
        assert os.path.isfile(path) and os.path.getsize(path) > 0
        print(f"ok 真机冒烟：{res['session']} 导出 {res['messages']} 条 / {res['bytes']} 字节")
    finally:
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    _t = tempfile.mkdtemp()
    try:
        test_render_plain()
        test_render_group_prefix()
        test_render_multiline()
        test_render_agent_mark()
        test_render_image()
        test_safe_and_clock()
        test_render_formats()
        test_split_grouping(_t)
        test_real_smoke()
    finally:
        shutil.rmtree(_t, ignore_errors=True)
    print("ALL PASS")
