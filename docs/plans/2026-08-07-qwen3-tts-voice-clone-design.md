# Qwen3-TTS 本地合成与声音克隆（2026-08-07）

## 背景

启动 Splash / 语音设置下载（见 `2026-08-07-splash-and-voice-settings-design.md`）已落地 VAD / ASR / VITS 分项下载。后续需接入官方 **Qwen3-TTS**，支持本地语音合成与 3 秒声音克隆，并按机器配置提供多挡模型；下载优先国内 **魔搭（ModelScope）**。

当前通话 TTS 仅有 `local-vits`（sherpa-onnx）与 `edge`（联网）。扩展挂点：`TtsProvider` / `createTtsProvider`、`MODEL_CATALOG`、`VoiceTtsConfig.provider`、设置页语音面板。

## 目标与非目标

### 目标

- 用户可选下载 Qwen3-TTS 模型变体，与 VITS / Edge 并列切换
- 支持合成 + 基于参考音频的声音克隆（Base 模型）
- 三挡规格适配不同机器；**一期只落地标准档 `0.6B-Base`**
- 下载源默认魔搭；模型与克隆档案存入**用户数据根目录**（`resolveWindowsClientDataRoot()`，即 `~/.lumii` 或 `LUMII_CLIENT_DATA_DIR`）
- 语言能力跟官方模型走（10 语等），产品侧不裁剪

### 非目标（一期）

- 按语言拆包 / 自训中英专用权重
- VoiceDesign 作为主路径
- 替换现有 VAD / ASR
- 一期即迁 ONNX / sherpa-onnx（列为二期）

## 调研摘要

| 项 | 结论 |
|----|------|
| 官方系列 | `Qwen3-TTS-12Hz-{0.6B\|1.7B}-{CustomVoice\|Base}` + `1.7B-VoiceDesign` + 共用 `Tokenizer-12Hz` |
| 克隆 | **Base**：约 3 秒参考音 + `ref_text`（ICL）；可选 x-vector only（质量较差） |
| 体积 | 0.6B ≈ 2.5GB；1.7B ≈ 4.5GB+（另计 Tokenizer） |
| 语言拆包 | 权重共享，**无法**靠删语言明显缩小；词表裁剪/量化是另一路径，一期不做 |
| 国内源 | 魔搭 `Qwen/Qwen3-TTS-*` |
| 运行时 | 官方 `qwen-tts`（Python/PyTorch，偏 GPU）；社区 ONNX/sherpa 可 CPU 但 RTF 偏高 |

## 三挡定位

| 挡位 | 模型 | 约体积 | 目标机器 | 分期 |
|------|------|--------|----------|------|
| 轻量 | `0.6B-Base` 量化（如 INT8） | 更小（二期标定） | 低配 / 内存紧张 | 二期 |
| **标准（默认）** | `Qwen3-TTS-12Hz-0.6B-Base` | ~2.5GB | 多数用户 | **一期** |
| 高质 | `Qwen3-TTS-12Hz-1.7B-Base` | ~4.5GB+ | 显存 ≥6–8GB | 二期下载与切换 |

Tokenizer-12Hz 各挡共用，只下载一次。无 GPU / 不愿下大模型时继续用 Edge 或 VITS。

## 架构

### 进程边界

```
设置页 / 通话 UI
    │ IPC (voice:*)
    ▼
main: VoiceCallService + Qwen3Tts (TtsProvider)
    │ 本地 RPC / stdio
    ▼
Python sidecar (qwen-tts)
    │ 只读本地权重路径
    ▼
{clientDataRoot}/models/voice/tts/qwen3/...
```

- 主进程新增 `Qwen3Tts`，实现现有 `TtsProvider`（`initialize` / `synthesize` / 销毁）
- Sidecar 使用**已下载本地目录**加载，禁止首次推理时联网拉模
- 输出建议 24kHz PCM/WAV，经现有 `voice:audio:chunk` 回渲染层
- Sidecar 不可用时提示用户，并允许切回 Edge / VITS

### Provider 配置

扩展 `VoiceTtsConfig`（示意）：

- `provider`: `'edge' | 'local-vits' | 'qwen3'`
- `qwen3Variant`: `'0.6b-base' | '1.7b-base'`（一期 UI 可只露出已实现项）
- `qwen3ProfileId?: string` — 当前克隆音色
- `language?: string` — 跟模型 `get_supported_languages()` / 官方列表；支持 `Auto`
- 现有 `speed` / `volume` 继续映射

## 下载与存储

### 数据根

统一使用 `resolveWindowsClientDataRoot()`，**不要**再写入 `app.getPath('userData')/models/voice`（现有 VAD/ASR/VITS 若仍在 userData，可另开迁移任务；**新建 Qwen3 路径必须落在 clientDataRoot**）。

建议布局：

```
{clientDataRoot}/
  models/voice/
    tts/qwen3/
      tokenizer-12hz/
      0.6b-base/
      1.7b-base/          # 二期
  voice/profiles/<profileId>/
    ref.wav
    meta.json
    prompt/               # 可选：缓存 create_voice_clone_prompt 产物
```

### Catalog（魔搭优先）

| id | 魔搭模型 ID（示例） | 说明 |
|----|---------------------|------|
| `tts-qwen3-tokenizer-12hz` | `Qwen/Qwen3-TTS-Tokenizer-12Hz` | 共用，先下 |
| `tts-qwen3-0.6b-base` | `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 标准档，一期 |
| `tts-qwen3-1.7b-base` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 高质，二期 |

- 下载：默认 ModelScope（SDK 或解析后的 CDN URL + 现有 HTTP Range / `.partial`）
- Hugging Face 仅作可选备用源
- `VoiceModelsPanel` 按 catalog 分项：进度、暂停、继续、取消
- 下载前按变体预估体积做磁盘空间校验

### 就绪规则

选 `provider === 'qwen3'` 且 `qwen3Variant === '0.6b-base'` 时需：

1. Tokenizer 目录完整  
2. `0.6b-base` 目录完整  
3. Sidecar 自检通过（可缓存）

克隆通话另需有效 `qwen3ProfileId`（或当次临时参考音）。未就绪：toast「请先在设置中下载语音模型 / 创建音色」+「去设置」。

## 声音克隆 UX

设置 → 语音设置 → **我的音色**（新建）：

1. 上传或录制参考音频（建议 ≥3s，清晰人声；过短/过噪则拦截）  
2. 填写 `ref_text`，或调用现有试麦 ASR 填入（ICL 必填）  
3. 可选：生成并缓存 `voice_clone_prompt`  
4. 预览合成一句 → 保存 `meta.json`（名称、语言、创建时间、模式、关联 variant）

通话 / 预览：选中 profile 后复用 prompt，避免每句重抽特征。

官方 API 对应：`create_voice_clone_prompt` + `generate_voice_clone`（`x_vector_only_mode=false` 为默认推荐）。

## 错误与降级

| 场景 | 行为 |
|------|------|
| 魔搭失败 / 中断 | 暂停续传；提示网络或换备用源 |
| 磁盘不足 | 下载前拒绝并提示所需空间 |
| OOM / 无 GPU | 明确文案；建议 Edge / VITS 或二期轻量档 |
| Sidecar 崩溃 | 销毁后重试一次；仍失败则本次禁用 qwen3 |
| 缺 ref_text（ICL） | 阻止保存克隆档案 |

## 分期与验收

### 一期

- [x] Catalog + 魔搭下载 Tokenizer + `0.6B-Base` → `clientDataRoot`
- [x] `provider: 'qwen3'` + Python sidecar 合成
- [x] 设置页克隆档案 CRUD + 预览
- [x] 与 Edge / VITS 并列切换；缺模型引导
- [x] 语言：模型支持的全部可用（含 Auto）

> 实现说明见 `2026-08-07-qwen3-tts-implementation.md`。端到端需本机安装 `qwen-tts` 并实际下载模型后验证。

### 二期

- [ ] `1.7B-Base` 下载与切换
- [ ] 可选 INT8 轻量档
- [ ] CustomVoice / instruct（可选）
- [ ] 评估迁 ONNX / sherpa-onnx
- [ ] （可选）将旧 VAD/ASR/VITS 目录迁到同一 `clientDataRoot`

### 一期验收

1. 仅标准档即可：下载 → 选 Qwen3 → 创建克隆音色 → 预览/通话出声  
2. 模型与 profile 均在用户数据根下  
3. 未就绪引导正确；可回退 Edge / VITS  

## 关键改动面（实现时）

- `model-manager.ts` — catalog、魔搭源、`clientDataRoot` 路径  
- `tts-engine.ts` / `voice-service.ts` — `Qwen3Tts`、sidecar 生命周期  
- `voice-events.ts` / `voice-commands.ts` / `voice-ipc.ts` / preload — 配置与克隆 IPC  
- `VoiceModelsPanel` / `SettingsPage` — 下载项、provider、变体、音色管理  
- 打包：sidecar 依赖与 `electron-builder` 资源（Python 环境策略与现有 embed 对齐或隔离 venv）  
- 文档：更新 README / `.env.example` 中语音模型路径说明（以代码 `~/.lumii` 为准）

## 已确认决策

1. 下载源：魔搭优先  
2. 一期模型：官方完整 `0.6B-Base`，不按语言拆包  
3. 语言：不限制，有哪些用哪些  
4. 存储：用户指定数据根（`LUMII_CLIENT_DATA_DIR` / `~/.lumii`）  
5. 运行时：一期 Python sidecar + 官方 `qwen-tts`；ONNX 二期  
6. 三挡：轻量（量化，二期）/ 标准 0.6B（一期）/ 高质 1.7B（二期）
