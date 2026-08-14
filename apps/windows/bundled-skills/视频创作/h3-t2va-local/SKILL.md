# H3 本地文生视频 (T2VA)

使用本地 MiniMax H3 模型（非在线 API）将文字描述生成带音频的视频。

## 核心原则（务必遵守）

1. **必须基于现成模板/工作流修改，禁止从零创建**：先查 ComfyUI 工作流库中已有的 H3 工作流（如 `文生视频-女-跳舞-v1-En .json`、`video_minimax_h3_i2v.json`），用 `get_workflow action:"get"` 取出后在其节点图上改参数，而不是手写全新 API JSON。
2. **先保存到 UI，再提交任务**：任何生成前，先用 `save_workflow action:"save"` 把工作流保存到 ComfyUI 用户库（这样用户在界面 Workflows 面板可见、可打开、可编辑），**然后**才 `enqueue_workflow` 提交执行。用户需要在界面上看到工作流。
3. **全程本地 GPU**：只用 category 含 `model/conditioning/minimax`、`T8/MiniMax H3` 的本地节点；**禁止** `partner/video/MiniMax` 下的在线 API 节点（`MinimaxHailuo03TextToVideoNode` 等）。

## 完整流程

### 阶段 0：查找并加载现成模板（必须先做）

1. **列出工作流库**：`get_workflow action:"list"`，找到 H3 相关的现成工作流。
2. **读取模板**：`get_workflow action:"get"` + `filename` + `format:"api"`，拿到 API 格式的节点图。
3. 环境已知的两个模板：
   - `文生视频-女-跳舞-v1-En .json`：纯文生视频（T2VA），用 `MiniMaxH3ImageToVideo`（不接 first_frame 即 T2VA）、`SamplerCustomAdvanced` + `BasicGuider` + `BasicScheduler` + `KSamplerSelect` + `RandomNoise`、`VAEDecode` + `VAEDecodeAudio`、`CreateVideo` + `SaveVideo`、`ResolutionSelector`、`ComfyMathExpression`（帧数=秒×24 取整到 17n+5 网格）
   - `video_minimax_h3_i2v.json`：图生视频（I2V），模板在 `MiniMaxH3ImageToVideo` 上多了 `first_frame`（来自 `LoadImage`）
4. **在模板基础上修改**：改 `prompt`、分辨率（`ResolutionSelector` 或 width/height）、时长（`PrimitiveFloat` value=秒数）、`noise_seed`、`filename_prefix`（`SaveVideo`），保留其余节点和连线不动。

### 阶段 1：提示词优化

1. **读取 H3 T2VA 规范**：加载本技能 `references/base-en.txt`，获取提示词编写规则（若缺失则从 `h3-prompt-writing` 技能复制）。
2. **按三段式结构重写**：
   - `integrated_multimodal_description`：分 Shot 描述视觉/动作/镜头/对话
   - `overall_soundscape`：1-4 句概括全片环境音和动作音效
   - `non_diegetic_music`：1-3 句描述背景音乐（乐器、速度、节奏、动态变化）
3. **镜头设计**：时长秒数内合理安排 [Shot 1]、[Shot 2]、[Shot 3] 标签，后续 Shot 用严格递增的 `At 00:SS.000` 卡点。
4. **虚拟女友项目专用（一镜到底/分段控制/双模式）**：若任务属于「抖音虚拟女友直播」项目（唱歌/跳舞/表情动作、一镜到底、快速/质量模式），切换到 `h3-prompt-writing` 技能中的「虚拟女友项目扩展」章节：
   - 一镜到底禁止硬切 [Shot 2]，改用 3 秒灵活分段时间轴（[0s-3s] 锚定开场 → 中间段延续/推进 → 收尾段定格）
   - 双模式：快速验证 megapixels=0.15 + 质量正式 megapixels=0.6，steps 均 20，比例 2:3（原图比例，禁止 9:16）
   - 超高画质 megapixels=0.9/1.0 仅限时长 ≤10s
   - 详细模板见 `h3-prompt-writing/references/segment-templates.md`
5. **呈现并确认（必须流程，不可跳过）**：向用户完整展示：① 输入图片/素材 ② 完整提示词（中文版+英文版）③ 全部参数（megapixels/steps/时长/比例/音色/prefix/seed）。**用户明确回复"确认/可以/OK"后，才允许提交生成；用户未确认，禁止 `enqueue_workflow`。**

### 阶段 2：环境检测

提交前确认本地 H3 生成能力（模板已存在时通常已具备，快速核对即可）：

1. **检查模型**：`list_local_models`，确认 `diffusion_models` 有 `minimax_h3_*`、`vae` 有 video+audio 两个 VAE、`text_encoders` 有 `qwen3vl_*_minimax_h3_*`。
2. **检查节点**：`create_workflow action:"node_info"` 搜索 `MiniMaxH3`，确认 `MiniMaxH3ImageToVideo`（原生）或 `MiniMaxH3AudioConditioningT8` 等存在。
3. **检查 VRAM**：`get_system_stats action:"health"` 确认 GPU 显存充足（H3 pruned 模型约需 10GB+ 空闲）。

### 阶段 3：先保存工作流到 UI（用户可见）

用 `save_workflow action:"save"` + `filename`（如 `H3_T2VA_主题.json`）+ 修改后的 API 格式 workflow：
- API 格式会被自动转换为 Web UI 格式，可直接在 ComfyUI 画布打开
- **这一步必须在提交任务之前完成**，并告知用户「工作流已保存，可在界面 Workflows 面板打开」

### 阶段 4：提交与验证

1. **提交**：`enqueue_workflow action:"enqueue"`，传入与保存时一致的 API JSON，记录返回的 `prompt_id`。
2. **格式陷阱**：`VHS_VideoCombine` 的 `format` 必须用枚举值 `video/h264-mp4`（连字符！写成 `video/h264/mp4` 会报 400）；若用模板的 `CreateVideo/SaveVideo` 则 `format:"auto"` 即可。
3. **轮询状态**：`queue action:"status"` + `prompt_id`，间隔 1-2 分钟。
4. **获取输出**：完成后 `get_image action:"list_outputs"` 查找视频文件（模板 SaveVideo 会注册到历史；VHS 可能不注册，需按文件名 `action:"get"` 直接取）。

### 阶段 5：交付

- 将视频文件通过 `message`（mediaUrl）发送给用户，或告知 ComfyUI `output/` 下的路径。
- 汇报关键参数（分辨率、时长、步数、耗时）。

## 性能参考

| 配置 | 采样步数 | 分辨率 | 帧数 | 预计耗时 |
|------|---------|--------|------|---------|
| pruned int8 + Turbo LoRA | 4 | 640×384 | 362 (15s) | ~8 分钟 |
| pruned int8 无 LoRA | 20 | 640×384 | 124 (5s) | ~5 分钟 |
| 完整 int8 无 LoRA | 20 | 640×384 | 124 (5s) | ~10 分钟 |
| pruned int8 质量模式 0.6 (2:3) | 20 | 640×960 | 362 (15s) | ~70 分钟 |

以上基于 RTX 4060 Ti 16GB，DynamicVRAM 模式。**实测（2026-08-13）：0.6 megapixels + 2:3 原图比例（640×960）15s 单段约 70 分钟；0.9 megapixels 15s 需 2 小时+，禁止使用，≤10s 才允许 0.9/1.0。**

## 关键参数速查

- 帧数公式：`max(5, round(秒*24)) + (5 - (max(5, round(秒*24)) % 17)) % 17`（17n+5 网格，如 15s=362）
- 分辨率步长 32；竖版舞蹈/人物建议 2:3（原图比例，禁止 9:16 避免拉伸），通用 16:9
- steps：Turbo LoRA 4 步；无 LoRA 20 步
- sampler/scheduler：原生模板用 `res_multistep`/`simple`；T8 节点用 `dual_clock_euler`/`native_flow`
- cfg：H3 流模型通常 cfg=1.0（BasicGuider 不强制）
- audio：`audio_mode:"native"`（T8）或模板默认即生成音频

## 注意事项

- 提示词必须严格遵循 T2VA 三段式，不可简化为普通 caption
- 362 帧（15s）是 H3 单段极限，更长内容需 LongVideo 分段
- 记录 `noise_seed` 以便复现
- 若 `get_workflow action:"list"` 找不到合适模板，优先用环境已有的 `文生视频-女-跳舞-v1-En .json` 作为基底，仍不要从零手写
