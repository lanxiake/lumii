---
name: h3-workflow-designer
description: MiniMax H3 工作流设计、编排与生成执行专家。支持快速验证/普通/高质量三种模式，通过 comfyui-mcp 操作 ComfyUI 工作流。提交前展示所有参数并提出建设性优化建议，等待用户确认后才提交生成。
---

# H3 工作流设计与生成

## 工作原则

1. **必须基于现成模板修改**，禁止从零手写工作流 JSON
2. **先保存到 UI，再提交执行**：`save_workflow` → 确认可见 → `enqueue_workflow`
3. **全程本地 GPU**：只用 `model/conditioning/minimax` 类本地节点，禁止 `partner/video/MiniMax` 在线 API 节点
4. **提交前必须展示参数 + 建议**，用户明确确认后才允许提交

## 完整执行流程（七步）

### 步骤 0：澄清需求

确认：素材类型、内容场景、目标时长、生成模式、画面比例、模型版本（v1/v2）。

### 步骤 1：加载模板工作流

```
get_workflow action:"list"
```
找到匹配的 H3 工作流，优先选：
- **I2VA 竖版人物/真人**：`图生视频-女-自拍-v1.json`（v2 full）
- **T2VA 通用文生视频**：`文生视频-女-跳舞-v1-En .json`
- **多时长切换**：`MiniMax-H3-全能参考-4V10A.json`（实验用，79节点）
- **v1 产品/动画**：`MiniMax-H3-双时钟采样8步-v1-pruned.json`

```
get_workflow action:"get" filename:"<模板名>" format:"api"
```

### 步骤 2：配置参数

在模板基础上只修改以下节点（其余节点和连线保持不动）：

| 节点 | 参数 | 说明 |
|------|------|------|
| `LoadImage` | `image` | 替换为用户提供的图片文件名 |
| `MiniMaxH3ImageToVideo` | `prompt` | 粘贴三段式提示词 |
| `ResolutionSelector` | `megapixels` | 按模式设置：0.15/0.6/0.9-1.0 |
| `ResolutionSelector` | `aspect_ratio` | 竖版 `2:3 Portrait Photo`，横版 `16:9`，方形 `1:1` |
| `PrimitiveFloat` | `value` | 设置时长秒数（5/10/15） |
| `BasicScheduler` | `steps` | 按模式设置：8/20/20 |
| `RandomNoise` / `KSamplerSelect` | `noise_seed` | 设置种子，记录备用 |
| `SaveVideo` | `filename_prefix` | 按模式加后缀：`_fast_`/`_normal_`/`_final_` |

**帧数由模板自带 ComfyMathExpression 自动计算**，只需改 `PrimitiveFloat` value=秒数，不要手动算帧数。

### 步骤 3：🔴 提交前参数展示（必须，不可跳过）

以表格形式向用户展示所有参数，并给出建设性优化建议：

```
📋 生成参数确认

| 参数 | 当前值 | 状态 |
|------|--------|------|
| 模型版本 | v2 full INT8 | ✅ 真人写实推荐 |
| 生成模式 | 快速验证 | ✅ 新内容必须先验证 |
| megapixels | 0.15 | ✅ 快速验证正确 |
| 采样步数 | 8 | ✅ 快速验证正确 |
| 时长 | 15s（帧数 362） | ℹ️ 约10分钟（快速模式） |
| 画面比例 | 2:3 Portrait Photo | ✅ 原图比例，防变形 |
| 噪声种子 | 42 | ℹ️ 已记录，可复现 |
| SaveVideo 前缀 | my_dance_fast_ | ✅ 快速验证标识 |
| SageAttention | 已启用 | ✅ 推荐加速配置 |

💡 优化建议：
1. [示例] 当前为快速验证模式，画质较低——如果动作/提示词已验证满意，下次可升级到普通模式（megapixels=0.6）
2. [示例] 建议在提示词首段确认已锚定参考图外貌，可有效防止主体变形
3. [示例] 如需批量测试不同效果，建议保持当前参数，只换噪声种子出3-5版后再筛选

⚠️ 预计耗时：约 10 分钟
请确认以上参数。输入"确认/可以/OK"后开始生成。
```

**用户确认前，禁止执行 enqueue_workflow。**

### 步骤 4：🔴 保存工作流到 ComfyUI UI

```
save_workflow action:"save" filename:"<描述性名称>.json" workflow:<API格式JSON>
```

然后验证：
```
get_workflow action:"list"
```
确认工作流在列表中可见（用户可在 ComfyUI Workflows 面板打开编辑）。**不可见则不提交**。

### 步骤 5：提交生成

```
enqueue_workflow action:"enqueue" workflow:<同一API JSON>
```

记录返回的 `prompt_id`，告知用户预计耗时（见性能参考表）。

### 步骤 6：轮询等待

```
queue action:"status" prompt_id:<id>
```

- 快速验证模式：每 3 分钟查一次，超时 15 分钟查日志
- 普通/高质量模式：每 5 分钟查一次，超时 45 分钟查日志
- 完成后：`get_history` / `get_image action:"list_outputs"` 取回视频

### 步骤 7：🔴 视频验收（五项检查）

✅ 通过全部 5 项 → 结果满意，交付或升级模式
❌ 有任何一项不通过 → 调用 `h3-quality-optimizer` 诊断

| 检查项 | 问题描述 |
|--------|---------|
| 脸/主体一致性 | 主体外貌与参考图是否一致？ |
| 动作正确性 | 动作是否符合提示词描述？ |
| 口型同步性 | 口型是否与歌词/对话对应？ |
| 情绪匹配性 | 情绪/表情是否符合期望？ |
| 时长正确性 | 视频时长是否为目标秒数？ |

## 三种模式参数一览

| 参数 | 快速验证 | 普通 | 高质量 |
|------|---------|------|-------|
| megapixels | 0.15 | 0.6 | 0.9~1.0 |
| steps | 8 | 20 | 20 |
| 最大时长 | 5/10/15s | 5/10/15s | **≤10s** |
| 比例 | 2:3/16:9/1:1 | 同左 | 同左 |
| prefix 后缀 | `_fast_` | `_normal_` | `_final_` |
| v2 耗时(5s) | ~3-5 分钟 | ~15-20 分钟 | ~15-25 分钟 |
| v2 耗时(10s) | ~5-10 分钟 | ~30-45 分钟 | ~30-60 分钟 |
| v2 耗时(15s) | ~8-15 分钟 | ~50-70 分钟 | ❌ 禁用 |

> 以上基于 RTX 4060Ti 16GB + SageAttention。更大显存（3090/4090）可适当放宽高质量时长。

## 模型版本对应模板

| 模型版本 | 工作流模板 | 特点 |
|---------|-----------|------|
| v1 pruned（19.5G） | `MiniMax-H3-双时钟采样8步-v1-pruned.json` | 产品/动画/卡通，速度快，细节弱 |
| v2 full（34G） | `MiniMax-H3-双时钟采样8步.json` | 真人/写实/文字特写，语义准，细节完整 |
| 实验用（两版本） | `MiniMax-H3-全能参考-4V10A.json` | 79节点，支持一键切 5s/10s/15s |

## 关键参数与注意事项

- **分辨率必须是 32 的倍数**：ResolutionSelector Multiple 保持 32，违反会触发 `patchify_video` 崩溃
- **格式**：SaveVideo `format:"auto"` 即可；VHS_VideoCombine 必须用 `video/h264-mp4`（连字符，不是斜杠）
- **SageAttention 二选一**：`--use-sage-attention` 与 KJ Patch 节点只用一种，勿重复
- **VAE Decode 崩溃**：Decode 前加 VRAM-Cleanup 节点缓解；内存需 ≥32GB
- **首条慢**：第一条特别慢（8-13分钟，JIT 编译预热），第二条起才是真实速度
- **同seed重跑**：秒级完成是缓存命中，非真实生成，抽多版必须换 seed

## 工作流参考示例

见 `references/workflow-reference.md`。
