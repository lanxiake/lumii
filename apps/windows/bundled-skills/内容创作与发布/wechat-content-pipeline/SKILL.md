---
name: wechat-content-pipeline
description: |
  端到端的微信公众号系列文章「创作 + 配图 + 发布」一体化技能包。
  从一句话主题出发，自动完成：选题研究 → 8段式写作 → 分层配图 → 生成发布版 → 发布到公众号草稿箱。
  支持多主题系列并行，每个系列只需维护自己的 00-series-outline.md，通用工具完全复用。
  触发词：写公众号 / 做一篇公众号 / 帮我写公众号 / 发布到公众号 / 存公众号草稿 / 继续写第X篇
metadata:
  emoji: "📰"
---

# wechat-makeup · 公众号内容创作技能包

> **绝不自动群发，只存草稿，由人工审核后推送。**

---

## 目录结构

```
wechat-makeup/                       ← 本技能包根目录
├── SKILL.md                         ← 本文件：技能总入口
├── GUIDE-FOR-AI.md                  ← AI全流程操作指南（新会话必读）
├── SETUP.md                         ← 环境配置：依赖/凭证/IP白名单
├── WORKFLOW.md                      ← 端到端SOP：每步命令+避坑表
├── .env.example                     ← 凭证模板（复制为 .env 填值）
├── .gitignore                       ← 忽略 .env 及过程数据
│
├── sub-skills/                      ← 可复用子技能（工具代码，与系列数据分离）
│   ├── article-writing-pipeline/    ← 写作流水线
│   │   ├── SKILL.md                 ← 8段式骨架、写作铁律、配图策略
│   │   └── references/article-templates.md
│   ├── cloakbrowser-scraper/        ← 截图/抓取/GIF
│   │   ├── SKILL.md
│   │   ├── scripts/screenshot.py   ← HTML→PNG截图（主力配图工具）
│   │   ├── scripts/scrape.py       ← 公众号爬取
│   │   ├── scripts/html_to_gif.py  ← 动画录制
│   │   └── templates/              ← 5个即用HTML模板
│   └── wechat-publisher/           ← 微信草稿发布
│       ├── SKILL.md
│       └── scripts/publish.py      ← 核心发布脚本（零依赖）
│
└── data/                            ← 系列内容数据（大纲/样板/文章，与子技能分离）
    ├── ai-programming/              ← 系列：《人人都能用AI写程序》（含 samples/ 示例样板）
    │   ├── 00-series-outline.md     ← 系列大纲与进度追踪
    │   ├── 00-image-design-guide.md ← 本系列专属配图规范
    │   ├── samples/                 ← 样板文章（供新系列/新文章参考）
    │   └── articles/                ← 新写文章的产出目录（默认为空）
    └── parenting-with-ai/           ← 系列：《教育是一场对自己的救赎》（含大纲，待写）
        ├── 00-series-outline.md
        ├── samples/
        └── articles/               ← 默认为空
```

---

## 快速开始

### 1. 安装依赖（每台机器做一次）

```bash
python -m pip install cloakbrowser pillow
```

cloakbrowser 首次运行自动下载定制 Chromium（约 535MB），缓存本地，后续无需重复。

### 2. 配置凭证（.env 文件，配一次长期生效）

复制技能包根目录的 `.env.example` 为 `.env`，填入凭证。脚本运行时自动向上查找加载，**新会话/新终端都不用再设环境变量**。

```bash
cd wechat-makeup
cp .env.example .env
# 编辑 .env 填入：
#   WECHAT_APP_ID=wx...        微信公众平台 → 设置与开发 → 基本配置
#   WECHAT_APP_SECRET=...      同上
#   LLM_LINK_API_KEY=sk-...    llm-link.top 个人中心（主力生图）
```

| 变量 | 来源 | 用途 |
|------|------|------|
| `WECHAT_APP_ID` | 微信公众平台 → 设置与开发 → 基本配置 | 发布草稿 |
| `WECHAT_APP_SECRET` | 同上 | 发布草稿 |
| `LLM_LINK_API_KEY` | llm-link.top 个人中心 | AI生图（主力配图） |

> `.env` 已被 `.gitignore` 忽略，绝不进仓库。

### 3. IP 白名单

```bash
python -c "import urllib.request; print(urllib.request.urlopen('https://api64.ipify.org').read().decode())"
```

把输出的 IP 填入微信公众平台 → IP白名单，等 3-5 分钟。发布报 `40164` 时以报错 IP 为准。

### 4. 最小验证

```bash
# 截图测试
python wechat-makeup/sub-skills/cloakbrowser-scraper/scripts/screenshot.py \
  wechat-makeup/sub-skills/cloakbrowser-scraper/templates/infographic.html \
  /tmp/test.png body 1000 900 500
# → 生成 test.png 即成功

# 发布测试（已在 .env 配好 WECHAT_APP_ID / WECHAT_APP_SECRET）
python wechat-makeup/sub-skills/wechat-publisher/scripts/publish.py <某篇publish.md>
# → [OK] 草稿已保存! media_id=... 即成功
```

---

## 子技能说明

| 子技能 | 作用 | 关键工具 |
|--------|------|---------|
| **article-writing-pipeline** | 8段式写作规范、内容深度标准、叙事技巧 | SKILL.md（规范文档） |
| **cloakbrowser-scraper** | 穿透反爬抓取竞品、HTML→PNG截图、录GIF | `screenshot.py` |
| **wechat-publisher** | Markdown→公众号HTML、上传图片、存草稿 | `publish.py` |

---

## 系列管理

### 已有系列

| 系列目录 | 标题 | 状态 |
|---------|------|------|
| `data/ai-programming/` | 《人人都能用AI写程序》 | 含 samples/ 示例样板，articles/ 待写 |
| `data/parenting-with-ai/` | 《教育是一场对自己的救赎》 | 含大纲，待写 |

### 新增系列步骤

1. 在 `wechat-makeup/data/` 下新建目录（如 `my-new-series/`）
2. 写 `00-series-outline.md`（定位 / 篇目 / 类比库 / 语言风格）
3. 建 `samples/` 和 `articles/` 目录
4. AI 接手时告知：**"技能包在 `wechat-makeup/`，当前系列大纲在 `wechat-makeup/data/<系列名>/00-series-outline.md`"**

### 系列大纲必须包含的内容

每个系列的 `00-series-outline.md` 是 AI 每次接手文章前的必读文件，需覆盖：

- **系列定位**：核心主张（1-2句话）、和同类内容的本质区别
- **目标读者**：具体到真实人物画像，不是人口统计数字
- **系列类比库**：全系列统一使用的核心比喻（≥3个）
- **语言风格**：要什么感觉、禁用什么句式
- **8段式调整**：本系列对通用骨架的特殊要求
- **AI工具切入方式**：每篇必须包含的 AI 使用场景
- **篇目规划**：含标题、打破的认知误区、AI切入点、状态
- **进度追踪表**：篇号 / 标题 / 状态（待写/已发布）

---

## 全流程一览

```
选题
 │
 ├─① 研究爆款（可选）
 │   python sub-skills/cloakbrowser-scraper/scripts/scrape.py "<URL>" --out-dir ref/
 │
 ├─② 写 final.md
 │   严格 8 段式，图片用 <!-- IMAGE:xx --> 占位
 │
 ├─③ 制作配图 HTML 模板（3-4 张）
 │   参考现有系列 data/*/articles/*/images/*.html
 │
 ├─④ 批量截图
 │   python sub-skills/cloakbrowser-scraper/scripts/screenshot.py <html> <png> body 500 900 <height>
 │
 ├─⑤ 写 publish.md
 │   加 frontmatter（title/author/summary/cover），替换图片占位为实际路径
 │
 └─⑥ 发布草稿
     python sub-skills/wechat-publisher/scripts/publish.py <publish.md绝对路径>
     → [OK] 草稿已保存! media_id=...
```

详细每步规范见 `GUIDE-FOR-AI.md`，完整命令参考见 `WORKFLOW.md`。

---

## 安全边界

- **只存草稿，绝不群发**（publish.py 调用 `draft/add`，无群发接口调用）
- 凭证只进 `.env`（已被 `.gitignore` 忽略），不进 git
- 第三方技能先审查代码再使用
