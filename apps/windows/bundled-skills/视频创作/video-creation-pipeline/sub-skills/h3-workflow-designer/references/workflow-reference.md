# 工作流参考示例与节点配置详解

基于真实 JSON 工作流文件提取的完整节点配置，可直接用于 get_workflow + 参数修改。

---

## 一、标准工作流节点清单（v2 full，18个节点）

工作流文件：`MiniMax-H3-双时钟采样8步.json`（v2 真人/写实）和 `MiniMax-H3-双时钟采样8步-v1-pruned.json`（v1 动画/产品）

两个工作流节点结构完全相同，仅 UNETLoader 引用的模型文件不同。

### 完整节点配置表

| 节点ID | 类型 | 关键 widgets_values | 说明 |
|--------|------|---------------------|------|
| 1 | **UNETLoader** | `["minimax_h3_fl2va_int8_convrot.safetensors", "default"]` | v1 改为 `pruned_int8_convrot` |
| 2 | **LoraLoaderBypassModelOnly** | `["minimax_h3_turbo_4步加速_comfyui.safetensors", 1]` | turbo LoRA，v1 不支持（可 bypass） |
| 3 | **CLIPLoader** | `["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "minimax", "default"]` | 文本编码器，固定不改 |
| 4 | **VAELoader（视频）** | `["minimax_h3_video_vae_fp16.safetensors"]` | 固定不改 |
| 5 | **VAELoader（音频）** | `["minimax_h3_audio_vae_fp32.safetensors"]` | 固定不改 |
| 6 | **MiniMaxH3AudioConditioningT8** | 见下方详细说明 | 核心节点：提示词+分辨率+模式 |
| 7 | **MiniMaxH3DualClockSamplerT8** | `[8, 12, 3]` → `[video_steps, audio_steps, shift]` | 采样步数，8步=turbo，20步=标准 |
| 8 | **BasicGuider** | `[]` | 无参数，连接 model + conditioning |
| 9 | **RandomNoise** | `[123456789, "fixed"]` | **修改 seed 以获得不同结果** |
| 10 | **SamplerCustomAdvanced** | `[]` | 无参数，连接 noise+guider+sampler+sigmas+latent |
| 11 | **MiniMaxH3AVDecodeT8** | `[]` | 无参数，解码 latent → 帧序列 + 音频 |
| 12 | **VHS_VideoCombine** | 见下方详细说明 | 输出 MP4 |
| 13 | **LoadImage** | `["10b.jpg", "image"]` | **修改为实际图片文件名**（I2VA 用） |
| 14 | **PrimitiveFloat（时长）** | `[5]` | **修改为目标秒数**（5/10/15） |
| 15 | **ComfyMathExpression（帧数）** | `["max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17"]` | 自动计算，不要手改 |
| 16 | **ResolutionSelector** | `["16:9 (Widescreen)", 0.7, 32]` | **修改比例和 megapixels** |
| 17 | **MiniMaxH3MemoryEfficientSageAttentionPatch** | `[]` | KJNodes SageAttention，固定 |
| 35 | **MarkdownNote** | 分辨率参考表 | 仅注释节点，不影响生成 |

### 节点数据流向

```
UNETLoader(1) → LoraLoader(2) → SageAttnPatch(17) → BasicGuider(8) → SamplerCustom(10)
CLIPLoader(3) ─────────────────────────────────────────┐
VAELoader×2(4,5) ──────────────────────────────────────┤
LoadImage(13) ─────────────────────────────────────────┤→ AudioConditioningT8(6)
ResolutionSelector(16) ────────────────────────────────┤   ↓ positive CONDITIONING → BasicGuider
PrimitiveFloat(14) → ComfyMathExpression(15) ──────────┘   ↓ av_latent LATENT → DualClockSampler(7)

DualClockSampler(7) → BasicGuider(8) → SamplerCustom(10) → AVDecodeT8(11) → VHS_VideoCombine(12)
RandomNoise(9) ─────────────────────────────────────────────────────────────┘
```

---

## 二、核心节点参数详解

### MiniMaxH3AudioConditioningT8（节点6）

这是最重要的节点，控制提示词、分辨率、帧数和生成模式。

**widgets_values 顺序：**
```
[0] prompt          提示词（三段式：integrated_multimodal_description + overall_soundscape + non_diegetic_music）
[1] width           宽度（由 ResolutionSelector 连入，不手动设）
[2] height          高度（由 ResolutionSelector 连入，不手动设）
[3] length          帧数（由 ComfyMathExpression 连入，不手动设）
[4] mode            生成模式：T2VA / I2VA / FL2VA / L2VA / Ref2VA
[5] audio_mode      音频模式：native（原生联合生成，推荐）
[6] 参数6           固定值 1
[7] 参数7           固定值 false
[8] 参数8           固定值 0
[9] 参数9           固定值 true
[10] quality        质量：match / max（max=最高，match=与视频匹配）
[11] preset         官方预设：official_2_to_15s（2-15s 视频标准预设）
```

**实际配置示例（I2VA 竖屏，5s）：**
```json
"widgets_values": [
  "integrated_multimodal_description: [Shot 1] ...\n\noverall_soundscape: ...\n\nnon_diegetic_music: ...",
  640,
  960,
  124,
  "I2VA",
  "native",
  1,
  false,
  0,
  true,
  "match",
  "official_2_to_15s"
]
```

**模式 T2VA vs I2VA 区别：**
- `T2VA`：不接 `first_frame`（LoadImage 节点不连接 ref_image_0）
- `I2VA`：接 `ref_image_0`（LoadImage → MiniMaxH3AudioConditioningT8.ref_images.ref_image_0）

### MiniMaxH3DualClockSamplerT8（节点7）

**widgets_values：**`[video_steps, audio_steps, shift]`

| 模式 | video_steps | audio_steps | shift | 说明 |
|------|------------|-------------|-------|------|
| 快速验证（turbo） | 4 | 4 | 3 | 需要 turbo LoRA |
| 快速验证（无 LoRA） | 8 | 12 | 3 | 推荐快速验证配置 |
| 普通/高质量 | 20 | 20 | 3 | 标准质量 |

> shift=3 为官方推荐，不要修改。

### VHS_VideoCombine（节点12）

**完整 widgets_values（字典格式）：**
```json
{
  "frame_rate": 24,
  "loop_count": 0,
  "filename_prefix": "MiniMaxH3/stable_4v4a",
  "format": "video/h264-mp4",
  "pix_fmt": "yuv420p",
  "crf": 19,
  "save_metadata": true,
  "trim_to_audio": false,
  "pingpong": false,
  "save_output": true
}
```

**⚠️ 格式铁律**：`format` 必须用 `"video/h264-mp4"`（连字符），写成 `"video/h264/mp4"` 会报 400。

修改时只需改 `filename_prefix`，其余保持默认。

### RandomNoise（节点9）

```json
"widgets_values": [123456789, "fixed"]
```
- 第一个值：`noise_seed`，**每次换 seed 才会生成不同结果**
- 第二个值：固定为 `"fixed"`

---

## 三、三种模式参数修改对照表

基于标准工作流，三种模式只需修改以下节点（其余全部保持不变）：

| 节点 | 参数 | 快速验证 | 普通 | 高质量 |
|------|------|---------|------|-------|
| **ResolutionSelector** | megapixels | `0.15` | `0.6` | `0.9~1.0` |
| **ResolutionSelector** | aspect_ratio | 按内容选 | 按内容选 | 按内容选 |
| **MiniMaxH3DualClockSamplerT8** | video_steps | `8` | `20` | `20` |
| **MiniMaxH3DualClockSamplerT8** | audio_steps | `12` | `20` | `20` |
| **PrimitiveFloat** | value（时长） | 5/10/15 | 5/10/15 | **≤10**（硬限制） |
| **VHS_VideoCombine** | filename_prefix | `xxx_fast_` | `xxx_normal_` | `xxx_final_` |
| **RandomNoise** | noise_seed | 42（或随机） | 用快速验证成功的 seed | 用普通模式满意的 seed |

---

## 四、分辨率参照表（来自工作流内置 MarkdownNote）

| megapixels | 比例 16:9 | 比例 2:3（Portrait） | 比例 1:1 |
|-----------|----------|---------------------|---------|
| 0.15 | ~480×272 | ~320×480 | ~384×384 |
| 0.2 | 608×352 | — | — |
| 0.4 | 864×480 | ~512×768 | 640×640 |
| 0.6 | 1056×608 | **640×960** | — |
| 0.7 | 1152×640 | — | — |
| 0.9 | 1280×736 | ~784×1168 | — |
| 0.98 | **1344×768**（H3原生画布） | — | — |
| 1.0 | 1376×768 | — | — |

> 所有分辨率均为 32 的倍数（Multiple=32）。竖版人物固定用 **2:3**，禁止 9:16。

---

## 五、实验工作流说明（MiniMax-H3-全能参考-4V10A.json，79节点）

新增节点类型（对比标准工作流）：
- `MiniMaxH3MultiRateSamplerEXPT8`：视频4步 + 音频10步多速率采样
- `Fast Groups Bypasser (rgthree)`：一键切换 5s/10s/15s 分支
- `UniBlockSwap`：实验性内存优化
- `ReservedVRAMSetter`：显存预留设置
- `LoraLoaderModelOnly`：仅模型 LoRA（不影响 CLIP）
- `LoadAudio`：加载参考音频（用于 Ref2VA 音频引导）
- `PrimitiveStringMultiline`：多行文本节点（存放提示词模板）

**使用时关键参数：**
```
ResolutionSelector: megapixels=0.4, aspect_ratio="16:9 (Widescreen)", multiple=32
VHS_VideoCombine: format="video/h264-mp4", frame_rate=24, crf=19
LoraLoaderModelOnly: "minimax_h3_turbo_4STEPS_comfyui.safetensors", strength=1
MiniMaxH3AudioConditioningT8: mode="T2VA"/"Ref2VA", preset="official_2_to_15s"
```

---

## 六、工作流选择与修改流程（MCP 操作步骤）

```bash
# Step 1: 列出可用工作流
get_workflow action:"list"

# Step 2: 获取 API 格式（可直接修改的格式）
get_workflow action:"get" filename:"MiniMax-H3-双时钟采样8步.json" format:"api"

# Step 3: 修改以下节点的 widgets_values（JSON patch 方式）
# - 节点6 (MiniMaxH3AudioConditioningT8): 修改 widgets_values[0]=提示词, [4]=模式
# - 节点9 (RandomNoise): 修改 widgets_values[0]=seed
# - 节点14 (PrimitiveFloat): 修改 widgets_values[0]=时长秒数
# - 节点16 (ResolutionSelector): 修改 widgets_values[1]=megapixels
# - 节点12 (VHS_VideoCombine): 修改 filename_prefix
# - 节点7 (MiniMaxH3DualClockSamplerT8): 修改 widgets_values[0]=steps（可选）
# - 节点13 (LoadImage): 修改 widgets_values[0]=图片文件名（I2VA 时）

# Step 4: 保存到 ComfyUI UI
save_workflow action:"save" filename:"my_workflow_v1.json" workflow:<修改后的JSON>

# Step 5: 确认可见后提交
get_workflow action:"list"   # 确认出现在列表中
enqueue_workflow action:"enqueue" workflow:<同一JSON>
```

---

## 七、工作流优化策略（基于实测数据）

### 速度优化优先级

| 手段 | 提速倍数 | 建议 |
|------|---------|------|
| PyTorch cu130（官方包自带） | 3-5× | ✅ 必须，不可缺 |
| SageAttention（KJNodes） | 1.5-2× | ✅ 推荐，生产配置 |
| turbo LoRA（4步） | ~2× | ✅ 快速验证用 |
| TE-Speed | 40-50% | ❌ 8步+INT8 实测失真，禁用 |
| EasyCache/HyperStep | 20-60% | ⚠️ 预览可用，成片禁用（可能肢体错乱）|

### 质量 vs 速度平衡

```
快速验证阶段（每条 5-15 分钟）：
  megapixels=0.15 + DualClockSampler steps=8 + turbo LoRA（可选）
  → 一条 15s 视频约 8-15 分钟
  → 用于：所有新内容的第一次验证

普通生产阶段（每条 15-70 分钟）：
  megapixels=0.6 + DualClockSampler steps=20 + SageAttention only
  → 一条 15s 视频约 50-70 分钟（4060Ti + SageOnly）
  → 用于：验证通过后的正式出片

高质量最终成片（每条 30-60 分钟，≤10s）：
  megapixels=0.9~1.0 + steps=20 + SageAttention only
  → 仅用于最终精选成片，时长必须 ≤10s（4060Ti）
  → 3090/4090 等高显存可尝试放宽到 15s（预计 60-90 分钟）
```

### 连续批量生产技巧

1. **一次排队多条**：所有视频排好队再离开，避免等待浪费
2. **第一条不计时**：JIT 编译预热，速度是后续条目的 1.5-2 倍慢
3. **seed 递增**：批量测试用 42、43、44... 递增，便于记录
4. **同 seed 缓存**：重跑前先换 seed，否则会直接命中缓存秒完成

### v1 vs v2 选择指南

| 内容类型 | 推荐模型 | 原因 |
|---------|---------|------|
| 真人视频、写实广告 | v2 full（34G） | 语义准，细节完整，面部正确 |
| 产品文字特写 | v2 full | v1 剪枝会导致文字模糊乱码 |
| 卡通、动画、产品动效 | v1 pruned（19.5G） | 速度快，卡通细节要求低 |
| 快节奏抽卡（>5条/次） | v1 pruned | 约 3-4 分钟/条 vs v2 的 5-6 分钟 |
| 不确定 | v2 full | 默认选更准确的版本 |
| 短剧/多参考角色一致 | Ref2VA（19.5G） | 另一套权重，专用于多参考图驱动 |

---

## 八、短剧与多参考模式节点配置

### 模式对比：FL2VA vs Ref2VA

| 模式 | 权重文件 | 参考输入 | 适用场景 |
|------|---------|---------|---------|
| **I2VA** | `fl2va_int8_convrot` | 首帧图 1 张 | 普通图生视频 |
| **FL2VA** | `fl2va_int8_convrot`（同 I2VA） | 首帧 + 尾帧各 1 张 | 动作连续、镜头衔接 |
| **Ref2VA** | `ref2va_pruned_int8_convrot`（另一套） | 参考图最多 4 张 + 参考音频 | 短剧角色一致性 |

> **重要**：Ref2VA 需要下载独立权重 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（19.5G），与 fl2va 权重不可互换。

---

### FL2VA 首尾帧工作流（镜头衔接）

在标准工作流基础上做如下改动：

**1. 节点1 UNETLoader — 权重文件不变**
```json
"widgets_values": ["minimax_h3_fl2va_int8_convrot.safetensors", "default"]
```
（与 I2VA 相同权重，FL2VA 只是接线方式不同）

**2. 节点6 MiniMaxH3AudioConditioningT8 — 修改 mode**
```json
"widgets_values": [
  "<三段式提示词>",
  640,   "width（ResolutionSelector 连入）"
  960,   "height"
  124,   "length（ComfyMathExpression 连入）"
  "FL2VA",   ← 关键：从 I2VA 改为 FL2VA
  "native",
  1, false, 0, true,
  "match",
  "official_2_to_15s"
]
```

**3. 首帧节点（节点13，原 LoadImage）**
```json
{
  "id": 13,
  "type": "LoadImage",
  "widgets_values": ["shot1_first_frame.jpg", "image"]
}
```
连线：`LoadImage(13).IMAGE → MiniMaxH3AudioConditioningT8(6).first_frame`

**4. 新增尾帧节点（LoadImage，新 ID）**
```json
{
  "id": 18,
  "type": "LoadImage",
  "widgets_values": ["shot1_last_frame.jpg", "image"]
}
```
连线：`LoadImage(18).IMAGE → MiniMaxH3AudioConditioningT8(6).last_frame`

**短剧镜头衔接技巧**：
- 上一个镜头生成完毕后，截取最后一帧 → 保存为 `shot_N_last.jpg`
- 下一个镜头将 `shot_N_last.jpg` 作为 `first_frame` 输入
- 可用 ffmpeg 提取末帧：`ffmpeg -sseof -0.1 -i shotN.mp4 -frames:v 1 shotN_last.jpg`

---

### Ref2VA 多参考工作流（角色一致性）

适用于短剧中需要保持同一角色在多个镜头中外貌一致的场景。

**1. 节点1 UNETLoader — 必须换 Ref2VA 权重**
```json
"widgets_values": ["minimax_h3_ref2va_pruned_int8_convrot.safetensors", "default"]
```

**2. 节点2 LoraLoaderBypassModelOnly — 建议 bypass**
Ref2VA 权重不支持 turbo LoRA，将 bypass 设为 true 或移除 LoRA 节点。

**3. 节点6 MiniMaxH3AudioConditioningT8 — mode 改为 Ref2VA**
```json
"widgets_values": [
  "<三段式提示词（含参考图标签 <Picture 1>、<Picture 2> 等）>",
  640, 960, 124,
  "Ref2VA",   ← 关键
  "native",
  1, false, 0, true,
  "match",
  "official_2_to_15s"
]
```

**4. 参考图节点（最多 4 张，按角色维度准备）**

| 节点ID | 文件 | 推荐内容 | 连线到 |
|--------|------|---------|--------|
| 13 | `char_front.jpg` | 角色正面全身 | `ref_image_0` |
| 18 | `char_side.jpg` | 角色侧面/半身 | `ref_image_1` |
| 19 | `char_closeup.jpg` | 角色面部特写 | `ref_image_2` |
| 20 | `char_outfit.jpg` | 服装细节 | `ref_image_3` |

```json
{
  "id": 13, "type": "LoadImage",
  "widgets_values": ["char_front.jpg", "image"]
},
{
  "id": 18, "type": "LoadImage",
  "widgets_values": ["char_side.jpg", "image"]
},
{
  "id": 19, "type": "LoadImage",
  "widgets_values": ["char_closeup.jpg", "image"]
}
```

连线：
```
LoadImage(13).IMAGE → MiniMaxH3AudioConditioningT8(6).ref_image_0
LoadImage(18).IMAGE → MiniMaxH3AudioConditioningT8(6).ref_image_1
LoadImage(19).IMAGE → MiniMaxH3AudioConditioningT8(6).ref_image_2
```

**5. 可选：参考音频节点（声音风格引导）**
```json
{
  "id": 21, "type": "LoadAudio",
  "widgets_values": ["char_voice_sample.mp3", null, null]
}
```
连线：`LoadAudio(21).AUDIO → MiniMaxH3AudioConditioningT8(6).ref_audio_0`

**6. Ref2VA 提示词中的参考标签写法**
```
integrated_multimodal_description: [Shot 1] <Picture 1> shows the character from the front, wearing a white shirt. She keeps her appearance, hairstyle, and clothing consistent with <Picture 1> and <Picture 2> throughout.
```
- `<Picture 1>` = ref_image_0，`<Picture 2>` = ref_image_1，以此类推
- 在提示词首句中明确引用参考图，防止角色漂移

---

### 短剧批量生成节点修改对照

每个镜头独立保存为不同工作流文件：

| 镜头 | filename_prefix | noise_seed | first_frame / ref | 模式 |
|------|----------------|-----------|-------------------|------|
| 第1镜 | `drama_ep1_shot1_` | 42 | 人物参考图 | Ref2VA |
| 第2镜 | `drama_ep1_shot2_` | 43 | shot1 末帧 | FL2VA |
| 第3镜 | `drama_ep1_shot3_` | 44 | shot2 末帧 | FL2VA |
| 结尾 | `drama_ep1_end_` | 45 | 人物参考图 | Ref2VA |

> 策略：开场和关键情感节点用 Ref2VA 锚定外貌；中间连续动作镜头用 FL2VA 保持画面流畅衔接。
