---
name: video-creation-pipeline
description: MiniMax H3 本地视频创作全流程编排技能。当用户要生成视频、制作短视频、图片转视频、优化视频提示词、剪辑合成视频时使用。依赖 comfyui-mcp 与本地 ComfyUI 通信，全程本地 GPU，无需外部 API。
---

# MiniMax H3 视频创作全流程

## 核心能力一览

| 能力 | 子技能 | 适用场景 |
|------|--------|---------|
| 提示词编写与优化 | `h3-prompt-master` | 编写/改写/诊断 H3 三段式提示词 |
| 工作流设计与生成 | `h3-workflow-designer` | 配置工作流参数、三模式生成 |
| 生成结果迭代优化 | `h3-quality-optimizer` | 结果不满意时诊断问题并改进 |
| 视频剪辑合成 | `h3-video-editor` | 剪切/拼接/加音/叠图/格式转换 |

## 前置环境（必须满足）

1. **ComfyUI 已本地启动**：`http://127.0.0.1:8188`，comfyui-mcp 已连接
2. **模型文件已就位**（二选一模型 + 公共组件）：

| 文件 | 大小 | 路径 |
|------|------|------|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（v1 剪枝版） | 19.5G | `models/diffusion_models/` |
| `minimax_h3_fl2va_int8_convrot.safetensors`（v2 完整版） | 34G | `models/diffusion_models/` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14.6G | `models/text_encoders/` |
| `minimax_h3_video_vae_fp16.safetensors` | 4.85G | `models/vae/` |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.56G | `models/vae/` |

3. **SageAttention 已安装**：KJNodes `PatchSageAttentionKJ` 节点（勿与 `--use-sage-attention` 同时使用）
4. **硬件要求**：显存 ≥16GB，内存 ≥32GB（推荐 64GB）

## 模型版本决策

```
目标内容是真人/写实/产品文字特写？
  ✅ 是 → v2 full INT8（34GB），SageAttention only
  ❌ 否 → 是产品视频/卡通/动画/快节奏抽卡？
        ✅ 是 → v1 pruned INT8（19.5GB），速度更快，细节弱
        ❓ 不确定 → 默认 v2（语义准、细节完整）
```

**注意**：v1 不支持 turbo LoRA；v2 支持 turbo（脚本链），JSON 工作流需手动加 LoRA 节点。

## 三种生成模式

| 模式 | megapixels | 步数 | 最大时长 | 预计耗时(15s·v2) | 用途 |
|------|-----------|------|---------|----------------|------|
| **快速验证** | 0.15 | 8 | 5/10/15s | ~5-15 分钟 | 验证提示词/内容是否符合预期 |
| **普通** | 0.6 | 20 | 5/10/15s | ~50-70 分钟 | 一般生产，质量与速度平衡 |
| **高质量** | 0.9~1.0 | 20 | **≤10s 硬限制** | ~30-60 分钟 | 最终精选成片 |

> **铁律**：任何新内容（新提示词/新图/新动作/新时长）必须先快速验证，确认内容对再升级模式。  
> **高质量时长限制**：4060Ti 实测 15s+0.9mp≈2小时+；显存更大（3090/4090）可视情放宽。

## 标准工作流（四阶段）

```
阶段 1  澄清需求
  → 素材类型：T2VA（文生）/ I2VA（图生）/ FL2VA（首尾帧）/ Ref2VA（全参考）
  → 内容场景：真人写实 / 产品广告 / 动画卡通 / 抖音竖屏
  → 目标时长：5s / 10s / 15s
  → 生成模式：快速验证 / 普通 / 高质量
  → 画面比例：2:3 竖版人物 / 16:9 通用横屏 / 1:1 方形
  信息充足时不重复询问，直接进入阶段 2

阶段 2  提示词（h3-prompt-master）
  → 编写三段式：integrated_multimodal_description / overall_soundscape / non_diegetic_music
  → 一镜到底：3 秒分段 + 四要素（动作/表情/声音/镜头）逐段检查
  → 向用户展示中英文提示词，等待明确确认

阶段 3  工作流设计与生成（h3-workflow-designer）
  → 加载模板 → 配置三模式参数
  → 展示所有参数并提出建设性优化建议，等待用户确认
  → 保存到 ComfyUI UI → 提交生成 → 轮询 → 取回视频

阶段 4a  结果满意 → h3-video-editor 剪辑合成，交付
阶段 4b  结果不满意 → h3-quality-optimizer 诊断问题 → 回到阶段 2/3 迭代
```

## 场景路由

| 用户说 | 直接路由 |
|--------|---------|
| "帮我生成视频" / "文生视频" / "图生视频" | 全流程（阶段1→4） |
| "帮我写提示词" / "优化提示词" | h3-prompt-master |
| "调整参数" / "换分辨率" / "换时长" | h3-workflow-designer |
| "视频不满意" / "脸变了" / "动作不对" / "音频有问题" | h3-quality-optimizer |
| "剪切视频" / "拼接" / "加背景音乐" | h3-video-editor |
| "快速出一个看看" | 快速验证模式，h3-workflow-designer |
| "批量出几个版本" | 批量生成引导（见下） |

## 批量生成引导

同一内容跑多个 seed 版本时：
1. 快速验证确认提示词正确后，**保持同一模式**，换 seed 多跑 3-5 版
2. 每次提交记录 `noise_seed`，便于复现优质结果
3. 从多版中筛选最佳，再升级普通/高质量出片
4. 同 seed 同参数重跑会命中 ComfyUI 缓存（秒级完成，非真实生成），抽多版必须换 seed

## 首次运行预期

- **第一条视频特别慢**（8-13 分钟）：Sage/Triton JIT 编译 + 模型首次载入预热
- **第二条起才是真实速度**：约 5 分钟/条（v2 full + SageOnly，640×640，5s）
- **连续生产效率最高**：一次性排队多条，从第二条起正常速度

## 输出文件命名约定

```
ComfyUI/output/
├── <主题>_fast_00001_.mp4      ← 快速验证版
├── <主题>_normal_00001_.mp4    ← 普通模式版
└── <主题>_final_00001_.mp4     ← 高质量版（最终成片）
```
