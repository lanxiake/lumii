---
name: xiaohongshu-content-pipeline
description: 小红书内容创作与发布端到端编排技能。用于将讨论主题、研究搜集材料、编写大纲、生成笔记内容、生图/卡片、转换发布格式、发布到小红书串成完整工作流；适用于小红书图文、长文、知识卡片、美妆种草、营销活动与系列笔记。
---

# 小红书内容创作与发布全流程

## 任务目标

把现有小红书相关技能组合为一条稳定工作流：

```text
讨论主题 → 研究搜集材料 → 编写大纲 → 生成内容 → 生图 → 转换格式 → 发布到小红书
```

本技能只做流程编排，不重复实现子技能能力。执行时按阶段调用对应技能规范。

## 适用场景

- 用户说“帮我做一篇小红书并发布”
- 用户说“围绕某个主题做小红书图文/长文/卡片”
- 用户说“先研究资料，再写大纲，再生图，最后发布小红书”
- 用户要测试小红书内容创作全流程
- 用户要做美妆、知识干货、品牌活动、招聘帖等小红书内容

## 技能组合索引

子技能位于 `sub-skills/`，按执行阶段分类。每阶段标注 **主推**（默认走这个）与 **可选**（特定场景才用）：

```text
sub-skills/
├── 01-topic-strategy/       # 主题讨论、受众定位、营销策略
├── 02-research-materials/   # 热点、竞品、源材料提炼
├── 03-content-writing/      # 正文、短文案、视频脚本
├── 04-outline-and-visuals/  # 大纲、信息图、卡片、封面
└── 05-publish/              # 发布格式转换、账号检查、上传发布
```

### 1. 讨论主题与定位

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `social-content` | 明确目标、受众、账号语气、资源约束 | **主推** |
| `beauty-content-strategy` | 美妆垂类策略 | 可选(美妆) |
| `campaign-plan` / `campaign-planning` | 营销活动级策略（功能重叠，任选其一） | 可选(活动) |

### 2. 研究搜集材料

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `content-engine` | 从文章、文档、访谈、截图中提炼原始观点 | **主推** |
| `content-planner` | 搜集热点、竞品标题（偏公众号，参考用） | 可选 |
| `content-creator` | 品牌声音、关键词、营销内容框架 | 可选(品牌) |

### 3. 大纲与正文

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `baoyu-xhs-images` | 深度分析 + 三套视觉/结构方案 + 滑动页大纲 | **主推** |
| `content-engine` | 源材料改写为平台原生表达 | **主推**(正文) |
| `social-media` / `short-form-video-plan` | 短社媒/短视频文案（非小红书原生，参考用） | 可选 |

### 4. 生图与卡片

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `baoyu-xhs-images` | 主力信息图生成（内置 `scripts/generate_image.py`，gpt-image-2） | **主推** |
| `card-xiaohongshu` | HTML 知识卡片截图，中文乱码时的兜底 | 可选(兜底) |
| `xhs-images` | 轻量信息图（与 baoyu 重叠，功能子集） | 可选 |
| `xiaohongshu-recruiter` | 招聘帖专用封面与发布 | 可选(招聘) |

### 5. 发布

| 子技能 | 用途 | 优先级 |
| --- | --- | --- |
| `post-to-xhs` | 默认发布入口：CDP 浏览器自动化，图文/长文、多账号、无头/有窗口 | **主推** |
| `xiaohongshu-upload` | 基于 `sau` CLI 的命令式上传（需已装 social-auto-upload） | 可选 |
| `xiaohongshu-recruiter` | 招聘帖专用发布 | 可选(招聘) |

## 默认工作流

### Step 1：澄清主题

如果用户没有提供完整信息，一次性询问：

```text
1. 主题或素材是什么？
2. 内容目标是什么？种草 / 干货 / 测评 / 教程 / 活动 / 招聘 / 其他
3. 目标受众是谁？
4. 要做单篇还是系列？
5. 是否需要真实发布？如果只是测试，默认只做到发布预览。
```

如果用户已提供足够信息，不要重复询问，直接进入 Step 2。

### Step 2：研究搜集材料

根据输入选择路径：

- 有网页、文章、Markdown、访谈、文档：使用 `content-engine` 提炼 3-7 个核心观点。
- 需要热点/竞品参考：使用 `content-planner` 搜索并汇总参考材料。
- 美妆主题：结合 `beauty-content-strategy` 的垂类策略与标签资源。
- 营销活动：使用 `campaign-plan` 或 `campaign-planning` 明确目标、受众、KPI。

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

### Step 3：编写大纲

优先使用 `baoyu-xhs-images` 的分析框架，产出滑动图文结构：

```text
封面 → 3-7 张内容页 → 总结/CTA
```

如果是纯文字长文，则产出：

```text
标题 → 开头钩子 → 正文分段 → 结尾 CTA → 标签
```

输出 `outline.md`，并暂停等待用户确认。

### Step 4：生成内容

确认大纲后生成 `final.md`：

```markdown
# 标题

## 正文

## 图片页文案

## 标签

## 发布说明
```

要求：

- **标题 ≤ 20 字**，有钩子（数字、痛点、悬念），发布前交给 `post-to-xhs` 做长度检查。
- **正文 ≤ 1000 字符**（含空格和标点），超出则精简。
- **正文结构化**：每段 1-3 句，段落间空行分隔，每段开头用 emoji 图标辅助识别，关键信息用标记（✔️ ▸ ⚠️ 📌）突出。
- 正文使用简体中文，口语化、适合收藏快速阅读。
- 避免夸大、绝对化、医疗承诺。
- 每篇只表达一个核心主张，避免泛泛而谈。

#### 系列文章标题

同一系列的文章标题统一为 **`序号：标题`** 格式，例如 `02：一个kubectl apply背后站着6个打工仔`。序号用两位数字，整条标题（含序号）仍遵守 ≤20 字约束。

### Step 5：生图或卡片

**主力**：用 `baoyu-xhs-images` 子技能的本地脚本 `scripts/generate_image.py`（gpt-image-2 via LLM-Link）。

1. 把每张图提示词写入笔记目录 `images/prompts.md`（按 `## #<section>` + `完整提示词:` 代码块分节）。
2. 首次使用复制 `baoyu-xhs-images/.env.example` 为 `.env` 填 `LLM_LINK_API_KEY`（可复用 wechat 同款 key，脚本自动向上查找）。
3. 逐张生成（小红书竖版 `--size 1080x1440`），图片落在 `images/`：
   ```bash
   cd sub-skills/04-outline-and-visuals/baoyu-xhs-images
   python scripts/generate_image.py --prompt-file <笔记目录>/images/prompts.md --section cover \
     --output <笔记目录>/images/01-cover.png --size 1080x1440
   ```

按内容类型选择子技能：

- 知识干货、教程、清单：`baoyu-xhs-images`（**主推**）
- 中文反复乱码 / 需精确文字排版：`card-xiaohongshu`（HTML 卡片截图兜底）
- 招聘帖：`xiaohongshu-recruiter`

#### 笔记风格生图（知识干货/教程系列优先使用）

当内容为知识干货、教程、技术科普类（如 K8S 系列）时，优先使用 **笔记风格**：

- **背景**：方格笔记本纸/点阵纸/白纸，有真实纸张质感
- **手写风格**：手写体文字 + 彩色笔标注 + 荧光笔高亮
- **标记**：箭头标注、下划线、圆圈标记、荧光高亮
- **图表**：简笔画风格，保留技术准确性
- **配色**：暖色调（黄、橙、粉）+ 冷色调（蓝、绿）手写笔颜色，白纸底色
- **文字**：图片中文字除专业术语外全部使用中文；专业术语（如 kubectl、API Server、etcd、Pod、Deployment）保留英文

在 prompts.md 中为每张图统一加入笔记风格描述前缀，确保整系列视觉风格一致。

生图前必须让用户确认图片方案：风格、页数、语言、是否使用本地素材。
生图完成后，更新合集 `00-series-outline.md` 进度表为「已生图」。

### Step 6：转换发布格式

生成 `publish.md`：

```markdown
# 发布标题

## 发布正文

## 图片

## 标签

## 发布模式
图文 / 长文

## 内容类型
knowledge / food / beauty / lifestyle / general

## 定时发布
立即发布 / YYYY-MM-DD HH:MM
```

同时生成 `publish-options.json`（CDP / sau CLI 共用）：

```json
{
  "publish_mode": "image-text",
  "content_type": "knowledge",
  "schedule": "",
  "account": "default",
  "tags": ["标签1", "标签2"]
}
```

发布前检查：

- 标题符合 `post-to-xhs` 标题长度规则（≤20 字）。
- 系列文章按 `序号：标题` 格式命名。
- 图文模式必须有图片。
- 长文模式图片可选，但需要用户选择排版模板。
- 图文格式正文内容不超过 1000 个字符（含空格和标点），超出则精简到 1000 字符以内。
- 正文结构化：短段 + emoji + 标记，适合收藏阅读。

### Step 6.5：定时发布推荐（可选）

若用户需要定时发布，或内容类型有明确流量规律，在发布前推荐时段：

1. 根据 Step 1 的「内容目标」映射 `content_type`（干货→`knowledge`、种草→`beauty`、美食→`food`、情感→`lifestyle`）
2. 运行推荐脚本获取 3–5 个候选时间：

```powershell
cd sub-skills/05-publish/post-to-xhs/scripts
python schedule_advisor.py --type <content_type> --json
```

3. 向用户展示推荐时段及理由（策略详见 `post-to-xhs/references/schedule-strategy.md`）
4. 用户选定后写入 `publish-options.json` 的 `schedule` 字段（格式 `YYYY-MM-DD HH:MM`）
5. 空 `schedule` 表示立即发布

**通用黄金时段速查**：

| 时段 | 时间 | 适合 |
| --- | --- | --- |
| 早高峰 | 07–09 | 干货、轻量图文 |
| 午休 | 12–14 | 美食、娱乐、搞笑 |
| 晚间巅峰 | 19–23 | 深度干货、测评、情感 |

### Step 7：发布到小红书

默认使用 `post-to-xhs`。

只有在用户明确要用 `sau` CLI，或当前环境已配置 `social-auto-upload` 且用户偏好命令式流程时，使用 `xiaohongshu-upload`。

发布前必须通过用户确认：

1. 标题
2. 正文
3. 图片
4. 账号
5. 发布模式：无头 / 有窗口
6. 发布时间：立即 / 定时（若定时，确认 `schedule` 时间）

绝不自动发布。

**定时发布执行**（CDP）：

```powershell
# 统一入口（读 publish-options.json）
python xhs_publish.py --article-dir "<笔记目录>"

# 或分步：填表后设置定时并发布
python cdp_publish.py click-publish --schedule "2026-06-13 20:00"
```

发布结束后（无论成功或仅填表），在笔记目录写 `publish-report.md` 留档（账号/模式/时间/状态），
并更新合集 `00-series-outline.md` 进度表为「已发布」。
## 模式选择

### 通用图文模式（默认）

```text
social-content → content-engine → baoyu-xhs-images（大纲+生图）→ post-to-xhs
```

### 知识卡片模式

```text
content-engine → baoyu-xhs-images → card-xiaohongshu（中文乱码兜底）→ post-to-xhs
```

### 营销活动模式

```text
campaign-plan → content-engine → baoyu-xhs-images → post-to-xhs / xiaohongshu-upload
```

### 招聘帖模式

```text
xiaohongshu-recruiter → post-to-xhs 或该技能自带发布流程
```

## 测试流程

用户只说“测试小红书内容创作”时，默认不真实发布，只走到发布预览：

```text
主题澄清 → 研究摘要 → 大纲确认 → 正文生成 → 图片方案 → 发布预览
```

如果用户确认要真实发布，再执行：

```text
账号检查 → 发布内容确认 → 发布模式确认 → 执行发布 → 输出报告
```

## 输出目录（统一结构化，详见 `data/README.md`）

所有产出**统一**放在 `data/<主题合集>/articles/<YYYYMMDD-slug>/` 下，结构对齐 wechat 技能，
不再用旧的散乱目录（`xhs-pipeline-outputs/`、`xhs-images/`、`xhs-outputs/`、`notes/` 已废弃）：

```text
data/<topic-collection>/
├── 00-series-outline.md           ← 合集大纲 + 进度追踪表（每次接手必读、完成阶段后更新）
├── samples/                        ← 样板成品（参考，可空）
└── articles/<YYYYMMDD-slug>/
    ├── research.md                ← 研究材料
    ├── outline.md                 ← 滑动页大纲
    ├── final.md                   ← 正文 + 图片页文案 + 标签
    ├── images/                    ← 01-cover.png / 02-content-1.png / ... + prompts.md
    │   └── prompts.md             ← 各图提示词（#section 分节，供生图脚本提取）
    ├── publish.md                 ← 发布版（标题/正文/图片清单/模式）
    ├── publish-options.json       ← 发布选项（content_type/schedule/账号/模式）
    ├── publish-title.txt          ← CDP/CLI 用标题（可选，从 publish.md 导出）
    ├── publish-desc.txt           ← CDP/CLI 用正文（可选）
    └── publish-report.md          ← 发布结果留档（账号/模式/定时/时间/状态）
```

### 进度管控

每个合集 `00-series-outline.md` 维护一张进度表，状态流转：
`待写 → 已写正文 → 已生图 → 待发布 → 已发布`。AI 接手前先读表，完成每阶段后回写。

| 编号 | 标题 | slug | 状态 | 发布日期 |
|------|------|------|------|---------|
| 1 | 示例 | 20260606-example | 待写 | - |

### 历史留存

每次真实发布后，在笔记目录写 `publish-report.md`（账号 / 发布模式 / 时间 / 状态 / 备注），
用于复盘与防重发。仅填表未发布也记一条「仅填表未发布」。

## 质量门禁

- 内容基于真实素材或明确标注为创意生成。
- 不编造引用、数据、账号表现。
- 不使用绝对化功效描述。
- 不把平台通用模板套成空话。
- 图片内容与正文一致。
- 发布动作必须等待用户明确确认。
