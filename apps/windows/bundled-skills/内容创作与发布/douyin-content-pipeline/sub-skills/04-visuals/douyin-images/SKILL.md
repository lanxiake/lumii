---
name: douyin-images
description: |
  抖音竖版配图/封面/图集生成。通过 LLM-Link gpt-image-2 按 prompts.md 分节生成图片。
  支持两种模式：通用 9:16 知识卡片（generate_image.py）、知识猫图解 3:4 博物图鉴风（generate_kg_image.py）。
  触发词：抖音配图、抖音封面、生成竖版图、图集配图、知识猫图解、科普图解生图。
---

# 抖音竖版配图生成

为抖音图文图集或「图转视频」模式生成竖版配图。

## 两种生图模式

| 模式 | 脚本 | 比例 | prompts.md 格式 | 适用 |
|------|------|------|----------------|------|
| **通用知识卡片** | `generate_image.py` | 9:16（1080×1920） | `## #cover` + `完整提示词:` 代码块 | 干货清单、手写笔记风 |
| **知识猫图解** | `generate_kg_image.py` | 3:4（1024×1365） | `## #01-cover` + `完整Prompt:` 缩进正文 | 博物馆图鉴风 3D 科普图解系列 |

知识猫图解的 **Agent 角色 + 四步生成规范** 见 `../../themes/knowledge-cat-illustrated/AGENT-PROMPT.md`；
端到端落盘与命令见 `../../themes/knowledge-cat-illustrated/WORKFLOW.md`。

## 配置

首次使用复制 `config.example.json` 为 `config.json`，填入 `api_key`（可与小红书/公众号共用 LLM-Link key）：

```json
{
  "api_key": "sk-...",
  "base_url": "https://www.llm-link.top",
  "model": "gpt-image-2"
}
```

脚本会向上查找 `config.json`，与 `baoyu-xhs-images` 配置格式兼容。

---

## 模式 A：通用 9:16 知识卡片

### 提示词文件

```markdown
## #cover
完整提示词:
```
竖版 9:16 抖音知识卡片，标题「kubectl 背后 6 个组件」，手写笔记风格...
```

## #slide-1
完整提示词:
```
...
```
```

### 生成命令

```powershell
cd sub-skills/04-visuals/douyin-images
python scripts/generate_image.py `
  --prompt-file "<笔记目录>/images/prompts.md" `
  --section cover `
  --output "<笔记目录>/images/01-cover.png" `
  --size 1080x1920
```

---

## 模式 B：知识猫图解（3:4 博物图鉴风）

### 提示词文件

按 `themes/knowledge-cat-illustrated/AGENT-PROMPT.md` STEP 3 模板生成，格式示例：

```markdown
# 图像Prompt记录 · 火山（共5张）

## #01-cover（火山 · 核心总览图）
- 模块：M00
- 尺寸：1024x1365（3:4）
- 完整Prompt：
  [Image 1/5] 核心总览图 — 火山

  SCENE:
  aerial 3D overview of an active stratovolcano...

  TITLE SYSTEM:
  - Main title (Chinese): "火山"
  ...

  STYLE DNA:
  photorealistic CGI render, museum-quality scientific illustration,
  warm parchment beige background (#F0EDE6), ...
```

> `generate_kg_image.py` 调用 gpt-image-2 时会**自动剥离** Midjourney 参数（`--ar/--v/--q/--s/--seed`）。

### 生成命令

```powershell
cd sub-skills/04-visuals/douyin-images

# 先单张确认封面风格
python scripts/generate_kg_image.py `
  --prompt-file "<笔记目录>/images/prompts.md" `
  --section 01-cover `
  --output "<笔记目录>/images/01-cover.png"

# 批量（跳过已存在，可中断续跑）
python scripts/generate_kg_image.py `
  --prompt-file "<笔记目录>/images/prompts.md" `
  --batch `
  --output-dir "<笔记目录>/images/"
```

### 质检（每张必检）

- 背景：暖羊皮纸米色 `#F0EDE6`，无纯白/纯黑/实景背景
- 中文标题/副标题清晰无乱码（主标题 ≤ 8 字、标注 ≤ 6 字）
- 标注：细线 + 白色小圆点锚点，无气泡框
- 底部总结 + 页脚 `— 知识猫图解 · 第X页 / 共N页 —`
- 与同系列其他图风格一致

---

## 风格建议（通用模式）

- 竖版 9:16，留白适合抖音 UI 安全区
- 大标题 + 3-5 个要点，字号适合手机阅读
- 手写笔记风 / 简笔画架构图均可
- 图片内中文为主，专业术语可保留英文

## 与流水线对应

| 产出 | 路径 |
|------|------|
| 提示词 | `images/prompts.md` |
| 配图 | `images/01-cover.png` … |
| 合成视频输入 | 同上图片列表 → `compose-douyin-video` |

生图前须用户确认风格与页数；生图后更新 `00-series-outline.md` 为「已生图」。
