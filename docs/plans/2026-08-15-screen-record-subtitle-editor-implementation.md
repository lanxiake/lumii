# 录屏字幕编辑器 — 实施计划

> 日期：2026-08-15  
> 设计：`docs/design/2026-08-15-screen-record-subtitle-editor-design.md`  
> 方法：TDD

---

## Part 1 — parseSrt + project 模型

1. RED：`parseSrt` round-trip / 非法块跳过
2. GREEN：实现 `parseSrt`
3. RED/GREEN：`hashCueText`、`buildProjectPaths`、`read/writeSubtitleProject`、`listRecordings`

## Part 2 — IPC + burn

1. RED：`listRecordings` 排序与过滤
2. RED：`burn` 增量 TTS（mock generateAudioFile：改文案才调用）
3. GREEN：`burn-subtitles-service` + IPC + preload + shared 类型

## Part 3 — Panel 成片 Tab

1. Tab 切换；list IPC；mtime 展示；点击打开编辑器

## Part 4 — RecordingSubtitleEditor

1. 左视频右列表；保存 / 烧录；导入文本；脏状态

## Part 5 — narrate 桥接

1. narrate 成功后写 project/cache/`.srt`；面板可「编辑字幕」

## 验证命令

```bash
cd apps/windows
npx vitest run src/main/screen-record
```
