---
name: mediacrawler
description: |
  用 MediaCrawler 采集小红书、抖音、快手、B站、微博、贴吧、知乎的公开笔记与评论，支持关键词搜索、指定帖子 ID、指定创作者主页三种模式，产出 JSONL / CSV / Excel / SQLite 等数据文件。
  凡是用户提到「爬一下小红书上关于 X 的笔记」「采集某平台评论」「扒一批选题素材」「看看这个关键词下哪些内容火」「跑一下 MediaCrawler」，
  或者遇到 MediaCrawler 的环境、登录、数据落盘问题时，都用这个技能。它负责：环境自检 → 确认登录态 → 启动采集 → 取回数据路径与条目数 → 常见故障处置。
  NOT for: 下载单个视频或图片文件（那是下载器类工具的事）；把内容发布出去（那是发布类技能的事）；只是问 MediaCrawler 是什么、要一份项目介绍（那是问答，不是执行）。
version: 0.1.0
activation_scope: on_demand
metadata:
  {
    "mtbot":
      {
        "emoji": "🕷️",
        "requires": { "anyBins": ["python", "python3", "py"] },
        "github_url": "https://github.com/NanmiCoder/MediaCrawler",
        "github_hash": "306ab4ca26c0e44fb87ede0e40e98748752815a6",
        "created_at": "2026-11-15",
        "entry_point": "scripts/wrapper.py",
        "dependencies": ["python>=3.10,<3.13", "playwright", "uvicorn[standard]"],
        "license": "NON-COMMERCIAL LEARNING LICENSE 1.1 (non-commercial only)",
      },
  }
---

# MediaCrawler 数据采集

## 动手之前，三件必须知道的事

**一、许可禁止商用。** 项目许可是 `NON-COMMERCIAL LEARNING LICENSE 1.1`，白纸黑字写明不得用于任何商业用途，也不得大规模爬取。用它之前先问清用途；不要把它包装成产品功能，也不要拿它做接单交付。给用户的产出摘要里要带上这句提醒。

**二、7 个平台全部以登录态为硬前提。** 这不是猜测——逐个看过代码（小红书查 `web_session`、B站查 `/x/web-interface/nav` 的 `isLogin`）后确认，没有登录态任何平台都拿不到数据。登录方式三种：扫码（有头浏览器弹二维码让人扫）、手机号、复用已有 cookie。**扫码这一步必须有人参与**，这是它的固有边界，不是你操作错了。

**三、优先走 CDP 模式。** 接管用户已经登录好的 Chrome（调试端口 9222），复用真实浏览器环境和登录态——README 的默认路径，反检测最好，也不必反复扫码。只有当 9222 不通时才降级为自己启动浏览器；注意降级前程序会**先空等 60 秒**去连 9222，这一步纯粹是浪费时间，wrapper 会替你跳过它。

## 工作流

### 第 1 步：自检，每次都要先跑

```bash
python "<skillDir>/scripts/wrapper.py" preflight
```

它一次告诉你：仓库在哪、venv 存不存在、Python 版本对不对、Playwright 浏览器装没装、CDP 端口通不通、登录态 profile 有没有、数据往哪落。

**哪一项是红的就先修哪一项**，不要带着问题往下跑——不然你花几分钟，换回来一个看不懂的报错。加 `--json` 可以拿机器可读的结果。

### 第 2 步：确认登录态，没有就登

```bash
python "<skillDir>/scripts/wrapper.py" login --platform xhs
```

这一步其实就是一次「最小采集」（抓 1 条就停），登录在过程中按需完成。界面会弹出二维码，**把二维码图片给用户扫**（wrapper 会打印它的落盘路径；如果用户就在机器前，直接看浏览器窗口也行）。

扫完登录态会存进 `browser_data/<平台>_user_data_dir`，下次不用再扫。扫码完成后可以直接 `Ctrl-C` 中断——登录态已经落地了。

### 第 3 步：采集

```bash
python "<skillDir>/scripts/wrapper.py" run --platform xhs --keywords "美食" --max 20
```

跑完它会把**新增的数据文件路径、条目数、登录态判定**打出来。给用户汇报时用下面那个摘要模板。

## wrapper 命令

| 命令 | 用途 | 常用参数 |
|---|---|---|
| `preflight` | 环境 + 登录态自检 | `--json` |
| `install` | 克隆仓库、建 venv、装依赖、装 Playwright 浏览器 | `--repo PATH`、`--index-url URL` |
| `login` | 触发登录（顺带最小采集） | `--platform`、`--cdp auto\|on\|off` |
| `run` | 执行采集 | `--platform`、`--type`、`--keywords`、`--max`、`--comments/--no-comments`、`--save-data-option`、`--headed/--headless` |
| `last` | 列出已有数据产物与条目数 | `--platform`、`--limit` |

平台代号：`xhs` 小红书、`dy` 抖音、`ks` 快手、`bili` B站、`wb` 微博、`tieba` 贴吧、`zhihu` 知乎。
采集类型：`search`（关键词）、`detail`（指定帖子 ID）、`creator`（指定创作者主页）。

**仓库位置**的解析顺序：`--repo` → 环境变量 `MEDIACRAWLER_HOME` → 本机已知副本（`<workspace>/temp/oss-deep-test/mediacrawler`）→ `~/MediaCrawler`。找不到就提示你跑 `install`。

## 关键约定

- **数据落盘**：`<repo>/data/<平台>/<格式>/<search_contents|search_comments>_<日期>.jsonl`。JSONL 一行一条 JSON，笔记和评论分两个文件。
- **登录态**存在 `browser_data/<平台>_user_data_dir`——Playwright 的持久化浏览器 profile，不是 cookie 字符串。删掉这个目录就等于退出登录。
- **CDP 开关只能改配置**：`.env` 只管数据库和代理 key，`ENABLE_CDP_MODE` / `HEADLESS` 这类开关只读 `config/base_config.py`，命令行没有对应参数（`--headless` 除外）。所以 wrapper 的 `--cdp auto` 会探测 9222，不通时**临时**改写这一行并在跑完/中断后还原（原文件备份为 `base_config.py.bak`）。
- **日志推送要靠 `uvicorn[standard]`**：默认装法缺 `websockets`，WebUI 的 `/api/ws/logs` 会 404，界面退化成轮询。preflight 会检查这一项。

## 故障处置

| 症状 | 原因 | 处置 |
|---|---|---|
| `Page.goto: Page crashed` / `Target crashed` | Playwright 浏览器目录被删或损坏（本机真实发生过） | 重跑 `wrapper.py install`；或 `python -m playwright install chromium` |
| 卡着不动、日志刷 `CDP port 9222 is not accessible` | 本机 Chrome 没开远程调试 | 让用户在 Chrome 地址栏开 `chrome://inspect/#remote-debugging` 勾选允许；或 `--cdp off` 走标准模式 |
| `Login state result: False` 然后一直等扫码 | 正常，在等用户扫 | 把二维码给人扫；无头环境出不了二维码，必须 `--headed` |
| 能跑但 0 条数据 | 平台侧没返回（风控/关键词太窄/登录态失效） | 换关键词试；确认登录态；看日志里 `Search notes response` 有没有 `items` |
| `UnicodeDecodeError: 'gbk' codec` | Windows 控制台编码 | wrapper 已强制 `PYTHONUTF8=1`；手工跑命令时要自己设 |
| 装依赖时报 SSL 证书过期 | 某些国内镜像证书失效 | 换源：`--index-url https://mirrors.aliyun.com/pypi/simple/` |

更细的排查步骤见 `references/troubleshooting.md`，完整的 CLI 契约见 `references/cli-contract.md`。

## 给用户的产出摘要

汇报时用这个结构，别只说"跑完了"：

```
平台 / 模式：小红书 · 关键词搜索
关键词：美食
结果：20 条笔记、110 条评论（新增 2 个文件）
落盘：<repo>/data/xhs/jsonl/search_contents_2026-11-15.jsonl
登录态：复用已有会话（Login state result: True）
提醒：该项目许可禁止商用，仅限个人学习研究
```

## 参考文件

- `references/cli-contract.md` —— 完整命令行契约：所有参数、输出目录结构、配置项含义、数据结构字段。
- `references/troubleshooting.md` —— 按症状排查的详细步骤，含本机实测踩过的坑。

## 来源与版本（给技能管理器用）

- 仓库：https://github.com/NanmiCoder/MediaCrawler
- 生成时 commit：`306ab4ca26c0e44fb87ede0e40e98748752815a6`（2026-11-09，实测通过的那一份）
- 技能版本：0.1.0 ｜ 生成日期：2026-11-15
- 入口：`scripts/wrapper.py`
- 更新判断：拿 GitHub API 取 main 的 HEAD 与上面的 hash 比对，不一致就说明上游动了，需要复核 `references/cli-contract.md`。
