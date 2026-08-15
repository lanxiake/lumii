# 工作流参考示例

真实场景的工作流配置参考，用于理解参数设置思路和节点配置方式。

---

## 示例1：I2VA 抖音竖屏自拍（v2 full，快速验证→普通→高质量升级链）

**场景**：固定角色图片生成5-15秒竖屏生活类视频  
**工作流模板**：`图生视频-女-自拍-v1.json`（或 `MiniMax-H3-双时钟采样8步.json`）

### 快速验证阶段参数

```json
{
  "CLIPLoader": {
    "clip_name": "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    "type": "minimax"
  },
  "UNETLoader": {
    "unet_name": "minimax_h3_fl2va_int8_convrot.safetensors",
    "weight_dtype": "fp8_e4m3fn"
  },
  "VAELoader (video)": {
    "vae_name": "minimax_h3_video_vae_fp16.safetensors"
  },
  "VAELoader (audio)": {
    "vae_name": "minimax_h3_audio_vae_fp32.safetensors"
  },
  "LoadImage": {
    "image": "角色图片.jpg"
  },
  "MiniMaxH3ImageToVideo": {
    "prompt": "integrated_multimodal_description: [Shot 1] ...\noverall_soundscape: ...\nnon_diegetic_music: ..."
  },
  "ResolutionSelector": {
    "megapixels": 0.15,
    "aspect_ratio": "2:3 Portrait Photo"
  },
  "PrimitiveFloat (duration)": {
    "value": 15
  },
  "BasicScheduler": {
    "scheduler": "native_flow",
    "steps": 8
  },
  "RandomNoise": {
    "noise_seed": 42
  },
  "SaveVideo": {
    "filename_prefix": "my_video_fast_",
    "format": "auto"
  }
}
```

### 升级为普通/高质量只改三处

| 阶段 | megapixels | steps | filename_prefix | 最大时长 |
|------|-----------|-------|-----------------|---------|
| 快速验证 | 0.15 | 8 | `_fast_` | 5/10/15s |
| 普通 | 0.6 | 20 | `_normal_` | 5/10/15s |
| 高质量 | 0.9 | 20 | `_final_` | **≤10s** |

---

## 示例2：T2VA 产品广告（v2 full，16:9，普通模式）

**场景**：从文字描述生成产品展示视频，需要文字清晰  
**工作流模板**：`文生视频-女-跳舞-v1-En .json`（MiniMaxH3ImageToVideo 不接 first_frame 即为 T2VA）

关键参数差异：
- `LoadImage`：不接入 `first_frame`（或节点整体绕过）
- `ResolutionSelector.aspect_ratio`：`16:9 Landscape`
- `ResolutionSelector.megapixels`：0.6
- `BasicScheduler.steps`：20
- `PrimitiveFloat.value`：5（产品视频通常5s够用）

---

## 示例3：多时长切换（实验工作流，一键 5s/10s/15s）

**工作流模板**：`MiniMax-H3-全能参考-4V10A.json`（79节点）

特点：
- 内置 `Fast Groups Bypasser` 节点，可一键切换5s/10s/15s
- 视频采样4步 turbo + 音频采样10步（`MultiRateSamplerEXPT8`）
- 适合快速探索多时长效果
- UNET 默认引用 full 模型；如需用 v1 pruned 需手动改 UNETLoader

使用时注意：
- 这是实验性工作流，不作为最终生产首选
- 稳定生产仍推荐 v1/v2 标准工作流

---

## 节点关键参数速查

### ResolutionSelector 宽高结果

| aspect_ratio | megapixels | 实际分辨率 |
|-------------|-----------|----------|
| 2:3 Portrait Photo | 0.15 | ~256×384 |
| 2:3 Portrait Photo | 0.6 | 640×960 |
| 2:3 Portrait Photo | 0.9 | ~784×1168（32倍数）|
| 1:1 Square | 0.4 | 640×640 |
| 16:9 Landscape | 0.4 | ~832×480 |
| 16:9 Landscape | 0.6 | 1024×576 |

### 采样参数组合

| 场景 | scheduler | sampler | steps | 说明 |
|------|-----------|---------|-------|------|
| 标准工作流（推荐） | `native_flow` | `dual_clock_euler` | 8~20 | T8 双时钟采样，官方推荐 |
| 官方模板 | `beta` | `dpmpp_2m` | 20 | 音频质量稳定线 |
| Turbo（v2 脚本） | `native_flow` | `dual_clock_euler` | 4 | 需要额外加载 turbo LoRA |

### 常见错误与修复

| 错误 | 原因 | 修复 |
|------|------|------|
| `patchify_video: shape invalid` | 分辨率不是32的倍数 | ResolutionSelector Multiple 保持 32 |
| `400 Bad Request` | VHS `format` 参数格式错 | 改为 `video/h264-mp4`（连字符） |
| VAE Decode OOM | 显存不足 | Decode 前插 VRAM-Cleanup 节点 |
| `OSError: tmp.pid_xxx` | SageAttention 锁文件 | 手动启动 ComfyUI（不用托管方式） |
| 同参数秒级完成 | ComfyUI 结果缓存 | 换 noise_seed 重跑 |

---

## 抖音系列批量生成参考流程

基于 `scripts/h3_douyin_selfie.py` 的批量逻辑移植到 MCP 工具链：

1. 准备动作列表（每行一个动作描述，3-8个字，具体明确）：
   ```
   整理头发，对镜头微笑
   拿起手机查看消息
   坐在床边伸懒腰
   喝一口水，露出满足表情
   ```
2. 为每个动作使用 h3-prompt-master 生成提示词
3. 全部先跑快速验证（统一用 megapixels=0.15，seed 递增）
4. 筛选动作自然的版本，记录对应 seed
5. 对筛选版本升级到普通/高质量出片
