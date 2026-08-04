#!/usr/bin/env python3
"""
统一发布入口：根据 publish-options.json 的 mode 分发到四种发布方式。

mode 取值：
  cdp-image   — CDP 填图文草稿
  cdp-video   — CDP 填视频草稿
  sau-image   — sau douyin upload-note
  sau-video   — sau douyin upload-video
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

from publish_options import PublishOptions


def _run(cmd: list[str], cwd: Path | None = None) -> int:
    """执行子进程命令并透传输出。"""
    print("[douyin_publish]", " ".join(cmd), file=sys.stderr)
    return subprocess.call(cmd, cwd=str(cwd) if cwd else None)


def publish_cdp_image(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """CDP 图文发布。"""
    images = sorted((article_dir / "images").glob("*.png"))
    if not images:
        raise SystemExit("[ERROR] no images in article images/")
    opts_path = article_dir / "publish-options.json"
    cmd = [sys.executable, str(scripts_dir / "douyin_cdp_publish.py")]
    if opts.account:
        cmd.extend(["--account", opts.account])
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    cmd.extend([
        "fill-image",
        "--options", str(opts_path),
        "--images", *[str(p) for p in images],
    ])
    if title_file.exists():
        cmd.extend(["--title-file", str(title_file)])
    if content_file.exists():
        cmd.extend(["--content-file", str(content_file)])
    return _run(cmd, scripts_dir)


def publish_cdp_video(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """CDP 视频发布。"""
    video = article_dir / "video" / "final.mp4"
    if not video.exists():
        raise SystemExit(f"[ERROR] video not found: {video}")
    cmd = [sys.executable, str(scripts_dir / "douyin_cdp_publish.py")]
    if opts.account:
        cmd.extend(["--account", opts.account])
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    cmd.extend([
        "fill-video",
        "--options", str(article_dir / "publish-options.json"),
        "--video", str(video),
    ])
    if title_file.exists():
        cmd.extend(["--title-file", str(title_file)])
    if content_file.exists():
        cmd.extend(["--content-file", str(content_file)])
    return _run(cmd, scripts_dir)


def publish_sau_image(opts: PublishOptions, article_dir: Path) -> int:
    """sau CLI 图文发布。"""
    if not shutil.which("sau"):
        raise SystemExit("[ERROR] sau CLI not found. Install social-auto-upload first.")
    images = sorted((article_dir / "images").glob("*.png"))
    cmd = [
        "sau", "douyin", "upload-note",
        "--account", opts.account,
        "--images", *[str(p) for p in images],
        "--title", opts.title,
    ]
    if opts.content:
        cmd.extend(["--note", opts.content])
    if opts.tags:
        cmd.extend(["--tags", ",".join(opts.tags)])
    if opts.schedule:
        cmd.extend(["--schedule", opts.schedule])
    return _run(cmd)


def publish_sau_video(opts: PublishOptions, article_dir: Path) -> int:
    """sau CLI 视频发布。"""
    if not shutil.which("sau"):
        raise SystemExit("[ERROR] sau CLI not found. Install social-auto-upload first.")
    video = article_dir / "video" / "final.mp4"
    cmd = [
        "sau", "douyin", "upload-video",
        "--account", opts.account,
        "--file", str(video),
        "--title", opts.title,
    ]
    if opts.content:
        cmd.extend(["--desc", opts.content])
    if opts.tags:
        cmd.extend(["--tags", ",".join(opts.tags)])
    if opts.schedule:
        cmd.extend(["--schedule", opts.schedule])
    if opts.cover and Path(opts.cover).exists():
        cmd.extend(["--thumbnail", opts.cover])
    return _run(cmd)


def dispatch(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """按 mode 分发到对应发布实现。"""
    mode = opts.mode
    handlers = {
        "cdp-image": publish_cdp_image,
        "cdp-video": publish_cdp_video,
        "sau-image": publish_sau_image,
        "sau-video": publish_sau_video,
    }
    if mode not in handlers:
        raise SystemExit(f"[ERROR] unknown mode: {mode}. Use: {', '.join(handlers)}")
    print(f"[douyin_publish] mode={mode} options={json.dumps(opts.to_field_status(), ensure_ascii=False)}")
    return handlers[mode](opts, article_dir, scripts_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description="Douyin unified publish dispatcher")
    parser.add_argument("--article-dir", required=True, help="单条内容目录")
    parser.add_argument("--mode", help="覆盖 publish-options.json 中的 mode")
    parser.add_argument("--prepare-video", action="store_true",
                        help="发布前先用 compose_douyin_video_with_voice 合成视频")
    args = parser.parse_args()

    article_dir = Path(args.article_dir).resolve()
    scripts_dir = Path(__file__).parent.resolve()
    opts_path = article_dir / "publish-options.json"
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    opts = PublishOptions.load(opts_path, title_file, content_file)
    if args.mode:
        opts.mode = args.mode

    if args.prepare_video or opts.mode in ("cdp-video", "sau-video"):
        narration = article_dir / "video" / "narration.json"
        video_out = article_dir / "video" / "final.mp4"
        if narration.exists() and (args.prepare_video or not video_out.exists()):
            compose_script = (
                scripts_dir.parent.parent.parent
                / "04-visuals" / "compose-douyin-video" / "scripts"
                / "compose_douyin_video_with_voice.py"
            )
            cmd = [
                sys.executable, str(compose_script),
                "--narration", str(narration),
                "--output", str(video_out),
            ]
            if opts.bgm and opts.bgm.file and Path(opts.bgm.file).exists():
                cmd.extend(["--bgm", opts.bgm.file, "--bgm-volume", str(opts.bgm.volume)])
            code = _run(cmd, compose_script.parent)
            if code != 0:
                raise SystemExit(code)

    raise SystemExit(dispatch(opts, article_dir, scripts_dir))


if __name__ == "__main__":
    main()
