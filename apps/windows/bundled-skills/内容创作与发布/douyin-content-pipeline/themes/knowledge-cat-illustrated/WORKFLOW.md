# 知识猫图解 · 端到端生成 SOP

> 将 `AGENT-PROMPT.md` 的四步流程映射为可复现的文件产出与命令。
> 配合 `douyin-content-pipeline/SKILL.md` 知识猫图解模式使用。

---

## 全景流程

```text
主体输入
  → 0. 主题确认（可选，主体明确则跳过）
  → ① 搜索研究（大纲前）
  → ② AGENT-PROMPT STEP 1-2 → brief.md + outline.md → 【人工确认大纲】
  → ③ 搜索研究（Prompt 前）
  → ④ AGENT-PROMPT STEP 3-4 → images/prompts.md + series-plan.md → 【人工确认封面风格】
  → ⑤ generate_kg_image.py 单张测封面 → 批量生图
  → ⑥ 搜索研究（文案前）
  → ⑦ douyin-script → final.md
  → ⑧ compose-douyin-video 或 post-to-douyin
```

> **搜索研究不可跳过**：保证科普准确性。三轮分别在「大纲前 / Prompt 前 / 文案前」执行。

---

## 0. 主题确认

若用户已给出明确主体（如「做一套火山知识猫图解」），**直接进入 STEP 1**，不再追问。

仅在主体完全无法判断时询问：

```text
主体：[名称]
系列名（可选，默认「知识猫图解」）
张数偏好（可选）：4/5/6/7/完整版
风格偏好（可选）：更震撼 / 更学术 / 更适合小红书 / 更像博物馆图鉴
```

---

## ① 搜索研究（大纲前）

搜索并写入 `research.md` 的「科学参考」段：

```text
- [主体] 核心结构组成（中英文术语）
- [主体] 关键数值/尺度（须可核实）
- [主体] 常见认知误区（为认知颠覆点提供依据）
- [主体] 与人类/环境的关系
```

---

## ② STEP 1-2：主体识别 + 模块选择

**严格按 `AGENT-PROMPT.md` STEP 1 和 STEP 2 执行**，落盘：

### `brief.md`

```markdown
# 系列简介

- 主体：{名称}
- 系列名：知识猫图解
- 主体分类：{类型标签}
- 张数：{N}张
- 认知颠覆点：原来...，而是...
- 核心科学结论：{18-34字}

## 每张图的反直觉金句

| 序号 | 模块 | 反直觉金句 |
|------|------|-----------|
| 01 | M00 | 原来...，而是... |
| 02 | M01 | ... |
```

### `outline.md`

```markdown
# 分镜大纲：{主体}（共N张）

## 选用模块

M00 → M01 → M02 → ...（共N张）

## 选择依据

- M00 核心总览图：...
- M01 结构剖面图：...

## 第1张：{大标题}（M00 · 核心总览图）

- **大标题**：{2-6字}
- **反直觉副标题**：原来...，而是...
- **英文副题**：{UPPERCASE ENGLISH}
- **核心视觉**：{40字以内}
- **必须标注的元素**：① ... ② ...（5-8个）
- **底部总结**：{18-34字}
- **科普说明**：{100字口语化}

## 第2张：...
```

**暂停等待用户确认大纲后再进入 STEP 3。**

---

## ③ 搜索研究（Prompt 前）

```text
- [主体] 外观/颜色/形态
- [主体] 各结构英文学术名称
- [主体] 典型场景参照（剖面图、卫星图、显微图等）
```

---

## ④ STEP 3-4：生成英文 Prompt + 整合汇总

**严格按 `AGENT-PROMPT.md` STEP 3 和 STEP 4 执行。**

### 对话输出顺序（必须遵守）

1. **系列规划表**（STEP 4.1 表格）
2. **模块选择依据**（STEP 4.2 逐条）
3. **逐张完整英文 Prompt**（STEP 4.3，每张 `### 图X / 共N张：模块名称` + 代码块）
4. **平台适配说明**（STEP 4.4 全文）

### 落盘 `series-plan.md`

将 STEP 4.1～4.4 完整写入。

### 落盘 `images/prompts.md`

格式须被 `generate_kg_image.py` 解析：

```markdown
# 图像Prompt记录 · {主体名称}（共N张）

## #01-cover（{大标题} · 核心总览图）
- 模块：M00
- 尺寸：1024x1365（3:4）
- 完整Prompt：
  [Image 1/N] 核心总览图 — {主体名}

  SCENE:
  aerial 3D overview of ...

  TITLE SYSTEM:
  - Main title (Chinese): "火山"
  - Subtitle (Chinese): "原来火山不是地球的伤口，而是深部热量释放到地表的通道"
  - English label: "VOLCANO · CORE OVERVIEW"

  VISUAL CONTENT:
  - ...

  ANNOTATION LABELS (Chinese):
  岩浆房, 火山口, 熔岩流, 火山灰柱, 板块边界, 地热区

  SPECIAL EFFECTS:
  volcanic glow, heat shimmer, ash plume dynamics

  LIGHTING:
  dramatic side lighting from upper left, consistent warm natural tone

  SUMMARY (Chinese, bottom):
  "火山连接着地表景观与地球内部热量循环。"

  FOOTER:
  "— 知识猫图解 · 第1页 / 共5页 —"

  STYLE DNA:
  photorealistic CGI render, museum-quality scientific illustration,
  warm parchment beige background (#F0EDE6), matte linen surface texture,
  DK encyclopedia aesthetic, natural history atlas style,
  Chinese educational poster format, 3:4 portrait ratio,
  annotation lines with small white dot anchor markers,
  navy blue Chinese label text (#1A2E4A),
  large Chinese Song-style bold main title at top,
  wide-spaced uppercase English subtitle below,
  small centered Chinese summary sentence at bottom,
  subtle designed series footer only, no external watermark, no logo, no UI chrome,
  deep ocean blue, geological brown, moss green, mineral gray natural palette,
  ultra-detailed 8K textures, dramatic natural lighting,
  consistent camera language, consistent lighting direction, same visual seed,
  --ar 3:4 --v 6.1 --q 2 --s 80 --seed 24680

## #02-structure（{大标题} · 结构剖面图）
- 模块：M01
- 尺寸：1024x1365
- 完整Prompt：
  ...
```

**暂停等待用户确认封面 Prompt / 风格后再批量生图。**

---

## ⑤ 批量生图

```powershell
cd sub-skills/04-visuals/douyin-images

# 先单张测封面（确认羊皮纸风格 + 中文渲染）
python scripts/generate_kg_image.py `
  --prompt-file "<笔记目录>/images/prompts.md" `
  --section 01-cover `
  --output "<笔记目录>/images/01-cover.png"

# 用户确认后批量（跳过已存在，可中断续跑）
python scripts/generate_kg_image.py `
  --prompt-file "<笔记目录>/images/prompts.md" `
  --batch `
  --output-dir "<笔记目录>/images/"
```

### 每张质检（6 项）

- [ ] 背景：暖羊皮纸 `#F0EDE6`，无纯白/纯黑
- [ ] 中文标题/副标题清晰（主标题 ≤ 8 字、标注 ≤ 6 字）
- [ ] 英文副标题全大写、拼写正确
- [ ] 标注：细线 + 白点锚点，无气泡框
- [ ] 底部总结 + 页脚已渲染
- [ ] 与同系列其他图风格一致

不通过则修改 Prompt 重试，最多 3 轮。

---

## ⑥ 搜索研究（文案前）

验证 `final.md` 中引用的数字、研究结论是否准确。

---

## ⑦ 撰写抖音文案

使用 `douyin-script` 根据 `outline.md` 撰写 `final.md`（图集口播 + 发布描述 + 标签）。

---

## ⑧ 发布

**图集转视频：**

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video.py `
  --images <笔记目录>/images/01-cover.png <笔记目录>/images/02-*.png `
  --output <笔记目录>/video/final.mp4 `
  --seconds 2.8
```

**图文图集：**

```powershell
python sub-skills/05-publish/post-to-douyin/scripts/douyin_cdp_publish.py fill-image `
  --title-file <笔记目录>/publish-title.txt `
  --content-file <笔记目录>/publish-desc.txt `
  --images <笔记目录>/images/*.png
```

只填草稿，**绝不自动最终发布**。

---

## 实战避坑

| 现象 | 解法 |
|------|------|
| 中文标题乱码 | 控制字数；Prompt 加 `render exact Chinese characters`；重试 |
| 出现气泡框 | 加 `no speech bubbles, no callout boxes` |
| 背景偏白/偏深 | SCENE 与 STYLE DNA 同时强调 `#F0EDE6` |
| 比例不对 | `尺寸：1024x1365` |
| 504 超时 | 脚本内置重试，通常第 2-3 次成功 |
