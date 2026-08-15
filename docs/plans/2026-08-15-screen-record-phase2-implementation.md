# 客户端录屏二期 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 MVP 之上交付二期：暂停/继续、系统声、时间线预览、可选 MP4、窗口捕获 B1、停录后 SRT+TTS 配音（默认烧字幕）。对应 `docs/design/2026-08-15-screen-record-phase2-design.md`。

**Architecture:** 状态机扩展 `paused` + MediaRecorder.pause/resume；desktop audio 混轨；ffmpeg-runner 共用转码/混音/烧字幕；narrate-service 编排客户端 TTS（`voiceService.generateAudioFile`）与 ffmpeg；ToolCallCard + recordings ACL 做成片预览。

**Tech Stack:** Electron MediaRecorder、Web Audio、`@ffmpeg-installer/ffmpeg`（运行时）、现有 voice TTS、Vitest、设置 localStorage `screenRecord` 扩展键。

**Design:** `docs/design/2026-08-15-screen-record-phase2-design.md`

---

## 范围锁与执行顺序

**严格按 Part P → A → B → C → D → E。** 每 Task：写失败测试 → 跑红 → 最小实现 → 跑绿 → 提交。

| Part | 交付 | 依赖 |
|------|------|------|
| P | paused 状态机 + pause/resume 工具/UI/托盘 | MVP |
| A | 系统声混轨 + 设置 | P（可并行于类型，但建议 P 后） |
| B | recordings 预览 ACL + ToolCallCard | MVP |
| C | ffmpeg-runner + 可选 MP4 | —（E 依赖 C） |
| D | 窗口捕获 B1 文案 | MVP |
| E | screen_record_narrate（TTS+SRT+烧字幕） | C、语音 TTS |

建议 worktree：`git checkout -b feat/screen-record-phase2`

---

## Part P：暂停 / 继续

### Task P.1：shared 类型扩展 paused

**Files:**
- Modify: `apps/windows/src/shared/screen-record.ts`
- Modify: `apps/windows/src/shared/screen-record.test.ts`

**Step 1:** 测试断言 `ScreenRecordStatus` 含 `'paused'`；错误码含 `not_recording` | `not_paused`；Command/Event 含 pause/resume。

**Step 2:** `npx vitest run src/shared/screen-record.test.ts` → 红。

**Step 3:** 扩展 union 与常量；命令：
- `screen-record:pause` / `screen-record:resume`
- 事件：`screen-record:event:pause-capture` / `resume-capture`

**Step 4:** 测试绿 → commit：`feat(screen-record): shared 增加 paused 态与 pause/resume 契约`

---

### Task P.2：Service 状态机 paused + 活跃计时

**Files:**
- Modify: `apps/windows/src/main/screen-record/screen-record-service.ts`
- Modify: `apps/windows/src/main/screen-record/screen-record-service.test.ts`

**行为：**
- `pause()`：仅 `recording` → `paused`，停活跃计时累计，通知 renderer pause-capture
- `resume()`：仅 `paused` → `recording`，恢复累计
- `elapsedMs` = 累计活跃 ms（paused 墙钟不加）
- `stop()` 允许从 `paused`
- `maxDurationSec` 按活跃时长触发

**Step 1:** 单测：recording→paused→resume→recording；pause 在 idle → not_recording；stop from paused finalize；假时钟下暂停 5s 不计入 elapsed。

**Step 2–4:** TDD 实现 → commit：`feat(screen-record): Service 支持 paused 与活跃时长`

---

### Task P.3：Capture + IPC + 工具 + UI

**Files:**
- Modify: `ScreenRecordCapture.ts` — `pause()`/`resume()` 调 MediaRecorder
- Modify: `screen-record-ipc.ts`、`preload/index.ts`、`screen-record-api.ts`
- Modify: `bridge-screen-record-tools.ts` + test — 注册 `screen_record_pause` / `screen_record_resume`
- Modify: `ScreenRecordPanel.tsx`、`ScreenRecordRoot.tsx`、`tray-manager.ts`、`main/index.ts`

**Step 1:** bridge 单测：pause/resume 透传；错误码透传。

**Step 2–4:** 实现三处同步 + 面板按钮 + 顶栏暂停态 + 托盘项 → commit：`feat(screen-record): pause/resume 采集、工具与 UI`

---

## Part A：系统声

### Task A.1：设置键 + start 参数

**Files:**
- Modify: `shared/screen-record.ts` — `includeSystemAudio?: boolean`；warning `system_audio_muted`；错误 `system_audio_unavailable`（若作独立码）
- Modify: `useSettings.types.ts` / `useSettings.ts` — `includeSystemAudioDefault: true`
- Modify: Settings 隐私录屏区 + `ScreenRecordPanel` 开关

**Commit:** `feat(screen-record): includeSystemAudio 设置与工具参数`

---

### Task A.2：Capture 混系统声

**Files:**
- Modify: `ScreenRecordCapture.ts` — desktop audio 条件开启；`mix-audio-tracks.ts` 混系统声+麦
- Modify: `mix-audio-tracks.test.ts`
- start-capture 事件带 `includeSystemAudio`

**行为：** 系统声失败 → notifyCaptureError `system_audio_unavailable`（或复用路径标 warning）→ 继续录；麦逻辑不变。

**Commit:** `feat(screen-record): desktop 系统声混轨与降级`

---

## Part B：时间线预览

### Task B.1：ACL 放行 recordings

**Files:**
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts` — `isAllowedPreviewPath` 含 `resolveRecordingsDir()`
- 若有单测则补；否则手测说明写在 commit body

**Commit:** `feat(screen-record): 预览 ACL 允许 recordings 目录`

---

### Task B.2：大文件按 path 预览

**Files:**
- 调研 `FilePreviewModal` / `files:read-preview-by-path` 10MB 限制
- 最小方案（择一写入代码注释）：
  1. 对 recordings 路径返回 `fileUrl` / custom protocol 而不读满 base64；或
  2. 新增 `screen-record:get-file-url` IPC，renderer `<video src={url}>`

**Commit:** `feat(screen-record): 成片大文件按 path 预览`

---

### Task B.3：ToolCallCard 成片 chip

**Files:**
- Modify: `ToolCallCard/index.tsx` — 解析 `screen_record_stop` / `screen_record_narrate` 的 JSON `path`/`mp4Path`
- 可点打开 FilePreviewModal（复用现有 preview context）

**Commit:** `feat(screen-record): 工具结果成片可点预览`

---

## Part C：可选 MP4 + ffmpeg-runner

### Task C.1：ffmpeg-runner 模块

**Files:**
- Create: `apps/windows/src/main/screen-record/ffmpeg-runner.ts`
- Create: `apps/windows/src/main/screen-record/ffmpeg-runner.test.ts`（mock spawn）
- Modify: `apps/windows/package.json` — `@ffmpeg-installer/ffmpeg` 移入 `dependencies`；确认 electron-builder asarUnpack

**API 草图：**
```ts
export async function runFfmpeg(args: string[], opts?: { cwd?: string }): Promise<{ ok: true } | { ok: false; message: string }>
export async function webmToMp4(input: string, output: string): Promise<...>
```

**Commit:** `feat(screen-record): 主进程 ffmpeg-runner 封装`

---

### Task C.2：stop 可选 exportMp4

**Files:**
- Modify: shared 类型、Service stop、设置 `exportMp4Default`、Settings UI、Panel
- stop 成功后若需 MP4 → runner；失败 warning `mp4_failed`

**Commit:** `feat(screen-record): stop 可选导出 MP4`

---

## Part D：窗口捕获 B1

### Task D.1：文案加固

**Files:**
- Modify: `ScreenRecordPanel.tsx`、`ScreenRecordConfirmDialog.tsx` — 单窗口醒目提示
- Modify: bridge / Service 对 `stream_ended` 的 message 文案
- 可选：status 事件 toast（若项目已有 toast 钩子）

**Commit:** `fix(screen-record): 窗口录制与 stream_ended 体验文案（B1）`

---

## Part E：字幕 + TTS 配音

### Task E.1：shared narrate 类型

**Files:**
- Modify: `shared/screen-record.ts` + test
- 类型：`ScreenRecordNarrateParams` / `ScreenRecordNarrateResult`；错误码 `tts_unavailable` | `narrate_failed` | `invalid_cues` | `source_not_in_recordings`
- `subtitleMode` 默认语义在文档与实现注释标明 **burn**

**Commit:** `feat(screen-record): narrate 共享类型与错误码`

---

### Task E.2：SRT 生成纯函数

**Files:**
- Create: `apps/windows/src/main/screen-record/srt.ts`
- Create: `srt.test.ts`

```ts
/** 将 cues 转为 SRT 文本（UTF-8） */
export function cuesToSrt(cues: Array<{ startMs: number; endMs: number; text: string }>): string
```

**Commit:** `feat(screen-record): SRT 生成工具`

---

### Task E.3：narrate-service

**Files:**
- Create: `apps/windows/src/main/screen-record/narrate-service.ts`
- Create: `narrate-service.test.ts`（mock TTS + ffmpeg）
- 依赖注入：`generateAudioFile(text, dir)`、`runFfmpeg`、`resolveRecordingsDir`

**流程：** 校验 path → TTS 各 cue → 填 endMs → 写 srt → filter_complex 混音 → burn 字幕（微软雅黑）→ 失败降级 soft → 返回新 path。

**烧字幕：** 优先 `subtitles=` 滤镜；字体路径候选 `C:\\Windows\\Fonts\\msyh.ttc` 等。

**Commit:** `feat(screen-record): narrate-service（TTS+混音+默认烧字幕）`

---

### Task E.4：工具 + IPC + 轻量 UI

**Files:**
- Modify: `bridge-screen-record-tools.ts` + test — `screen_record_narrate`
- Modify: preload / ipc 若需独立 invoke
- Modify: `ScreenRecordPanel` —「旁白/字幕…」简易入口（多行 startSec + text，或说明走 AI）
- 设置：`narrateOriginalAudioGain` 可选接入 Settings

**Commit:** `feat(screen-record): screen_record_narrate 工具与轻量 UI`

---

## Part F：回归验收

### Task F.1：自动化

```bash
cd apps/windows
npx vitest run src/shared/screen-record.test.ts src/main/screen-record src/main/agent-runtime/bridge-screen-record-tools.test.ts src/renderer/screen-record
pnpm typecheck
```

### Task F.2：手工对照设计 §11 清单

全部勾选后：`docs: 录屏二期验收通过` 或 bugfix commits。

---

## 已知限制（二期不修，只注释）

1. 单窗口可能无系统声 loopback  
2. 窗口最小化仍可能黑屏（B1 仅提示）  
3. TTS 长文本耗时；narrate 同步等待，Agent 应控制 cues 数量  
4. burn 依赖系统中文字体路径  
5. 不提供自动 ASR 字幕  

## 执行方式

1. `feat/screen-record-phase2` 分支或 worktree  
2. `executing-plans` 按 Part 串行  
3. 偏离先改本计划并 commit，再改代码  
