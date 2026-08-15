# 客户端录屏（AI 可控）— 二期设计

> 日期：2026-08-15  
> 状态：v0.1，设计待实施  
> 基线：MVP 已交付，见 `docs/design/2026-08-15-screen-record-design.md`  
> 实施计划：`docs/plans/2026-08-15-screen-record-phase2-implementation.md`

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 范围 | 暂停/继续；系统声；聊天时间线预览；可选 MP4；窗口捕获体验加固（B1）；停录后字幕+TTS 配音 |
| 暂停 | `MediaRecorder.pause/resume`；状态 `paused`；活跃时长不计暂停墙钟；成片无静默段 |
| 系统声 | desktop 流开 audio + 与麦混轨；失败降级；整屏优先，单窗口可能无 loopback |
| 时间线 | `stop`/`narrate` 结果 path 可点预览；放行 `recordings/`；大文件按 path 不整包 base64 |
| MP4 | stop 后可选 ffmpeg 转码；失败保留 WebM |
| 窗口 B1 | 文案/提示/stream_ended 体验，不换捕获后端 |
| 旁白 | 工具 `screen_record_narrate`；客户端 TTS；**字幕默认烧进画面**；旁路 `.srt` 仍写出 |

---

## 1. 背景与范围

### 1.1 相对 MVP 的增量

MVP 已交付：整屏/窗口、画面+麦、四工具、简易 UI、确认策略、WebM。

二期补齐：录制中可控暂停、更完整音频、成片可预览与导出、成片旁白管线。

### 1.2 二期明确不做

- Graphics Capture / 原生抓帧（三期方案 2）
- 成片自动 ASR 转写字幕
- 录制中实时烧字幕 / 实时旁白
- 多路并发、区域裁剪、摄像头 PiP、`recordings/` 自动清理
- 完整时间轴精剪 UI

---

## 2. 状态机（相对 MVP）

MVP 五态扩展为六态：

`idle → pending_confirm → recording ⇄ paused → stopping → idle`（另有 `error`）

| 转换 | 条件 |
|------|------|
| recording → paused | `pause` / UI / 托盘 |
| paused → recording | `resume` |
| recording\|paused → stopping | `stop` / maxDuration / stream_ended / crash / quit |
| pause 非 recording | `not_recording` |
| resume 非 paused | `not_paused` |

**活跃时长：** `elapsedMs` 与 `maxDurationSec` 只累计 `recording` 态时间；暂停期间墙钟不计。

**采集：** renderer 对 `MediaRecorder` 调 `pause()`/`resume()`；暂停期间不分片 IPC。

---

## 3. 系统声

| 项 | 约定 |
|----|------|
| 设置 | `screenRecord.includeSystemAudioDefault`（默认 `true`） |
| start 参数 | `includeSystemAudio?: boolean`（覆盖默认） |
| 实现 | desktop `getUserMedia` 在需要时 `audio: true`；与麦经 AudioContext 混轨 |
| 失败 | `system_audio_unavailable` → 降级继续；结果 `warning: 'system_audio_muted'` |
| 限制 | Windows 整屏 loopback 较可靠；单窗口可能无系统声 → 降级不整单失败 |

面板增加「包含系统声音」开关。

---

## 4. 时间线预览

| 项 | 约定 |
|----|------|
| ACL | `files:read-preview-by-path` / 等价预览通路允许 `resolveRecordingsDir()` |
| 大文件 | 禁止依赖 10MB 整文件 base64；按 path 提供可播 URL（custom protocol 或扩展预览 IPC） |
| UI | `ToolCallCard` 识别 `screen_record_stop` / `screen_record_narrate` 成功 `path`（及 `mp4Path`）→ 打开 `FilePreviewModal` |

---

## 5. 可选 MP4

| 项 | 约定 |
|----|------|
| 依赖 | `@ffmpeg-installer/ffmpeg` 升为运行时依赖；主进程 `ffmpeg-runner` 封装 |
| 设置 | `exportMp4Default`（默认 `false`） |
| stop | 可选 `exportMp4`；成功返回 `mp4Path`；失败 `warning: 'mp4_failed'`，WebM 保留 |
| 打包 | asarUnpack / 生产路径可用 |

旁白管线（§7）复用同一 ffmpeg 封装。

---

## 6. 窗口捕获体验（B1）

- 录单窗口：面板/确认更醒目提示「保持目标窗口可见，最小化可能导致黑屏」
- `stream_ended`：工具与 UI 文案标明「目标窗口已关闭，已保存已录片段」
- **不**引入原生 Graphics Capture

---

## 7. 字幕 + TTS 配音（停录后期）

### 7.1 工具 `screen_record_narrate`

```ts
{
  path: string
  cues: Array<{ startMs: number; text: string; endMs?: number }>
  writeSrt?: boolean          // 默认 true
  dub?: boolean               // 默认 true
  subtitleMode?: 'soft'|'burn' // 默认 'burn'
  originalAudioGain?: number  // 默认 0.35（或设置 narrateOriginalAudioGain）
  exportMp4?: boolean
}
```

### 7.2 流水线

1. 校验 path ∈ `recordings/`
2. 每条 cue → `voiceService.generateAudioFile`（当前 TTS provider）
3. 缺 `endMs` 时用 TTS 实际时长；写 UTF-8 SRT
4. ffmpeg：旁白按 `startMs` 对齐混入；压低原声
5. 默认 **burn** 烧字幕（微软雅黑等系统字体）；同时写旁路 `.srt`
6. burn 失败 → 降级 soft + `warning: 'subtitle_burn_failed'`
7. 输出新文件（如 `*-narrated.webm`）；**原片保留**

### 7.3 错误码

`tts_unavailable` | `narrate_failed` | `invalid_cues` | `source_not_in_recordings` |（复用）`disabled`

### 7.4 UI

面板最近成片：「旁白/字幕…」轻量表单；音色完全复用语音设置。

---

## 8. 设置键增量

| 键 | 默认 | 含义 |
|----|------|------|
| `includeSystemAudioDefault` | `true` | 默认录系统声 |
| `exportMp4Default` | `false` | stop 后自动 MP4 |
| `narrateOriginalAudioGain` | `0.35` | 旁白混流原声增益 |

（MVP 四键不变。）

---

## 9. AI 工具一览（二期后）

| 工具 | 作用 |
|------|------|
| `screen_record_list_sources` | 同 MVP |
| `screen_record_start` | + `includeSystemAudio` |
| `screen_record_stop` | + `exportMp4` / `mp4Path` |
| `screen_record_status` | status 含 `paused` |
| `screen_record_pause` | recording → paused |
| `screen_record_resume` | paused → recording |
| `screen_record_narrate` | SRT + TTS 配音 + 默认烧字幕 |

系统提示：暂停跳过无用时段；旁白 cues 由 Agent/用户提供；禁止用录屏代替截图观察。

---

## 10. 模块落点（建议）

| 位置 | 职责 |
|------|------|
| `shared/screen-record.ts` | 状态/错误码/narrate 类型扩展 |
| `main/screen-record/screen-record-service.ts` | paused + 活跃计时 |
| `main/screen-record/ffmpeg-runner.ts` | 转码 / 混音 / 烧字幕 |
| `main/screen-record/narrate-service.ts` | narrate 编排（TTS + ffmpeg） |
| `renderer/screen-record/ScreenRecordCapture.ts` | pause/resume；系统声音轨 |
| `bridge-screen-record-tools.ts` | pause/resume/narrate |
| `ToolCallCard` + preview ACL | 时间线预览 |

---

## 11. 验收清单（二期）

- [ ] pause→resume→stop：成片无静默段；活跃计时正确；托盘/顶栏/面板一致
- [ ] 整屏可录系统声；失败降级；麦+系统声可同开
- [ ] stop/narrate 工具结果可点开预览；大文件可播
- [ ] exportMp4 成功出可播 MP4；失败保留 WebM
- [ ] 窗口录制提示与 stream_ended 文案达标
- [ ] narrate：2 条 cue → 成片字幕已烧进 + `.srt`；TTS 为当前客户端音色；原声被压低；burn 失败降级；TTS 不可用不损坏原片

---

## 12. 分期回顾

| 期 | 交付 |
|----|------|
| MVP | 已交付 |
| **二期** | 本文档 |
| 三期 | 原生后端；观察流；自动 ASR 字幕等 |

---

## 13. 后续：教程流水线

Agent 教程录制效率优化（mark / timeline / narrate 富返回 / inspect）见：

- 设计：`docs/design/2026-08-16-screen-record-tutorial-pipeline-design.md`
- 计划：`docs/plans/2026-08-16-screen-record-tutorial-pipeline-implementation.md`
