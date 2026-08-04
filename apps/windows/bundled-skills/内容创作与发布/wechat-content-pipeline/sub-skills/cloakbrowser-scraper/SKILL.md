---
name: cloakbrowser-scraper
description: |
  基于 CloakBrowser 的浏览器抓取与自动化技能。CloakBrowser 是修改 Chromium C++ 源码、
  从渲染层伪装指纹的 stealth 浏览器，能穿透 Cloudflare Turnstile、微信公众号、reCAPTCHA v3、
  FingerprintJS 等反爬检测（官方 14 项检测通过 14 项）。API 与 Playwright 完全兼容，
  只需把 import 换成 cloakbrowser。
  使用场景：(1) 抓取被反爬保护的网页(微信公众号/Cloudflare 站点/SPA) (2) 任何需要浏览器
  自动化操作的任务(点击/填表/截图/登录) (3) 常规 requests/firecrawl/WebFetch 被 403/验证码挡住时的兜底方案
  (4) 为文章制作演示素材:把 HTML 信息图/终端/对话/动效截图或录成 GIF(templates/ + screenshot.py + html_to_gif.py)。
type: tool
version: 1.0.0
tags:
  - web-scraping
  - browser-automation
  - anti-bot
  - playwright
  - cloudflare
  - wechat
required_pip:
  - cloakbrowser
---

# CloakBrowser Scraper · 反爬浏览器抓取与自动化

## 一、什么时候用这个技能

**默认优先级**：常规抓取先用 firecrawl / WebFetch（快、省）。一旦遇到下列信号，立刻切到本技能：

- 返回 403 / 404（实为反爬伪装）/ Cloudflare 5 秒等待页 / "环境异常请完成验证"
- 目标是微信公众号（`mp.weixin.qq.com`）、知乎、被 Cloudflare/DataDome/Akamai 保护的站点
- 页面内容由 JS 异步渲染，静态抓取拿到空壳
- 需要交互：点击、滚动加载、填表单、登录、截图

**本项目约定**：后续所有"浏览器抓取 / 自动化浏览器操作"任务，统一使用本技能，不再临时手写 Playwright。

## 二、为什么是 CloakBrowser

传统反检测工具（playwright-stealth、undetected-chromedriver）在 JS 运行时打补丁，反爬系统在 C++ 渲染层就识破了。CloakBrowser 直接改 Chromium C++ 源码、做了 16 个底层补丁后重新编译——指纹从"地基"就是干净的，Canvas/WebGL/AudioContext/TLS(JA3/JA4)/字体枚举/WebDriver 标识全部覆盖。

**关键事实**（来自官方测试）：
- reCAPTCHA v3：原版 Playwright 0.1 分 → CloakBrowser 0.9 分（人类水平）
- Cloudflare Turnstile：原版 FAIL → CloakBrowser PASS（非交互自动解锁）
- FingerprintJS：原版 DETECTED → CloakBrowser PASS
- 14 项检测通过 14 项

## 三、安装

```bash
python -m pip install cloakbrowser
# 首次 launch() 会自动下载定制 Chromium 二进制(约 200MB,缓存到本地)
```

> 注意：本机 pip 被 uv 接管，必须用 `python -m pip`，不要直接 `pip install`。

## 四、最小用法：一行替换 Playwright

```python
# 原版 Playwright
# from playwright.sync_api import sync_playwright
# pw = sync_playwright().start(); browser = pw.chromium.launch()

# CloakBrowser —— 只换这一行
from cloakbrowser import launch
browser = launch()

page = browser.new_page()
page.goto("https://protected-site.com", wait_until="networkidle", timeout=60000)
page.wait_for_timeout(3000)          # 给 JS 渲染留时间
html = page.content()
browser.close()
```

返回的 `browser` 是标准 Playwright `Browser` 实例，已有的 Playwright 代码改一行 import 即可复用。

## 五、推荐入口：scripts/scrape.py

封装好的通用抓取脚本，处理了正文提取、图片收集、编码陷阱：

```bash
python scripts/scrape.py <url> [--out-dir DIR] [--wait MS] [--selector CSS] [--shots]
```

输出到 `out-dir`（默认 `scrape_out/`）：

| 文件 | 内容 |
|------|------|
| `meta.json` | 标题、URL、图片 URL 列表、正文字数 |
| `body.txt` | 提取的正文纯文本 |
| `page.html` | 完整渲染后的 HTML |
| `shot.png` | 整页截图（加 `--shots`）|

正文容器按优先级自动尝试：`#js_content`(微信) → `rich_media_content` → `article` → 知乎/简书 → `main` → `body`。可用 `--selector` 覆盖。

**实战示例**（已验证可穿透微信公众号）：

```bash
python scripts/scrape.py "https://mp.weixin.qq.com/s/xxxx" --out-dir wx_out
# OK title='...' body_chars=2651 imgs=14 out=wx_out
```

## 六、关键避坑（Windows 环境）

1. **不要往 stdout 打印正文**——Windows 控制台默认 GBK，中文正文含 `\xa0` 等字符会抛 `UnicodeEncodeError`。一律写文件（`encoding="utf-8"`），stdout 只打印安全的英文摘要。
2. **微信正文是 JS 渲染的**——静态 HTML 拿不到，必须 `wait_until="networkidle"` + 额外 `wait_for_timeout`，再用 `eval_on_selector("#js_content", "el => el.innerText")`。
3. **`pip` 被 uv 接管**——用 `python -m pip install`。
4. **504 可能来自上游**——若目标站本身慢，加大 `timeout` 与等待；CloakBrowser 不背这个锅。

## 七、自动化操作示例

```python
from cloakbrowser import launch
browser = launch()
page = browser.new_page()
page.goto("https://example.com/login", wait_until="networkidle")
page.fill("#username", "user")
page.fill("#password", "pass")
page.click("button[type=submit]")
page.wait_for_url("**/dashboard")
page.screenshot(path="after_login.png", full_page=True)
browser.close()
```

所有 Playwright API（`fill` / `click` / `wait_for_selector` / `screenshot` / `eval_on_selector` / 拦截请求等）均可用。

## 七点五、把动画页面录成 GIF

`scripts/html_to_gif.py` 把带 CSS/JS 动画的 HTML 录成 GIF——比静态截图生动得多，适合做"成果演示"：烟花动效、终端打字机、AI 对话逐字回复、加载动画等。

```bash
python scripts/html_to_gif.py <html> <out.gif> [frames] [interval_ms] [W] [H]
# 例：录 AI 打字对话(文字页,体积极小)
python scripts/html_to_gif.py demo/ai-chat.html out.gif 42 130 600 340
# 例：录全屏烟花(粒子多,1-2MB)
python scripts/html_to_gif.py demo/firework.html out.gif 28 110 600 380
```

要点：
- Pillow 的 optimize 会自动去掉重复静态帧，最终帧数可能少于设定（正常）
- 文字界面色彩少，GIF 几十 KB；全屏粒子动画 1-2 MB
- **公众号、小红书支持 GIF 自动播放**；抖音需转视频（本机无 ffmpeg，可让用户用在线工具或在文章里改放视频）
- 控体积：减 colors / 降分辨率 / 减帧数

## 七点六、演示素材模板库（templates/）

写教程/营销文章时，"看得见的成果"和"专业的原理图"是质量分水岭。`templates/` 提供 4 个即用模板，复制改文案即可，配合 `screenshot.py` / `html_to_gif.py` 产出。**定位：配图默认用 gpt-image-2-pro 生图（见 article-writing-pipeline）；HTML 模板是兜底——仅当中文信息图反复乱码、需精确控制布局、或要做动态 GIF 时才用。**

| 模板 | 用途 | 产出方式 | 风格 |
|------|------|---------|------|
| `infographic.html` | 概念/架构/流程信息图 | 截图 `.wrap` | 黑白手绘讲义风(手写体+黑框分区+橙色虚线标注)，对标《风声的AI编程》 |
| `terminal.html` | 命令行程序运行成果 | 截图 `.term` | 暗色终端，收入蓝/支出红/高亮橙 |
| `ai-chat.html` | 人机协作过程(发提示词→AI逐字回复→完成) | 录 GIF 或截末帧 | 微信聊天气泡 + 打字机动画 |
| `firework.html` | 成果庆祝动效 | 录 GIF | 全屏 Canvas 烟花 |

**典型用法**：

```bash
# 信息图：改 infographic.html 的标题/层级文案 → 截图
python scripts/screenshot.py templates/infographic.html out/arch.png .wrap 2500

# 终端成果：改 terminal.html 的命令/输出 → 截图
python scripts/screenshot.py templates/terminal.html out/run.png .term 1500

# AI 对话过程：改 ai-chat.html 的 TYPE_TEXT/CODE_LINES/OK_TEXT → 录 GIF
python scripts/html_to_gif.py templates/ai-chat.html out/chat.gif 42 130 600 340

# 烟花成果：改 firework.html 文案 → 录 GIF
python scripts/html_to_gif.py templates/firework.html out/done.gif 28 110 600 380
```

品牌色统一：橙 `#ff6b35` / 深蓝 `#1a3a5c`。手写体信息图依赖联网字体 Long Cang，`wait` 给足 2500ms+。

## 八、与其他技能协作

| 场景 | 配合 |
|------|------|
| 抓竞品文章学风格 | 本技能抓正文 → article-writing-pipeline 分析风格 |
| 抓数据做分析 | 本技能抓 → 自行解析 body.txt / meta.json |
| 图片素材收集 | meta.json 里的 imgs 列表 → 批量下载 |

## 九、版本历史

- v1.0.0 (2026-05-29)：初版。封装 CloakBrowser 通用抓取脚本，验证穿透微信公众号反爬。
