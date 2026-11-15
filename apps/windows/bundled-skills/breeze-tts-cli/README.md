# Breeze TTS CLI 技能

本地快速文字转语音 CLI，支持文字造音色、音色克隆、批量生成。

## 快速导航

- **[SKILL.md](./SKILL.md)** — 完整参数文档 & 指令库
- **[templates/](./templates/)** — 配置文件示例

## 三种用法

### 1. 文字造音色（最常用）

```bash
kiro breeze-tts-cli \
  --text "这是一条演讲稿。" \
  --instruction "professional teacher, clear and patient" \
  --output lesson.wav
```

**场景**：做课件配音、讲解视频、故事配音。

---

### 2. 音色克隆

```bash
kiro breeze-tts-cli \
  --mode clone \
  --text "新的文字。" \
  --ref-audio teacher.wav \
  --ref-text "teacher.wav 对应的完整逐字稿。" \
  --output output.wav
```

**场景**：保持某个人的声音特征，生成新文字。**要求**：
- `--ref-text` 必须与 `--ref-audio` **一字不差**
- 参考音频最好 5-30 秒
- 中文、英文混合最好分开录

---

### 3. 批量生成

新建 `batch.txt`：
```
文字1|指令1
文字2|指令2
文字3|指令3
```

```bash
kiro breeze-tts-cli --batch batch.txt --output-dir ./outputs
```

**场景**：批量课件配音。

---

## 常用指令（复制即用）

### 教学

```
professional teacher, clear diction, patiently explaining
一位严肃认真的教授，字字清晰，充满权威感。
an enthusiastic teacher, energetic and encouraging
```

### 故事

```
gentle female narrator, warm and poetic, very slow
温柔的讲述者，富有诗意，语速缓慢。
dark and mysterious narrator, dramatic
```

### 情绪

```
tired and exhausted, very slow, monotone
疲惫的中年人，语速很慢，无力感。

anxious and urgent, fast speech, high-pitched
焦急的语气，语速快，带有紧迫感。
```

---

## 实测速度

| 场景 | 耗时 |
|---|---|
| 第一条（冷启动） | ~1min |
| 后续每条 | ~1min |
| 批量起 API 服务 | 每条 <10s |

**单条工作**接受 1 分钟。  
**批量生成** >5 条时，建议启动常驻 API：

```bash
cd E:\ai\breeze-tts
python -m breeze_infer.api E:/ai/breeze-tts-2 --port 7860
```

---

## 故障排查

### "模型权重未找到"

```bash
# 确保权重在这里
ls E:\ai\breeze-tts-2\model-00001-of-00002.safetensors
```

如未下载，执行续传脚本：

```bash
bash E:\ai\dl-breeze-model.sh
```

### "venv 异常"

重装：

```bash
cd E:\ai\breeze-tts
rm -rf .venv
python -m venv .venv
pip install -r requirements.txt
```

### "克隆音色失败"

检查 `--ref-text` 是否与音频**逐字匹配**（包括标点）。

---

## 许可

模型权重：BreezeBlue Research and Non-Commercial License  
生成音频：个人 / 教学可用；商用需授权  
克隆声音：需本人同意
