# -*- coding: utf-8 -*-
"""非文本消息的**标签**自测（`describe_nontext` / `_LINK_KINDS`）。

跑法：`python test_render_labels.py`（毫秒级，不碰微信、不碰真实库）。

为什么要它：这些标签是**代聊模型读消息时唯一的性质线索**——它看到的是
`[引用] 你在干嘛` 而不是原始 XML，标签错了模型就判错消息性质，而且**不会报错**。

已出过事的一条（2026-10-11）：`appmsg <type>57` 被标成 `[直播]`，实际是**引用回复**。
扫全库 84 条 type=57 的消息，**每一条**的 XML 都带 `<refermsg>`（引用的原文+时间+发送者），
没有例外。于是每一条引用回复在模型眼里都成了「有人发了直播」。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import wechat_core as core  # noqa: E402

fails = []


def check(label, cond, extra=""):
    if not cond:
        fails.append(label)
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))


def appmsg(kind, title="标题", extra=""):
    """造一条 appmsg 的 XML（与微信落库的形状一致：lt=49 时正文就是这段 XML）。"""
    return (f'<msg><appmsg appid="" sdkver="0"><title>{title}</title><des></des>'
            f'<type>{kind}</type>{extra}</appmsg></msg>')


REFER = ("<refermsg><content>你先说说</content><createtime>1791708109</createtime>"
         "<fromusr>wxid_x</fromusr></refermsg>")

# 下面两段是**照真实落库形状抄的**（2026-10-14 从本机库里取的样本），别改成"看着更顺眼"的写法：
# 它们各自的坑就在那点不好看的地方。
MERGED = (
    '<msg><appmsg><title>时遇的聊天记录</title><des>时遇: [图片]</des><type>19</type>'
    '<url>https://support.weixin.qq.com/x</url>'
    '<recorditem><![CDATA[<recordinfo><title>时遇的聊天记录</title><datalist count="3">'
    '<dataitem datatype="2" dataid="a1"><cdnthumburl>305f02</cdnthumburl></dataitem>'
    '<dataitem datatype="1" dataid="a2"><datadesc>你如果有自己的意识</datadesc>'
    '<sourcename>TOOLAN</sourcename><sourcetime>2026-09-06 15:57:22</sourcetime>'
    '<srcMsgCreateTime>1788681442</srcMsgCreateTime></dataitem>'
    '<dataitem datatype="8" dataid="a3"><datatitle>日式料理50道.html</datatitle></dataitem>'
    '</datalist></recordinfo>]]></recorditem></appmsg></msg>')

IMG = ('<msg><img aeskey="53b5" encryver="0" cdnthumblength="2716" cdnthumbheight="120"'
       ' cdnthumbwidth="120" cdnbigimgurl="305c" length="32171" md5="abc"/></msg>')

print("=== 非文本标签 ===")

# ① 本次修的那条：57 = 引用（不是直播）
out = core.describe_nontext(49, appmsg(57, "在的 有什么要办的", REFER))
check("appmsg type=57 → [引用]（不是 [直播]）", out.startswith("[引用]"), out[:40])
check("引用那条的正文跟着标签走", "在的 有什么要办的" in out, out[:40])
check("全库证据：57 恒带 refermsg（回归时别改回 57:直播）", 57 not in (62, 63) and core._LINK_KINDS[57] == "引用",
      str(core._LINK_KINDS.get(57)))

# ② 相邻的几个标签没被这次改动带歪
for kind, want in ((5, "链接"), (6, "文件"), (19, "聊天记录"), (33, "小程序"),
                   (44, "视频号"), (62, "拍一拍"), (87, "群公告"),
                   (2000, "转账"), (2001, "红包")):
    out = core.describe_nontext(49, appmsg(kind, "样例"))
    check(f"appmsg type={kind} → [{want}]", out.startswith(f"[{want}]"), out[:40])

# ③ 认不出的类型仍走兜底「链接」——**不能**因为加了新标签就让未知类型变成空白
out = core.describe_nontext(49, appmsg(9999, "未知类型样例"))
check("未知 appmsg type → 兜底 [链接]（不吞消息）", out.startswith("[链接]"), out[:40])

# ④ 无 title 时标签本身仍在（消息不能被吞掉）
out = core.describe_nontext(49, appmsg(57, ""))
check("无 title 时仍给出 [引用]", out.startswith("[引用]"), out[:40])

print()
print("=== 引用 / 合并转发展开（2026-10-14 新增）===")

# ⑤ 引用：被引原文与说话人
who, quoted = core.refer_text(appmsg(57, "这是AI回复的", REFER))
check("refer_text 取被引原文（不是 title）", (who, quoted) == ("", "你先说说"), repr((who, quoted)))
out = core.describe_nontext(49, appmsg(57, "这是AI回复的", REFER))
check("一行的引用把原文接在后面", "你先说说" in out and out.startswith("[引用]"), out[:60])

# 被引内容本身是 XML（实测 15 条里 3 条如此）→ 必须压成摘要，不能把 XML 灌给模型
NEST = ("<refermsg><displayname>TOOLAN</displayname><content>"
        "&lt;msg&gt;&lt;img aeskey=\"a\" cdnthumblength=\"2716\" length=\"32171\"/&gt;&lt;/msg&gt;"
        "</content></refermsg>")
who, quoted = core.refer_text(appmsg(57, "回复", NEST))
check("被引内容是图片 → 压成 [图片 31KB]，不是 XML",
      who == "TOOLAN" and quoted == "[图片 31KB]", repr(quoted))
NEST_APP = ("<refermsg><displayname>张三</displayname><content>"
            "&lt;msg&gt;&lt;appmsg&gt;&lt;title&gt;报告.pdf&lt;/title&gt;&lt;type&gt;6&lt;/type&gt;"
            "&lt;/appmsg&gt;&lt;/msg&gt;</content></refermsg>")
check("被引内容是文件 → [文件] 报告.pdf", core.refer_text(appmsg(57, "回复", NEST_APP))[1] == "[文件] 报告.pdf",
      repr(core.refer_text(appmsg(57, "回复", NEST_APP))[1]))

# ⑥ 合并转发：type=19 读得对（`datatype="2"` 会冒充 `type="2"`），逐条展得开
check("type=19 不被 dataitem 的 datatype 冒充", core._num(MERGED, "type") == 19, str(core._num(MERGED, "type")))
out = core.describe_nontext(49, MERGED)
check("合并转发 → [聊天记录] + 条数", out.startswith("[聊天记录]") and "（3 条）" in out, out[:60])
items = core.merged_forward(MERGED)
check("merged_forward 逐条展开", len(items) == 3, str(len(items)))
check("datatype=1 → datadesc + 发送者", items[1]["sender"] == "TOOLAN" and items[1]["text"] == "你如果有自己的意识",
      repr(items[1]))
check("datatype=2 无标题 → [图片]（不吞）", items[0]["text"] == "[图片]", repr(items[0]))
check("datatype=8 → datatitle", items[2]["text"] == "日式料理50道.html", repr(items[2]))
check("展不开时返回 []（不假装成功）", core.merged_forward(appmsg(19, "标题")) == [])

# ⑦ 属性名左边界：`length="` 不能命中 `cdnthumblength="`（原图 vs 缩略图）
check("_attr(length) 取原图不是缩略图", core._attr(IMG, "length") == "32171", core._attr(IMG, "length"))
check("图片大小按原图算", core.describe_nontext(3, IMG) == "[图片 31KB]", core.describe_nontext(3, IMG))

# ⑧ **群里**引用：被引原文自带「发送者: 」前缀 ⇒ 整段 XML 会漏给用户（真机 589 条里 2 条）
GROUP_REF = ("<refermsg><displayname></displayname><content>"
             "wxid_jnt7kck7di1622: <?xml version=\"1.0\"?> <msg> "
             "<img aeskey=\"f35\" cdnthumblength=\"1779\" length=\"63093\"/> </msg>"
             "</content></refermsg>")
who, quoted = core.refer_text(appmsg(57, "你这也不是codex", GROUP_REF))
check("带前缀的被引原文也压成摘要（不漏 XML）",
      quoted == "[图片 62KB]" and "<img" not in quoted, repr(quoted))
check("照旧取原图大小（前缀剥掉后边界仍然管用）", "1779" not in quoted, repr(quoted))
check("前缀剥不掉时原样留着（人话不能被吞）",
      core._nested_text("wxid_a: 你好，明天见") == "wxid_a: 你好，明天见",
      repr(core._nested_text("wxid_a: 你好，明天见")))

print()
print("=== 非文本补全（2026-10-14：视频号 / 转账 / 引用判据）===")

# ⑨ 视频号：`<title>` 是微信自己的升级提示，真东西在 finderFeed/finderLive 里
#    （XML 照本机库里的真身抄，只删了几段无关字段）
LIVE = ('<msg><appmsg><title>当前版本不支持展示该内容，请升级至最新版本。</title>'
        '<action>view</action><type>63</type>'
        '<url>https://support.weixin.qq.com/security/readtemplate?t=w_security_center_website/upgrade</url>'
        '<finderLive><finderLiveID>2042947499411346807</finderLiveID><nickname>Qoder.ai</nickname>'
        '<desc>运营，造自己的工具|第一期收官</desc></finderLive></appmsg></msg>')
out = core.describe_nontext(49, LIVE)
check("视频号用作者+描述，不用「请升级」那句提示",
      out == "[视频号] Qoder.ai：运营，造自己的工具|第一期收官", out)
check("视频号不再吐 support.weixin 升级链接", "support.weixin" not in out, out)
FEED = ('<msg><appmsg><title>当前版本不支持展示该内容，请升级至最新版本。</title><type>51</type>'
        '<url>https://support.weixin.qq.com/security/readtemplate?t=w_security_center_website/upgrade</url>'
        '<finderFeed><feedType>4</feedType><nickname>菇乡视界</nickname><desc>光影定格爱</desc>'
        '</finderFeed></appmsg></msg>')
check("finderFeed 那条也认（51/44/63 两种容器都见过）",
      core.describe_nontext(49, FEED) == "[视频号] 菇乡视界：光影定格爱",
      core.describe_nontext(49, FEED))
# 小程序里也夹着 <finderLive>，但它的 <title> 本身是内容 ⇒ 不许被作者名顶掉
MINI = ('<msg><appmsg><title>五行性格测试来辣</title><type>33</type><url></url>'
        '<finderLive><nickname>某某</nickname><desc>直播中</desc></finderLive></appmsg></msg>')
check("不是 44/51/63 时不拿 finder 顶掉自己的标题",
      core.describe_nontext(49, MINI) == "[小程序] 五行性格测试来辣",
      core.describe_nontext(49, MINI))

# ⑩ 转账：金额在 wcpayinfo/feedesc，`<des>` 后半句是升级提示
PAY = ('<msg><appmsg appid="" sdkver=""><title><![CDATA[微信转账]]></title>'
       '<des><![CDATA[收到转账1000.00元。如需收钱，请点此升级至最新版本]]></des>'
       '<type>2000</type>'
       '<url><![CDATA[https://support.weixin.qq.com/cgi-bin/mmsupport-bin/readtemplate?t=page/common_page__upgrade&text=text001]]></url>'
       '<wcpayinfo><paysubtype>1</paysubtype><feedesc><![CDATA[￥1000.00]]></feedesc></wcpayinfo>'
       '</appmsg></msg>')
check("转账带出金额", core.describe_nontext(49, PAY) == "[转账] ￥1000.00",
      core.describe_nontext(49, PAY))
check("`type=0` 带 wcpayinfo 的也认（实测 2 条）",
      core.describe_nontext(49, PAY.replace("<type>2000</type>", "<type>0</type>")) == "[转账] ￥1000.00")
check("没有 feedesc 时退回 des 的第一句（升级提示切掉）",
      core.describe_nontext(49, PAY.replace("<feedesc><![CDATA[￥1000.00]]></feedesc>", ""))
      == "[转账] 收到转账1000.00元",
      core.describe_nontext(49, PAY.replace("<feedesc><![CDATA[￥1000.00]]></feedesc>", "")))
check("红包没金额就不硬编（原样 [红包]）",
      core.describe_nontext(49, appmsg(2001, "新年快乐")).startswith("[红包]"),
      core.describe_nontext(49, appmsg(2001, "新年快乐")))

# ⑪ **有 refermsg 就是引用**，不看子类型（实测 type=1 里夹着 2 条引用）
ONE_REF = appmsg(1, "哈哈这个我先收了", REFER)
out = core.describe_nontext(49, ONE_REF)
check("type=1 带 refermsg 也走引用（不是 [链接]）",
      out.startswith("[引用]") and "你先说说" in out, out)
check("type=1 不带 refermsg 仍是链接卡片",
      core.describe_nontext(49, appmsg(1, "https://x.com/i/status/2096954082674217209"))
      == "[链接] https://x.com/i/status/2096954082674217209",
      core.describe_nontext(49, appmsg(1, "https://x.com/i/status/2096954082674217209")))
check("普通链接照旧带 URL（别把 nags 过滤器做过头）",
      "(https://mp.weixin.qq.com/s/abc)" in core.describe_nontext(
          49, appmsg(5, "Plan Mode 已死", "<url><![CDATA[https://mp.weixin.qq.com/s/abc]]></url>")),
      core.describe_nontext(
          49, appmsg(5, "Plan Mode 已死", "<url><![CDATA[https://mp.weixin.qq.com/s/abc]]></url>")))

print()
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
