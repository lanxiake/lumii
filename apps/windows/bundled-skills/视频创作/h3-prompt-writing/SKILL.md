---
name: h3-prompt-writing
description: Write MiniMax H3 video generation prompts for T2VA, I2VA, FL2VA, L2VA, and Ref2VA. Use when rewriting multimodal requests into H3 prompt structures, composing integrated_multimodal_description, overall_soundscape, and non_diegetic_music, aligning keyframes, or defining reference labels for images, videos, and audio.
compatibility: Portable to any agent that can read local files — no external API calls, MiniMax Hub tools, or proprietary runtime required. The agents/openai.yaml file only adds optional ChatGPT/Codex UI metadata; it does not restrict the skill to OpenAI agents.
---

# H3 Prompt Writing

## Workflow

1. Identify the input mode: T2VA, I2VA, FL2VA, L2VA, or full-reference Ref2VA.
2. For base text/keyframe modes, read `references/base-en.txt` and follow its final prompt structure.
3. For full-reference mode, read `references/ref-en.txt` and follow its six-section rewrite format.
4. Preserve the exact field names, section order, labels, and timing notation from the selected guide.

## Base Modes

- T2VA: build the full audiovisual timeline from text.
- I2VA: start from the first frame and develop forward from it.
- FL2VA: describe the continuous path between the first and last frames.
- L2VA: infer a plausible opening and converge to the supplied last frame.

Use `integrated_multimodal_description`, `overall_soundscape`, and `non_diegetic_music` in the order shown in `references/base-en.txt`.

## Full-Reference Mode

Ref2VA rewrites use `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, and `non_diegetic_music` in that order. Reference labels stay consistent across all sections.

Read `references/ref-en.txt` for label rules, retention analysis, and complete examples.

## Output Rules

- Write rewrite sections in English; preserve dialogue, lyrics, and visible scene text in their original language.
- Describe each shot by composition, subjects, environment, actions, camera, sound, and the exact point where referenced content appears.
- Avoid plot summaries, unresolved reference labels, and timing that does not match the requested duration.

---

# 虚拟女友项目扩展（3 秒分段时间轴 + 双生成模式）

> 面向「抖音虚拟女友直播」项目（MiniMax H3 本地生成）。当用户提到虚拟女友、唱歌/跳舞/表情动作视频、一镜到底、快速/质量模式时，使用本节规范。

## 1. 3 秒灵活分段时间轴

### 1.1 原则
- **以 3 秒为基准**，允许按动作自然划分（如 2s+4s+3s+3s+3s），总时长精确等于目标时长。
- **一镜到底禁止写 [Shot 2] 硬切标签**，改用连续承接语（"the motion continues naturally" / "the camera holds a static shot" / "she keeps swaying with the beat"）。
- **开始 3 秒必须锚定首帧图**：明确"保持<图片1>中的外貌/服装/位置/姿态"，描述开场动作（看向镜头、微笑、开口）。
- **结束 3 秒必须有收尾锚定**：明确收尾动作 + 表情定格 + 声音收束，防止结尾突兀。
- 每段写四要素：**动作 + 表情 + 声音/歌词 + 镜头状态**。

### 1.2 15 秒一镜到底示例结构

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, phone-front-camera selfie style, the 19-year-old Chinese girl shown in <Picture 1> keeps her appearance, {服装}, loose black long hair, and seat position {位置}, {道具/手势}.
[0s-3s] 首帧锚定段：看向镜头，微笑，开口唱第一句，镜头固定带轻微手持晃动。
[3s-6s] 动作延续段：身体随节奏轻摆，唱第二句，动作自然延续，镜头保持不动。
[6s-9s] 情绪推进段：高音处微微歪头，眼神更亮，镜头极轻推近。
[9s-12s] 副歌起伏段：摆动幅度略增，唱第四句，镜头恢复固定。
[12s-15s] 收尾锚定段：唱完最后一句，害羞低头，放下道具，轻笑声，定格在她看着镜头的微笑。
The bedroom stays consistent throughout: bookshelf with warm lamp on the left, bed with off-white sheets behind her on the right, soft mixed window light from the left, slight natural grain, no cuts, no camera movement except the gentle handheld sway.

overall_soundscape: {环境音 + 动作音 + 非语言人声，1-4 句}

non_diegetic_music: {背景音乐：乐器/速度/节奏/动态，1-3 句}
```

### 1.3 时长-分段速查

| 目标时长 | 帧数(17n+5) | 分段建议 |
|---------|------------|---------|
| 5s | 121 | [0-2s]+[2-5s] |
| 10s | 245 | [0-2s]+[2-5s]+[5-8s]+[8-10s] |
| 15s | 362 | [0-3s]+[3-6s]+[6-9s]+[9-12s]+[12-15s] |
| 20s | 485 | 每段4s×5 |
| 30s | 725 | 每段5s×6 |

帧数公式：`max(5, round(秒*24)) + (5 - (max(5, round(秒*24)) % 17)) % 17`

## 2. 双生成模式

| 参数 | 快速模式（验证） | 质量模式（正式） |
|------|----------------|----------------|
| 用途 | 验证提示词/内容是否符合 | 验证通过后正式出片 |
| ResolutionSelector megapixels | 0.15 | 0.6 |
| BasicScheduler steps | 20 | 20 |
| 画面比例 | 2:3（原图比例） | 2:3（原图比例） |
| SaveVideo filename_prefix | ..._fast_ | ..._final_ |

> **⚠️ 画面比例铁律（2026-08-13）**：一律使用 **2:3 (Portrait Photo)**，禁止 9:16——原图 1024×1536 为 2:3，强制 9:16 会把人物横向拉伸变形。更精确做法：用 `ImageScaleToTotalPixels`+`GetImageSize` 直接读取原图缩放尺寸传给 H3。

> **⚠️ 超高画质限制（2026-08-13）**：megapixels 0.9/1.0 为超高画质，**仅限时长 ≤10s**（约 4-8 分钟/段）；15s 超高画质在 4060Ti 上需 2 小时+，禁止直接使用。**15s 一律用 0.6**（实测约 70 分钟/段，画质 640×960 与原图比例一致）。

**使用原则**：换任何新内容（新动作/新歌词/新图片/新时长）都先跑快速模式，确认内容对了再上质量模式。不要直接跑质量模式——一次 20-30 分钟，内容不对就白等。

## 3. ComfyUI 完整执行流程（六步，带验证节点）

```
步骤0 素材准备: 选定动作图 → 确认动作/歌词/时长 → 确认模式（新内容→快速，已验收→质量）

步骤1 写提示词: 按 3 秒分段写 → 首段锚定首帧图 → 中间段四要素 → 尾段收尾定格
            → 一镜到底用承接语禁止硬切 → 三段式完整（multimodal/soundscape/music）

🔴 验证节点A（提交前强制确认）: 【必须流程，不可跳过】
            → 向用户完整展示：① 输入图片 ② 完整提示词（中文版+英文版）③ 全部参数
            （megapixels/steps/时长/比例/音色/prefix/seed）
            → 用户明确回复"确认/可以/OK"后，才允许进入下一步
            → 用户未确认，禁止 enqueue_workflow 提交生成

步骤2 构建工作流: get_workflow list 找模板（图生视频-女-自拍-v1.json）
            → 改 LoadImage 图片 → 改 prompt → 改 ResolutionSelector（0.15/0.6, 2:3 原图比例）
            → 改 PrimitiveFloat 秒数 → 改 SaveVideo filename_prefix（_fast_/_final_）

🔴 验证节点B（工作流入库）: save_workflow 保存到用户库
            → get_workflow list 确认可见（UI Workflows 面板）
            → 界面不可见不提交——用户需要能在界面打开编辑

步骤3 提交生成: enqueue_workflow → 记录 prompt_id → 告知用户预计耗时

步骤4 等待轮询: 每 3-5 分钟 queue status → 超时（快速15分/质量45分）查日志确认没卡死
            → 完成后 get_history / get_image 取回视频

🔴 验证节点C（视频验收）: 5 项检查——脸一致？动作对？口型对？情绪对？时长对？
            ✅ 通过 → 进入步骤5（质量模式）
            ❌ 动作不对 → 改提示词 → 重跑快速模式
            ❌ 脸不对 → 修/换基准图 → 重跑快速模式

步骤5 质量模式出片: 同一工作流只改两处（megapixels 0.15→0.6、filename_prefix _fast_→_final_）
            → 另存新工作流 → 确认入库 → 提交 → 等待 40-70 分钟（15s 用 0.6；≤10s 才允许 0.9/1.0）

步骤6 交付: 视频发送用户/告知路径 → 汇报参数（分辨率/时长/步数/耗时）→ 用户确认满意
```

- 帧数计算用模板自带 `ComfyMathExpression`（表达式保留），改 `PrimitiveFloat` value=秒数。
- 输出：`SaveVideo` 的 `format:"auto"` 即可；`filename_prefix` 区分 `_fast_`/`_final_`。
- 详细模板见 `references/segment-templates.md`。

## 4. 常用问题速查

| 问题 | 处理 |
|------|------|
| 直接跑质量模式行吗？ | 新内容不建议，先快速模式 5-10 分钟验证 |
| 快速模式脸变了？ | 检查首段是否写"保持<图片1>中的外貌/服装/位置"（锁脸关键），还变就换基准图 |
| 口型对不上歌词？ | 歌词用 `<d>[Chinese] 原文。</d>` 逐字保留 + 写"clear vocals (S1)"音色描述 |
| 一镜到底变多镜头？ | 检查是否误写 [Shot 2] 硬切标签，一镜到底必须用承接语 |
| 怎么判断用哪种模式？ | 内容有变化→快速；内容没变只是要更清晰→质量 |
