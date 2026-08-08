# Qwen3-TTS 本地推理加速笔记（CUDA Graph）

> 学习 / 复盘文档。记录 2026-08-08 前后把本地语音合成从「明显慢于实时」优化到「可边出边播、约 2× 实时」的过程与结论。  
> 相关实现计划见 [2026-08-07-qwen3-tts-implementation.md](./2026-08-07-qwen3-tts-implementation.md)。

**环境：** Windows + RTX 4060 Ti + 内置 `python-embed`（`torch 2.5.1+cu121`）+ `Qwen3-TTS-12Hz-0.6B-CustomVoice`  
**效果：** 用户反馈「效果很好」；实测整段合成从约 21s → 约 1.4s（非流式），流式首包约 2.9s。

---

## 1. 问题现象

设置页预览 / 对话 TTS 在 GPU 已启用（bf16）时仍明显偏慢：

- 短句「你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。。」整段要 **~20s+** 才出声
- 官方宣传的「约 97ms 端到端」与本地体感差一个数量级
- 已做句级切分流式，但首段仍要等完整 `generate`，体感改善有限

---

## 2. 排查路径（哪些没用 / 哪些有用）

### 2.1 魔搭「更小量化模型」——没有可直接替换的卡

| 结论 | 说明 |
|------|------|
| 官方最小就是 0.6B CustomVoice | 魔搭上无 INT8/GPTQ/AWQ/FP8 的 PyTorch 权重卡可替换当前 sidecar |
| 社区 GGUF 在 HF 为主 | 需 llama.cpp / CrispASR 等另一套运行时，不能丢进现有 `qwen_tts` |
| 量化≠加速（对本卡） | 0.6B Talker 已较小；瓶颈在 Code Predictor 的高频自回归 |

**教训：** 先确认「下载更小权重」是否真的接到当前推理栈；否则只是换文件，链路不变。

### 2.2 注意力实现与采样参数——收益可忽略

同机对比（预热后）：

- `eager` vs `sdpa`：RTF 接近（约 6.5 量级），**sdpa 未明显快于 eager**
- `do_sample=False`（greedy）：几乎无加速
- `torch.compile(talker)`：几乎无加速

**教训：** 在「外层仍是 HuggingFace `generate` + 每帧嵌套 Code Predictor `generate`」时，换 attn / 采样 / 局部 compile 捅不动主瓶颈。

### 2.3 Profiler：瓶颈在哪里

官方路径 `torch.profiler`（一句预览文本）要点：

- 权重确在 **`cuda:0` / bfloat16**，不是「其实在跑 CPU」
- Decode（speech tokenizer）相对便宜；**绝大部分时间在 AR generate**
- CUDA 热点是海量 `aten::linear` / `aten::matmul`（上万次调用）
- 对应实现：每个 codec 帧里 Talker forward 再调一次 `code_predictor.generate`（约 15 步 AR）

另测拆分计时（官方路径，预热后）：

| 阶段 | 「你好，」 | 整句预览 |
|------|-----------|----------|
| `model.generate` | ~7s | ~25s |
| `speech_tokenizer.decode` | ~0.1s | ~0.1s |

**教训：** 优化方向应是「缩短 AR 调度开销 + 真流式出 PCM」，而不是抠 decode 或再切一两句文本。

---

## 3. 有效方案：`faster-qwen3-tts`（CUDA Graph）

社区包 [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts)（PyPI `>=0.3.2`）：

- 用 `StaticCache` + **`torch.cuda.CUDAGraph`** 吃掉 Python / kernel launch 开销
- **不依赖 FlashAttention**（Windows 上装 FA2 成本高）
- 提供 **帧级流式** API：`generate_custom_voice_streaming` / `generate_voice_clone_streaming`
- 官方 README 在 **RTX 4060（Windows）** 上相对 baseline 有约一个数量级的 RTF / TTFA 改善（定义：RTF>1 为快于实时）

本机实测（0.6B CustomVoice，CUDA，预热后）：

| 指标 | 官方 `qwen_tts` | `faster-qwen3-tts` |
|------|-----------------|---------------------|
| 整段「你好，我叫 Lumii。I’m your best partner，是你的最佳伙伴呀。。」 | ~21s | **~1.4s**（非流式） |
| 流式首包 TTFA（chunk_size=4） | ≈整段结束 | **~2.9s** |
| 流式整段边出边播 | — | **~7s** 播完约 2.5s+ 音频量级 |
| 吞吐（非流式） | ~0.15× 实时 | **~2× 实时** |

短句「你好，」流式 TTFA 可到约 **0.4s**（库内直接测；经 sidecar 还有 IPC 开销）。

---

## 4. 产品侧落地方式

### 4.1 Sidecar 双后端

文件：

- `apps/windows/src/main/voice/qwen3_tts_sidecar.py`（主源）
- `apps/windows/assets/scripts/qwen3_tts_sidecar.py`（打包副本，**必须同步**）

策略：

1. CUDA 且 `preferFaster=true` → 优先 `FasterQwen3TTS.from_pretrained` + `warmup(prefill_len=64)` 捕获 Graph  
2. 失败 → 回退官方 `Qwen3TTSModel`（eager / 可选 FA2）+ 句级切分流式  
3. `synthesize_stream`：  
   - **faster**：帧级流式（`chunk_size` 默认 4，约 333ms 音频/包）——**不要**再按句切分（每段会重新 prefill，首包反而变差）  
   - **stock**：保留句级切分，缩短「整段等完」的体感  

### 4.2 客户端依赖与加载

文件：`apps/windows/src/main/voice/qwen3-tts-client.ts`

- `installQwenDeps` / `ensureFasterQwen3Tts`：安装或补装 `faster-qwen3-tts>=0.3.2`
- 已有 CUDA 运行时 early-return 时也会补装 faster
- `load` 传入 `preferFaster: true`；`loadedKey` 含 `faster-v1`，避免旧进程被误判已加载
- UI 状态可显示 `CUDA Graph`（`backend === 'faster'`）

### 4.3 播放链路（不变）

`Qwen3Tts.synthesize` → `synthesizeStream` → 每段 PCM `onChunk` → 边播边合。  
后端从「句级」升级到「帧级」后，同一条播放管线自动受益。

---

## 5. 关键设计取舍

1. **句级流式 vs 帧级流式**  
   - 官方整段 `generate`：句级切分有价值（缩短 TTFA）  
   - CUDA Graph 帧级流式：整段一次 generate + 中途 yield；再切句会重复 prefill（本机 prefill 曾到 ~1.7s），**有害**

2. **首次 load 变慢是预期**  
   - `warmup` 要捕获 predictor / talker Graph（数秒）  
   - 换来的是后续请求数量级加速；状态文案应写清「含 CUDA Graph 预热」

3. **CPU 路径不走 faster**  
   - Graph 方案面向 NVIDIA CUDA；CPU 继续官方路径即可

4. **sidecar 双文件同步**  
   - 开发态 `resolveSidecarScript` 优先 `src/main/voice/`  
   - 打包仍读 assets；改 sidecar 必须同步，否则会 silently 用旧逻辑（曾踩过 float16 / 未同步脚本）

---

## 6. 可复用的排查清单（以后同类「本地大模型慢」）

1. 确认设备与 dtype（真在 GPU？bf16 还是误用 fp16 炸 CUDA？）  
2. 拆 `generate` vs `decode` 计时，别先优化非热点  
3. Profiler 看调用次数：上万次 tiny gemm → 怀疑 Python AR 调度 / 嵌套 generate  
4. 先搜社区是否已有 **同模型的 CUDA Graph / 静态 cache / 专用 runtime**，再自研量化  
5. 「更小量化权重」要同时回答：格式、运行时、是否破坏现有 API  
6. 流式策略要匹配后端：整段 AR 用帧级；无流式 API 才用句级降 TTFA  
7. 预热与常驻进程：把 Graph capture / kernel 编译从「用户第一次说话」挪到 load

---

## 7. 关键路径速查

| 路径 | 职责 |
|------|------|
| `apps/windows/src/main/voice/qwen3_tts_sidecar.py` | JSON-RPC；faster / stock 双后端 |
| `apps/windows/assets/scripts/qwen3_tts_sidecar.py` | 打包副本 |
| `apps/windows/src/main/voice/qwen3-tts-client.ts` | 启停 sidecar、装依赖、RPC |
| `apps/windows/src/main/voice/tts-engine.ts` | `Qwen3Tts` 流式播放适配 |
| `~/.lumii/runtimes/python-embed` | 隔离 Python（勿混 conda） |
| `~/.lumii/models/voice/tts/qwen3/` | 本地模型与 tokenizer |

依赖：

```text
qwen-tts
faster-qwen3-tts>=0.3.2
torch==2.5.1+cu121（或同系列 CUDA 轮）
transformers==4.57.3
```

---

## 8. 后续可选项（未做）

- 进一步压 TTFA：调小 `chunk_size`、load 后后台 keep-alive、设置页进入即预热  
- Windows 上尝试可用的 FlashAttention 轮（非必须；faster 路径已不依赖）  
- GGUF / qwentts.cpp 作为另一档「极限体积 / Vulkan」后端（集成成本高）  
- 把 RTF / TTFA 做成设置页或日志里的常驻指标，便于回归

---

## 9. 一句话总结

**慢的本质是官方 Python AR 调度，不是「模型文件太大」；在 4060 Ti 上，用 `faster-qwen3-tts` 的 CUDA Graph + 帧级流式，比换量化权重或换 SDPA 有效得多。**
