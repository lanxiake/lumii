---
name: knowledge-cat-illustrated
description: |
  知识猫图解·博物馆图鉴风自然科普图解主题。
  将任意自然科学主体拆解为 4～7 张 3D 科普图解系列（3:4 竖版、英文 Prompt 直出、gpt-image-2-pro 批量生图）。
  Agent 执行时必须完整遵循 AGENT-PROMPT.md 四步流程，不得跳步、不得强行套用不适配模块。
  触发词：知识猫图解 / 做一套图解 / 图解百科 / 科普图解 / 自然科普系列 / 博物馆图鉴风
type: theme
parent: douyin-content-pipeline
version: 1.0.0
---

# 知识猫图解 · 主题技能

## 执行入口（Agent 必读）

选用本主题时，**按顺序加载并严格执行**：

| 优先级 | 文件 | 用途 |
|--------|------|------|
| 1 | **`AGENT-PROMPT.md`** | Agent 角色设定 + STEP 1～4 完整生成规范（**核心，不可省略**） |
| 2 | **`WORKFLOW.md`** | 与抖音流水线集成的端到端 SOP、落盘文件、生图命令 |
| 3 | `THEME.md` | 速查索引与视觉约束摘要 |

> **关键约束**：收到主体名称后，按 `AGENT-PROMPT.md` 四步**一次性输出**系列规划表 → 模块依据 → 逐张英文 Prompt → 平台适配说明；同时落盘到笔记目录（见 `WORKFLOW.md`）。

## 与子技能关系

| 阶段 | 调用 | 说明 |
|------|------|------|
| 研究 | `content-engine`（跨流水线） | 大纲前 / Prompt 前 / 文案前三轮搜索 |
| 大纲 + Prompt | **本主题 `AGENT-PROMPT.md`** | 替代通用 `douyin-script` 分镜结构 |
| 批量生图 | `douyin-images/scripts/generate_kg_image.py` | 解析 `images/prompts.md` |
| 口播文案 | `douyin-script` | 图集描述、标签、口播（生图后） |
| 合成/发布 | `compose-douyin-video` / `post-to-douyin` | 图转视频或图文图集 |

## 产出文件一览

```text
data/<合集>/articles/<YYYYMMDD-slug>/
├── research.md          ← 含科学参考（搜索核实）
├── brief.md           ← STEP 1：分类、认知颠覆点、每张反直觉金句
├── outline.md           ← STEP 2：分镜大纲 + 模块链
├── series-plan.md       ← STEP 4：系列规划表 + 模块依据 + 平台适配
├── images/
│   ├── prompts.md       ← STEP 3：完整英文 Prompt（generate_kg_image 输入）
│   └── 01-cover.png …   ← 批量生图产出
├── final.md             ← 抖音口播 + 发布描述
└── publish.md           ← 发布清单
```

## 生图规格

- 比例：**3:4**（`1024x1365`）
- 模型：gpt-image-2-pro（LLM-Link `images/generations`）
- `generate_kg_image.py` 调用时**自动删除** Midjourney 参数
