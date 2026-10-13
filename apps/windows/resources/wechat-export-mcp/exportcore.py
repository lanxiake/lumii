"""B · 记录导出 —— 核心逻辑（不依赖微信运行；只有需要真库时才去读）。

把某个会话的消息流导出成**能读、能分享、能归档**的文件：md / html / json，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

只读：不修改任何微信数据。
"""
import html
import json
import os
import re
import sqlite3
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
_SHARED = os.path.join(os.path.dirname(HERE), "wechat-mcp")   # 共享基础层（零复制）
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import mcp_stdio  # noqa: E402  （只为了报进度；没装回调时 progress() 是空操作）
import wechat_core as core  # noqa: E402

MEDIA_NONE, MEDIA_IMAGES, MEDIA_ALL = "none", "images", "all"
_MEDIA = (MEDIA_NONE, MEDIA_IMAGES, MEDIA_ALL)
_SPLIT = ("none", "month")
_WIN_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_BIG = 10 ** 9


def bad_args(args):
    """枚举参数的**边界校验**，返回问题列表（空 = 没问题）。合法值在这里定，工具 schema 也读它。

    为什么要单独校验：`media="image"`（拼错）原来会连着两次比较都不命中 → 一颗媒体都不出、
    也不报错，调用方拿到的是 `isError=false` 的正常结果——"参数打错"与"这批消息没图"分不出来。
    `format` 更隐蔽：悄悄退回 md，返回里看着一切正常。
    """
    return [f"{k}={args[k]!r}（可选 {list(ok)}）"
            for k, ok in (("format", tuple(_RENDER)), ("media", _MEDIA), ("split", _SPLIT))
            if args.get(k) and args[k] not in ok]


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
        })
    return {"name": names.get(talker, talker), "talker": talker, "records": out}


def _export_media(talker, records, assets_dir, media, transcribe_voice, report):
    """把图片/语音落进 assets_dir，并回填到记录上。缺 key / 缺依赖 / 音频已清 → 记数跳过。"""
    os.makedirs(assets_dir, exist_ok=True)

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
                m = core.image_message(talker, rec["local_id"])
            except Exception:
                m = None
            path = (m or {}).get("image_path")
            if not path or not os.path.isfile(path):
                report["image_missing"] += 1
                continue
            idx += 1
            dest = os.path.join(assets_dir, f"img_{idx:03d}{os.path.splitext(path)[1] or '.jpg'}")
            try:
                with open(path, "rb") as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                rec["image"] = os.path.relpath(dest, os.path.dirname(assets_dir))
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
                _silk_to_wav(silk, dest)
                rec["voice"] = os.path.relpath(dest, os.path.dirname(assets_dir))
                report["voice_exported"] += 1
            except Exception:
                report["voice_missing"] += 1                  # 缺 pilk 或解码失败
            if transcribe_voice:
                try:
                    import wechat_asr
                    rec["voice_text"] = wechat_asr.transcribe(silk)
                except Exception:
                    report["transcribe_failed"] += 1          # 缺 sherpa-onnx / 缺模型


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
    if rec.get("image"):
        lines += [f"![图片]({asset_prefix}{rec['image']})", ""]
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


def _html(title, records, since, until, asset_prefix=""):
    def esc(s):
        return html.escape(s or "").replace("\n", "<br>")

    rows = []
    for r in records:
        media = ""
        if r.get("image"):
            media += f'<img src="{asset_prefix}{esc(r["image"])}">'
        if r.get("voice"):
            media += f'<audio controls src="{asset_prefix}{esc(r["voice"])}"></audio>'
        if r.get("voice_text"):
            media += f'<div class="vt">语音转写：{esc(r["voice_text"])}</div>'
        rows.append(
            f'<div class="m {"me" if r["from_me"] else "them"}">'
            f'<div class="meta">{esc(r["time"])} · {esc(r["sender"])}</div>'
            f'<div class="txt">{esc(r["text"])}{media}</div></div>')
    span = f"{_clock(since)} ~ {_clock(until)}" if since and until else "全部"
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
</style>
<h1>与「{html.escape(title)}」的聊天记录</h1>
<div class="sub">导出时间：{_clock(time.time())} ｜ 共 {len(records)} 条 ｜ 时间范围：{span}</div>
{''.join(rows)}
</html>"""


def _json(title, records, since, until):
    return json.dumps({"title": title, "exported_at": int(time.time()),
                       "since": since, "until": until, "count": len(records),
                       "messages": records}, ensure_ascii=False, indent=2)


_RENDER = {"md": _md, "html": _html, "json": lambda t, r, s, u, p="": _json(t, r, s, u)}


def export_chat(talker, out_dir, format="md", since=0, until=0, media=MEDIA_NONE,
                transcribe_voice=False, split="none"):
    """导出单个会话。返回 `{out_dir, session, messages, files_written, bytes, media_report}`。

    `split="month"` 时按月拆成子目录（每段一份文件），防单文件过大。
    """
    fmt = format if format in _RENDER else "md"
    # 进度：跨全部分片读消息 + 逐条解密图片/解码语音，大会话要跑几十秒。
    # 单调性由 mcp_stdio.progress 兜底，这里不必自己维护递增序列。
    mcp_stdio.progress("正在读取会话记录（跨全部分片）…")
    data = build_records(talker, since, until)
    records = data["records"]
    mcp_stdio.progress(f"读到 {len(records)} 条消息，开始写文件")
    session_dir = os.path.join(out_dir, _safe(data["name"]))
    report = {"image_exported": 0, "image_missing": 0,
              "voice_exported": 0, "voice_missing": 0, "transcribe_failed": 0}

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
            _export_media(talker, recs, os.path.join(base, "assets"), media, transcribe_voice, report)
        body = _RENDER[fmt](data["name"], recs, since, until)
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
            "bytes": total_bytes, "media": media, "media_report": report}
