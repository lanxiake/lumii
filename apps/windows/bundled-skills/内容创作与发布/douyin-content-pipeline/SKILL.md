---
name: douyin-content-pipeline
description: |
  抖音内容创作与发布端到端编排技能。用于将讨论主题、研究搜集材料、编写短视频脚本、准备视频素材、转换发布格式、发布到抖音串成完整工作流。
  内置「知识猫图解」主题：博物馆图鉴风 3D 科普图解系列（3:4 竖版、多页分镜、英文 Prompt 批量生图）。
  触发词：抖音内容 / 知识猫图解 / 做一套图解 / 图解百科 / 科普图解 / 自然科普系列 / 博物馆图鉴风
---

# 抖音内容创作与发布全流程

## 任务目标

把抖音相关能力组合为一条稳定工作流：

```text
讨论主题 → 研究搜集材料 → 编写脚本/大纲 → 生成文案 → 生图/合成视频 → 转换发布格式 → 发布到抖音
```

本技能只做流程编排，不重复实现子技能能力。执行时按阶段调用对应技能规范。

## 适用场景

- 用户说「帮我做一条抖音并发布」
- 用户说「围绕某个主题写抖音短视频脚本」
- 用户说「先研究竞品，再写脚本，最后发布抖音」
- 用户要测试抖音内容创作全流程（不真实发布）
- 用户要做知识科普、产品种草、教程类抖音内容
- 用户要做「知识猫图解」博物馆图鉴风自然科普图解系列

## 内置主题类型

| 主题 ID | 名称 | 规范文件 | 适用 |
| --- | --- | --- | --- |
| `knowledge-cat-illustrated` | 知识猫图解 | `themes/knowledge-cat-illustrated/` | 自然科学主体、博物馆图鉴风 3D 科普图解、4～7 张分镜 |
| `k8s-comic-saga` | K8s修仙传漫画爽文 | `themes/k8s-comic-saga/` | 技术漫画小说、竖版分镜+配音、爽文搞笑有内涵 |

**识别规则**：用户提到「知识猫图解 / 图解百科 / 科普图解 / 博物馆图鉴 / 自然科普系列」，或主题属于地貌/海洋/天气/天文/生态/微观/地质等自然科学类别时，默认选用本主题。

选用本主题时，**Agent 必须按顺序加载并严格执行**：

1. `themes/knowledge-cat-illustrated/AGENT-PROMPT.md` — 角色设定 + STEP 1～4 完整生成规范（**核心，不可跳步**）
2. `themes/knowledge-cat-illustrated/WORKFLOW.md` — 搜索轮次、落盘文件、生图命令、发布 SOP
3. `themes/knowledge-cat-illustrated/SKILL.md` — 主题入口与产出清单

关键行为：

- 主体明确时**直接执行四步**，一次性输出：系列规划表 → 模块依据 → 逐张英文 Prompt → 平台适配说明
- 同步落盘 `brief.md`、`outline.md`、`series-plan.md`、`images/prompts.md`
- 图片比例 **3:4**（`1024x1365`）；生图用 `generate_kg_image.py`
- 大纲确认后生图；封面确认后批量；发布前用户确认

## 技能组合索引

子技能位于 `sub-skills/`，按执行阶段分类。每阶段标注 **主推**（默认走这个）与 **可选**（特定场景才用）：

```text
sub-skills/
├── 02-research-materials/   # 竞品抓取、热点素材
├── 03-content-writing/      # 短视频脚本、标题、标签
├── 04-visuals/              # 竖版配图、图集转视频
└── 05-publish/              # CDP 填草稿、sau CLI 上传
```

跨流水线复用（避免重复打包，直接引用小红书流水线子技能）：

| 阶段 | 引用路径 | 用途 |
| --- | --- | --- |
| 主题定位 | `../xiaohongshu-content-pipeline/sub-skills/01-topic-strategy/social-content` | 明确目标、受众、账号语气 |
| 材料提炼 | `../xiaohongshu-content-pipeline/sub-skills/02-research-materials/content-engine` | 从文章/文档提炼核心观点 |

### 1. 讨论主题与定位

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `social-content`（跨流水线） | 明确目标、受众、账号语气、资源约束 | **主推** |

### 2. 研究搜集材料

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `content-engine`（跨流水线） | 从文章、文档、访谈中提炼原始观点 | **主推** |
| `crawling-social-media` | 下载竞品抖音/B站/小红书视频与元数据 | 可选(竞品) |

### 3. 脚本与文案

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `douyin-script` | 分镜脚本、钩子、口播、标题、标签、发布文案 | **主推** |

### 4. 配图与视频

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `douyin-images` | LLM-Link gpt-image-2 生成竖版配图/图集（通用 9:16 或知识猫图解 3:4） | **主推**(图集) |
| `compose-douyin-video` | ffmpeg 将图片合成为 1080×1920 MP4 | **主推**(图转视频) |
| 用户自备素材 | 实拍、剪辑软件导出 | 可选(实拍) |

### 5. 发布

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `post-to-douyin` | CDP 填充创作者中心草稿，人工确认后发布 | **主推** |
| `douyin-upload` | `sau` CLI 登录、cookie 校验、视频/图文上传 | 可选(CLI) |

## 默认工作流

### Step 1：澄清主题

如果用户没有提供完整信息，一次性询问：

```text
1. 主题或素材是什么？
2. 内容目标是什么？种草 / 干货 / 测评 / 教程 / 活动 / 其他
3. 目标受众是谁？
4. 要做单条还是系列？
5. 发布形式：短视频 / 图文图集？
6. 视频是否已准备好？若未准备，默认只做到脚本与发布预览。
7. 是否需要真实发布？若只是测试，默认只走到发布预览。
```

如果用户已提供足够信息，不要重复询问，直接进入 Step 2。

### Step 2：研究搜集材料

根据输入选择路径：

- 有网页、文章、Markdown、访谈、文档：使用 `content-engine` 提炼 3-7 个核心观点。
- 需要竞品参考：使用 `crawling-social-media` 抓取竞品视频标题、描述、标签。
- 需要账号定位：使用 `social-content` 明确受众与语气。

输出 `research.md` 结构：

```markdown
# 研究材料

## 主题

## 目标受众

## 核心观点

## 参考材料

## 差异化角度

## 风险与禁区
```

### Step 3：编写脚本大纲

使用 `douyin-script` 产出分镜结构：

```text
钩子(0-3s) → 铺垫 → 主体(1-3个要点) → 总结/转化 → CTA
```

输出 `outline.md`，并暂停等待用户确认。

### Step 4：生成完整脚本与发布文案

确认大纲后生成 `final.md`：

```markdown
# 标题

## 口播脚本（带时间轴）

## 画面/字幕提示

## 发布描述（标题+正文+标签）

## 发布说明
```

要求：

- **标题 ≤ 30 字**，前 3 秒必须有钩子（数字、痛点、悬念、反常识）。
- **竖版 9:16**（1080×1920），时长 15-60 秒为主（教程可到 3 分钟）。
- **字幕必备**：85%+ 用户静音观看，脚本须含字幕文案。
- 正文使用简体中文，口语化、快节奏（约 160-180 字/分钟）。
- 避免夸大、绝对化、医疗承诺。
- 每条视频只表达一个核心主张。

#### 系列视频标题

同一系列统一为 **`序号｜标题`** 或 **`序号：标题`** 格式，例如 `02｜kubectl 背后站着 6 个组件`。

### Step 5：生图或合成视频

按内容形式选择路径：

#### A. 图文图集（多张竖版图）

1. 在 `images/prompts.md` 编写各页提示词（`## #cover` + `完整提示词:` 代码块）。
2. 复制 `sub-skills/04-visuals/douyin-images/config.example.json` 为 `config.json` 填 `api_key`。
3. 逐张生成（竖版 `--size 1080x1920`）：

```powershell
cd sub-skills/04-visuals/douyin-images
python scripts/generate_image.py `
  --prompt-file <笔记目录>/images/prompts.md `
  --section cover `
  --output <笔记目录>/images/01-cover.png `
  --size 1080x1920
```

生图前须用户确认风格与页数；完成后更新进度为「已生图」。

#### B. 图集转视频（幻灯片 MP4）

**无配音**（固定每张停留时长）：

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video.py `
  --images <笔记目录>/images/01-cover.png <笔记目录>/images/02-point-1.png `
  --output <笔记目录>/video/final.mp4 `
  --seconds 2.8
```

**有配音**（推荐，时长随口播自动对齐）：

```powershell
# 先写 <笔记目录>/video/narration.json（分镜口播 + 图片路径）
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video_with_voice.py `
  --narration <笔记目录>/video/narration.json `
  --output <笔记目录>/video/final.mp4
```

依赖 **ffmpeg**（或 `imageio-ffmpeg`）+ **edge-tts**。完成后更新进度为「已剪辑」。

#### C. 实拍/外部剪辑

视频放入 `video/`：

```text
video/
├── raw.mp4          ← 原始素材（可选）
├── final.mp4        ← 待发布成片
└── subtitles.srt    ← 字幕文件（可选）
```

若无成片，在 `final.md` 标注「待拍摄/待剪辑」，不进入真实发布。

### Step 6：转换发布格式

生成 `publish.md`：

```markdown
# 发布标题

## 发布描述

## 视频/图片

## 标签

## 发布类型
视频 / 图文
```

发布前检查：

- 视频模式必须有 `video/final.mp4`（或用户指定路径）。
- 图文模式必须有图片列表。
- 标题、描述、标签与 `douyin-upload` CLI 契约一致（视频：`title + desc + tags`；图文：`title + note + tags`）。

### Step 7：发布到抖音

默认使用 `post-to-douyin`（CDP 填草稿，人工确认后发布）。

**四种发布方式**（内容形态 × 发布通道）：

| # | 形态 | 通道 | 命令 |
|---|------|------|------|
| 1 | 图文 | CDP | `douyin_cdp_publish.py fill-image` |
| 2 | 视频 | CDP | `douyin_cdp_publish.py fill-video` |
| 3 | 图文 | sau CLI | `sau douyin upload-note` |
| 4 | 视频 | sau CLI | `sau douyin upload-video` |

仅当用户明确要用 `sau` CLI，或环境已配置 `social-auto-upload` 时，使用 `douyin-upload`。

**CDP 图文示例：**

```powershell
cd sub-skills/05-publish/post-to-douyin/scripts
python douyin_cdp_publish.py fill-image `
  --title-file <笔记目录>/publish-title.txt `
  --content-file <笔记目录>/publish-desc.txt `
  --images <笔记目录>/images/*.png
```

**CDP 视频示例：**

```powershell
python douyin_cdp_publish.py fill-video `
  --title-file <笔记目录>/publish-title.txt `
  --content-file <笔记目录>/publish-desc.txt `
  --video <笔记目录>/video/final.mp4
```

发布前必须通过用户确认：

1. 标题
2. 描述/正文
3. 视频或图片
4. 账号
5. 发布模式：无头 / 有窗口

绝不自动发布。

发布结束后，在笔记目录写 `publish-report.md` 留档，并更新合集 `00-series-outline.md` 进度表为「已发布」。

## 模式选择

### 通用短视频模式（实拍，默认）

```text
social-content → content-engine → douyin-script → post-to-douyin
```

### 图集转视频模式

```text
content-engine → douyin-script → douyin-images → compose-douyin-video → post-to-douyin
```

### 图文图集模式

```text
content-engine → douyin-script → douyin-images → post-to-douyin fill-image
```

### 竞品研究模式

```text
crawling-social-media → content-engine → douyin-script → douyin-images → compose-douyin-video → post-to-douyin
```

### sau CLI 模式（可选）

```text
douyin-script → compose-douyin-video → douyin-upload upload-video
```

### 仅脚本模式（无素材）

```text
content-engine → douyin-script → publish.md（预览，不发布）
```

### 知识猫图解模式（博物馆图鉴风科普图集）

```text
主体输入
  → 搜索（大纲前）→ AGENT-PROMPT STEP 1-2 → brief.md + outline.md →【确认大纲】
  → 搜索（Prompt前）→ AGENT-PROMPT STEP 3-4 → prompts.md + series-plan.md →【确认封面】
  → generate_kg_image.py 单张测封面 → 批量生图（3:4）
  → 搜索（文案前）→ douyin-script → final.md
  → compose-douyin-video 或 post-to-douyin fill-image
```

**Agent 执行规范**（详见 `themes/knowledge-cat-illustrated/AGENT-PROMPT.md`）：

| 步骤 | 动作 | 落盘 |
|------|------|------|
| STEP 1 | 主体分类、认知颠覆点、核心科学结论 | `brief.md` |
| STEP 2 | 动态选模块 M00～M99（4～7 张） | `outline.md` |
| STEP 3 | 逐张英文 Prompt（含 STYLE DNA） | `images/prompts.md` |
| STEP 4 | 系列规划表 + 模块依据 + 平台适配 | `series-plan.md` + 对话输出 |

主体明确时**不追问**，直接按四步生成；仅在主体无法判断时询问系列名/张数/风格。

知识猫图解专用产出（在通用目录基础上追加）：

```text
articles/<YYYYMMDD-slug>/
├── brief.md           ← STEP 1
├── outline.md         ← STEP 2（确认后再生图）
├── series-plan.md     ← STEP 4 整合
├── images/prompts.md  ← STEP 3（generate_kg_image 输入）
└── images/01-cover.png …
```

生图命令见 `WORKFLOW.md` §⑤；先单张测封面再批量。

## 测试流程

用户只说「测试抖音内容创作」时，默认不真实发布，只走到发布预览：

```text
主题澄清 → 研究摘要 → 大纲确认 → 脚本生成 → 发布预览
```

如果用户确认要真实发布，再执行：

```text
账号检查 → 发布内容确认 → 发布模式确认 → 执行发布 → 输出报告
```

## 输出目录（统一结构化，详见 `data/README.md`）

所有产出**统一**放在 `data/<主题合集>/articles/<YYYYMMDD-slug>/` 下，结构对齐小红书/公众号流水线：

```text
data/<topic-collection>/
├── 00-series-outline.md           ← 合集大纲 + 进度追踪表（每次接手必读、完成阶段后更新）
├── samples/                        ← 样板成品（参考，可空）
└── articles/<YYYYMMDD-slug>/
    ├── research.md                ← 研究材料
    ├── outline.md                 ← 分镜大纲
    ├── final.md                   ← 口播脚本 + 发布文案 + 标签
    ├── images/                    ← 01-cover.png / prompts.md（图集模式）
    ├── video/                     ← final.mp4（图转视频或实拍）
    ├── publish.md                 ← 发布版（标题/描述/素材清单/类型）
    ├── publish-title.txt          ← CDP/CLI 用标题（可由 publish.md 导出）
    ├── publish-desc.txt           ← CDP/CLI 用描述
    └── publish-report.md          ← 发布结果留档
```

### 进度管控

每个合集 `00-series-outline.md` 维护一张进度表，状态流转：
`待写 → 已写脚本 → 已生图 → 已剪辑 → 待发布 → 已发布`。AI 接手前先读表，完成每阶段后回写。

| 编号 | 标题 | slug | 状态 | 发布日期 |
|------|------|------|------|---------|
| 1 | 示例 | 20260606-example | 待写 | - |

## 质量门禁

- 内容基于真实素材或明确标注为创意生成。
- 不编造引用、数据、账号表现。
- 不使用绝对化功效描述。
- 视频画面、字幕与脚本一致。
- 发布动作必须等待用户明确确认。
