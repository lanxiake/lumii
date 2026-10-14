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

# 自包含 HTML 的内嵌预算（`inline_max_mb=0` = 不限）。**实测**（2026-10-14，探针
# `verify/wechat-mcp/probe_html_size.py`）：一个 500 条带图的会话，原图 30 MB ⇒ base64 后
# 40 MB；同样的会话只出文字是 17 KB。也就是说体积**全在图上**，按同一比例，5000 条就是 400 MB
# 的单文件——浏览器扛不住，也没法发出去。所以给上限：超了**退回落盘**（东西一样不少），
# 在页首和返回里如实说明"这份不再自包含"。
_INLINE_BUDGET_MB = 20


def bad_args(args):
    """枚举参数的**边界校验**，返回问题列表（空 = 没问题）。合法值在这里定，工具 schema 也读它。

    为什么要单独校验：`media="image"`（拼错）原来会连着两次比较都不命中 → 一颗媒体都不出、
    也不报错，调用方拿到的是 `isError=false` 的正常结果——"参数打错"与"这批消息没图"分不出来。
    `format` 更隐蔽：悄悄退回 md，返回里看着一切正常。
    """
    bad = [f"{k}={args[k]!r}（可选 {list(ok)}）"
           for k, ok in (("format", tuple(_RENDER)), ("media", _MEDIA), ("split", _SPLIT))
           if args.get(k) and args[k] not in ok]
    mb = args.get("inline_max_mb")
    # `True` 也是 int，别放过去当 1 MB
    if mb is not None and (isinstance(mb, bool) or not isinstance(mb, (int, float)) or mb < 0):
        bad.append(f"inline_max_mb={mb!r}（非负数字，0 = 不限）")
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


def _md(title, records, since, until, asset_prefix=""):
    span = f"{_clock(since)} ~ {_clock(until)}" if since and until else "全部"
    head = [f"# 与「{title}」的聊天记录", "",
            f"> 导出时间：{_clock(time.time())} ｜ 共 {len(records)} 条 ｜ 时间范围：{span}", "",
            "---", ""]
    return "\n".join(head) + "\n" + "\n".join(_md_block(r, asset_prefix) for r in records)


def _html(title, records, since, until, asset_prefix="", note=""):
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
.warn{{background:#fff7e6;border:1px solid #ffe0a3;color:#8a5a00;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:16px}}
</style>
<h1>与「{html.escape(title)}」的聊天记录</h1>
<div class="sub">导出时间：{_clock(time.time())} ｜ 共 {len(records)} 条 ｜ 时间范围：{span}</div>
{warn}{nav}
{''.join(rows)}
</html>"""


def _json(title, records, since, until):
    return json.dumps({"title": title, "exported_at": int(time.time()),
                       "since": since, "until": until, "count": len(records),
                       "messages": records}, ensure_ascii=False, indent=2)


_RENDER = {"md": _md, "html": _html, "json": lambda t, r, s, u, p="": _json(t, r, s, u)}


def export_chat(talker, out_dir, format="md", since=0, until=0, media=MEDIA_NONE,
                transcribe_voice=False, split="none", inline_max_mb=_INLINE_BUDGET_MB):
    """导出单个会话。返回 `{out_dir, session, messages, files_written, bytes, media_report}`。

    `split="month"` 时按月拆成子目录（每段一份文件），防单文件过大。

    **html + media ⇒ 媒体内嵌成 data URI（自包含）**：一个文件就能发给别人、换台机器也不掉图。
    md 与 json 仍旧把媒体放 `assets/`（md 里塞 base64 没人要）。超过 `inline_max_mb` 的部分
    **退回落盘**并如实报告（`media_report.inline_fallback`），页首也会写明"这份不再自包含"。
    """
    fmt = format if format in _RENDER else "md"
    # 进度：跨全部分片读消息 + 逐条解密图片/解码语音，大会话要跑几十秒。
    # 单调性由 mcp_stdio.progress 兜底，这里不必自己维护递增序列。
    mcp_stdio.progress("正在读取会话记录（跨全部分片）…")
    data = build_records(talker, since, until)
    records = data["records"]
    mcp_stdio.progress(f"读到 {len(records)} 条消息，开始写文件")
    session_dir = os.path.join(out_dir, _safe(data["name"]))
    report = {"image_exported": 0, "image_missing": 0, "image_no_key": 0,
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
        body = _RENDER[fmt](data["name"], recs, since, until,
                            **({"note": note} if fmt == "html" else {}))
        path = os.path.join(base, f"chat.{fmt}")
        tmp = path + ".tmp"
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

    return {"out_dir": os.path.abspath(out_dir), "session": data["name"], "format": fmt,
            "split": split, "messages": len(records), "files_written": written,
            "bytes": total_bytes, "media": media, "inline": inline, "media_report": report}
