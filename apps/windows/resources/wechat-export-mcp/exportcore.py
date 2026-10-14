"""B · 记录导出 —— 核心逻辑（不依赖微信运行；只有需要真库时才去读）。

把某个会话的消息流导出成**能读、能分享、能归档**的文件：md / html / json，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

只读：不修改任何微信数据。
"""
import html
import json
import os
import re
import shutil
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import mcp_stdio  # noqa: E402  （只为了报进度；没装回调时 progress() 是空操作）
import wechat_core as core  # noqa: E402

MEDIA_NONE, MEDIA_IMAGES, MEDIA_FILES, MEDIA_ALL = "none", "images", "files", "all"
_MEDIA = (MEDIA_NONE, MEDIA_IMAGES, MEDIA_FILES, MEDIA_ALL)
_SPLIT = ("none", "month")
_WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_BIG = 10 ** 9

# 全库检索时**允许跳过**的失败：这几个只说明"这一个会话读不动"，不是代码错了。
# 别的异常一律往上抛——踩过的坑正是"`except Exception` 把逻辑错误（读错了元组顺序）
# 一起吞掉"，于是全库搜恒返回"命中 0 个"、不报错、看着像个正常结果。
E_SKIP = (core.UnknownTalker, OSError, sqlite3.Error)

# 自包含 HTML 的内嵌预算（`inline_max_mb=0` = 不限）。**实测**（2026-10-14，探针
# `verify/wechat-mcp/probe_html_size.py`）：一个 500 条带图的会话，原图 30 MB ⇒ base64 后
# 40 MB；同样的会话只出文字是 17 KB。也就是说体积**全在图上**，按同一比例，5000 条就是 400 MB
# 的单文件——浏览器扛不住，也没法发出去。所以给上限：超了**退回落盘**（东西一样不少），
# 在页首和返回里如实说明"这份不再自包含"。
_INLINE_BUDGET_MB = 20

# 全库检索导出时最多导出多少个会话（按命中条数从多到少取）。不给上限的话，
# 一个"你"字能在几十个会话里命中，导出目录直接爆掉；砍掉多少**如实报**（`sessions_skipped`）。
_MAX_SESSIONS = 20

# 按关键词导出时**每个会话**默认最多导多少条命中。给默认值是刻意的：不给上限的话，
# 拿"你"这种词搜出来的量级是几万条、写出来是几百 MB 的文件——用户没预期、也打不开。
# 撞上限会置 `truncated`，如实说。`limit=0` = 不限（调用方明确要求时才这么用）。
_SCAN_LIMIT = 500


def bad_args(args):
    """枚举参数的**边界校验**，返回问题列表（空 = 没问题）。合法值在这里定，工具 schema 也读它。

    为什么要单独校验：`media="image"`（拼错）原来会连着两次比较都不命中 → 一颗媒体都不出、
    也不报错，调用方拿到的是 `isError=false` 的正常结果——"参数打错"与"这批消息没图"分不出来。
    `format` 更隐蔽：悄悄退回 md，返回里看着一切正常。
    """
    bad = [f"{k}={args[k]!r}（可选 {list(ok)}）"
           for k, ok in (("format", _FORMATS), ("media", _MEDIA), ("split", _SPLIT))
           if args.get(k) and args[k] not in ok]
    mb = args.get("inline_max_mb")
    # `True` 也是 int，别放过去当 1 MB
    if mb is not None and (isinstance(mb, bool) or not isinstance(mb, (int, float)) or mb < 0):
        bad.append(f"inline_max_mb={mb!r}（非负数字，0 = 不限）")
    for k in ("limit", "max_sessions"):     # 负数会变成"从尾部切""取前 -3 个"这种怪语义
        v = args.get(k)
        if v is not None and (isinstance(v, bool) or not isinstance(v, int) or v < 0):
            bad.append(f"{k}={v!r}（非负整数）")
    return bad


def _safe(name):
    cleaned = _WIN_BAD.sub("_", name or "").strip().rstrip(".")
    return cleaned or "session"


def _clock(ts):
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def _month(ts):
    return time.strftime("%Y-%m", time.localtime(ts))


def render_text(lt, content):
    """消息 → `(完整文本, 是否助手代发)`。

    **保留换行**（不像 `core._render` 那样压成一行）。群聊里 `message_content` 前缀了发送者，
    用核心的 `_PREFIX_RE` 剥掉（它靠 `\n` 定位，所以剥完再保留换行）。
    非文本消息（图片/语音/引用…）走 `describe_nontext` 拿一行摘要。
    """
    raw = core.decode(content)
    stripped = core._PREFIX_RE.sub("", raw)
    if stripped.lstrip().startswith("<"):
        return core.describe_nontext(lt & 0xFFFFFFFF, stripped.replace("\n", " ")).strip(), False
    return core.split_agent_mark(stripped.strip())


def forward_of(lt, content):
    """合并转发（lt=49 + appmsg type=19）→ 逐条列表；别的消息一律 `[]`。

    正文整段在 `<recorditem>` 的 CDATA 里，`render_text` 只能给出一行摘要（含条数），
    所以这里另出一份结构化的给渲染层（md/html 排成转发块，json 直接是数组）。

    `ponytail:` 转发块里的**图片导不出来**——它们没有自己的 `local_id`，落不到
    `image_message()` 的定位路径上，只能显示 `[图片]`。真要图得去 msg/attach 按 md5 反查，
    那是另一件事。
    """
    return core.merged_forward(core.decode(content)) if (lt & 0xFFFFFFFF) == 49 else []


def file_of(lt, content):
    """文件消息（`appmsg type=6`）→ `{title, size, ext}`；别的消息 `None`。

    映射到**磁盘上的哪个文件**是 B6 才做的事（走共享层的 `build_index`/`match_file`），
    这里只解析消息本身——记录里先有"这是个文件、多大"，落不落盘由 `media` 决定。
    """
    return core.parse_file_msg(core.decode(content)) if (lt & 0xFFFFFFFF) == 49 else None


def iter_rows(talker, since=0, until=0):
    """跨**所有分片**取会话消息，时间正序。

    返回 `[(ct, lt, content, sender_username, local_id)]`。
    只读 message_0.db 会漏掉绝大部分历史（微信 4.x 按时间滚动分片），这里合并全部。
    """
    core._refresh()
    tbl = core.tbl_of(talker)
    rows = []
    for shard in core._cache["msg"]:
        if tbl not in core._cache["tables"].get(shard, ()):
            continue
        smap = core._cache["senders"].get(shard, {})
        conds, params = [], []
        if since:
            conds.append("create_time >= ?")
            params.append(int(since))
        if until:
            conds.append("create_time <= ?")
            params.append(int(until))
        where = (" where " + " and ".join(conds)) if conds else ""
        con = sqlite3.connect(shard)
        try:
            for ct, lt, content, sid, lid, _src, _pk in core._query_rows(
                    con, tbl, where, params + [_BIG], True):
                rows.append((ct, lt, content, smap.get(sid, ""), lid))
        finally:
            con.close()
    rows.sort(key=lambda r: r[0])
    return rows


def build_records(talker, since=0, until=0):
    """导出用的记录列表（时间正序）。每条含显示名、from_me、完整文本、类型。

    `talker` 走 `core.talker_of`：会话**显示名**必须能导出，解析不出唯一目标就抛
    `UnknownTalker`（MCP 侧 → `target_not_found`）。校验放在这里而不是 server，
    是因为它同时守住"只传显示名"这条路——别指望每个调用方都记得先解析。
    """
    talker = core.talker_of(talker)
    core._refresh()
    names, me = core.names(), core.self_wxid()
    out = []
    for ct, lt, content, sender, lid in iter_rows(talker, since, until):
        who = "我" if sender == me else (names.get(sender, sender) if sender else "(未知)")
        text, agent_sent = render_text(lt, content)
        out.append({
            "ts": ct, "time": _clock(ct), "month": _month(ct), "type": lt & 0xFFFFFFFF,
            "sender": who, "from_me": sender == me, "agent_sent": agent_sent,
            "text": text, "local_id": lid,
            "image": None, "voice": None, "voice_text": None,
            "forward": forward_of(lt, content), "file": file_of(lt, content),
        })
    return {"name": names.get(talker, talker), "talker": talker, "records": out}


def type_name(rec):
    """消息类型的中文名。**从渲染文本里取**，不另抄一份 `local_type` 映射表。

    另抄一份的下场有先例：57（引用）被标成"文件"，而且谁都看不出来。
    `[图片 12KB]` → `图片` 就是这个道理——`describe_nontext` 已经把类型写进那对方括号里了。

    `ponytail:` 这段和 C 侧 `wechat-crm-mcp/chatlog.py:type_label` 是同构的两份。**不合并**：
    两个产品各自打成独立的 onefile，共用就得上抬到共享层 `wechat_core`——为一个纯映射表
    改共享层（要重跑全部 16 个测试文件）不划算。
    """
    lt = rec.get("type") or 0
    text = rec.get("text") or ""
    if lt == 1:
        return "文本"
    if lt in (10000, 10002):
        return "系统"
    if text.startswith("["):
        end = text.find("]")
        if 0 < end <= 12:
            return text[1:end].split(" ")[0]
    return "其它"


def stats_of(records, media_report=None, busiest=10):
    """统计报表（**纯计数，不下结论**）。

    只出"数得出来的东西"：条数 / 双方占比 / 按月 / 按小时 / 按星期 / 类型 / 发言人 / 首末与跨度。
    **不做**意向打分、情绪、画像——那是划死的红线（和 C 侧 `customer_brief` 同一条）。
    报表存在的意义是让模型**先看形状再看原文**，不必把几千条消息全塞进上下文。
    """
    n = len(records)
    me = sum(1 for r in records if r.get("from_me"))
    by_month, by_day, types, senders = {}, {}, {}, {}
    hours = [0] * 24
    week = [0] * 7
    for r in records:
        lt = time.localtime(int(r.get("ts") or 0))
        hours[lt.tm_hour] += 1
        week[lt.tm_wday] += 1
        m = r.get("month") or ""
        by_month[m] = by_month.get(m, 0) + 1
        d = (r.get("time") or "")[:10]
        by_day[d] = by_day.get(d, 0) + 1
        t = type_name(r)
        types[t] = types.get(t, 0) + 1
        s = r.get("sender") or "(未知)"
        senders[s] = senders.get(s, 0) + 1
    ts = [int(r.get("ts") or 0) for r in records] or [0]
    return {
        "count": n, "from_me": me, "from_other": n - me,
        "first": records[0]["time"] if n else "", "last": records[-1]["time"] if n else "",
        "span_days": round((max(ts) - min(ts)) / 86400, 1) if n else 0.0,
        "active_days": len(by_day),
        # 小时键补零成两位：字典序 = 时间序，喂给模型和铺进表格都不会乱序
        "by_hour": {f"{h:02d}": c for h, c in enumerate(hours) if c},
        "by_weekday": {"周" + "一二三四五六日"[i]: c for i, c in enumerate(week)},
        "by_month": dict(sorted(by_month.items())),
        # 逐日全量序列太长（三年的会话上千行），只给"最忙的几天"与活跃天数
        "busiest_days": [{"day": d, "count": c} for d, c in
                         sorted(by_day.items(), key=lambda kv: -kv[1])[:busiest]],
        "types": [{"type": k, "count": v} for k, v in sorted(types.items(), key=lambda kv: -kv[1])],
        "top_senders": [{"sender": k, "count": v} for k, v in
                        sorted(senders.items(), key=lambda kv: -kv[1])[:15]],
        "media": media_report,
    }


def _flat(d, prefix=""):
    """嵌套报表 → 一层键值对（铺进 xlsx 的「统计」表时不能有嵌套）。"""
    out = {}
    for k, v in (d or {}).items():
        if isinstance(v, dict):
            out.update(_flat(v, f"{prefix}{k}."))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                if isinstance(x, dict):
                    out.update(_flat(x, f"{prefix}{k}[{i}]."))
                else:
                    out[f"{prefix}{k}[{i}]"] = x
        else:
            out[prefix + k] = v
    return out


def keyword_hits(records, keyword, limit=0):
    """按关键词挑出命中记录 → `(命中的记录, 是否被 limit 截断)`。

    匹配的是**渲染后的正文**（`render_text` 的产物，保留换行）加**附件文件名**——
    于是「图片」「语音」这类摘要词、和"那份叫 XX 的 pdf"都搜得到，和核心层
    `search_messages` 的口径一致。

    命中过多时保留**最新的** `limit` 条（记录是时间正序），并把截断**如实上报**：
    "就这么多"和"被上限切了"在结果里长得一模一样，不报就是让人把答案当事实。
    """
    kw = (keyword or "").strip().lower()
    if not kw:
        return records, False
    out = [r for r in records
           if kw in ((r.get("text") or "") + "\n" + ((r.get("file") or {}).get("title") or "")).lower()]
    if limit and len(out) > limit:
        return out[-int(limit):], True
    return out, False


def _rel(dest, base):
    """相对路径**一律用 `/`**：Windows 上 `relpath` 给的是 `assets\\img.jpg`，写进 HTML 的 `src`
    是坏 URL、写进 markdown 更不是路径——这正是"换台机器打开全是红叉"的一半原因。
    """
    return os.path.relpath(dest, base).replace(os.sep, "/")


def _data_uri(path, default_mime="image/jpeg"):
    """文件 → `data:` URI（自包含 HTML 用）。base64 后体积约 ×4/3，所以调用方要**先量后嵌**。

    `default_mime` 是给认不出扩展名的（解出来的图可能是 `.dat`）：认错 MIME 只是浏览器不当图渲染，
    而给个 `application/octet-stream` 是**必定**不渲染，所以宁可赌一个具体类型。
    """
    import base64
    import mimetypes
    mime = mimetypes.guess_type(path)[0] or default_mime
    with open(path, "rb") as f:
        return f"data:{mime};base64," + base64.b64encode(f.read()).decode("ascii")


def _export_media(talker, records, assets_dir, media, transcribe_voice, report,
                  inline=False, budget=0):
    """把图片/语音落进 assets_dir，并回填到记录上。缺 key / 缺依赖 / 音频已清 → 记数跳过。

    `inline=True`（自包含 HTML）：媒体**内嵌成 data URI、不落盘**，累计超过 `budget` 字节后
    退回写 assets/（**不丢东西**）并计入 `inline_fallback`——降级要留痕，不能让用户以为
    拿到的是一份自包含文件。
    """
    if media in (MEDIA_IMAGES, MEDIA_ALL):
        idx = 0
        # `idx` 只对**定位成功**的图片自增（决定 img_NNN 的编号，必须保持密集）；
        # 进度另用一个计数器，否则缺图时进度会跳。
        n_img = sum(1 for r in records if r["type"] == 3)
        done = 0
        for rec in records:
            if rec["type"] != 3:
                continue
            done += 1
            if done % 10 == 0 or done == n_img:
                mcp_stdio.progress(f"导出图片 {done}/{n_img}", total=n_img, n=done)
            try:
                m, why = core.image_message(talker, rec["local_id"])   # → (msg, 失败原因)
            except Exception:
                m, why = None, "error"
            path = (m or {}).get("image_path")
            if not path or not os.path.isfile(path):
                # `no_key`（图片 AES key 还没抓过，**在微信里点开任意一张图就有了**）与
                # `no_file`（原图与中图本地都没有，永久缺失）分开计：用户要做的事完全不同。
                report["image_no_key" if why == "no_key" else "image_missing"] += 1
                continue
            idx += 1
            dest = os.path.join(assets_dir, f"img_{idx:03d}{os.path.splitext(path)[1] or '.jpg'}")
            try:
                size = os.path.getsize(path)
            except OSError:
                report["image_missing"] += 1
                continue
            if inline and (not budget or report["inline_bytes"] + size <= budget):
                try:
                    rec["image"] = _data_uri(path)
                    report["inline_bytes"] += size
                    report["image_exported"] += 1
                except OSError:
                    report["image_missing"] += 1
                continue
            if inline:
                report["inline_fallback"] += 1
            try:
                os.makedirs(assets_dir, exist_ok=True)
                with open(path, "rb") as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                rec["image"] = _rel(dest, os.path.dirname(assets_dir))
                report["image_exported"] += 1
            except OSError:
                report["image_missing"] += 1

    if media == MEDIA_ALL:
        idx = 0
        n_voice = sum(1 for r in records if r["type"] == 34)
        done = 0
        for rec in records:
            if rec["type"] != 34:
                continue
            done += 1
            # 语音比图片慢（SILK 解码，开转写更慢）→ 每 5 条报一次
            if done % 5 == 0 or done == n_voice:
                mcp_stdio.progress(f"导出语音 {done}/{n_voice}", total=n_voice, n=done)
            try:
                silk = core.voice_file(talker, rec["ts"], rec["local_id"])
            except Exception:
                silk = None
            if not silk or not os.path.isfile(silk):
                report["voice_missing"] += 1
                continue
            idx += 1
            dest = os.path.join(assets_dir, f"voice_{idx:03d}.wav")
            try:
                os.makedirs(assets_dir, exist_ok=True)        # pilk 只会写文件，没法直接给内存
                _silk_to_wav(silk, dest)
            except Exception:
                report["voice_missing"] += 1                  # 缺 pilk 或解码失败
                continue
            try:
                size = os.path.getsize(dest)
                if inline and (not budget or report["inline_bytes"] + size <= budget):
                    rec["voice"] = _data_uri(dest, "audio/wav")
                    report["inline_bytes"] += size
                    os.remove(dest)                           # 内嵌了就别留副本
                    report["voice_exported"] += 1
                    continue
                if inline:
                    report["inline_fallback"] += 1
                rec["voice"] = _rel(dest, os.path.dirname(assets_dir))
                report["voice_exported"] += 1
            except OSError:
                report["voice_missing"] += 1
            if transcribe_voice:
                try:
                    import wechat_asr
                    rec["voice_text"] = wechat_asr.transcribe(silk)
                except Exception:
                    report["transcribe_failed"] += 1          # 缺 sherpa-onnx / 缺模型

    if media in (MEDIA_FILES, MEDIA_ALL):
        _export_files(records, assets_dir, report)


def _file_dest(files_dir, title, size, used):
    """文件消息 → 落盘用的文件名（`None` = 这一份已经收过了，别存第二遍）。

    同一份文件被反复发（群里转来转去）是常态，所以"同名同大小"直接判重；
    同名不同大小才是另一个版本，另存成 `名字 (2).ext`。`used` 是**本次导出**的账，
    不查磁盘：重跑一遍导出覆盖自己那份是无害的。
    """
    name = _safe(title)
    stem, ext = os.path.splitext(name)
    n = 1
    while name in used:
        if used[name] == size:
            return None
        n += 1
        name = f"{stem} ({n}){ext}"
    used[name] = size
    return name


def _export_files(records, assets_dir, report):
    """把记录里的**文件附件**（`appmsg type=6`）从磁盘收进 `files/`。

    只认共享层那套映射（`build_index` + `match_file`，一样是**只拷不搬**）。没下载/已过期的
    文件定位不到，如实计数——**别把"没定位到"说成"这个会话没文件"**。

    `ponytail:` 文件**从不内嵌**（哪怕在 `format=html` 的自包含模式下）：几十 MB 的 pdf 塞成
    data URI 只会把单文件撑爆，而"提取文件"这个用途本来要的就是磁盘上的真文件。
    """
    files_dir = os.path.join(os.path.dirname(assets_dir), "files")
    idx = core.build_index()
    used = {}
    for rec in records:
        f = rec.get("file")
        if not f:
            continue
        src, status = core.match_file(idx, f["title"], f["size"])
        if not src:
            report["file_missing"] += 1
            continue
        if status == "size_mismatch":
            report["file_mismatch"] += 1                  # 同名但大小不符：可能是另一版本
        name = _file_dest(files_dir, f["title"], f["size"], used)
        if name is None:
            report["file_dup"] += 1
            continue
        try:
            os.makedirs(files_dir, exist_ok=True)
            with open(src, "rb") as r, open(os.path.join(files_dir, name), "wb") as w:
                shutil.copyfileobj(r, w)
        except OSError:
            report["file_missing"] += 1
            continue
        f["path"] = _rel(os.path.join(files_dir, name), os.path.dirname(assets_dir))
        report["file_exported"] += 1


def _silk_to_wav(silk_path, wav_path):
    """SILK → 单声道 16bit wav（stdlib `wave` + `pilk`）。"""
    import wave

    import pilk
    import wechat_asr
    rate = wechat_asr.SAMPLE_RATE
    pcm = wav_path + ".pcm"
    try:
        pilk.decode(silk_path, pcm, pcm_rate=rate)
        with open(pcm, "rb") as f:
            data = f.read()
    finally:
        try:
            os.remove(pcm)
        except OSError:
            pass
    with wave.open(wav_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(data)


# ---- 三种格式的渲染 ----

def _md_block(rec, asset_prefix=""):
    head = f"### {rec['time']} · {rec['sender']}"
    if rec.get("agent_sent"):
        head += "（助手代发）"
    lines = [head, ""]
    if rec["text"]:
        lines += [rec["text"], ""]
    if rec.get("forward"):
        fw = rec["forward"]
        lines += [f"> **转发的聊天记录（{len(fw)} 条）**", ">"]
        for it in fw:
            head = " ".join(x for x in (it["sender"], it["time"]) if x)
            for i, ln in enumerate(str(it["text"]).split("\n")):
                lines.append(f"> {head + '：' if head and i == 0 else ''}{ln}")
        lines += [""]
    if rec.get("image"):
        lines += [f"![图片]({asset_prefix}{rec['image']})", ""]
    if (rec.get("file") or {}).get("path"):
        lines += [f"[附件：{rec['file']['title']}]({asset_prefix}{rec['file']['path']})", ""]
    if rec.get("voice"):
        lines += [f"[语音]({asset_prefix}{rec['voice']})", ""]
    if rec.get("voice_text"):
        lines += [f"> 语音转写：{rec['voice_text']}", ""]
    return "\n".join(lines)


def _stats_table(stats):
    """统计报表的 markdown 表（放正文最前面）。**都是计数**，没有一句判断。"""
    if not stats or not stats["count"]:
        return ""
    s = stats
    rows = [
        ("条数", f"{s['count']}（我 {s['from_me']} / 对方 {s['from_other']}）"),
        ("时间范围", f"{s['first']} ~ {s['last']}（跨 {s['span_days']} 天，有消息的 {s['active_days']} 天）"),
        ("类型", "、".join(f"{t['type']} {t['count']}" for t in s["types"])),
        ("发言人", "、".join(f"{t['sender']} {t['count']}" for t in s["top_senders"][:5])),
        ("按月", "、".join(f"{k} {v}" for k, v in s["by_month"].items())),
        ("按小时", "、".join(f"{k}时 {v}" for k, v in s["by_hour"].items())),
        ("按星期", "、".join(f"{k} {v}" for k, v in s["by_weekday"].items())),
        ("最忙的几天", "、".join(f"{d['day']} {d['count']}" for d in s["busiest_days"][:5])),
    ]
    if s.get("media"):
        rows.append(("媒体账", "、".join(f"{k} {v}" for k, v in _flat(s["media"]).items())))
    body = "\n".join(f"| {k} | {v} |" for k, v in rows if v)
    return f"## 统计报表\n\n| 项 | 值 |\n|---|---|\n{body}\n\n---\n"


def _md(title, records, since, until, asset_prefix="", stats=None):
    span = f"{_clock(since)} ~ {_clock(until)}" if since and until else "全部"
    head = [f"# 与「{title}」的聊天记录", "",
            f"> 导出时间：{_clock(time.time())} ｜ 共 {len(records)} 条 ｜ 时间范围：{span}", "",
            _stats_table(stats), "---", ""]
    return "\n".join(head) + "\n" + "\n".join(_md_block(r, asset_prefix) for r in records)


def _html(title, records, since, until, asset_prefix="", note="", stats=None):
    def esc(s):
        return html.escape(s or "").replace("\n", "<br>")

    rows, toc, day = [], [], None
    for r in records:
        d = r["time"][:10]
        if d != day:                                   # 跨多天才有目录；一天的会话给了是噪音
            day = d
            anchor = f"d{len(toc)}"
            toc.append((d, anchor))
            rows.append(f'<div class="day" id="{anchor}">{esc(d)}</div>')
        media = ""
        if r.get("image"):
            media += f'<img src="{asset_prefix}{esc(r["image"])}">'
        if r.get("voice"):
            media += f'<audio controls src="{asset_prefix}{esc(r["voice"])}"></audio>'
        if (r.get("file") or {}).get("path"):
            media += (f'<div class="fl"><a href="{asset_prefix}{esc(r["file"]["path"])}" '
                      f'download>附件：{esc(r["file"]["title"])}</a></div>')
        if r.get("voice_text"):
            media += f'<div class="vt">语音转写：{esc(r["voice_text"])}</div>'
        if r.get("forward"):
            items = "".join(
                f'<div class="fw-i"><span class="fw-w">{esc(it["sender"])} {esc(it["time"])}</span>'
                f'{esc(it["text"])}</div>' for it in r["forward"])
            media += (f'<div class="fw"><div class="fw-t">转发的聊天记录'
                      f'（{len(r["forward"])} 条）</div>{items}</div>')
        rows.append(
            f'<div class="m {"me" if r["from_me"] else "them"}">'
            f'<div class="meta">{esc(r["time"])} · {esc(r["sender"])}</div>'
            f'<div class="txt">{esc(r["text"])}{media}</div></div>')
    if len(toc) < 2:                                   # 只有一天：连分隔条一起撤掉
        marks = {f'<div class="day" id="{a}">{esc(d)}</div>' for d, a in toc}
        rows = [x for x in rows if x not in marks]
    span = f"{_clock(since)} ~ {_clock(until)}" if since and until else "全部"
    nav = ("" if len(toc) < 2 else
           '<nav class="toc">' + "".join(f'<a href="#{a}">{esc(d)}</a>' for d, a in toc) + "</nav>")
    warn = f'<div class="warn">{esc(note)}</div>' if note else ""
    stat = ""                                          # 报表：只放计数，且默认折叠起来不挤正文
    if stats and stats["count"]:
        items = "".join(f"<div><b>{esc(k)}</b>：{esc(v)}</div>" for k, v in (
            ("条数", f"{stats['count']}（我 {stats['from_me']} / 对方 {stats['from_other']}）"),
            ("时间范围", f"{stats['first']} ~ {stats['last']}（{stats['active_days']} 天有消息）"),
            ("类型", "、".join(f"{t['type']} {t['count']}" for t in stats["types"])),
            ("按小时", "、".join(f"{k}时 {v}" for k, v in stats["by_hour"].items())),
            ("按月", "、".join(f"{k} {v}" for k, v in stats["by_month"].items())),
        ))
        stat = f'<details class="stats"><summary>统计报表</summary>{items}</details>'
    return f"""<!doctype html><html lang="zh"><meta charset="utf-8">
<title>与「{html.escape(title)}」的聊天记录</title>
<style>
body{{font:15px/1.6 system-ui,"Microsoft YaHei",sans-serif;max-width:820px;margin:24px auto;padding:0 16px;background:#f5f5f5;color:#222}}
h1{{font-size:20px}} .sub{{color:#888;font-size:13px;margin-bottom:24px}}
.m{{margin:10px 0;display:flex;flex-direction:column}} .me{{align-items:flex-end}}
.meta{{font-size:12px;color:#999;margin-bottom:2px}}
.txt{{background:#fff;border-radius:10px;padding:8px 12px;max-width:78%;white-space:pre-wrap;word-break:break-word}}
.me .txt{{background:#95ec69}} img{{max-width:100%;border-radius:8px;margin-top:6px}}
audio{{margin-top:6px;max-width:100%}} .vt{{font-size:13px;color:#555;margin-top:4px}}
.fw{{margin-top:6px;border-left:3px solid #ccc;padding:6px 10px;background:#fafafa;border-radius:6px;font-size:14px}}
.fw-t{{color:#888;font-size:12px;margin-bottom:4px}}
.fw-i{{margin:3px 0;white-space:pre-wrap;word-break:break-word}}
.fw-w{{color:#888;font-size:12px;margin-right:4px}}
.day{{text-align:center;color:#888;font-size:12px;margin:20px 0 8px}}
.toc{{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:20px}}
.toc a{{font-size:12px;color:#576b95;background:#fff;border-radius:10px;padding:2px 8px;text-decoration:none}}
.fl{{margin-top:6px;font-size:13px}} .fl a{{color:#576b95}}
.stats{{background:#fff;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:16px;color:#555}}
.stats summary{{cursor:pointer;color:#576b95}}
.stats div{{margin-top:4px}}
.warn{{background:#fff7e6;border:1px solid #ffe0a3;color:#8a5a00;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:16px}}
</style>
<h1>与「{html.escape(title)}」的聊天记录</h1>
<div class="sub">导出时间：{_clock(time.time())} ｜ 共 {len(records)} 条 ｜ 时间范围：{span}</div>
{warn}{stat}{nav}
{''.join(rows)}
</html>"""


def _json(title, records, since, until, stats=None):
    return json.dumps({"title": title, "exported_at": int(time.time()),
                       "since": since, "until": until, "count": len(records),
                       "stats": stats, "messages": records}, ensure_ascii=False, indent=2)


# 三种格式都是文本，一张表就够。合法值只有一份来源（`_FORMATS`），
# 工具 schema 与参数校验都读它——别在这里再抄一遍，也别在 server 里再抄一遍。
_RENDER = {"md": _md, "html": _html, "json": _json}
_FORMATS = tuple(_RENDER)


def session_subdir(out_dir, name, query=""):
    """会话（+可选检索词）→ 导出子目录。**目录结构只在这一个地方定**。

    ```
    <out_dir>/<会话名>/                     split=none
    <out_dir>/<会话名>/<YYYY-MM>/           split=month
    <out_dir>/<会话名>/q-<关键词>/          按关键词导出（再叠 split 就在它下面）
    ```

    为什么检索结果单开一层 `q-<关键词>/`：同一个会话搜三次是**日常用法**，都写在
    `<会话名>/chat.md` 会让后一次**静默盖掉**前一次。目录里带检索词，导完自己就说清了
    "这份是什么"。关键词净化后截断到 40 字符——长句子当目录名会撞路径长度上限。
    """
    base = os.path.join(out_dir, _safe(name))
    if (query or "").strip():
        base = os.path.join(base, "q-" + _safe(query.strip())[:40])
    return base


def _write_session(out_dir, data, records, fmt, since, until, media, transcribe_voice,
                   split, inline_max_mb, query="", report=None):
    """把一个会话（已切成要导的那部分）写盘。返回本会话的结果 dict。

    **html + media ⇒ 媒体内嵌成 data URI（自包含）**：一个文件就能发给别人、换台机器也不掉图。
    md/json 把媒体放 `assets/`（正文里塞 base64 没人要）。超过 `inline_max_mb` 的部分
    **退回落盘**并如实报告（`media_report.inline_fallback`），页首也会写明"这份不再自包含"。
    """
    mcp_stdio.progress(f"读到 {len(records)} 条消息，开始写文件")
    session_dir = session_subdir(out_dir, data["name"], query)
    report = report if report is not None else {
        "image_exported": 0, "image_missing": 0, "image_no_key": 0,
        "inline_bytes": 0, "inline_fallback": 0,
        "voice_exported": 0, "voice_missing": 0, "transcribe_failed": 0,
        "file_exported": 0, "file_missing": 0, "file_mismatch": 0, "file_dup": 0}
    inline = fmt == "html" and media != MEDIA_NONE
    budget = int((inline_max_mb or 0) * 1024 * 1024)

    groups = {}
    if split == "month":
        for r in records:
            groups.setdefault(r["month"], []).append(r)
    else:
        groups[""] = records

    written, total_bytes = [], 0
    for month, recs in groups.items():
        base = os.path.join(session_dir, month) if month else session_dir
        os.makedirs(base, exist_ok=True)
        if media != MEDIA_NONE:
            # 用**解析过的** talker：`tbl_of` 是拿字符串算 md5 的，直接喂显示名会算出不存在的表
            # ⇒ 每张图都定位不到、`image_missing` 计数一路涨，导出的文件里一张图都没有。
            # （`build_records` 里已经解析过一次，这里沿用它的结果。）
            _export_media(data["talker"], recs, os.path.join(base, "assets"), media,
                          transcribe_voice, report, inline=inline, budget=budget)
        note = ""
        if inline and report["inline_fallback"]:
            note = (f"有 {report['inline_fallback']} 项媒体超过内嵌上限（{inline_max_mb} MB），"
                    f"已放到同目录 assets/ 下——这份 HTML 因此不再自包含，"
                    f"换台机器打开那些图会是空框。要全内嵌请调大 inline_max_mb（0 = 不限）。")
        if report["file_exported"]:
            note += (f"本会话还收了 {report['file_exported']} 个文件附件在 files/ 目录，"
                     f"它们不内嵌——要一起发出去请连该目录一起打包。")
        # 报表**在本组自己的记录上算**：split=month 时每份文件讲的是它那个月，不是全年
        stats = stats_of(recs, report)
        path = os.path.join(base, f"chat.{fmt}")
        tmp = path + ".tmp"
        kw = {"stats": stats}                           # 报表进每一份正文：md 是一张表，json 是一个字段
        if fmt == "html":
            kw["note"] = note
        body = _RENDER[fmt](data["name"], recs, since, until, **kw)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(body)
        os.replace(tmp, path)
        n = os.path.getsize(path)
        written.append(os.path.relpath(path, out_dir))
        total_bytes += n

    for dp, _d, fs in os.walk(session_dir):                 # 把媒体体积也算进去
        for f in fs:
            if not f.startswith("chat."):
                try:
                    total_bytes += os.path.getsize(os.path.join(dp, f))
                except OSError:
                    pass

    # 报表另落一份 `stats.json`：**不管什么格式都在**。md/html 里的报表是给人扫一眼的，
    # 而"要拿去分析的报表"得有个不依赖格式的机读落点——喂模型、喂脚本都直接读它。
    out_stats = {**stats_of(records, report), "session": data["name"],
                 "talker": data["talker"], "since": since, "until": until,
                 "query": (query or ""), "format": fmt, "exported_at": int(time.time())}
    sp = os.path.join(session_dir, "stats.json")
    stmp = sp + ".tmp"
    with open(stmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(out_stats, ensure_ascii=False, indent=2))
    os.replace(stmp, sp)

    return {"dir": session_dir, "session": data["name"], "format": fmt, "split": split,
            "messages": len(records), "files_written": written, "bytes": total_bytes,
            "media": media, "inline": inline, "media_report": report, "stats": out_stats}


def export_chat(talker, out_dir, format="md", since=0, until=0, media=MEDIA_NONE,
                transcribe_voice=False, split="none", inline_max_mb=_INLINE_BUDGET_MB,
                keyword="", limit=0):
    """导出**单个会话**。返回 `{out_dir, session, messages, stats, files_written, bytes, media_report}`。

    `split="month"` 时按月拆成子目录（每段一份文件），防单文件过大。

    `keyword` 非空时**只导出命中的那些消息**（正文 + 附件名匹配），命中超过 `limit` 条
    就保留最新的 `limit` 条并置 `truncated`（记录永远时间正序）。
    """
    fmt = format if format in _FORMATS else "md"
    # 进度：跨全部分片读消息 + 逐条解密图片/解码语音，大会话要跑几十秒。
    # 单调性由 mcp_stdio.progress 兜底，这里不必自己维护递增序列。
    mcp_stdio.progress("正在读取会话记录（跨全部分片）…")
    data = build_records(talker, since, until)
    records, trunc = keyword_hits(data["records"], keyword, limit)
    res = _write_session(out_dir, data, records, fmt, since, until, media, transcribe_voice,
                         split, inline_max_mb, query=keyword)
    res.update({"out_dir": os.path.abspath(out_dir), "keyword": keyword or "",
                "truncated": trunc, "scanned": len(data["records"])})
    return res


def export_many(out_dir, keyword, format="md", since=0, until=0, media=MEDIA_NONE,
                transcribe_voice=False, split="none", inline_max_mb=_INLINE_BUDGET_MB,
                limit=0, max_sessions=_MAX_SESSIONS):
    """按关键词在**全部会话**里搜，只导出命中的部分——每个命中的会话一个子目录。

    `talker` 不给就是这条路（"帮我全库找一下提到 X 的记录"）。两个刻意的取舍：

    - **先扫完再排序**：命中的会话按命中条数从多到少导，于是 `max_sessions` 砍掉的是尾巴
      而不是"恰好排在字典序前面的那 20 个"。命中的记录本来就在手上（每会话 ≤ `limit` 条），
      不重扫第二遍。
    - **零命中的会话不留空目录**：全库 200 个会话里只 3 个命中，就不该在导出目录里
      撒 200 个空文件夹。
    """
    kw = (keyword or "").strip()
    if not kw:
        raise ValueError("keyword 必填（不给 talker 时只能按关键词搜）")
    core._refresh()
    # ⚠️ `talkers()` 给的是 `(表名, talker)`——**反了**。曾经按反序取，于是每个会话都抛
    # `UnknownTalker`，而下面那个 `except` 把它们**全吞了**：全库搜恒返回"命中 0 个"、
    # 不报错、看着像个正常结果。（实测 72 个会话命中 0，而单会话搜同一个词命中 12。）
    pairs = list(core.talkers())
    matched, failed = [], 0
    for i, (_tbl, t) in enumerate(pairs, 1):
        mcp_stdio.progress(f"检索会话 {i}/{len(pairs)}", total=len(pairs), n=i)
        try:
            data = build_records(t, since, until)
        except E_SKIP as e:                             # 单个会话读不动（表损坏等）不该拖垮全库，
            failed += 1                                 # 但**必须计数**——静默跳过就是上面那个坑
            if failed <= 3:
                mcp_stdio.progress(f"跳过 {t}：{e}")
            continue
        recs, trunc = keyword_hits(data["records"], kw, limit)
        if recs:
            matched.append((data, recs, trunc))
    matched.sort(key=lambda x: -len(x[1]))
    results, skipped = [], 0
    for data, recs, trunc in matched:
        if len(results) >= int(max_sessions or _MAX_SESSIONS):
            skipped += 1
            continue
        mcp_stdio.progress(f"导出 {data['name']}（{len(recs)} 条）")
        try:
            r = _write_session(out_dir, data, recs, format if format in _FORMATS else "md",
                               since, until, media, transcribe_voice, split, inline_max_mb, query=kw)
        except OSError:
            continue
        r.update({"truncated": trunc, "scanned": len(data["records"])})
        results.append(r)
    index = _write_index(out_dir, results, kw, since, until) if len(results) > 1 else None
    for r in results:                                   # 每份 stats 都已落盘，返回里别重复塞两遍
        r.pop("stats", None)
    return {"out_dir": os.path.abspath(out_dir), "keyword": kw, "format": format,
            "sessions_scanned": len(pairs), "sessions_failed": failed,
            "sessions_matched": len(matched),
            "sessions_exported": len(results), "sessions_skipped": skipped,
            "index": index, "results": results}


def _write_index(out_dir, results, keyword, since, until):
    """多会话导出时在根上留一份清单（会话 / 命中 / 时间范围 / 目录）——否则导完只看见一堆文件夹。"""
    rows = ["| 会话 | 命中 | 时间范围 | 目录 |", "|---|---|---|---|"]
    for r in results:
        s = r.get("stats") or {}
        span = f"{s.get('first', '')} ~ {s.get('last', '')}" if s else ""
        rows.append(f"| {r['session']} | {r['messages']} | {span} | `{os.path.basename(r['dir'])}/` |")
    body = "\n".join([
        "# 导出清单", "",
        f"> 导出时间：{_clock(time.time())} ｜ 关键词：`{keyword}` ｜ 共 {len(results)} 个会话", "",
        *rows, "",
        "每个会话目录里的 `stats.json` 是那份记录的统计报表（机读）；`chat.<格式>` 是正文。", ""])
    path = os.path.join(out_dir, "index.md")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(body)
    os.replace(tmp, path)
    return os.path.relpath(path, out_dir).replace(os.sep, "/")
