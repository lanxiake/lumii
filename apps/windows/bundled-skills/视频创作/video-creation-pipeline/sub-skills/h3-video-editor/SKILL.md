---
name: h3-video-editor
description: 视频/图片剪辑合成专家。使用 ffmpeg 命令行处理本地视频文件，支持剪切、拼接、加音频、叠加图片、变速、格式转换等操作。所有命令执行前完整展示并等待用户确认。
---

# 视频剪辑合成

## 工作原则

1. **所有命令展示后等待确认**：生成命令后以代码块展示，说明操作效果，用户确认后才执行
2. **工具选择**：优先 ffmpeg 命令行；复杂帧级操作（风格迁移/视频融合）使用 ComfyUI 节点
3. **保留原文件**：所有操作默认输出新文件，不覆盖原文件

## 工作流程

1. 确认输入文件路径（绝对路径）、操作类型、输出文件名
2. 生成 ffmpeg 命令，展示并说明效果
3. 等待用户确认（"确认/可以/OK"）
4. 执行命令，报告结果
5. 如有错误，分析原因并提出修复方案

## 常用操作指令

### 1. 剪切片段

```bash
# 从第 2 秒开始，截取 5 秒
ffmpeg -i input.mp4 -ss 00:00:02 -t 5 -c copy output_clip.mp4

# 精确帧级剪切（重新编码，更精确）
ffmpeg -i input.mp4 -ss 00:00:02.000 -to 00:00:07.000 -c:v libx264 -c:a aac output_clip.mp4
```

| 参数 | 说明 |
|------|------|
| `-ss` | 起始时间（HH:MM:SS.ms 或秒数） |
| `-t` | 截取时长（秒） |
| `-to` | 结束时间（与 `-t` 二选一） |
| `-c copy` | 流拷贝（快速，但可能精度差） |

### 2. 拼接多个视频

```bash
# 方法1：同编码参数时用 concat demuxer（最快）
# 先创建文件列表 list.txt：
# file 'clip1.mp4'
# file 'clip2.mp4'
# file 'clip3.mp4'
ffmpeg -f concat -safe 0 -i list.txt -c copy output_merged.mp4

# 方法2：重新编码统一参数（兼容不同编码的视频）
ffmpeg -i clip1.mp4 -i clip2.mp4 -i clip3.mp4 \
  -filter_complex "[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]" \
  -map "[v]" -map "[a]" output_merged.mp4
```

### 3. 替换/添加音频

```bash
# 替换视频音轨为新音频（保持视频时长）
ffmpeg -i video.mp4 -i new_audio.mp3 -c:v copy -c:a aac \
  -map 0:v:0 -map 1:a:0 -shortest output_with_audio.mp4

# 混合原音轨 + 背景音乐（音量各50%）
ffmpeg -i video.mp4 -i bgm.mp3 \
  -filter_complex "[0:a]volume=0.5[a1];[1:a]volume=0.5[a2];[a1][a2]amix=inputs=2[aout]" \
  -map 0:v -map "[aout]" -c:v copy -c:a aac output_mixed.mp4

# 去掉音轨
ffmpeg -i video.mp4 -an -c:v copy output_silent.mp4
```

### 4. 叠加图片/水印

```bash
# 右下角叠加 logo（距边 10px）
ffmpeg -i video.mp4 -i logo.png \
  -filter_complex "overlay=W-w-10:H-h-10" \
  -c:a copy output_watermark.mp4

# 全屏淡入图片（第 2 秒开始，持续 3 秒）
ffmpeg -i video.mp4 -i overlay.png \
  -filter_complex "[1:v]fade=in:st=2:d=0.5,fade=out:st=5:d=0.5[img];[0:v][img]overlay=0:0" \
  -c:a copy output_overlay.mp4
```

### 5. 变速

```bash
# 2 倍速（视频 + 音频同步）
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" \
  -map "[v]" -map "[a]" output_2x.mp4

# 0.5 倍速（慢放）
ffmpeg -i input.mp4 \
  -filter_complex "[0:v]setpts=2.0*PTS[v];[0:a]atempo=0.5[a]" \
  -map "[v]" -map "[a]" output_slow.mp4
```

### 6. 格式转换

```bash
# MP4 → GIF（适合预览，帧率15）
ffmpeg -i input.mp4 -vf "fps=15,scale=480:-1:flags=lanczos" \
  -loop 0 output.gif

# 提取音频
ffmpeg -i video.mp4 -vn -c:a aac output_audio.aac

# 压缩视频（降低比特率）
ffmpeg -i input.mp4 -c:v libx264 -crf 28 -preset fast -c:a aac -b:a 128k output_compressed.mp4
```

### 7. 裁剪画面（改比例）

```bash
# 从 16:9 裁剪为 9:16 竖版（居中裁剪）
ffmpeg -i input_16x9.mp4 \
  -filter_complex "crop=ih*9/16:ih:(iw-ih*9/16)/2:0" \
  -c:a copy output_9x16.mp4

# 缩放到指定分辨率（保持比例，pad 黑边）
ffmpeg -i input.mp4 \
  -filter_complex "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" \
  -c:a copy output_padded.mp4
```

## ComfyUI 进阶操作（帧级处理）

当 ffmpeg 无法满足需求时，使用 ComfyUI 视频节点：

| 操作 | ComfyUI 节点 |
|------|-------------|
| 视频转帧序列 | `VHS_LoadVideo` → `SaveImage` |
| 帧序列转视频 | `VHS_VideoCombine` |
| AI 风格迁移 | `VHS_LoadVideo` → 风格模型 → `VHS_VideoCombine` |
| 视频插帧（补帧） | `FILM_VFI` 节点（需 FilmVFI 插件） |

## 操作确认格式

执行任何命令前，以以下格式展示：

```
📋 操作预览

操作：[操作类型]
输入：[完整路径]
输出：[完整路径]
说明：[这条命令做什么，会产生什么效果]

命令：
```bash
[完整 ffmpeg 命令]
```

预计耗时：[估算]
输入"确认/可以/OK"开始执行。
```

## 常见错误处理

| 错误 | 原因 | 修复 |
|------|------|------|
| `No such file or directory` | 路径错误或空格未引号包裹 | 用双引号包裹所有路径 |
| `codec not currently supported` | 输出格式不支持原编码 | 加 `-c:v libx264 -c:a aac` 重新编码 |
| 拼接后视频跳帧 | 各片段编码参数不一致 | 用方法2（filter_complex concat）重新编码 |
| 音视频不同步 | concat 方式没有重新编码 | 去掉 `-c copy`，让 ffmpeg 重新编码对齐 |
| GIF 太大 | fps 和 scale 太高 | 降低 fps（10-15），缩小 scale（480宽以下） |
