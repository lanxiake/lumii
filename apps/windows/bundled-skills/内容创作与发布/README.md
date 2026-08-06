# 内容创作与发布 · 技能包总览

本目录汇集了**内容创作与多平台发布**相关的全部技能包，覆盖公众号、小红书、抖音、X(Twitter)、B站、TikTok 等主流平台，从选题策划、内容写作、智能配图到自动化发布一站式打通。

---

## 📂 目录结构

```
内容创作与发布/
├── content-creation-publisher/    # 内容采集与多平台发布编排
├── intelligent-content-system/    # 智能内容全流程系统
├── douyin-content-pipeline/       # 抖音内容创作与发布全流程（含知识猫图解主题）
├── wechat-article-publish/        # 微信公众号系列文章
├── wechat-hotspot-publisher/      # 热点话题多平台发布
├── wechat-makeup/                 # 微信公众号美妆文章
├── xiaohongshu-content-pipeline/   # 小红书内容创作与发布全流程编排（含15个分阶段子技能）
├── xiaohongshu-makeup/            # 小红书美妆系列笔记
└── 抖音视频自动化/                 # 抖音/TikTok 技能集合（8个）
```

---

## 🎯 一级技能（端到端工作流）

### 📰 content-creation-publisher · 内容采集与发布
**端到端的「网页采集 + 格式化 + 配图 + 多平台发布」一体化技能包。**
从一篇网页或 Markdown 出发，自动完成：网页采集 → 格式优化 → 智能配图 → 发布到微信公众号 / X(Twitter)。
内置 5 个子技能：`baoyu-url-to-markdown`、`baoyu-format-markdown`、`article-illustrator`、`baoyu-post-to-wechat`、`baoyu-post-to-x`。

**触发词**：采集这篇文章并发布 / 帮我配图发到公众号 / 从 URL 到公众号一键完成

---

###  intelligent-content-system · 智能内容系统
**根据用户需求自动识别场景，编排调用多个子技能完成全流程。**
支持场景：
- 网页内容采集与再创作（采集 → 配图 → 发布）
- 热点内容创作（热点采集 → AI 生成 → 多平台发布）

**触发词**：自动写一篇并发布 / 智能内容创作

---

### 🎬 douyin-content-pipeline · 抖音内容创作与发布
**将抖音内容生产链路串成「讨论主题 → 研究 → 脚本/大纲 → 生图/合成视频 → 发布」的端到端工作流。**
内置 **知识猫图解** 主题：博物馆图鉴风 3D 自然科普图解系列（4～7 张分镜、3:4 竖版、英文 Prompt 批量生图），原 `kg-tutorials` 能力已并入此流水线。
支持通用短视频、图文图集、图集转视频、竞品研究等模式；默认只填草稿，真实发布前须用户确认。

**触发词**：做一条抖音并发布 / 知识猫图解 / 做一套图解 / 图解百科 / 科普图解 / 自然科普系列

---

### 📝 wechat-article-publish · 微信公众号系列文章
**微信公众号系列文章的「创作 + 配图 + 发布」一体化技能包。**
从一句话主题出发：选题研究 → 8段式写作 → 分层配图 → 生成发布版 → 公众号草稿箱。
支持多主题系列并行。

**触发词**：写公众号 / 做一篇公众号 / 继续写第X篇

---

### 🔥 wechat-hotspot-publisher · 热点多平台发布
**智能采集热点话题，10分制筛选优质选题，AI 生成爆款内容并多平台发布。**
覆盖能力：标题/封面/标签/图片/HTML 排版自动生成；支持素材上传、草稿箱发布。
目标平台：微信公众号、小红书、B站等。

**触发词**：发布热点 / 抓热点写文章 / 多平台发布

---

### 💄 wechat-makeup · 微信公众号美妆文章
**端到端的美妆公众号文章创作与发布。**
从一句话主题出发：选题研究 → 8段式写作 → GPT 优先配图 → 公众号草稿箱。
不内置历史数据，新主题在 `data/` 下独立工作目录。

**触发词**：写公众号 / 发布到公众号 / 存公众号草稿

---

### 🌺 xiaohongshu-content-pipeline · 小红书全流程编排
**将小红书内容生产链路串成「讨论主题 → 研究搜集材料 → 编写大纲 → 生成内容 → 生图 → 转换格式 → 发布」的端到端工作流。**
不重复实现子技能能力，负责按场景编排 `content-planner`、`content-engine`、`baoyu-xhs-images`、`card-xiaohongshu`、`post-to-xhs`、`xiaohongshu-upload` 等技能。
支持通用图文、美妆系列、知识卡片、营销活动、招聘帖等模式；默认测试只做到发布预览，真实发布前必须用户确认。

**触发词**：做一篇小红书并发布 / 测试小红书内容创作 / 从选题到发布 / 小红书全流程

---

### 🌸 xiaohongshu-makeup · 小红书美妆系列
**将任意美妆主题（产品线/成分/护肤方案/妆容风格）拆解为系列化笔记，实现连续种草。**
三个子技能：
- `xhs-series-planner` — 系列大纲规划
- `xhs-note-writer` — 逐篇笔记写作（含开头/末尾钩子）
- `xhs-image-prompter` — 配图提示词生成

**触发词**：做一个关于XX的系列 / 写下一篇 / 帮我策划XX主题

---

## 🌸 小红书内容创作（15 个子技能）

> 目录：`xiaohongshu-content-pipeline/sub-skills/`，按阶段分类存放。

### ⭐ 核心刚需（中文原生）

| 阶段目录 | 技能 | 功能描述 |
|------|------|---------|
| `05-publish/` | **`post-to-xhs`** | 小红书内容发布。支持图文/长文双模式；可直接接收用户内容或自动从网页 URL 抓取，简化发布流程 |
| `05-publish/` | **`xiaohongshu-upload`** | 基于 `sau` CLI 的小红书账号登录、cookie 校验、视频/图文上传，稳定的命令式工作流 |
| `04-outline-and-visuals/` | **`card-xiaohongshu`** | 小红书风格知识卡片生成，多张联排可滑动浏览 |
| `04-outline-and-visuals/` | **`xhs-images`** / **`baoyu-xhs-images`** | 小红书图文系列生成器，支持多种风格，将复杂内容拆成 1-10 张卡通信息图（宝玉系列） |
| `04-outline-and-visuals/` | **`xiaohongshu-recruiter`** | 小红书 AI 招聘帖发布。"Systemic Flux" 极客风封面图 + Playwright 半自动化发布 |
| `01-topic-strategy/` | **`beauty-content-strategy`** | 美妆社交媒体内容策略制定 |

### 📊 通用内容创作与策划

| 阶段目录 | 技能 | 功能描述 |
|------|------|---------|
| `02-research-materials/` | **`content-engine`** | 平台原生内容系统（X/LinkedIn/TikTok/YouTube/Newsletter），保留作者真实声音的多平台改编 |
| `03-content-writing/` | **`content-creator`** | SEO 优化的营销内容创作，含品牌音色分析器、SEO 优化器、社交媒体模板 |
| `02-research-materials/` | **`content-planner`** | 公众号选题规划与内容日历，基于文章搜索与趋势分析输出差异化建议 |
| `01-topic-strategy/` | **`social-content`** | 多平台社交内容创建/调度/优化（LinkedIn/Twitter/Instagram/TikTok/Facebook） |
| `03-content-writing/` | **`social-media`** | LinkedIn/Twitter/X 短篇社交内容创作指南 |
| `01-topic-strategy/` | **`campaign-plan`** | 完整营销活动简报：目标、受众、信息、渠道策略、内容日历、KPI |
| `01-topic-strategy/` | **`campaign-planning`** | 营销活动规划框架：受众细分、渠道策略、预算分配、KPI 定义 |
| `03-content-writing/` | **`short-form-video-plan`** | 短视频规划专家（Instagram/LinkedIn/TikTok/X/YouTube） |

---

## 🎬 抖音视频自动化（8 个子技能）

> 目录：`抖音视频自动化/`

### ⭐ 核心刚需

| 技能 | 功能描述 |
|------|---------|
| **`douyin-upload`** | 基于 `sau` CLI 的抖音账号登录、cookie 校验、视频/图文上传，中文原生工作流 |
| **`crawling-social-media`** | 多平台视频/内容下载：B站/YouTube/TikTok/抖音/Instagram/Twitter/小红书 |
| **`ai-subtitle-generator`** | AI 字幕生成：自动添加字幕、SRT 文件生成、字幕烧录 |

### 📹 视频内容创作

| 技能 | 功能描述 |
|------|---------|
| **`ai-social-media-content`** | AI 驱动的多平台社交内容生成（图片/视频/Reels/Shorts/字幕/标签）；集成 FLUX、Veo、Seedance、Wan、Kokoro TTS |
| **`tiktok`** | TikTok 视频文案/脚本创作及优化 |
| **`tiktok-ads`** | TikTok Ads 投放配置、优化与管理（含 Spark Ads、Events API） |
| **`tiktok-script`** | 短视频脚本构建器（TikTok/Reels/Shorts）：带时间戳、Hook、视觉提示、跨平台改编 |
| **`video-content-strategist`** | 视频内容战略规划：YouTube 频道、短视频管线、长视频改编 |

---

## 🔄 推荐使用流程

### 场景一：写公众号文章
```
wechat-article-publish 或 wechat-makeup
  └→ 一句话主题 → 选题 → 8段式写作 → 配图 → 公众号草稿
```

### 场景二：小红书端到端创作发布
```
xiaohongshu-content-pipeline
  └→ 讨论主题 → 研究搜集材料 → 编写大纲 → 生成内容 → 生图/卡片
        └→ 转换发布格式 → post-to-xhs 或 xiaohongshu-upload 发布
```

### 场景三：小红书种草系列
```
xiaohongshu-makeup
  └→ 系列大纲规划 → 逐篇写作 → 配图提示词
        └→ post-to-xhs 或 xiaohongshu-upload 发布
```

### 场景四：抖音视频发布
```
tiktok-script 或 video-content-strategist
  └→ 脚本创作 → ai-subtitle-generator 字幕
        └→ douyin-upload 发布
```

### 场景五：网页文章再创作
```
content-creation-publisher 或 intelligent-content-system
  └→ 采集 → 格式优化 → 智能配图 → 多平台一键发布
```

### 场景六：热点追踪
```
wechat-hotspot-publisher
  └→ 热点采集 → 10分制筛选 → AI生成 → 公众号/小红书/B站多平台发布
```

---

## 📌 环境依赖

| 依赖 | 用途 | 涉及技能 |
|------|------|---------|
| `sau` CLI（`social-auto-upload`） | 小红书/抖音账号登录与上传 | `xiaohongshu-upload`、`douyin-upload` |
| Playwright | 浏览器自动化发布 | `xiaohongshu-recruiter` |
| 微信公众平台 API | 公众号草稿/发布 | `wechat-*` 系列 |
| LLM-Link / OpenAI API | 文本生成、生图 | 全系列 |

详细配置请参考各技能包内的 `SETUP.md` 或 `references/runtime-requirements.md`。

---

## 🆕 最新更新

- **2026-06-11**：移除独立 `kg-tutorials` 技能，「知识猫图解」博物馆图鉴风科普图解并入 `douyin-content-pipeline/themes/knowledge-cat-illustrated/`
- **2026-06-05**：将原 `小红书内容创作/` 的 15 个子技能物理迁移到 `xiaohongshu-content-pipeline/sub-skills/` 分阶段目录
- **2026-06-04**：新增 `xiaohongshu-content-pipeline`，整合小红书「主题讨论/研究/大纲/内容/生图/格式转换/发布」端到端流程
- **2026-06-02**：新增小红书内容创作子技能集合（15 个）与 `抖音视频自动化/`（8 个）子技能集合
- **2026-06-02**：`xiaohongshu-makeup` 重构为系列化发文架构，新增 3 个子技能
- **2026-05-30**：`kg-tutorials` 引入三轮搜索机制，提升科学准确性
