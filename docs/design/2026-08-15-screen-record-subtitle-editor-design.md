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

附属文件全部收在**单个目录**内，`recordings/` 根目录下每个成片只对应「一个视频 + 一个文件夹」：

| 路径 | 用途 |
|------|------|
| `{stem}.lumii-subs/project.json` | cue 项目：id / startMs / endMs / text / textHash / audioFile? / style |
| `{stem}.lumii-subs/subtitles.srt` | 旁路字幕（「保存字幕」写出，也是烧录输入） |
| `{stem}.lumii-subs/tts/` | 按 cue id 存 TTS 音频 |
| `{stem}.lumii-subs/original.{ext}` | 首次烧录前备份的无字幕原片 |

旧版散落在根目录的 `{stem}.lumii-subs.json` / `{stem}.srt` / `{stem}-narrated.srt` / `{stem}.subs-cache/` 仍可读，
`migrateLegacySidecar()` 会在 load/save/burn 时幂等迁入附属目录。

`textHash` = 规范化文本（trim）的稳定哈希。烧录时若 hash 与当前文案不符或音频缺失 → 该条重 TTS。

命名约定：新流程用 `{stem}.srt`；历史 `{stem}-narrated.srt` 仅作 load 回退源。

---

## 3. IPC

| Channel | 行为 |
|---------|------|
| `screen-record:list-recordings` | 扫描根目录 webm/mp4（附属目录在子目录内天然排除），mtime desc |
| `screen-record:load-subtitle-project` | 读 json → 否则 parse srt → 否则空；附带 `originalPath` |
| `screen-record:save-subtitle-project` | 写 project.json + subtitles.srt（不混音不烧录） |
| `screen-record:burn-subtitles` | 增量 TTS + 混音/烧录 → **就地覆盖成片** |
| `screen-record:restore-original` | 用 `original.{ext}` 覆盖成片，撤销烧录 |

烧录与 AI 配音都遵循同一条规则：**ffmpeg 输入永远是 `original.{ext}`，输出覆盖可见成片**。
这样重复烧录不会字幕叠字幕，列表里也始终只有一个视频。勾选导出 MP4 时容器会从 webm 变成 mp4，
旧扩展名的成片随即删除。中间产物一律先写进临时目录，成功后才覆盖，失败不留半成品。

路径必须落在 `resolveRecordingsDir()` 下。

---

## 4. UI

### 4.1 Panel Tab（v0.2 重排）

功能按「录制前」与「录制后」分摊，避免录制页堆满开关：

- **录制**：类型筛选（全部/屏幕/窗口）+ 搜索 + 源列表；麦克风 / 系统声 / MP4 / 始终允许收进可折叠的「录制选项」（收起时以摘要行展示当前配置）；底栏只留开始 / 暂停 / 继续 / 停止
- **成片**：列表（name、相对时间、bytes、含字幕标记），选中行展开操作区：预览 / 编辑字幕、AI 旁白、打开文件夹；旁白草稿框移到此页，作用于选中成片

### 4.1.1 录制完成自动跳转

`stopInternal` 写盘成功后主进程广播 `screen-record:event:recording-saved`（path/durationMs/bytes/mp4Path）。渲染层收到后回填最近成片、打开面板、切到「成片」页并选中该文件（列表自动刷新并滚动到位）。UI 主动 stop 时同样触发，保证 AI 停录与手动停录行为一致。

### 4.2 RecordingSubtitleEditor

- 左：`lumii-local` 视频；点 cue 跳转；播放高亮当前条
- 右：可编辑 cue 列表
- 底栏：保存字幕 | 烧录成片；「含配音」开关（默认开）
- 从文本导入：`startMs|text` 行格式（替代面板简易旁白 textarea 为主入口）

### 4.3 一键旁白桥接

`narrate` 成功后写入 project + cache + `.srt`，UI 可打开编辑器续改；后续以 save/burn 为准，避免全量覆盖用户改稿。

---

## 5. 画面守卫（最小化黑屏/白屏）

窗口被最小化或隐藏时，桌面捕获持续输出纯黑/纯白帧，成片会出现整段黑屏；窗口缩放还会改变视频轨尺寸导致编码异常。处理方式：

| 层 | 措施 |
|----|------|
| 采集 | 桌面流经 `<video>` → `<canvas>` 定尺寸合成后再录（`computeCaptureSize` 等比缩放并对齐偶数），窗口缩放不影响输出分辨率 |
| 采集 | 逐帧采样 32x18 判定空帧（`isBlankFrame`，≥97% 像素接近纯黑/纯白）；判定为空帧即跳过本帧绘制，画布保留最后一张有内容的帧，画面恢复自动继续 |
| 采集 | `<video>` 挂到屏幕外的 DOM 节点（脱离文档的元素在部分环境下不解码帧）；绘帧用 `setInterval` 而非 `requestAnimationFrame`（后者在窗口最小化时被暂停） |
| 主进程 | 主窗口 `backgroundThrottling: false`；Windows 追加 `AllowWgc*Capturer` 特性开关以支持被遮挡窗口 |
| 状态 | 空帧持续 `BLANK_HOLD_MS` 后上报 `target_window_hidden`，恢复时上报 `target_window_visible`；服务按非致命处理，仅切换 `targetHidden` 并广播状态，录制不中断 |

> 注意：冻结判定必须**先于绘制**。早期实现是「连续空帧满 `BLANK_HOLD_MS` 才停止绘制」，白帧在等待期内已经被画进画布，冻结后画面恰好停在白屏上。

---

## 6. 模块落点

| 位置 | 职责 |
|------|------|
| `main/screen-record/srt.ts` | `parseSrt` / `cuesToSrt` |
| `main/screen-record/subtitle-project.ts` | project 路径、读写、textHash、list |
| `main/screen-record/burn-subtitles-service.ts` | 增量 TTS + 烧录编排 |
| `renderer/screen-record/frame-guard.ts` | 输出尺寸计算 + 空帧检测 |
| `shared/screen-record.ts` | 列表/project/burn 类型、recording-saved 事件 |
| `ScreenRecordPanel` + `RecordingSubtitleEditor` | UI |

---

## 7. 验收

- [ ] 成片 Tab 按生成时间降序列表；点开可播
- [ ] 字幕可增删改；保存只写附属目录，不改成片
- [ ] 烧录就地覆盖成片，根目录不出现 `-burned`；原片存于 `original.{ext}` 且可还原
- [ ] 二次烧录以原片为输入，字幕不叠字幕
- [ ] 改一条文案再烧：仅该条重 TTS（缓存命中可测）
- [ ] narrate 后可打开编辑器看到 cues
- [ ] 停止录制后面板自动弹出并选中新成片
- [ ] 录制中最小化目标窗口：成片为冻结画面而非黑屏/白屏，面板给出提示，恢复后继续正常录制
- [ ] 录制中缩放目标窗口：成片分辨率不变、无花屏

---

## 8. 相关：教程流水线

Agent 侧 mark/timeline、narrate 可观测返回、inspect 见  
`docs/design/2026-08-16-screen-record-tutorial-pipeline-design.md`。
