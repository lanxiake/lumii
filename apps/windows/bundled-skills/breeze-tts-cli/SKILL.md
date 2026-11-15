# Breeze TTS 2 · CLI 技能

快速本地文字转语音。支持文字造音色、音色克隆、情绪指令。

## 安装

```bash
# 技能已在 Lumii 技能库中，无需额外安装
# 前置：Breeze TTS 2 已部署到 E:\ai\breeze-tts（见部署文档）
```

## 快速开始

### 1️⃣ 最简单：文字造音色

```bash
kiro breeze-tts-cli \
  --text "同学们好，今天讲函数的单调性。" \
  --instruction "温和的年轻男老师，清晰、语速适中。" \
  --output ~/Downloads/lesson.wav
```

### 2️⃣ 高级：音色克隆

```bash
kiro breeze-tts-cli \
  --mode clone \
  --text "这道题我讲过三遍了。" \
  --ref-audio teacher_ref.wav \
  --ref-text "参考音频的完整逐字稿，一个字都不能差。" \
  --instruction "声音疲惫，语速很慢。" \
  --output output.wav
```

### 3️⃣ 批量生成

写配置文件 `batch.txt`：
```
文字1 | 指令1
文字2 | 指令2
文字3 | 指令3
```

```bash
kiro breeze-tts-cli --batch batch.txt --output-dir ./outputs
```

## 参数说明

### 通用参数

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `--text` | string | ✅ | 要生成的文字。支持 `[笑]` `[叹气]` 等表情事件 |
| `--instruction` | string | ❌ | Voice Design 的风格指令（英文效果更好） |
| `--output` | path | ✅ | 输出 wav 文件路径 |
| `--cfg-scale` | number | ❌ | 遵循指令的强度，1-10，默认 4 |
| `--seed` | number | ❌ | 随机种子，固定后结果可复现 |

### 克隆模式（`--mode clone`）

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `--ref-audio` | path | ✅ | 参考音频（wav / mp3） |
| `--ref-text` | string | ✅ | 参考音频的**完整逐字稿**（一字不差） |
| `--instruction` | string | ❌ | 可选：改进克隆的语气 |

### 批量模式（`--batch`）

| 参数 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `--batch` | path | ✅ | 批量配置文件（每行：文字 \| 指令） |
| `--output-dir` | path | ✅ | 输出目录 |
| `--parallel` | number | ❌ | 并发数，默认 2（避免显存爆炸） |

## 表情事件

### 中文

```
[笑] [咳嗽] [清嗓子] [叹气] [打喷嚏] [吸气] [呼气]
```

### English

```
(laugh) (cough) (clears_throat) (sigh) (sneeze) (inhale) (exhale)
```

## 常用指令库

### 教学场景

- **讲授**：`"professional teacher explaining clearly and patiently"`
- **强调**：`"emphasizing the key point, speaking slowly and deliberately"`
- **激励**：`"encouraging and uplifting tone, energetic and positive"`
- **示警**：`"warning tone, urgent and serious, speaking quickly"`

### 叙述场景

- **故事**：`"gentle female narrator, warm and poetic, speaking slowly"`
- **新闻**：`"professional news anchor, clear diction, neutral tone"`
- **解说**：`"documentary narrator, knowledgeable and authoritative"`

### 情绪调整

- **疲惫**：`"tired and exhausted voice, very slow speech, monotone"`
- **焦急**：`"anxious and impatient, fast speech, slightly high-pitched"`
- **深思**：`"thoughtful and contemplative, pausing between phrases"`

## 实测数据

| 场景 | 耗时 | 显存 | 音量 |
|---|---|---|---|
| 首次冷启动（含加载7GB权重） | 4m15s | 1.4GB | — |
| 第 1 条新进程 | ~1m | 1.4GB | — |
| 后续同进程 | 秒级 | 1.4GB | — |

**优化建议**：
- 单条：接受 1 分钟延迟
- 批量（>5条）：启动 API 服务（`python -m breeze_infer.api`），每条 <10s

## 输出格式

- **采样率**：24 kHz
- **声道**：单声道
- **格式**：WAV（pcm_s16）
- **典型大小**：每秒 ~47 KB

## 故障排除

### "找不到 Python venv"
确保 `E:\ai\breeze-tts\.venv` 存在：
```bash
cd E:\ai\breeze-tts
python -m venv .venv
pip install -r requirements.txt
```

### "显存不足"
降低 `--cfg-scale` 到 2，或减少 `--parallel` 并发数。

### "音频文件空白 / 静音"
检查 `--ref-text` 是否与 `--ref-audio` 逐字匹配（克隆模式）；检查 `--text` 中文字是否过少。

## 许可

模型权重适用 **BreezeBlue Research and Non-Commercial License**。
自托管生成的音频可用于个人、教学用途；商用需授权。
克隆他人声音需取得本人同意。
