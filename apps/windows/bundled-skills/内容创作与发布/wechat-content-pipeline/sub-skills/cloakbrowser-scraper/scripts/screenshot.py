#!/usr/bin/env python3
"""通用截图脚本：用 CloakBrowser 打开本地 HTML 或网页,截全图或指定元素。

用法：
  python screenshot.py <html_or_url> <out.png> [css_selector] [wait_ms] [W] [H]

参数：
  css_selector  只截这个元素(如 .wrap / .term / .chat);省略则整页截图
  wait_ms       渲染等待毫秒(默认 2500;含联网字体/动画的页面要给够)
  W H           视口宽高(默认 760x1000)

要点：
- 本地 HTML 用文件路径即可,会自动转 file:// URI
- 截元素用 element.screenshot,只截该元素的实际尺寸,不留多余白边
- 含手写字体(Long Cang 等需联网)的信息图,wait 给 2500ms 以上等字体加载
"""
import sys, pathlib
from cloakbrowser import launch


def main():
    if len(sys.argv) < 3:
        print("用法: python screenshot.py <html_or_url> <out.png> [selector] [wait_ms] [W] [H]", file=sys.stderr)
        sys.exit(2)
    src = sys.argv[1]
    out = sys.argv[2]
    sel = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    wait = int(sys.argv[4]) if len(sys.argv) > 4 else 2500
    W = int(sys.argv[5]) if len(sys.argv) > 5 else 760
    H = int(sys.argv[6]) if len(sys.argv) > 6 else 1000

    url = src if src.startswith(("http://", "https://", "file://")) else pathlib.Path(src).resolve().as_uri()

    browser = launch()
    try:
        page = browser.new_page(viewport={"width": W, "height": H})
        page.goto(url)
        page.wait_for_timeout(wait)
        el = page.query_selector(sel) if sel else None
        if el:
            el.screenshot(path=out)
        else:
            page.screenshot(path=out, full_page=True)
        print("OK", out)
    finally:
        browser.close()


if __name__ == "__main__":
    main()
