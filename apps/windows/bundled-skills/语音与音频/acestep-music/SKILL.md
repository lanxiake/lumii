---
name: acestep-music
description: 用本机 ACE-Step 1.5 开源音乐模型生成带人声的完整歌曲。当用户要「生成一首歌」「做段背景音乐」「用这段音频的音色再做一首」「把这首歌改成爵士版」「歌词唱出来」时使用。核心能力是声音一致性：reference_audio 可保持音色并自由定长度，cover 音色最稳但锁死长度。全部本地推理，不上传、不联网、不消耗额度。
version: v1.0（2026-11-10，RTX 4060 Ti 16GB 全量实测 + 五组声音一致性对照）
---

# ACE-Step 1.5 · 本地音乐生成

> **定位：把「歌词 + 风格」变成一首能听的歌，人声是模型直接唱出来的。**
> 不需要 SUNO 那种在线服务，不消耗额度。代价是 16GB 显卡上出曲约 2 倍实时。

## 环境状态

已装在本机，开箱可用：

| 项 | 位置 |
|---|---|
| 程序 | `E:\ai`（Windows 便携包） |
| Python | `E:\ai\python_embeded\python.exe`（3.11.9, torch 2.7.1+cu128） |
| 模型 | `E:\ai\checkpoints`（10.09 GB，4 个组件，已 sha256 校验） |
| CLI | `E:\ai\acestep_cli.py` |
| Web 界面 | `http://127.0.0.1:7861`（7860 被 Breeze TTS 占着） |
| 输出 | `E:\ai\gradio_outputs\` |

```bash
cd E:\ai
./python_embeded/python.exe acestep_cli.py --help
```

---

## 一、声音一致性（最重要，用错会白干）

三种手段效果差很多。同一段 40 秒参考音频实测（MFCC 余弦，1.0 为完全相同）：

| 做法 | 音色余弦 | 歌词 | 长度自由 |
|---|---|---|---|
| 仅 `audio_codes` + 换风格 | 0.811–0.940 | ❌ 会乱 | ✅ |
| `cover` | **0.996** | ✅ | ❌ 锁死源长度 |
| **`reference_audio`** | **0.983** | ✅ | ✅ |

### 要长歌 → 用 `reference_audio`

```python
GenerationParams(
    task_type="text2music",
    reference_audio=r"参考.flac",   # 音色锚点
    duration=120,                   # 长度自己定
    caption="...", lyrics="...",
)
```

它只影响音色和混音底色，不锁结构。实测可从 40 秒参考生成 120 秒新歌，余弦 0.983。

### 但风格别跨太远

同一个参考音频，只改 caption：

| caption | 音色余弦 |
|---|---|
| 接近参考（upbeat cute pop 128BPM） | **0.9860** |
| 跨得远（acoustic folk 100BPM） | 0.8882 |

**规律**：`reference_audio` 是「往参考方向拉」，不是「钉死音色」。
风格、BPM、编制越贴近参考越稳；跨两个大类就明显衰减。

要跨大类又必须保音色，只有 `cover` 能到 0.996，代价是长度锁死。

### 为什么 `audio_codes` 不够

官方原话：codes「隐式包含作曲旋律、配器编排、以及**少许**音色信息」。
那点信息量太小，caption 一换就被盖住。它适合**同风格做变体**，不适合跨风格改造。

### 决策表

| 需求 | 选 |
|---|---|
| 长歌，音色像参考 | `--ref-audio` + 风格贴近参考 |
| 长歌，但换风格大类 | `--ref-audio`，接受 0.88 衰减 |
| 等长改造，音色一模一样 | `--task cover --src-audio` |
| 同风格多个变体 | `--codes` |
| 只要氛围 | 纯 caption |

---

## 二、命令

### 从零生成

```bash
cd E:\ai
./python_embeded/python.exe acestep_cli.py gen \
  --caption "Upbeat cheerful cute pop, bright female vocal, handclaps, ukulele, 128 BPM" \
  --lyrics "[Verse]
太阳出来 晃呀晃
踩着节拍 一起去流浪
[Chorus]
啦啦啦 转个圈
开心就要大声喊" \
  --duration 40 --bpm 128 --steps 8 \
  --outdir ./gradio_outputs/song --rename my.flac
```

### 保音色生成长歌（推荐）

```bash
./python_embeded/python.exe acestep_cli.py gen \
  --ref-audio ref.flac \
  --caption "Upbeat cute pop, bright female vocal, 128 BPM" \
  --lyrics "..." --duration 120 \
  --outdir ./gradio_outputs --rename new.flac
```

### 等长改造

```bash
./python_embeded/python.exe acestep_cli.py gen \
  --task cover --src-audio ref.flac --cover-strength 0.8 \
  --caption "Jazz piano ballad, warm female vocal, 90 BPM" \
  --outdir ./gradio_outputs --rename jazz.flac
```

### 其他子命令

```bash
# 提取语义码
./python_embeded/python.exe acestep_cli.py codes ref.flac -o ref.codes.txt --json

# 分析音频 → caption/歌词/BPM/调性
./python_embeded/python.exe acestep_cli.py understand ref.flac -o meta.json

# 确认真的有人声在唱
./python_embeded/python.exe acestep_cli.py verify out.flac \
  --asr-python "E:/mysoft/conda3/python.exe" --expect "期望歌词"

# 看模型 / 音频信息
./python_embeded/python.exe acestep_cli.py info [audio]
```

---

## 三、参数要点

| 参数 | 说明 |
|---|---|
| `--caption` | 风格描述，**英文更稳**。写风格+情绪+乐器+音色 |
| `--lyrics` | 歌词，**必须带 `[Verse]` `[Chorus]` 段落标签** |
| `--duration` | 10–480 秒（16GB 开 LM 上限 480） |
| `--ref-audio` | 音色参考，保一致性主力 |
| `--codes` | 语义码，同风格变体用 |
| `--task` | text2music / cover / repaint / lego / extract / complete |
| `--steps` | turbo 用 8；base 用 32–64 |
| `--lm-temperature` | 0.85 稳；0.95 有灵性但咬字易糊 |
| `--no-lm` | 跳过 LM 纯 DiT，最快但失去自动编配 |

### 让「欢乐/可爱/动感」到位

- BPM 120–130，128 是甜区
- 必须写 `cute` / `bubbly` / `playful`，只写 `happy` 会变普通励志流行
- 加具体乐器：`handclaps` `ukulele` `glockenspiel` 对可爱感特别有效
- 歌词放拟声词，「啦啦啦」「蹦蹦跳」唱得更跳脱
- 段落标签写全，加 `[Pre-Chorus]` `[Bridge]` `[Outro]` 结构更完整

---

## 四、性能（RTX 4060 Ti 16GB）

| 场景 | 时长 | 耗时 | 实时倍率 |
|---|---|---|---|
| 纯文字 | 30 s | 69 s | 2.31x |
| 纯文字 | 45 s | 106 s | 2.35x |
| reference_audio | 120 s | 106 s | **0.88x** |
| cover（锁长度） | 40 s | 9.6 s | 0.24x |

**瓶颈在 LM 不在 DiT**。45 秒音频出 225 个语义码（秒数 × 5），光这一步 27.7 秒。

提速优先换 `--lm acestep-5Hz-lm-0.6B`，比任何其他优化都见效。

---

## 五、16GB 显存配置（必须懂）

1. **int8 量化 + 常驻 GPU**（界面默认，最优）：DiT 9.4→2.5 GB，VAE 剩 11.95 GB，峰值 12.2 GB
2. **DiT 卸载到 CPU**（脚本兜底）：`--offload`，峰值 15.7 GB，余量薄

⚠️ **不量化又不卸载 = 卡死**。VAE 空闲显存归零后转 CPU 分块解码，
实测卡在 `_tiled_decode_inner` **19 小时**无进展。是死锁，不是慢。

⚠️ **任何时候只跑一个实例**。两个进程抢显存会双双退化到 CPU。

---

## 六、六个任务类型

| 类型 | 作用 | 限制 |
|---|---|---|
| `text2music` | 文本生成，最常用 | — |
| `cover` | 改风格保结构 | **输出长度锁死源音频** |
| `repaint` | 重绘局部时段 | 需 `--repaint-start/end` |
| `lego` | 加单条音轨 | 仅 base 模型 |
| `extract` | 分离单条音轨 | 仅 base 模型 |
| `complete` | 补全不完整作品 | 仅 base 模型 |

---

## 七、坑

1. `--quantize` 必须配 `compile_model`，源码有 assert（CLI 已自动处理）
2. 临时文件别叫 `.part`，程序只检查目录存在，半截文件会被当完整模型，启动即崩
3. `--init_service` 要带值 `true`，裸开关直接报错
4. `torchcodec` 导入失败**不影响出曲**，只影响 LoRA 训练前准备数据集
5. 便携版 `python_embeded` 没 pip，ASR 要用 `--asr-python` 指向 conda 环境

---

## 八、随附脚本

`scripts/` 下都是可用的，需要时拷到 `E:\ai` 跑（脚本按 `E:\ai` 为根目录写的）：

| 脚本 | 用途 |
|---|---|
| `acestep_cli.py` | 主 CLI，五个子命令 |
| `download_models.py` | 模型下载，断点续传 + sha256 |
| `full_song.py` | 用 reference_audio 生成 120 秒完整歌 |
| `timbre_compare.py` | 音色相似度测量（MFCC 余弦，纯 numpy） |
| `run_ui.sh` | 起 Web 界面 |

详细安装与实测记录：`outputs/ace-step-1.5/安装与实测.md`（868 行）
