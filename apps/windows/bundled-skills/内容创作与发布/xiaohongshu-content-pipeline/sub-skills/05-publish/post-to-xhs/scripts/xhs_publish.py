"""
小红书统一发布入口：读取 publish-options.json，按模式分发到 CDP pipeline。

用法:
    python xhs_publish.py --article-dir <笔记目录>
    python xhs_publish.py --article-dir <笔记目录> --schedule "2026-06-13 20:00"
    python xhs_publish.py --article-dir <笔记目录> --recommend-schedule
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from publish_options import PublishOptions
from schedule_advisor import recommend_schedule_times, normalize_content_type


def _print_cmd(cmd: list[str]) -> None:
    """打印即将执行的命令（stderr）。"""
    print("[xhs_publish]", " ".join(cmd), file=sys.stderr)


def publish_cdp_image(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """CDP 图文模式：填表并可选择定时发布。"""
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    if not title_file.exists():
        title_file = article_dir / "publish.md"
    if not content_file.exists():
        content_file = article_dir / "publish.md"

    images_dir = article_dir / "images"
    images = sorted(images_dir.glob("*.png")) + sorted(images_dir.glob("*.jpg"))
    if not images:
        print("Error: no images in article images/", file=sys.stderr)
        return 2

    cmd = [
        sys.executable,
        str(scripts_dir / "publish_pipeline.py"),
        "--title-file",
        str(title_file) if title_file.suffix == ".txt" else str(article_dir / "final.md"),
        "--content-file",
        str(content_file) if content_file.suffix == ".txt" else str(article_dir / "final.md"),
        "--images",
        *[str(p) for p in images],
    ]
    if opts.account and opts.account != "default":
        cmd.extend(["--account", opts.account])
    if opts.schedule:
        cmd.extend(["--schedule", opts.schedule])
    _print_cmd(cmd)
    return subprocess.call(cmd)


def publish_cdp_long(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """CDP 长文模式：仅填表到模板选择阶段（后续步骤需分步执行）。"""
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    if not title_file.exists():
        title_file = article_dir / "final.md"
    if not content_file.exists():
        content_file = article_dir / "final.md"

    cmd = [
        sys.executable,
        str(scripts_dir / "publish_pipeline.py"),
        "--mode",
        "long-article",
        "--title-file",
        str(title_file),
        "--content-file",
        str(content_file),
    ]
    placements = article_dir / "placements.json"
    if placements.exists():
        cmd.extend(["--placements", str(placements)])
    if opts.account and opts.account != "default":
        cmd.extend(["--account", opts.account])
    _print_cmd(cmd)
    return subprocess.call(cmd)


def dispatch(opts: PublishOptions, article_dir: Path, scripts_dir: Path) -> int:
    """按 publish_mode 分发发布任务。"""
    mode = opts.publish_mode or "image-text"
    print(
        f"[xhs_publish] mode={mode} options={json.dumps(opts.to_field_status(), ensure_ascii=False)}"
    )
    if mode == "long-article":
        return publish_cdp_long(opts, article_dir, scripts_dir)
    return publish_cdp_image(opts, article_dir, scripts_dir)


def main() -> None:
    """CLI 入口。"""
    parser = argparse.ArgumentParser(description="Xiaohongshu unified publish dispatcher")
    parser.add_argument("--article-dir", required=True, help="笔记目录（含 publish-options.json）")
    parser.add_argument("--schedule", help="覆盖定时 YYYY-MM-DD HH:MM")
    parser.add_argument(
        "--recommend-schedule",
        action="store_true",
        help="根据 content_type 输出推荐时段后退出",
    )
    parser.add_argument("--recommend-count", type=int, default=5)
    args = parser.parse_args()

    article_dir = Path(args.article_dir).resolve()
    scripts_dir = Path(__file__).resolve().parent
    opts_path = article_dir / "publish-options.json"
    title_file = article_dir / "publish-title.txt"
    content_file = article_dir / "publish-desc.txt"
    opts = PublishOptions.load(opts_path, title_file, content_file)

    if args.schedule:
        opts.schedule = args.schedule

    if args.recommend_schedule:
        ctype = normalize_content_type(opts.content_type)
        recs = recommend_schedule_times(content_type=ctype, count=args.recommend_count)
        print(json.dumps({"content_type": ctype, "recommendations": recs}, ensure_ascii=False, indent=2))
        return

    sys.exit(dispatch(opts, article_dir, scripts_dir))


if __name__ == "__main__":
    main()
