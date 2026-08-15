# 录屏成片库 + 可编辑字幕（增量配音）

> 日期：2026-08-15  
> 状态：设计待实施  
> 基线：二期旁白已交付，见 `docs/design/2026-08-15-screen-record-phase2-design.md`  
> 实施计划：`docs/plans/2026-08-15-screen-record-subtitle-editor-implementation.md`

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 编辑面 | 预览页：左视频 + 右字幕时间轴（增删改、改时间） |
| 落盘 | 「保存字幕」只写旁路 `.srt` + project；「烧录成片」另开动作 |
| 配音 | 按条重配：改过文案的 cue 重新 TTS；未改的复用缓存音频 |
| 面板 | Popover 内 Tab：录制 / 成片（按 mtime 降序） |

---

## 1. 背景

二期 `screen_record_narrate` 为一锤子流水线（TTS → SRT → 混音 → 烧录），用户无法事后改 cue、删条、重烧。成片散落在 `{workspace}/temp/recordings/`，面板仅展示「最近成片」。

本阶段补齐：成片库浏览、应用内预览编辑、字幕与烧录解耦、增量配音。

### 1.1 明确不做

- ASR 自动转写
- 完整 NLE / 多轨精剪
- 旧 `~/.lumii/recordings` 迁移
- 跨机器音频缓存迁移

---

## 2. Sidecar 布局

与成片同目录（`recordings/`）：

| 路径 | 用途 |
|------|------|
| `{stem}.lumii-subs.json` | cue 项目：id / startMs / endMs / text / textHash / audioFile? |
| `{stem}.subs-cache/` | 按 cue id 存 TTS 音频 |
| `{stem}.srt` | 用户可见旁路字幕（「保存字幕」写出） |

`textHash` = 规范化文本（trim）的稳定哈希。烧录时若 hash 与当前文案不符或音频缺失 → 该条重 TTS。

命名约定：新流程用 `{stem}.srt`；历史 `{stem}-narrated.srt` 仅作 load 回退源。

---

## 3. IPC

| Channel | 行为 |
|---------|------|
| `screen-record:list-recordings` | 扫描 webm/mp4（排除 `_narrate_tmp`、`*.subs-cache`），mtime desc |
| `screen-record:load-subtitle-project` | 读 json → 否则 parse `.srt` / `-narrated.srt` → 否则空 |
| `screen-record:save-subtitle-project` | 写 json + `{stem}.srt`（不混音不烧录） |
| `screen-record:burn-subtitles` | 增量 TTS + 混音/烧录 → `{stem}-burned.{ext}` |

路径必须落在 `resolveRecordingsDir()` 下。

---

## 4. UI

### 4.1 Panel Tab

- **录制**：现有源选择 / 开停 / 暂停
- **成片**：列表（name、mtime、bytes、hasSrt）；点击打开编辑器；刷新

### 4.2 RecordingSubtitleEditor

- 左：`lumii-local` 视频；点 cue 跳转；播放高亮当前条
- 右：可编辑 cue 列表
- 底栏：保存字幕 | 烧录成片；「含配音」开关（默认开）
- 从文本导入：`startMs|text` 行格式（替代面板简易旁白 textarea 为主入口）

### 4.3 一键旁白桥接

`narrate` 成功后写入 project + cache + `.srt`，UI 可打开编辑器续改；后续以 save/burn 为准，避免全量覆盖用户改稿。

---

## 5. 模块落点

| 位置 | 职责 |
|------|------|
| `main/screen-record/srt.ts` | `parseSrt` / `cuesToSrt` |
| `main/screen-record/subtitle-project.ts` | project 路径、读写、textHash、list |
| `main/screen-record/burn-subtitles-service.ts` | 增量 TTS + 烧录编排 |
| `shared/screen-record.ts` | 列表/project/burn 类型 |
| `ScreenRecordPanel` + `RecordingSubtitleEditor` | UI |

---

## 6. 验收

- [ ] 成片 Tab 按生成时间降序列表；点开可播
- [ ] 字幕可增删改；保存只出 `.srt` + json，不改成片
- [ ] 烧录产出 `-burned` 新文件；原片保留
- [ ] 改一条文案再烧：仅该条重 TTS（缓存命中可测）
- [ ] narrate 后可打开编辑器看到 cues
