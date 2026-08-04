#!/usr/bin/env python3
"""把一个 HTML 页面(带 CSS/JS 动画)录制成 GIF。

基于 CloakBrowser 按帧截图 + Pillow 合成。适合把烟花动效、打字机效果、
加载动画等做成可在公众号/小红书直接插入的 GIF，比静态截图生动得多。

用法：
  python html_to_gif.py <html_path> <out.gif> [frames] [interval_ms] [W] [H]

参数：
  frames       截多少帧(默认 30)
  interval_ms  帧间隔毫秒(默认 120),也作为 GIF 播放速度
  W H          视口宽高(默认 600x380)

注意：
- Pillow 的 optimize 会自动去掉重复静态帧,最终帧数可能少于设定值(正常)
- 文字类页面色彩少,GIF 很小(几十 KB);全屏粒子动画较大(1-2 MB)
- 公众号、小红书均支持 GIF 自动播放;抖音需要转视频(本机无 ffmpeg,可让用户用在线工具转)
- 控制体积：减少 colors、降低分辨率、减少帧数
"""
import sys, pathlib, io
from cloakbrowser import launch
from PIL import Image


def main():
    if len(sys.argv) < 3:
        print("用法: python html_to_gif.py <html> <out.gif> [frames] [interval_ms] [W] [H]", file=sys.stderr)
        sys.exit(2)
    html = pathlib.Path(sys.argv[1]).resolve().as_uri()
    out = sys.argv[2]
    frames = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    interval = int(sys.argv[4]) if len(sys.argv) > 4 else 120
    W = int(sys.argv[5]) if len(sys.argv) > 5 else 600
    H = int(sys.argv[6]) if len(sys.argv) > 6 else 380

    browser = launch()
    try:
        page = browser.new_page(viewport={"width": W, "height": H})
        page.goto(html)
        page.wait_for_timeout(400)
        imgs = []
        for _ in range(frames):
            imgs.append(Image.open(io.BytesIO(page.screenshot())).convert("RGB"))
            page.wait_for_timeout(interval)
        pal = [im.convert("P", palette=Image.ADAPTIVE, colors=128) for im in imgs]
        pal[0].save(out, save_all=True, append_images=pal[1:],
                    duration=interval, loop=0, optimize=True)
        import os
        print(f"OK {out} {len(pal)}frames {os.path.getsize(out)//1024}KB")
    finally:
        browser.close()


if __name__ == "__main__":
    main()
