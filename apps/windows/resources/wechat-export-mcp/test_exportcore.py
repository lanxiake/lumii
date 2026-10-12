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


def test_args_are_validated():
    """非法枚举值必须被**挑出来**，不许静默降级。

    原先 `media="image"`（拼错）会连着两次比较都不命中 → 一颗媒体都不出、也不报错，
    调用方拿到的还是 `isError=false` 的正常结果，"参数打错"与"这批消息没图"分不出来。
    """
    ok = {"talker": "x", "out_dir": "D:\\x", "format": "md", "media": "all", "split": "month"}
    assert E.bad_args(ok) == [], E.bad_args(ok)
    assert E.bad_args({}) == [], "没给的可选参数不该算错"
    for bad in ("image", "IMAGE", "imgs"):          # 空串/None 按"没给"处理（server 里回落默认值）
        got = E.bad_args({"media": bad})
        assert got and "media" in got[0], (bad, got)
    assert "format" in E.bad_args({"format": "pdf"})[0]
    assert "split" in E.bad_args({"split": "week"})[0]
    # 合法值只有一份来源：schema 的 enum 与校验读的是同一个元组
    assert set(E._MEDIA) == {"none", "images", "all"} and E._SPLIT == ("none", "month")
    print("ok args_are_validated")


def test_real_display_name_talker():
    """真机只读冒烟（无微信库时跳过）：会话**显示名**能导出，解析不出要报错。"""
    try:
        root = E.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 显示名冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 显示名冒烟（无数据目录）")
        return
    name = E.core.names().get("filehelper")
    if not name:
        print("skip 显示名冒烟（本机没有文件传输助手）")
        return
    data = E.build_records(name)
    assert data["records"] and data["talker"] == "filehelper", (len(data["records"]), data["talker"])
    try:
        E.build_records("绝对不存在的会话xyz")
    except E.core.UnknownTalker:
        pass
    else:
        raise AssertionError("解析不出的会话名必须抛 UnknownTalker，不能静默导出 0 条")
    print(f"ok 显示名可导出：{name} → {len(data['records'])} 条，不存在的名字会被拒")


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
        test_args_are_validated()
        test_real_display_name_talker()
        test_real_smoke()
    finally:
        shutil.rmtree(_t, ignore_errors=True)
    print("ALL PASS")
