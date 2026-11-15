# acestep-music

本地音乐生成技能。用 ACE-Step 1.5 开源模型，从歌词 + 风格描述生成带人声的完整歌曲。

## 装在哪

| 项 | 路径 |
|---|---|
| 技能 | `skills/语音与音频/acestep-music/` |
| 程序 | `E:\ai` |
| 模型 | `E:\ai\checkpoints`（10.09 GB） |
| CLI | `E:\ai\acestep_cli.py` |
| 输出 | `E:\ai\gradio_outputs\` |
| Web 界面 | http://127.0.0.1:7861 |

## 目录

```
acestep-music/
├── SKILL.md                  技能说明（Agent 读这个）
├── README.md                 本文件
└── scripts/
    ├── acestep_cli.py        主 CLI：gen/codes/info/understand/verify
    ├── download_models.py    模型下载（断点续传 + sha256）
    ├── full_song.py          用 reference_audio 生成 120 秒完整歌
    ├── timbre_compare.py     音色相似度测量（MFCC 余弦）
    └── run_ui.sh             起 Web 界面
```

## 怎么用

脚本按 `E:\ai` 为根目录写的，用之前拷过去：

```bash
cp skills/语音与音频/acestep-music/scripts/acestep_cli.py E:/ai/
cd E:/ai
./python_embeded/python.exe acestep_cli.py gen \
  --caption "Upbeat cute pop, bright female vocal, 128 BPM" \
  --lyrics "[Verse]
太阳出来 晃呀晃
[Chorus]
啦啦啦 转个圈" \
  --duration 40 --outdir ./gradio_outputs --rename song.flac
```

## 声音一致性：一句话版

| 要什么 | 用什么 |
|---|---|
| 长歌，音色像参考 | `--ref-audio ref.flac`（0.983） |
| 等长改造，音色必须一样 | `--task cover --src-audio ref.flac`（0.996，锁长度） |
| 同风格多个变体 | `--codes ref.codes.txt` |
| 只要氛围 | 什么都不传，纯 caption |

`--ref-audio` 是「往参考方向拉」，不是钉死音色。风格、BPM、编制越接近参考越稳：
流行 128BPM 是 0.986，跨到民谣 100BPM 掉到 0.888。

## 前置

已装好，无需额外操作。若模型丢失：

```bash
cd E:/ai && python download_models.py --verify
```

## 详细文档

`outputs/ace-step-1.5/安装与实测.md`（868 行）——安装全过程、7 个坑、
16GB 双方案、五组一致性对照、CLI 用法。
