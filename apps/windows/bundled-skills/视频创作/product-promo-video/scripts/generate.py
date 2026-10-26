#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
产品宣传视频生成器（PIL 出帧 + ffmpeg 编码）

两种调用方式：
  1. 技能运行时：参数经 SKILL_PARAMS 环境变量传入（JSON），结果打到 __SKILL_RESULT__:
  2. 命令行：python generate.py config.json [--selfcheck]

config 结构见 example-config.json；selfcheck 只验证片段构建与首帧渲染，不出视频。

依赖: Pillow, ffmpeg; 图表额外需要 plotly + kaleido（缺失时降级为文字卡片）
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1920, 1080
FPS = 30

BG_COLOR = (20, 20, 30)
GRID_COLOR = (30, 30, 40)
ACCENT_COLOR = (0, 200, 255)
TEXT_COLOR = (220, 220, 220)
MUTED_COLOR = (140, 140, 150)
HIGHLIGHT_COLOR = (255, 100, 100)
ARROW_COLOR = (255, 200, 0)

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/PingFang.ttc",
]

_screenshot_cache = {}


def _font(size):
    for candidate in FONT_CANDIDATES:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _text_center(draw, text, y, size, color):
    font = _font(size)
    bbox = draw.textbbox((0, 0), text, font=font)
    draw.text(((WIDTH - (bbox[2] - bbox[0])) // 2 - bbox[0], y), text, fill=color, font=font)


def _grid_background():
    img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    draw = ImageDraw.Draw(img)
    for x in range(0, WIDTH, 40):
        draw.line([(x, 0), (x, HEIGHT)], fill=GRID_COLOR, width=1)
    for y in range(0, HEIGHT, 40):
        draw.line([(0, y), (WIDTH, y)], fill=GRID_COLOR, width=1)
    return img


def title_card(title, subtitle, progress=1.0):
    """标题卡片；progress 控制副标题 / 下划线的入场。"""
    img = _grid_background()
    draw = ImageDraw.Draw(img)
    _text_center(draw, title, 400, 96, ACCENT_COLOR)
    if progress > 0.4:
        _text_center(draw, subtitle, 550, 48, TEXT_COLOR)
        y = 640
        draw.line([(WIDTH // 2 - 120, y), (WIDTH // 2 + 120, y)], fill=ACCENT_COLOR, width=4)
    return img


def draw_arrow(draw, x1, y1, x2, y2, color=ARROW_COLOR, width=4):
    draw.line([x1, y1, x2, y2], fill=color, width=width)
    angle = math.atan2(y2 - y1, x2 - x1)
    length, spread = 24, math.pi / 6
    for sign in (-1, 1):
        draw.line(
            [x2, y2,
             x2 - length * math.cos(angle + sign * spread),
             y2 - length * math.sin(angle + sign * spread)],
            fill=color, width=width,
        )


def load_screenshot(path, max_width=1600, max_height=860):
    """居中贴到画布上，返回 (画布, 截图实际外框)。结果按路径缓存。"""
    if path in _screenshot_cache:
        return _screenshot_cache[path]
    img = Image.open(path).convert("RGB")
    scale = min(max_width / img.width, max_height / img.height, 1.0)
    new_size = (int(img.width * scale), int(img.height * scale))
    resized = img.resize(new_size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
    x, y = (WIDTH - new_size[0]) // 2, (HEIGHT - new_size[1]) // 2
    canvas.paste(resized, (x, y))
    result = (canvas, (x, y, new_size[0], new_size[1]))
    _screenshot_cache[path] = result
    return result


def screenshot_frame(path, caption, annotation, progress):
    """截图帧 + 说明条 + 按进度出现的动态标注。"""
    base, (x, y, w, h) = load_screenshot(path)
    img = base.copy()
    draw = ImageDraw.Draw(img)

    if annotation == "highlight_top" and 0.2 < progress < 0.8:
        draw.rectangle([x + 40, y + 40, x + w - 40, y + 140], outline=HIGHLIGHT_COLOR, width=4)
    elif annotation == "highlight_center" and 0.2 < progress < 0.8:
        box_w, box_h = w // 2, h // 3
        bx, by = x + (w - box_w) // 2, y + (h - box_h) // 2
        draw.rectangle([bx, by, bx + box_w, by + box_h], outline=HIGHLIGHT_COLOR, width=4)
    elif annotation == "arrow_down" and 0.3 < progress < 0.7:
        grow = (progress - 0.3) / 0.4
        sx, sy = x + w // 2, y + 180
        draw_arrow(draw, sx, sy, sx, sy + int(320 * grow))

    if caption:
        draw.rectangle([0, HEIGHT - 140, WIDTH, HEIGHT], fill=(0, 0, 0))
        _text_center(draw, caption, HEIGHT - 105, 52, TEXT_COLOR)
    return img


def _fade(img, progress):
    """片段首尾 10% 做亮度渐变，避免硬切。"""
    if progress < 0.1:
        factor = progress * 10
    elif progress > 0.9:
        factor = (1 - progress) * 10
    else:
        return img
    return img.point(lambda v: int(v * factor))


def _apply_fade(fn):
    def wrapper(local_frame, total_frames, progress):
        return _fade(fn(local_frame, total_frames, progress), progress)
    return wrapper


# ---------------------------------------------------------------- Plotly 图表

def _plotly_figure(spec):
    import plotly.graph_objects as go
    from plotly.subplots import make_subplots

    kind = spec.get("type")
    layout = dict(
        paper_bgcolor="#14141E",
        plot_bgcolor="#14141E",
        font={"color": "#DCDCDC", "size": 26},
        width=WIDTH,
        height=HEIGHT,
        margin=dict(t=120, b=80, l=80, r=80),
    )

    if kind == "indicator":
        cells = spec["metrics"][:4]
        rows = 2 if len(cells) > 2 else 1
        cols = 2 if len(cells) > 1 else 1
        fig = make_subplots(
            rows=rows, cols=cols,
            specs=[[{"type": "indicator"}] * cols] * rows,
            vertical_spacing=0.15, horizontal_spacing=0.1,
        )
        for i, cell in enumerate(cells):
            fig.add_trace(
                go.Indicator(
                    mode="number",
                    value=cell["value"],
                    title={"text": cell["label"], "font": {"size": 36}},
                    number={"suffix": cell.get("suffix", ""), "font": {"size": 80}},
                ),
                row=i // cols + 1, col=i % cols + 1,
            )
        fig.update_layout(**layout)

    elif kind == "bar":
        fig = go.Figure(go.Bar(
            x=[c["label"] for c in spec["bars"]],
            y=[c["value"] for c in spec["bars"]],
            text=[c["value"] for c in spec["bars"]],
            textposition="outside",
            textfont=dict(size=32, color="white"),
            marker_color=ACCENT_COLOR,
        ))
        fig.update_layout(title={"text": spec.get("title", ""), "x": 0.5, "xanchor": "center",
                                  "font": {"size": 48}}, showlegend=False, **layout)

    elif kind == "sankey":
        nodes = spec["nodes"]
        fig = go.Figure(go.Sankey(
            node=dict(label=[n["label"] for n in nodes], thickness=30, pad=15,
                      line=dict(color="white", width=2)),
            link=dict(source=[l["from"] for l in spec["links"]],
                      target=[l["to"] for l in spec["links"]],
                      value=[l["value"] for l in spec["links"]]),
        ))
        fig.update_layout(title={"text": spec.get("title", ""), "x": 0.5, "xanchor": "center",
                                  "font": {"size": 48}}, **layout)

    else:
        raise ValueError("未知图表类型: %s" % kind)

    return fig


def _render_chart_png(spec, work_dir):
    """Plotly 渲染为 PNG；kaleido 缺失时降级为文字卡片。"""
    target = os.path.join(work_dir, "chart-%d.png" % abs(hash(json.dumps(spec, sort_keys=True))))
    try:
        _plotly_figure(spec).write_image(target, format="png", width=WIDTH, height=HEIGHT)
    except Exception as exc:  # kaleido 缺失 / 渲染失败
        print("  [warn] 图表渲染失败，降级为文字卡片: %s" % exc)
        return None
    img = Image.open(target).convert("RGBA")
    # Plotly 出 RGBA，PIL 画布是 RGB，不转换会在合成时报通道不匹配
    canvas = Image.new("RGB", img.size, BG_COLOR)
    canvas.paste(img, mask=img.split()[3])
    return canvas


# ---------------------------------------------------------------- 配置 -> 片段

def build_segments(cfg, work_dir):
    """返回 [(帧数, render(local_frame, total, progress) -> Image)]，按顺序拼接。"""
    segments = []

    def card_segment(card_cfg):
        seconds = float(card_cfg.get("seconds", 3))
        title, subtitle = card_cfg["title"], card_cfg.get("subtitle", "")

        def render(_local, _total, progress):
            return title_card(title, subtitle, progress)
        segments.append((int(seconds * FPS), render))

    def chart_segment(spec):
        seconds = float(spec.get("seconds", 10))
        img = _render_chart_png(spec, work_dir)
        if img is None:
            caption = spec.get("title") or spec.get("type", "chart")
            def render(_local, _total, progress, caption=caption):
                return title_card(caption, "图表渲染不可用", progress)
        else:
            def render(_local, _total, progress, img=img):
                return img
        segments.append((int(seconds * FPS), _apply_fade(render)))

    def shot_segment(item):
        seconds = float(item.get("seconds", 5))
        path, caption, annotation = item["screenshot"], item.get("caption", ""), item.get("annotation")

        def render(_local, _total, progress):
            return screenshot_frame(path, caption, annotation, progress)
        segments.append((int(seconds * FPS), render))

    if cfg.get("intro"):
        card_segment(cfg["intro"])

    for section in cfg.get("sections", []):
        if section.get("title"):
            card_segment({"title": section["title"], "subtitle": section.get("subtitle", ""),
                          "seconds": section.get("seconds", 2)})
        for item in section.get("items", []):
            if "screenshot" in item:
                shot_segment(item)
            elif "chart" in item:
                chart_segment(dict(item["chart"], seconds=item.get("seconds", 10)))

    if cfg.get("outro"):
        card_segment(cfg["outro"])

    return segments


def validate(cfg):
    if not cfg.get("style"):
        print("[warn] 未指定 style，按 product-demo 处理")
    output = cfg.get("output") or {}
    if not output.get("dir") or not output.get("filename"):
        raise ValueError("output.dir 与 output.filename 必填")
    segments = cfg.get("sections") or cfg.get("intro") or cfg.get("outro")
    if not segments:
        raise ValueError("至少要提供 intro / sections / outro 之一")
    for section in cfg.get("sections", []):
        for item in section.get("items", []):
            path = item.get("screenshot")
            if path and not os.path.exists(path):
                raise ValueError("截图不存在: %s" % path)


def render(cfg, work_dir):
    segments = build_segments(cfg, work_dir)
    if not segments:
        raise ValueError("没有可渲染的片段")

    frame_dir = os.path.join(work_dir, "frames")
    os.makedirs(frame_dir, exist_ok=True)

    total = sum(n for n, _ in segments)
    print("渲染 %d 帧（%.1f 秒 @ %d fps）" % (total, total / FPS, FPS))

    idx = 0
    for frames, render_fn in segments:
        for local in range(frames):
            img = render_fn(local, frames, local / max(frames - 1, 1))
            img.save(os.path.join(frame_dir, "frame_%05d.png" % idx))
            idx += 1
        if idx % (FPS * 10) < frames:
            print("  %d/%d 帧" % (idx, total))

    out_path = os.path.join(cfg["output"]["dir"], cfg["output"]["filename"])
    os.makedirs(cfg["output"]["dir"], exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", os.path.join(frame_dir, "frame_%05d.png"),
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
        out_path,
    ]
    print("编码视频 -> %s" % out_path)
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out_path


def selfcheck(cfg, work_dir):
    """不出视频，只验证片段构建、图表渲染与首帧。"""
    segments = build_segments(cfg, work_dir)
    assert segments, "片段列表为空"
    for frames, render_fn in segments:
        img = render_fn(0, frames, 0.5)
        assert img.size == (WIDTH, HEIGHT), "帧尺寸不对: %s" % (img.size,)
        assert img.mode == "RGB", "帧颜色模式不对: %s" % img.mode
    total = sum(n for n, _ in segments)
    print("selfcheck ok: %d 个片段，%d 帧（%.1f 秒）" % (len(segments), total, total / FPS))


def _emit_result(payload):
    """技能运行时约定的结果协议：单行 __SKILL_RESULT__:JSON。"""
    print("__SKILL_RESULT__" + json.dumps(payload, ensure_ascii=False))


def _run(cfg, check_only):
    work_dir = tempfile.mkdtemp(prefix="promo-frames-")
    try:
        if check_only:
            selfcheck(cfg, work_dir)
            return {"ok": True, "selfcheck": True}
        out = render(cfg, work_dir)
    finally:
        # 帧序列体积很大（3600 帧 ≈ 数 GB），用完即删
        shutil.rmtree(work_dir, ignore_errors=True)

    return {
        "ok": True,
        "outputPath": os.path.abspath(out),
        "bytes": os.path.getsize(out),
        "message": "视频已生成: %s (%.2f MB)" % (out, os.path.getsize(out) / 1024 / 1024),
    }


def _load_config_file(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main():
    raw_params = os.environ.get("SKILL_PARAMS")

    try:
        if raw_params:
            # 技能运行时：参数全部来自 SKILL_PARAMS，不接受命令行参数
            params = json.loads(raw_params) if raw_params.strip() else {}
            cfg = params.get("config")
            if not cfg:
                # 也允许直接从 params 里给 configPath，或把 config 字段平铺进来
                if params.get("configPath"):
                    cfg = _load_config_file(params["configPath"])
                else:
                    cfg = params
            validate(cfg)
            _emit_result(_run(cfg, check_only=bool(params.get("selfcheck"))))
            return 0

        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        if not args:
            print(__doc__)
            return 1
        cfg = _load_config_file(args[0])
        validate(cfg)
        _emit_result(_run(cfg, check_only="--selfcheck" in sys.argv))
        return 0

    except Exception as exc:
        if raw_params:
            _emit_result({"ok": False, "error": str(exc)})
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main())
