#!/usr/bin/env python3
"""通用网页抓取脚本，基于 CloakBrowser（穿透 Cloudflare/微信等反爬）。

用法：
  python scrape.py <url> [--out-dir DIR] [--wait MS] [--selector CSS] [--shots]

输出（写到 out-dir，默认 ./scrape_out）：
  meta.json  — 标题、URL、图片列表、正文字数
  body.txt   — 提取的正文纯文本
  page.html  — 完整渲染后的 HTML
  shot.png   — 整页截图（加 --shots 时）

设计要点：
- 所有输出写文件，不往 stdout 打印正文（避免 Windows GBK 控制台编码错误）
- 正文容器按优先级尝试多个常见选择器，可用 --selector 覆盖
- networkidle + 额外 wait，确保 JS 渲染完成
"""

import argparse
import json
import os
import sys

try:
    from cloakbrowser import launch
except Exception as e:
    print("IMPORT_ERROR: 未安装 cloakbrowser。运行 python -m pip install cloakbrowser", file=sys.stderr)
    print(e, file=sys.stderr)
    sys.exit(1)

# 正文容器候选（按优先级），覆盖微信/知乎/简书/通用博客
BODY_SELECTORS = [
    "#js_content",                 # 微信公众号
    "div.rich_media_content",      # 微信备用
    "article",                     # 通用语义标签
    "div.RichText",                # 知乎
    "div.show-content",            # 简书
    "main",
    "#page-content",
    "body",
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--out-dir", default="scrape_out")
    p.add_argument("--wait", type=int, default=5000, help="渲染后额外等待毫秒")
    p.add_argument("--selector", default="", help="自定义正文 CSS 选择器")
    p.add_argument("--shots", action="store_true", help="保存整页截图")
    args = p.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    browser = launch()
    try:
        page = browser.new_page()
        page.goto(args.url, wait_until="networkidle", timeout=60000)
        page.wait_for_timeout(args.wait)

        title = page.title()
        html = page.content()

        # 正文提取
        selectors = [args.selector] if args.selector else BODY_SELECTORS
        body = ""
        for sel in selectors:
            if not sel:
                continue
            try:
                t = page.eval_on_selector(sel, "el => el.innerText")
                if t and len(t) > len(body):
                    body = t
            except Exception:
                continue

        # 图片
        imgs = page.eval_on_selector_all(
            "img",
            "els => els.map(e => e.getAttribute('data-src') || e.src).filter(Boolean)"
        )

        if args.shots:
            page.screenshot(path=os.path.join(args.out_dir, "shot.png"), full_page=True)

        with open(os.path.join(args.out_dir, "page.html"), "w", encoding="utf-8") as f:
            f.write(html)
        with open(os.path.join(args.out_dir, "body.txt"), "w", encoding="utf-8") as f:
            f.write(body or "")
        meta = {
            "title": title,
            "url": args.url,
            "body_chars": len(body),
            "img_count": len(imgs),
            "imgs": imgs,
        }
        with open(os.path.join(args.out_dir, "meta.json"), "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        # 只往 stdout 打印安全的元信息摘要
        print(f"OK title={title!r} body_chars={len(body)} imgs={len(imgs)} out={args.out_dir}")
    finally:
        browser.close()


if __name__ == "__main__":
    main()
