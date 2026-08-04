---
name: compose-douyin-video
description: 将多张竖版图片合成为抖音可用的 1080x1920 MP4 幻灯片视频。依赖本机 ffmpeg。用于图集转视频、知识卡片轮播。触发词：图转视频、图片合成视频、抖音幻灯片视频。
---

# 图集合成抖音视频

把有序图片合成为竖版 H.264 MP4，供 `post-to-douyin fill-video` 或 `douyin-upload upload-video` 使用。

## 前置条件

- 本机已安装 **ffmpeg** 且在 PATH 中
- 输入图片为 PNG/JPG/WebP，建议已按 9:16 生成（`douyin-images`）

## 命令

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video.py `
  --images "<笔记目录>/images/01-cover.png" "<笔记目录>/images/02-point-1.png" "<笔记目录>/images/03-summary.png" `
  --output "<笔记目录>/video/final.mp4" `
  --seconds 2.8
```

可选背景音乐：

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video.py `
  --images ... `
  --output "<笔记目录>/video/final.mp4" `
  --seconds 2.8 `
  --audio "<路径>/bgm.mp3"
```

## 参数说明

| 参数 | 说明 | 默认 |
|------|------|------|
| `--images` | 有序图片路径（至少 1 张） | 必填 |
| `--output` | 输出 MP4 路径 | 必填 |
| `--seconds` | 每张图停留秒数 | 2.8 |
| `--audio` | 可选背景音乐 | 无 |

输出规格：1080×1920、30fps、yuv420p，适合抖音上传。

## 配音合成（推荐）

每张分镜独立口播，时长随配音自动对齐：

1. 在 `video/narration.json` 编写分镜口播（见下方格式）
2. 一键生成配音 + 竖版 MP4：

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video_with_voice.py `
  --narration "<笔记目录>/video/narration.json" `
  --output "<笔记目录>/video/final.mp4"
```

依赖：`edge-tts`（`python -m pip install edge-tts mutagen`）、ffmpeg（PATH 或 `imageio-ffmpeg`）。

`narration.json` 示例：

```json
{
  "voice": "zh-CN-YunxiNeural",
  "rate": "+10%",
  "segments": [
    { "segment_id": "S01", "image": "../images/01-cover.png", "text": "钩子口播..." }
  ]
}
```

仅重新合成（跳过 TTS）：加 `--skip-tts`。

## 典型工作流

```text
douyin-images 生成 images/*.png
    → narration.json 分镜口播
    → compose_douyin_video_with_voice 合成 video/final.mp4（含配音）
    → post-to-douyin fill-video（或 douyin-upload upload-video）
```

无配音时仍可用 `compose_douyin_video.py`（固定每张停留秒数 + 可选 BGM）。

合成完成后更新 `00-series-outline.md` 为「已剪辑」。
