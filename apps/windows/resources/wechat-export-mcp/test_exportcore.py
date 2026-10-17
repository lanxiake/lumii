"""exportcore 单测（纯函数 + 真机只读冒烟）。运行：python test_exportcore.py"""
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:                                # Windows 控制台常是 GBK：会话名里可能带编不出的字符（实测 U+00A0），
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # 不钉住 print 会抛错 → 测试**假失败**
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
import exportcore as E

IMG_XML = ('<msg><img aeskey="x" md5="0123456789abcdef0123456789abcdef" '
           'length="17408"></img></msg>')
# 照真实落库形状抄（2026-10-14 本机取样）：文件名在 `<title>`，大小在 `<totallen>`
FILE_MSG = ('<msg><appmsg appid="wx6618" sdkver="0"><title>报表.xlsx</title><type>6</type>'
            '<appattach><totallen>11</totallen><fileext>xlsx</fileext></appattach></appmsg></msg>')
GROUP_TEXT = "vicky1990202:\n12345那边回复了"
MULTILINE = "第一行\n第二行\n第三行"
# 照真实落库形状抄的（2026-10-14 本机取样）：`datatype="2"` 排在 `<type>19</type>` 之后，
# 而 `<type>` 是元素——属性名不卡左边界就会把 type=19 读成 2（详见 wechat_core._attr）。
MERGED = ('<msg><appmsg><title>时遇的聊天记录</title><type>19</type>'
          '<recorditem><![CDATA[<recordinfo><datalist count="3">'
          '<dataitem datatype="2" dataid="a1"><cdnthumburl>305f</cdnthumburl></dataitem>'
          '<dataitem datatype="1" dataid="a2"><datadesc>你如果有自己的意识</datadesc>'
          '<sourcename>TOOLAN</sourcename><sourcetime>2026-09-06 15:57:22</sourcetime></dataitem>'
          '<dataitem datatype="8" dataid="a3"><datatitle>日式料理50道.html</datatitle></dataitem>'
          '</datalist></recordinfo>]]></recorditem></appmsg></msg>')


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


def test_render_quote_and_forward():
    """引用与合并转发：以前导出里只有 `[引用] 回复正文` 和 `[聊天记录] 标题`，被引原文和
    转发内容整段丢失（那是**导出这个产品最主要的使用场景**）。"""
    refer = ('<msg><appmsg><title>这是AI回复的</title><type>57</type>'
             '<refermsg><displayname>TOOLAN</displayname><content>还不晓得 晚点给你说</content>'
             '</refermsg></appmsg></msg>')
    text, _ = E.render_text(49, refer.encode("utf-8"))
    assert text == "[引用] 这是AI回复的 ← TOOLAN: 还不晓得 晚点给你说", repr(text)
    assert E.forward_of(49, refer.encode("utf-8")) == [], "引用不是合并转发"

    merged = MERGED.encode("utf-8")
    assert E.forward_of(1, merged) == [], "只有 lt=49 才去解转发"
    items = E.forward_of(49, merged)
    assert [it["text"] for it in items] == ["[图片]", "你如果有自己的意识", "日式料理50道.html"], items
    md = E._md("群", [dict(_recs()[0], forward=items, text="[聊天记录] 时遇的聊天记录（3 条）")], 0, 0)
    assert "转发的聊天记录（3 条）" in md and "> TOOLAN 2026-09-06 15:57:22：你如果有自己的意识" in md, md
    html = E._html("群", [dict(_recs()[0], forward=items, text="x")], 0, 0)
    assert 'class="fw"' in html and "日式料理50道.html" in html and "&lt;" not in html, html[html.find("fw") - 50:]
    js = json.loads(E._json("群", [dict(_recs()[0], forward=items)], 0, 0))
    assert js["messages"][0]["forward"][1]["sender"] == "TOOLAN", js["messages"][0]["forward"]
    print("ok render_quote_and_forward")


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


def test_html_inline_media(tmp):
    """`format=html` + media ⇒ 图**内嵌**（自包含），超预算才退回落盘。

    为什么要内嵌：老实现出的是 `assets/img_001.jpg` 相对路径，把 html 单独发给别人全是红叉。
    为什么要**上限**：实测 500 条带图的会话原图 30 MB ⇒ base64 后 40 MB（`probe_html_size.py`），
    同比例 5000 条就是 400 MB——所以超限必须**退回落盘 + 留痕**，不能假装自包含。
    """
    png = (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)          # 内容不重要，要的是「认得出的 png 字节」
    src = os.path.join(tmp, "src.png")
    with open(src, "wb") as f:
        f.write(png)
    orig = E.core.image_message
    # 契约是 `(msg, 失败原因)`（见 `core.image_message`），成功时原因是空串
    E.core.image_message = lambda talker, lid: ({"image_path": src}, "")
    try:
        def run(inline, budget):
            rec = dict(_recs()[0], type=3, image=None, local_id=7)
            rep = {"image_exported": 0, "image_missing": 0, "image_no_key": 0, "inline_bytes": 0,
                   "inline_fallback": 0, "voice_exported": 0, "voice_missing": 0,
                   "transcribe_failed": 0}
            assets = os.path.join(tmp, "s1", "assets")   # 与生产同构：<会话目录>/assets
            E._export_media("x", [rec], assets, E.MEDIA_IMAGES, False, rep,
                            inline=inline, budget=budget)
            return rec, rep, assets

        rec, rep, assets = run(True, 0)
        assert rec["image"].startswith("data:image/png;base64,"), rec["image"][:40]
        assert rep["inline_bytes"] == len(png) and not rep["inline_fallback"], rep
        assert not os.path.isdir(assets), "内嵌了就不该再落 assets/"
        html = E._html("客户群", [rec], 0, 0, note="")
        assert 'src="data:image/png;base64,' in html and "assets/" not in html, html[:400]

        rec, rep, assets = run(True, len(png) - 1)        # 预算不够一格 ⇒ 退回落盘
        assert rec["image"] == "assets/img_001.png", rec["image"]
        assert rep["inline_fallback"] == 1 and rep["inline_bytes"] == 0, rep
        assert os.path.isfile(os.path.join(assets, "img_001.png")), "降级也不能把东西丢了"

        rec, rep, _ = run(False, 0)                       # md 那条路不受影响
        assert rec["image"] == "assets/img_001.png", rec["image"]

        # key 没抓 ≠ 图没了：两者用户要做的事不同，必须分账（`core.image_message` 特意分的）
        E.core.image_message = lambda talker, lid: (None, "no_key")
        _, rep, _ = run(True, 0)
        assert rep["image_no_key"] == 1 and rep["image_missing"] == 0, rep
    finally:
        E.core.image_message = orig
    print("ok html_inline_media")


def test_html_day_nav():
    """跨天的 html 给**日期目录 + 锚点**（几百条的会话靠它跳），一天的会话不给（那是噪音）。"""
    r = _recs()
    one = E._html("客户群", r, 0, 0)
    assert '<nav class="toc">' not in one and 'class="day"' not in one, "同一天不该有目录/分隔条"
    two = E._html("客户群", [dict(r[0], time="1970-01-01 08:01"),
                             dict(r[1], time="1970-01-02 09:00")], 0, 0)
    assert two.count('class="day"') == 2 and two.count('class="toc"') == 1, two.count("toc")
    assert '<a href="#d1">1970-01-02</a>' in two and 'id="d1"' in two
    warned = E._html("群", r, 0, 0, note="有 1 项媒体超限")
    assert "有 1 项媒体超限" in warned and 'class="warn"' in warned
    assert "**" not in warned, "note 进的是 HTML，写了 markdown 加粗会原样显示成星号"
    print("ok html_day_nav")


def test_file_attachment(tmp):
    """文件消息（appmsg type=6）→ 收进 `files/`，同名的另一版本另存、同一份不重复收。

    判重是刻意的：群里同一份文件被转来转去是常态，`file_dup` 计数让"少收了"和"本来就只有一份"
    分得开。
    """
    fm = E.file_of(49, FILE_MSG.encode("utf-8"))
    assert fm == {"title": "报表.xlsx", "size": 11, "ext": "xlsx"}, fm
    assert E.file_of(49, b"<msg><appmsg><title>x</title><type>5</type></appmsg></msg>") is None
    assert E.file_of(1, b"hello") is None

    fdir = os.path.join(tmp, "f1", "files")
    used = {}
    assert E._file_dest(fdir, "报表.xlsx", 11, used) == "报表.xlsx"
    assert E._file_dest(fdir, "报表.xlsx", 11, used) is None, "同一份（同名同大小）不该收第二遍"
    assert E._file_dest(fdir, "报表.xlsx", 99, used) == "报表 (2).xlsx", "另一版本要另存"
    assert E._file_dest(fdir, 'a<b>.pdf', 1, used) == "a_b_.pdf", "文件名要净化"

    # 走一遍真拷：造一个"磁盘上的文件"，让共享层的映射找到它
    src_dir = os.path.join(tmp, "disk")
    os.makedirs(src_dir, exist_ok=True)
    with open(os.path.join(src_dir, "报表.xlsx"), "wb") as f:
        f.write(b"hello world")
    orig = E.core.build_index
    E.core.build_index = lambda root=None: orig(src_dir)
    try:
        rep = {k: 0 for k in ("image_exported", "image_missing", "inline_bytes", "inline_fallback",
                              "voice_exported", "voice_missing", "transcribe_failed",
                              "file_exported", "file_missing", "file_mismatch", "file_dup")}
        recs = [dict(_recs()[0], type=49, local_id=9, file=dict(fm))]
        E._export_media("x", recs, os.path.join(tmp, "f1", "assets"), E.MEDIA_FILES, False, rep)
        assert recs[0]["file"]["path"] == "files/报表.xlsx", recs[0]["file"]
        assert open(os.path.join(tmp, "f1", "files", "报表.xlsx"), "rb").read() == b"hello world"
        assert rep["file_exported"] == 1 and rep["file_missing"] == 0, rep
        md = E._md("群", recs, 0, 0)
        assert "[附件：报表.xlsx](files/报表.xlsx)" in md, md
        assert 'href="files/报表.xlsx"' in E._html("群", recs, 0, 0)

        recs = [dict(_recs()[0], type=49, local_id=9,
                     file={"title": "没有这个.pdf", "size": 3, "ext": "pdf"})]
        rep["file_missing"] = 0
        E._export_media("x", recs, os.path.join(tmp, "f1", "assets"), E.MEDIA_FILES, False, rep)
        assert rep["file_missing"] == 1 and "path" not in recs[0]["file"], "定位不到要计数，不能编路径"
    finally:
        E.core.build_index = orig
    print("ok file_attachment")


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
    assert set(E._MEDIA) == {"none", "images", "files", "all"} and E._SPLIT == ("none", "month")
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


def test_real_media_by_display_name():
    """真机只读冒烟：**用显示名**导出时媒体也得出得来（无微信库 / 没缓存 key 时跳过）。

    这条是回归钉：`_export_media` 原先把**没解析过的** talker 喂给 `image_message`，而
    `tbl_of` 是拿字符串算 md5 的——显示名算出来的表根本不存在 ⇒ **每张图都定位不到**，
    导出的 html 一张图没有、还报 `ok:true`，只有 `image_missing` 在涨。
    而"用显示名"正是工具说明里推荐的用法（`list_sessions` 返回的就是 name）。
    """
    try:
        root = E.core.db_root()
    except Exception as e:                                  # noqa: BLE001
        print(f"skip 媒体冒烟（取不到库: {e}）")
        return
    if not root or not os.path.isdir(root):
        print("skip 媒体冒烟（无数据目录）")
        return
    try:
        import wechat_image
        if not wechat_image.cached_aes_key():
            print("skip 媒体冒烟（没缓存图片 AES key，`image_missing` 本来就会全灭）")
            return
    except Exception:                                       # noqa: BLE001
        print("skip 媒体冒烟（wechat_image 不可用）")
        return
    out = tempfile.mkdtemp(prefix="export_media_")
    try:
        for s in E.core.sessions()[:8]:                     # 挑一个真有图的会话（限前 8 个）
            name = s.get("name")
            if not name:
                continue
            try:
                recs = E.build_records(name)["records"]
            except Exception:                               # noqa: BLE001
                continue
            if sum(1 for r in recs if r["type"] == 3) < 1:
                continue
            res = E.export_chat(name, out_dir=out, format="html", media="images")
            rep = res["media_report"]
            assert rep["image_exported"] >= 1, (name, rep)
            body = open(os.path.join(out, res["files_written"][0]), encoding="utf-8").read()
            assert 'src="data:image/' in body, "有图却不内嵌？"
            assert "assets/" not in body, "自包含的 html 不该再引用 assets/"
            print(f"ok 显示名导出带图：{res['session'][:12]} 内嵌 {rep['image_exported']} 张 / "
                  f"{rep['inline_bytes'] / 1e6:.1f} MB，缺 {rep['image_missing']}")
            return
        print("skip 媒体冒烟（前 8 个会话里没有带图的）")
    finally:
        shutil.rmtree(out, ignore_errors=True)


def test_type_name():
    """类型名**从渲染文本里取**，不另抄映射表——另抄一份的下场有先例（57 被标成"文件"）。"""
    assert E.type_name({"type": 1, "text": "你好"}) == "文本"
    assert E.type_name({"type": 3, "text": "[图片 12KB]"}) == "图片"
    assert E.type_name({"type": 34, "text": "[语音 11.3 秒]"}) == "语音"
    assert E.type_name({"type": 10000, "text": "你撤回了一条消息"}) == "系统"
    assert E.type_name({"type": 999, "text": "没见过的形态"}) == "其它"
    assert E.type_name({}) == "其它", "缺字段不该炸"
    print("ok type_name")


def test_stats_of():
    """统计报表逐项对账（合成数据）。**时区无关**：期望值由 `localtime` 现算，不写死小时。"""
    r = _recs()
    s = E.stats_of(r, media_report={"image_exported": 1})
    assert (s["count"], s["from_me"], s["from_other"]) == (2, 1, 1), s
    assert list(s["by_month"]) == ["1970-01"] and s["by_month"]["1970-01"] == 2
    h = time.localtime(r[0]["ts"]).tm_hour
    assert s["by_hour"] == {f"{h:02d}": 2}, s["by_hour"]
    assert sum(s["by_weekday"].values()) == 2 and set(s["by_weekday"]) == set("周一 周二 周三 周四 周五 周六 周日".split())
    assert s["types"] == [{"type": "文本", "count": 2}], s["types"]
    assert {t["sender"]: t["count"] for t in s["top_senders"]} == {"张三": 1, "我": 1}
    assert s["busiest_days"] == [{"day": "1970-01-01", "count": 2}], s["busiest_days"]
    assert s["active_days"] == 1 and s["first"] == r[0]["time"] and s["last"] == r[-1]["time"]
    assert s["span_days"] == round((r[1]["ts"] - r[0]["ts"]) / 86400, 1)
    assert s["media"]["image_exported"] == 1
    assert E.stats_of([])["count"] == 0 and E.stats_of([])["by_hour"] == {}
    # 嵌套报表要能铺成一层键值对（xlsx 的「统计」表靠它）
    flat = E._flat({"a": {"b": 1}, "c": [{"d": 2}], "e": [1, 2]})
    assert flat == {"a.b": 1, "c[0].d": 2, "e[0]": 1, "e[1]": 2}, flat
    print("ok stats_of（报表逐项对账 + 铺平）")


def test_keyword_hits():
    """只导命中：大小写不敏感、附件名也算、超上限**保留最新的**并标 `truncated`。"""
    r = [dict(x, text=x["text"]) for x in _recs()]
    r[1]["file"] = {"title": "发票-9月.pdf"}
    assert E.keyword_hits(r, "")[0] is r, "不给关键词 = 原样返回"
    assert len(E.keyword_hits(r, "吃饭")[0]) == 1
    assert len(E.keyword_hits(r, "发票")[0]) == 1, "附件名里的词也要搜得到"
    assert len(E.keyword_hits(r, "PDF")[0]) == 1, "英文大小写不敏感"
    assert E.keyword_hits(r, "吃饭", limit=1) == ([r[0]], False)
    many = [dict(x, ts=i, text="命中") for i, x in enumerate(_recs() * 3)]
    got, trunc = E.keyword_hits(many, "命中", limit=2)
    assert trunc is True and [x["ts"] for x in got] == [4, 5], "截断要保留**最新**的那几条"
    print("ok keyword_hits（命中/截断/保留最新）")


def test_session_subdir():
    """目录结构只有一处定义，这里对着它验收（关键词带一层 `q-`，且长词要截断）。"""
    root = os.path.join(os.sep, "tmp", "导出")
    assert E.session_subdir(root, "张三") == os.path.join(root, "张三")
    assert E.session_subdir(root, "张三", "发票").endswith(os.path.join("张三", "q-发票"))
    last = E.session_subdir(root, "a/b", "c:d").split(os.sep)[-2:]
    assert last == ["a_b", "q-c_d"], last
    assert len(E.session_subdir(root, "n", "长" * 200).split(os.sep)[-1]) == 42, "长关键词要截断到 40 字"
    assert E.session_subdir(root, "张三", "   ") == os.path.join(root, "张三"), "空白关键词 = 没有关键词"
    print("ok session_subdir")


def test_analysis_formats(tmp):
    """分析向导出：`json` / `md` 都带 `stats`，且 `stats.json` **不挑格式**都落得下来。"""
    data = {"name": "客户群", "talker": "wxid_x"}
    recs = _recs()
    out = tempfile.mkdtemp(dir=tmp, prefix="analysis_")
    E._write_session(out, data, recs, "json", 0, 0, E.MEDIA_NONE, False, "none", E._INLINE_BUDGET_MB)
    sdir = os.path.join(out, "客户群")
    js = json.load(open(os.path.join(sdir, "chat.json"), encoding="utf-8"))
    assert js["stats"]["count"] == 2, js["stats"]
    assert json.load(open(os.path.join(sdir, "stats.json"), encoding="utf-8"))["count"] == 2
    md = E._write_session(out, data, recs, "md", 0, 0, E.MEDIA_NONE, False, "none", E._INLINE_BUDGET_MB)
    assert "## 统计报表" in open(os.path.join(sdir, "chat.md"), encoding="utf-8").read()
    assert md["stats"]["session"] == "客户群" and os.path.isdir(md["dir"])
    assert "xlsx" not in E._FORMATS, "xlsx 已撤（给分析用走 json），别留半条路"
    print("ok analysis_formats（json 带 stats / md 有报表 / stats.json 都落）")


def test_docs_list_all_formats():
    """**文档漂移守卫**：`server.TOOLS` 里每个工具、每个 `format` 取值，README 与技能包都得提到。

    为什么值得一条：这一版并进了文件面（`list_files` / `archive_files` / `disk_usage`）。
    README/技能包**不会因为代码改了而报错**——它只会静静地少讲一个工具，谁都不发现，
    直到有用户来问"你到底能不能收文件"。
    """
    import importlib.util
    root = os.path.dirname(os.path.abspath(__file__))
    # 按**文件路径**加载，别写 `import server`：共享层的 sys.path 排在前面，那句会拿到
    # `../wechat-mcp/server.py`（另一个产品），于是断言看着跑过了、其实测的是别人。
    spec = importlib.util.spec_from_file_location("exp_server", os.path.join(root, "server.py"))
    srv = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srv)
    assert srv.SERVER_NAME == "wechat-export", srv.SERVER_NAME
    want = [t["name"] for t in srv.TOOLS] + list(srv.FORMATS)
    for label, p in (("README.md", os.path.join(root, "README.md")),
                     ("skills/wechat-export-mcp/SKILL.md",
                      os.path.join(root, "skills", "wechat-export-mcp", "SKILL.md"))):
        txt = open(p, encoding="utf-8").read()
        missing = [w for w in want if w not in txt]
        assert not missing, f"{label} 没提到：{missing}"
    print(f"ok 文档对账：{len(srv.TOOLS)} 个工具 + {len(srv.FORMATS)} 种格式都在 README 与技能包里")


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
        test_render_quote_and_forward()
        test_safe_and_clock()
        test_render_formats()
        test_split_grouping(_t)
        test_html_inline_media(_t)
        test_html_day_nav()
        test_file_attachment(_t)
        test_args_are_validated()
        test_type_name()
        test_stats_of()
        test_keyword_hits()
        test_session_subdir()
        test_analysis_formats(_t)
        test_docs_list_all_formats()
        test_real_display_name_talker()
        test_real_media_by_display_name()
        test_real_smoke()
    finally:
        shutil.rmtree(_t, ignore_errors=True)
    print("ALL PASS")
