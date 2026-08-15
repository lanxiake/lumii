# 客户端录屏（AI 可控）— Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 交付 MVP：整屏 + 任意窗口录制（含 Lumii 自身免确认）、画面 + 麦克风混轨 WebM 落盘、AI 四工具全流程可控、人手简易 UI / 托盘救急。对应设计 `docs/design/2026-08-15-screen-record-design.md` §1.2 MVP 必须交付 4 条。

**Architecture:** 主进程 `ScreenRecordService` 状态机编排 + desktopCapturer 源 ID + 磁盘预检 + fs.WriteStream 分片追加；渲染进程 `ScreenRecordCapture` 调 `getUserMedia(chromeMediaSource='desktop')` + AudioContext 混音麦轨 + `MediaRecorder(webm/VP8+Opus)`；AI 层经 `bridge-screen-record-tools.ts` 注册四工具，只调 Service 不碰采集实现；采集实现为可替换边界，二期可换原生后端。

**Tech Stack:** Electron `desktopCapturer` / `webContents.getMediaSourceId()`、Web Audio `AudioContext.createMediaStreamDestination` + MediaStreamTrack 混轨、`MediaRecorder`(mimeType='video/webm;codecs=vp8,opus')、TypeBox 工具、`fs.createWriteStream` + 单次写 chunk 上限 2 MB 拆分、Vitest、设置 localStorage 新增 `screenRecord` 段、托盘菜单动态项。

**Design:** `docs/design/2026-08-15-screen-record-design.md`（v0.1，设计已评审待实施）

---

## 范围锁与执行顺序

**执行严格按 Part 0 → Part 6 顺序，不可跳步。** 每 Part 内 Task 间有依赖，按编号递增执行。每个 Task 内按 Step 1（写失败测试）→ Step 2（跑确认失败）→ Step 3（最小实现）→ Step 4（跑通过）→ Step 5（提交）顺序，**任何一步失败不进入下一步**。

| Part | 交付 | 依赖 |
|------|------|------|
| 0 | 类型常量 + 设置键扩展 + shared 命令/事件 | 无 |
| 1 | 主进程 ScreenRecordService（状态机 + 源 + 确认 + 写盘 + 监听崩溃） | Part 0 |
| 2 | 渲染进程采集（MediaRecorder + 混音 + 分片 IPC + stream ended） | Part 0, 1 |
| 3 | AI 四工具桥接（bridge-screen-record-tools） | Part 0, 1 |
| 4 | IPC 三处同步 + preload + 简易 UI 面板 + 确认弹窗 | Part 0, 1, 2 |
| 5 | 托盘入口 + 顶栏红点计时 + 设置接入 | Part 0, 1, 4 |
| 6 | 测试补齐 + MVP 整体验收（手工 + 自动化） | Part 0–5 |

---

## Part 0：类型常量与设置地基

### Task 0.1：shared 类型与命令/事件常量

**Files:**
- Create: `apps/windows/src/shared/screen-record.ts`
- Modify: `apps/windows/src/renderer/hooks/business/useSettings/useSettings.types.ts` — 追加 `ScreenRecordConfig` 并挂到 `AppSettings`
- Modify: `apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts` — DEFAULT_SETTINGS 追加 screenRecord 默认值；merge 路径处理

**Step 1: 写失败测试（类型测试用 `expectTypeOf`，放 shared 旁）**

Create: `apps/windows/src/shared/screen-record.test.ts`

```ts
import { describe, expect, it, expectTypeOf } from 'vitest'
import type {
  ScreenRecordSource,
  ScreenRecordStatus,
  ScreenRecordStartParams,
  ScreenRecordStopResult,
  ScreenRecordCommand,
  ScreenRecordEvent,
  ScreenRecordErrorCode,
} from './screen-record'
import { SCREEN_RECORD_SETTINGS_DEFAULTS, RECORDINGS_DIRNAME, MAX_DURATION_SEC_CAP, MIN_FREE_DISK_BYTES } from './screen-record'

describe('screen-record shared 常量', () => {
  it('常量值与设计一致', () => {
    expect(RECORDINGS_DIRNAME).toBe('recordings')
    expect(MAX_DURATION_SEC_CAP).toBe(7200)
    expect(MIN_FREE_DISK_BYTES).toBe(500 * 1024 * 1024)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.enabled).toBe(true)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.alwaysAllow).toBe(false)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.includeMicDefault).toBe(true)
    expect(SCREEN_RECORD_SETTINGS_DEFAULTS.confirmTimeoutSec).toBe(120)
  })
})

describe('screen-record 类型形状', () => {
  it('ScreenRecordSource 含 isLumii 标记', () => {
    expectTypeOf<ScreenRecordSource>().toHaveProperty('sourceId')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('name')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('type')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('isLumii')
    expectTypeOf<ScreenRecordSource>().toHaveProperty('thumbnailDataUrl')
  })
  it('Status union 为五态', () => {
    expectTypeOf<ScreenRecordStatus>().toMatchTypeOf<'idle' | 'pending_confirm' | 'recording' | 'stopping' | 'error'>()
  })
  it('Error union 覆盖设计 §6 全部 12 条', () => {
    const codes: ScreenRecordErrorCode[] = [
      'disabled','already_recording','no_active_session','source_unavailable',
      'insufficient_disk_space','mic_unavailable','permission_denied',
      'confirmation_timeout','stream_ended','capture_failed','write_failed',
    ]
    expect(codes.length).toBeGreaterThanOrEqual(11)
  })
})
```

**Step 2: 跑确认失败**

```bash
cd apps/windows
npx vitest run src/shared/screen-record.test.ts
```
→ 红：文件不存在或常量未导出。

**Step 3: 最小实现**

`screen-record.ts` 内容要点（每类型写中文注释，对齐设计 §3.1 工具参数表、§6 错误表）：

```ts
/** 录屏源（screen/window），Lumii 自身源 isLumii=true */
export interface ScreenRecordSource {
  sourceId: string
  name: string
  /** 'screen' 整屏 | 'window' 单窗口 */
  type: 'screen' | 'window'
  /** 是否 Lumii 自身窗口（免确认）。主进程以 webContents.getMediaSourceId() 为主判断，标题 fallback */
  isLumii: boolean
  /** 缩略图 base64 dataURL；list_sources includeThumbnail=false 时为 '' */
  thumbnailDataUrl: string
  /** display_id 辅助区分多屏 */
  displayId?: string
}

/** 录屏状态机五态（设计 §2.1） */
export type ScreenRecordStatus = 'idle' | 'pending_confirm' | 'recording' | 'stopping' | 'error'

/** 设计 §6 错误码全集（12 条） */
export type ScreenRecordErrorCode =
  | 'disabled'
  | 'already_recording'
  | 'no_active_session'
  | 'source_unavailable'
  | 'insufficient_disk_space'
  | 'mic_unavailable'
  | 'permission_denied'
  | 'confirmation_timeout'
  | 'stream_ended'
  | 'capture_failed'
  | 'write_failed'
  | 'usage'

/** list_sources 工具参数 & 返回 */
export interface ScreenRecordListSourcesParams { includeThumbnail?: boolean }
export interface ScreenRecordListSourcesResult { ok: true; sources: ScreenRecordSource[] } | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** screen_record_start 参数（设计 §3.1 第二行） */
export interface ScreenRecordStartParams {
  sourceId: string
  /** 默认 true，跟随设置 includeMicDefault；显式传值覆盖默认 */
  includeMic?: boolean
  /** 默认 1800；>7200 截断 7200；<0 报 usage */
  maxDurationSec?: number
}

/** start 返回（needs_confirmation 时不阻塞 Agent） */
export type ScreenRecordStartResult =
  | { ok: true; status: 'recording'; sessionId: string; startedAt: number }
  | { ok: true; status: 'needs_confirmation'; sessionId: string; confirmTimeoutSec: number; sourceName: string; sourceType: string }
  | { ok: false; error: ScreenRecordErrorCode; message?: string }

/** stop/status 返回（设计 §3.1 第 3/4 行） */
export interface ScreenRecordStopResult {
  ok: true
  path: string
  durationMs: number
  bytes: number
  /** 若麦轨降级无声（mic_unavailable 继续录时），带 warning */
  warning?: 'mic_muted'
} | { ok: false; error: ScreenRecordErrorCode; message?: string; partialPath?: string }

export interface ScreenRecordStatusResult {
  ok: true
  status: ScreenRecordStatus
  sessionId?: string
  sourceId?: string
  sourceName?: string
  elapsedMs?: number
  startedAt?: number
  /** status === 'pending_confirm' 时带剩余倒计时秒 */
  pendingConfirm?: boolean
  confirmTimeoutSec?: number
  confirmStartedAt?: number
  includeMic?: boolean
} | { ok: false; error: ScreenRecordErrorCode }

/** 录屏设置（设计 §4.5 四个键） */
export interface ScreenRecordConfig {
  enabled: boolean
  /** AI 非自身源录屏是否免确认（仍尊重系统麦克风权限） */
  alwaysAllow: boolean
  /** 默认是否混入麦克风 */
  includeMicDefault: boolean
  /** AI 触发时确认弹窗超时秒数，超时自动拒绝 */
  confirmTimeoutSec: number
}
export const SCREEN_RECORD_SETTINGS_DEFAULTS: ScreenRecordConfig = {
  enabled: true, alwaysAllow: false, includeMicDefault: true, confirmTimeoutSec: 120,
} as const

/** 其它常量（设计 §2.1 §3.1） */
export const RECORDINGS_DIRNAME = 'recordings'
/** maxDurationSec 上限；超出截断不报错 */
export const MAX_DURATION_SEC_CAP = 7200
/** 磁盘可用 < 此值（500 MB）start 直接拒绝 */
export const MIN_FREE_DISK_BYTES = 500 * 1024 * 1024
/** MediaRecorder 分片间隔秒（设计 §2.2 chunk interval 2–5s） */
export const MEDIA_RECORDER_TIMESLICE_MS = 3000
/** 单 chunk 超此字节数（2 MB）时在 IPC 发送前拆分，避免阻塞主进程（设计 §2.2） */
export const MAX_CHUNK_BYTES_PER_IPC = 2 * 1024 * 1024
/** 确认超时触发的 session 内部定时 tick 精度 */
export const CONFIRM_TIMEOUT_TICK_MS = 1000

/* ---------------- IPC 命令 & 事件类型（三处同步用） ---------------- */

/** Renderer → Main 命令（ScreenRecordService 作为唯一 consumer） */
export type ScreenRecordCommand =
  | { readonly type: 'screen-record:list-sources'; includeThumbnail?: boolean }
  | { readonly type: 'screen-record:start'; params: ScreenRecordStartParams; sessionId?: string }
  | { readonly type: 'screen-record:stop' }
  | { readonly type: 'screen-record:status' }
  | { readonly type: 'screen-record:confirm-respond'; sessionId: string; allow: boolean; rememberAlwaysAllow?: boolean }
  /** 渲染进程分片写盘（base64 或 Uint8Array 经结构化克隆） */
  | { readonly type: 'screen-record:chunk'; sessionId: string; chunkBase64: string; index: number; isLast: boolean }
  /** 渲染进程 MediaStream ended（目标窗口关闭） */
  | { readonly type: 'screen-record:stream-ended'; sessionId: string }
  /** 渲染进程采集层报错（非致命由 Service decide；致命→ stopping） */
  | { readonly type: 'screen-record:capture-error'; sessionId: string; reason: string }

/** Main → Renderer 事件（ScreenRecordCapture 订阅） */
export type ScreenRecordEvent =
  | { readonly type: 'screen-record:event:status-changed'; status: ScreenRecordStatus; detail: ScreenRecordStatusResult }
  | { readonly type: 'screen-record:event:confirm-requested'; sessionId: string; sourceName: string; sourceType: string; sourceId: string; thumbnailDataUrl?: string; timeoutSec: number; startedAt: number }
  | { readonly type: 'screen-record:event:start-capture'; sessionId: string; sourceId: string; includeMic: boolean; maxDurationSec: number }
  | { readonly type: 'screen-record:event:stop-capture'; sessionId: string }
  | { readonly type: 'screen-record:event:cancelled'; sessionId: string; reason: ScreenRecordErrorCode }
  /** 确认用户操作后 Service 通知 capture 层直接丢弃（pending_confirm 期间 stop） */
```

**Step 3 继续：useSettings.types.ts 追加**

在 `AppSettings` 接口旁新增：

```ts
/** 录屏设置（设计 §4.5） */
export interface ScreenRecordConfig {
  enabled: boolean
  alwaysAllow: boolean
  includeMicDefault: boolean
  confirmTimeoutSec: number
}

// 在 AppSettings interface 内追加：
export interface AppSettings {
  // ... 已有字段不动 ...
  screenRecord: ScreenRecordConfig
}
```

`useSettings.ts` 的 `DEFAULT_SETTINGS` 常量末尾追加：

```ts
screenRecord: {
  enabled: true,
  alwaysAllow: false,
  includeMicDefault: true,
  confirmTimeoutSec: 120,
},
```

并在 `deepMergeSettings` 或 `parseSettings`（看 `useSettings.ts` 内 merge 实现位置）补上 `screenRecord` 对象路径的逐层 merge，**避免整对象覆盖导致未改字段丢失**（对齐 App UI Control 实现计划 Task 15 §C 层要点：在注入脚本内 merge）。

**Step 4: 跑通过**

```bash
cd apps/windows
npx vitest run src/shared/screen-record.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 5: 提交**

```bash
git add apps/windows/src/shared/screen-record.ts \
  apps/windows/src/shared/screen-record.test.ts \
  apps/windows/src/renderer/hooks/business/useSettings/useSettings.types.ts \
  apps/windows/src/renderer/hooks/business/useSettings/useSettings.ts
git commit -m "feat(screen-record): shared 类型、命令事件常量 + 设置键扩展"
```

---

## Part 1：主进程 ScreenRecordService 核心

### Task 1.1：ScreenRecordService 纯函数模块（状态机 + Lumii 源识别）

**Files:**
- Create: `apps/windows/src/main/screen-record/screen-record-service.ts`
- Create: `apps/windows/src/main/screen-record/screen-record-service.test.ts`
- Create: `apps/windows/src/main/screen-record/index.ts`（桶导出）

**Step 1: 写失败测试**

`screen-record-service.test.ts` 覆盖设计 §9.1 单测清单（至少 80% 先写，剩下补在 Part 6 Task 6.1）：

```ts
import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  createScreenRecordService,
  type ScreenRecordService,
  type ScreenRecordServiceDeps,
} from './screen-record-service'
import type { ScreenRecordSource } from '../../shared/screen-record'

/** 假源：第 0 个是 Lumii 自身（isLumii=true） */
const FAKE_SOURCES: ScreenRecordSource[] = [
  { sourceId: 'lumii-id', name: '灵栖 Lumii', type: 'window', isLumii: true, thumbnailDataUrl: '' },
  { sourceId: 'screen-1', name: 'Screen 1', type: 'screen', isLumii: false, thumbnailDataUrl: '', displayId: '1' },
  { sourceId: 'notepad', name: '无标题 - 记事本', type: 'window', isLumii: false, thumbnailDataUrl: '' },
]

describe('ScreenRecordService — 状态机基础（设计 §9.1）', () => {
  let svc: ScreenRecordService
  let deps: ScreenRecordServiceDeps

  beforeEach(() => {
    deps = makeFakeDeps()
    svc = createScreenRecordService(deps)
  })

  it('初始 idle', () => {
    expect(svc.getStatus().status).toBe('idle')
  })

  it('idle → recording（Lumii 自身源免确认）', async () => {
    const r = await svc.start({ sourceId: 'lumii-id' })
    expect(r.ok && r.status).toBe('recording')
    expect(svc.getStatus().status).toBe('recording')
  })

  it('重复 start 返回 already_recording（幂等不叠态）', async () => {
    await svc.start({ sourceId: 'lumii-id' })
    const r = await svc.start({ sourceId: 'screen-1' })
    expect(!r.ok && r.error).toBe('already_recording')
  })

  it('idle stop → no_active_session（幂等）', async () => {
    const r = await svc.stop()
    expect(!r.ok && r.error).toBe('no_active_session')
  })

  it('pending_confirm → stop 取消确认回 idle', async () => {
    // alwaysAllow=false（默认）+ 非自身源 → pending_confirm
    const r1 = await svc.start({ sourceId: 'screen-1' })
    expect(r1.ok && r1.status).toBe('needs_confirmation')
    expect(svc.getStatus().status).toBe('pending_confirm')
    const r2 = await svc.stop()
    expect(r2.ok).toBe(true) // stop 在 pending 态视为取消，ok=true 且不返回文件
    expect(svc.getStatus().status).toBe('idle')
  })

  it('非自身源 + alwaysAllow=true → 直接 recording，跳过 pending_confirm', async () => {
    deps = makeFakeDeps({ alwaysAllow: true })
    svc = createScreenRecordService(deps)
    const r = await svc.start({ sourceId: 'screen-1' })
    expect(r.ok && r.status).toBe('recording')
  })

  it('start 时源已消失 → source_unavailable（重验证）', async () => {
    const d = makeFakeDeps()
    d.getSources = async () => FAKE_SOURCES.slice(0, 1) // start 前瞬间记事本关了
    svc = createScreenRecordService(d)
    const r = await svc.start({ sourceId: 'notepad' })
    expect(!r.ok && r.error).toBe('source_unavailable')
  })

  it('磁盘 < 500MB → insufficient_disk_space（不开流）', async () => {
    const d = makeFakeDeps()
    d.getFreeDiskBytes = async () => 499 * 1024 * 1024
    svc = createScreenRecordService(d)
    const r = await svc.start({ sourceId: 'lumii-id' })
    expect(!r.ok && r.error).toBe('insufficient_disk_space')
  })

  it('总开关 enabled=false → 四操作均 disabled', async () => {
    const d = makeFakeDeps({ enabled: false })
    svc = createScreenRecordService(d)
    expect((await svc.listSources()).ok).toBe(false)
    expect((await svc.start({ sourceId: 'lumii-id' })).error).toBe('disabled')
    expect((await svc.stop()).error).toBe('disabled')
    expect(svc.getStatus().error).toBe('disabled')
  })

  it('maxDurationSec > 7200 截断为 7200（不报错）', async () => {
    const d = makeFakeDeps()
    let captured: unknown = null
    d.notifyRendererStartCapture = (_, __, ___, max) => { captured = max }
    svc = createScreenRecordService(d)
    await svc.start({ sourceId: 'lumii-id', maxDurationSec: 99999 })
    expect(captured).toBe(7200)
  })
})
```

**Step 2: 跑确认失败**

```bash
cd apps/windows
npx vitest run src/main/screen-record/screen-record-service.test.ts
```
→ 红（文件不存在）。

**Step 3: 最小实现（ScreenRecordService 类工厂 + 状态机）**

`screen-record-service.ts` 要点：

```ts
/** ScreenRecordService 依赖（DIP，方便测） */
export interface ScreenRecordServiceDeps {
  /** 列出源（内部调 desktopCapturer.getSources + 标 isLumii） */
  getSources: (includeThumbnail: boolean) => Promise<ScreenRecordSource[]>
  /** 读取渲染进程设置 JSON（对齐 isAppUiControlEnabled 模式），返回 screenRecord.* 段或整份 */
  readSettings: () => Promise<{
    enabled: boolean; alwaysAllow: boolean; includeMicDefault: boolean; confirmTimeoutSec: number
  }>
  /** 录屏落盘根目录（= resolveWindowsClientDataRoot()/recordings），Task 1.2 前先传；测试可临时 */
  resolveRecordingsDir: () => string
  /** 启动时磁盘剩余字节数（目标为 resolveRecordingsDir 的所在卷） */
  getFreeDiskBytes: (dirPath: string) => Promise<number>
  /** 主进程侧：发 IPC 给渲染进程 ScreenRecordCapture 起流 */
  notifyRendererStartCapture: (sessionId: string, sourceId: string, includeMic: boolean, maxDurationSec: number) => void
  /** 主进程侧：通知渲染停止采集 */
  notifyRendererStopCapture: (sessionId: string) => void
  /** 主进程侧：通知取消 pending（pending_confirm 态用户拒绝/超时/stop） */
  notifyRendererCancelled: (sessionId: string, reason: ScreenRecordErrorCode) => void
  /** 主进程侧：弹 AI 确认弹窗给用户 */
  notifyRendererConfirmRequested: (payload: {
    sessionId: string; sourceName: string; sourceType: string; sourceId: string
    thumbnailDataUrl?: string; timeoutSec: number; startedAt: number
  }) => void
  /** 广播状态变化给 UI + 时间线 */
  emitStatusChanged: (detail: ScreenRecordStatusResult) => void
  /** 开文件句柄：返回写入绝对路径 + WriteStream 抽象；测试可注入 mock */
  createWriteStream: () => Promise<{ path: string; write: (buf: Uint8Array) => void; end: () => Promise<void>; bytesWritten: () => number }>
  /** 当前时间 ms（测试用 fake clock） */
  nowMs: () => number
}

/** 运行时状态（内部，不对外） */
interface InternalState {
  status: ScreenRecordStatus
  sessionId: string | null
  sourceId: string | null
  sourceName: string | null
  startedAt: number | null
  includeMic: boolean
  maxDurationSec: number
  /** 活跃写流句柄；idle/pending 态 null */
  writer: Awaited<ReturnType<ScreenRecordServiceDeps['createWriteStream']>> | null
  /** pending_confirm 开始时间；用于计算剩余倒计时 */
  confirmStartedAt: number | null
  /** pending 态 setTimeout 句柄；stop / 用户操作必须清掉避免泄漏 */
  confirmTimer: ReturnType<typeof setTimeout> | null
  /** stop → maxDuration 定时器句柄 */
  maxDurationTimer: ReturnType<typeof setTimeout> | null
  /** 累积 chunk 序号（校验顺序） */
  nextChunkIndex: number
  /** capture_failed 流结束异常原因（stop 时写入 partialPath） */
  captureFailedReason: string | null
}
```

工厂函数 `createScreenRecordService(deps)` 返回实现四个公开方法 + `handleChunk/handleStreamEnded/handleCaptureError/respondConfirm` 共 8 个方法的对象。**状态机只允许以下合法转移**，不合法转移一律返回 `{ok:false,error:'usage'}` 且不改内部 state：

```
idle + start(自身源 or alwaysAllow) → recording
idle + start(非自身)                 → pending_confirm
pending_confirm + 用户允许              → recording
pending_confirm + 用户拒绝/超时/stop    → idle
recording + stop/maxDuration/streamEnd → stopping → idle（finalize 后）
error + 任何操作                        → idle（reset 后再受理）
```

关键内部流程：
1. **Lumii 自身识别**：在 `getSources` 中（Task 1.2 落地）先取主窗口 `mainWindow.webContents.getMediaSourceId()`，与 `desktopCapturer.getSources` 的每项 id 对比；若主窗未初始化或无此 API，回退标题匹配（正则 `/灵栖|灵栖 Lumii|Lumii/`）。`isLumii` 字段写入 `ScreenRecordSource`。
2. **文件命名**：`recording-yyyyMMdd-HHmmss.webm`（本地时区，设计 §2.1 第七行）。路径为 `resolveRecordingsDir()` 返回值 + '/' + 文件名。
3. **chunk 接收校验**：接收 `screen-record:chunk` 时校验 `index === nextChunkIndex` 否则丢弃（避免乱序损坏容器）。`isLast=true` 不立即 close；等 `stop()` 明确调用或 `stream-ended` 后再 `end()`。
4. **确认超时**：进入 `pending_confirm` 时起 `setTimeout(confirmTimeoutSec * 1000)`；到时若仍在 pending，则走 `respondConfirm(allow=false, reason='confirmation_timeout')`。
5. **maxDuration 自动停**：进入 `recording` 时起 `setTimeout(maxDurationSec * 1000)` 到时 `stop()` 自动 finalize。
6. **before-quit flush**：`app.on('before-quit')`（由 Task 1.3 在 main/index.ts 注册）调用 `service.flushBeforeQuit()` → 若 status=recording/stopping/pending 立即 writer.end() 并切 idle，避免坏文件。
7. **webContents crashed/destroyed**：由 Task 1.3 在 main/index.ts 监听 renderer 对应事件，调 `service.handleRendererGone()` → recording 态时 writer.end() + 标 `capture_failed` + 切 error/idle。

**Step 4: 跑通过**

```bash
cd apps/windows
npx vitest run src/main/screen-record/screen-record-service.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 5: 提交**

```bash
git add apps/windows/src/main/screen-record/screen-record-service.ts \
  apps/windows/src/main/screen-record/screen-record-service.test.ts \
  apps/windows/src/main/screen-record/index.ts
git commit -m "feat(screen-record): 主进程 ScreenRecordService 状态机与纯函数（TDD 通过）"
```

---

### Task 1.2：接真实 Electron 依赖（desktopCapturer + 写盘 + 磁盘检查）+ 单目录 recordings 创建

**Files:**
- Modify: `apps/windows/src/main/screen-record/screen-record-service.ts` — 追加 `createRealScreenRecordServiceDeps(mainWindowRef, getRendererSettings)` 生产环境工厂
- Create: `apps/windows/src/main/client-data-root.ts`（若已存在则 modify；CLAUDE.md 已声明 `client-data-root.ts`，先 read 再改）— 追加 `resolveRecordingsDir()`
- Create: `apps/windows/src/main/screen-record/disk-space.ts` + `disk-space.test.ts` — 封装 Windows 卷剩余字节（drivetype 忽略网络盘）

**Step 1: 先读 `client-data-root.ts` 与 `main/index.ts` 中 resolveWindowsClientDataRoot 使用位置，确认路径一致性**

```bash
# 非测试命令，纯读取：先 read e:\my-project\open-source\lumii\apps\windows\src\main\client-data-root.ts
```

Step 1.5: `resolveRecordingsDir()` 实现要点：
```ts
import { RECORDINGS_DIRNAME } from '../shared/screen-record'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { accessSync } from 'node:fs'

export function resolveRecordingsDir(): string {
  const root = resolveWindowsClientDataRoot() // 该函数文件内已有
  const dir = join(root, RECORDINGS_DIRNAME)
  try { accessSync(dir) } catch { mkdirSync(dir, { recursive: true }) }
  return dir
}
```

**Step 2: disk-space.ts** 实现要点：Windows 下用 `node:os` + `GetDiskFreeSpaceExW` 原生无法直接调，MVP 用 **`child_process.execFile('wmic', ...)` 或 PowerShell 一行 `Get-PSDrive`** 二选一；优先 PowerShell（无 wmic 兼容问题）：

```ps1
Get-PSDrive -Name ((Split-Path -Qualifier "E:\foo") -replace ':$','') | Select-Object Free
```
解析返回的整数字节；若 cmdlet 失败（受限环境），回退 `fs.statfs` (Node 19+) 或直接 `fs.stat` 估 `10GB` **宽松放行**（不阻塞 MVP；错误码 `insufficient_disk_space` 由 500MB 阈值 → 松到 100MB 也可，但设计要求 500，优先 PowerShell）。

**Step 3: createRealScreenRecordServiceDeps** 要点：
- `getSources(includeThumbnail)` → `desktopCapturer.getSources({types:['screen','window'], thumbnailSize: includeThumbnail ? {width: 320, height: 180} : {width:0,height:0}})`；thumbnail 按需转 `data:image/png;base64,...`。
- 标记 isLumii：主窗口存在 → 取 `mainWindow.webContents.getMediaSourceId()`，对每条源 `.id === mediaSourceId` → true；或 fallback 源 `name.includes('灵栖') && type==='window'`；两者任一即 isLumii。
- `readSettings` → 复用 `getRendererSettingsJson()`（main/index.ts 或 bridge-permission-ipc-forward.ts 已有此函数；先搜索代码库再决定复用位置，若无可 copy 实现 + 注来源），JSON.parse 后取 `.screenRecord`，缺字段用 `SCREEN_RECORD_SETTINGS_DEFAULTS` 填。
- `createWriteStream` → 生成文件名 `recording-yyyyMMdd-HHmmss.webm`（`Intl.DateTimeFormat` 本地时区 + padding 0），`fs.createWriteStream(path)`，封装成接口。

**Step 4: 跑测试（服务测试仍用 fake deps；真实 dep 由手工验收）**

```bash
cd apps/windows
npx vitest run src/main/screen-record/screen-record-service.test.ts src/main/screen-record/disk-space.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 5: 提交**

```bash
git add apps/windows/src/main/screen-record/disk-space.ts \
  apps/windows/src/main/screen-record/disk-space.test.ts \
  apps/windows/src/main/screen-record/screen-record-service.ts \
  apps/windows/src/main/client-data-root.ts
git commit -m "feat(screen-record): 接真实 Electron 依赖：desktopCapturer 源识别、写盘、磁盘 500MB 预检"
```

---

### Task 1.3：main/index.ts 集成（实例化 + before-quit + renderer 崩溃监听）

**Files:**
- Modify: `apps/windows/src/main/index.ts` — 导入 createScreenRecordService + real deps 工厂；实例化单例；监听 renderer 崩溃 + app before-quit；注册 IPC handlers（与 Task 4.1 联动，但此处占 IPC 主进程侧注册坑位避免漏）
- Create: `apps/windows/src/main/screen-record/screen-record-ipc.ts` — IPC 注册集中文件（设计 §7 的 screen-record-ipc.ts 落点）

**Step 1: screen-record-ipc.ts 暴露 `registerScreenRecordIpc(service, mainWindow)`**，内部：
```ts
ipcMain.handle('screen-record:list-sources', (_, p) => service.listSources(p?.includeThumbnail))
ipcMain.handle('screen-record:start', (_, p) => service.start(p.params))
ipcMain.handle('screen-record:stop', () => service.stop())
ipcMain.handle('screen-record:status', () => service.getStatus())
ipcMain.on('screen-record:confirm-respond', (_, p) => service.respondConfirm(p))
ipcMain.on('screen-record:chunk', (_, p) => service.handleChunk(p))
ipcMain.on('screen-record:stream-ended', (_, p) => service.handleStreamEnded(p))
ipcMain.on('screen-record:capture-error', (_, p) => service.handleCaptureError(p))
```
**注意**：三处同步原则；此文件只注册主进程侧 handle/on，preload 和 renderer 在 Part 4 Task 4.1 补。

**Step 2: main/index.ts 集成点**：
- 实例化放在 `mainWindow` 创建完成之后（因为 getMediaSourceId 依赖主窗），在 `trayManager = new TrayManager(...)` 附近，保持同一作用域。
- `before-quit` 监听：已存在该监听就并到里面，service 不存在跳过。
- `mainWindow.webContents.on('crashed' / 'destroyed')`：监听两处，都调 `service.handleRendererGone()`。
- 导出 `getScreenRecordService()` accessor（对齐 Task 13 App UI 计划的 getAgentRuntimeBridge 模式），供 bridge-screen-record-tools.ts（Part 3）与托盘（Part 5）读取。

**Step 3: 构建通过**

```bash
cd apps/windows
pnpm typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/main/index.ts apps/windows/src/main/screen-record/screen-record-ipc.ts
git commit -m "feat(screen-record): main/index.ts 集成服务实例 + before-quit flush + renderer crash 监听"
```

---

## Part 2：渲染进程采集层 ScreenRecordCapture

### Task 2.1：ScreenRecordCapture 模块（getUserMedia + 混音 + MediaRecorder + 分片）

**Files:**
- Create: `apps/windows/src/renderer/screen-record/ScreenRecordCapture.ts`
- Create: `apps/windows/src/renderer/screen-record/index.ts`（桶导出）
- Create: `apps/windows/src/renderer/screen-record/mix-audio-tracks.test.ts`（纯函数：两轨合流 AudioContext mix 单测用 OfflineAudioContext）

**Step 1: 写失败测试（混音纯函数）**

`mix-audio-tracks.test.ts`: 测 `mixDesktopAudioWithMic(desktopTrack?, micTrack?)` 返回一个 destination track；无 desktop 时直接回 mic 单轨，无 mic 时回 desktop 原音（但 desktop 源本身无音，故 silent），两者都有时合成。MVP 要求画面 + 麦；系统声（desktop track 音轨）可能无也不报错。

**Step 2: ScreenRecordCapture 类实现要点**

```ts
export interface ScreenRecordCaptureDeps {
  /** 经 preload ElectronAPI 暴露的 sendCommand / onEvent / chunkUploader（三处同步后才有） */
  ipc: {
    sendChunk: (sessionId: string, chunkBase64: string, index: number, isLast: boolean) => void
    notifyStreamEnded: (sessionId: string) => void
    notifyCaptureError: (sessionId: string, reason: string) => void
  }
  nowMs: () => number
}

export class ScreenRecordCapture {
  private session: {
    sessionId: string
    mediaStream: MediaStream
    audioCtx: AudioContext | null
    mediaRecorder: MediaRecorder
    nextChunkIndex: number
    startTime: number
  } | null = null

  async start(params: { sessionId: string; sourceId: string; includeMic: boolean }): Promise<void> {
    // 1. desktop 流：必须用 chromeMediaSource='desktop' + chromeMediaSourceId
    //    约束：maxWidth/maxHeight 不限（显示器原生）；frameRate 默认 30
    const desktopStream = await navigator.mediaDevices.getUserMedia({
      audio: false, // 音频单独处理（设计 MVP 只麦，系统声不强制）
      video: {
        mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: params.sourceId, maxFrameRate: 30 },
      } as MediaTrackConstraints,
    })

    // 2. 麦轨（可选）：失败降级 silent，不整体失败（设计 §6 mic_unavailable → 无声继续）
    let micStream: MediaStream | null = null
    let micWarning = false
    if (params.includeMic) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      } catch {
        micWarning = true
      }
    }

    // 3. 混音（AudioContext.createMediaStreamDestination）
    //    只把 video track + 合成 audio track 塞给 MediaRecorder
    const outTracks: MediaStreamTrack[] = [...desktopStream.getVideoTracks()]
    const audioCtx = micStream ? new (window.AudioContext || (window as any).webkitAudioContext)() : null
    if (micStream && audioCtx) {
      const micSrc = audioCtx.createMediaStreamSource(micStream)
      const dest = audioCtx.createMediaStreamDestination()
      micSrc.connect(dest)
      // 如果 desktop 源碰巧有音频（系统声未来接入）也一并混进 dest，目前 desktop audio=false 所以无
      outTracks.push(...dest.stream.getAudioTracks())
    }
    const combined = new MediaStream(outTracks)

    // 4. MediaRecorder 明确指定 webm vp8 opus；浏览器不支持时报错 capture_failed
    const mimeType = pickSupportedMime(['video/webm;codecs=vp8,opus','video/webm;codecs=vp8','video/webm'])
    if (!mimeType) throw new Error('capture_failed: no webm encoder')

    const mr = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 2_500_000 })
    this.session = { sessionId: params.sessionId, mediaStream: combined, audioCtx, mediaRecorder: mr, nextChunkIndex: 0, startTime: deps.nowMs() }

    // 5. ondataavailable → base64 编码 → 超 2MB 拆分 → ipc.sendChunk
    mr.ondataavailable = (e) => {
      if (!this.session || e.data.size === 0) return
      this.emitChunk(e.data, false)
    }
    mr.onerror = () => deps.ipc.notifyCaptureError(params.sessionId, 'media_recorder_error')
    mr.start(MEDIA_RECORDER_TIMESLICE_MS) // 设计 §2.2 2–5s，常量 3000

    // 6. desktop 视频轨 ended（目标窗口最小化/关闭 → 部分 Electron 版本触发）
    desktopStream.getVideoTracks()[0].addEventListener('ended', () => {
      deps.ipc.notifyStreamEnded(params.sessionId)
      this.stopInternal(true) // true = 是 ended 触发，stop() 不要重复 finalize
    })
  }

  async stop(): Promise<{ recordedMs: number }> {
    if (!this.session) return { recordedMs: 0 }
    // MediaRecorder.stop() → 触发最后一次 ondataavailable(isLast=true) + onstop
    return await this.stopInternal(false)
  }

  private emitChunk(blob: Blob, forceLast: boolean) { /* base64 编码 + 超 2MB 拆 */ }
}
```

**关键约束（设计 §2.2 原文照做，一个字不能省）**：
- chunk interval 3000 ms（常量 MEDIA_RECORDER_TIMESLICE_MS）
- 单 chunk > 2 MB → 拆分再发 IPC，避免阻塞
- 监听 stream ended → IPC 通知主进程
- 两路混轨 < 500ms 轻微时间偏移，MVP 接受，**不要自行做音频延迟补偿**

**Step 3: 类型检查 + 纯测试通过**

```bash
cd apps/windows
npx vitest run src/renderer/screen-record/mix-audio-tracks.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/renderer/screen-record/ScreenRecordCapture.ts \
  apps/windows/src/renderer/screen-record/index.ts \
  apps/windows/src/renderer/screen-record/mix-audio-tracks.test.ts
git commit -m "feat(screen-record): 渲染进程 ScreenRecordCapture 采集混音与分片"
```

---

## Part 3：AI 四工具桥接

### Task 3.1：bridge-screen-record-tools.ts 注册四工具（模式对齐 bridge-app-ui-tools.ts）

**Files:**
- Create: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts`
- Create: `apps/windows/src/main/agent-runtime/bridge-screen-record-tools.test.ts`
- Modify: `apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts` — `registerAll()` 追加 `registerScreenRecordTools()` 调用（设计 §7：bridge-screen-record-tools）

**Step 1: 写失败测试**

`bridge-screen-record-tools.test.ts`（mock service）：
```ts
// 覆盖：
// 1. 四工具名正确：screen_record_list_sources / screen_record_start / screen_record_stop / screen_record_status
// 2. list_sources includeThumbnail 默认 false（不传时 service 收到 false）
// 3. start maxDurationSec=99999 → 在 bridge 层截断 7200（或留给 service 做但测试要一致）
// 4. stop idle 返回 no_active_session（幂等，工具层 ok:false error 原样透传，不抛）
// 5. 总开关 enabled=false 时四工具均 disabled（service.getStatus/start/list 调用前短路）
```

**Step 2: bridge-screen-record-tools.ts 实现（模式 100% 参考 bridge-app-ui-tools.ts）**

```ts
import { Type } from '@sinclair/typebox'
import { ToolRegistry, createMtBotTool, type ToolExecutionContext, type MtBotTool } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { ScreenRecordService } from '../screen-record'
import { MAX_DURATION_SEC_CAP } from '../../shared/screen-record'

export interface RegisterScreenRecordToolsDeps {
  getService: () => ScreenRecordService | null
}

export function registerScreenRecordTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  deps: RegisterScreenRecordToolsDeps,
): void {
  const get = () => deps.getService()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(createMtBotTool({
    name: 'screen_record_list_sources', label: 'Screen Record List Sources', category: 'channel' as const,
    description:
      '列出可录制的整屏和窗口源（含 Lumii 自身）。' +
      '默认 includeThumbnail=false 不返回缩略图，节省 token；需要缩略图区分时显式传 true。' +
      'isLumii=true 的源是 Lumii 自身窗口，无需用户确认即可录制。',
    parameters: Type.Object({
      includeThumbnail: Type.Optional(Type.Boolean({ description: '是否返回每张源的缩略图（base64 PNG，每张 10-50KB，默认 false）' })),
    }),
    isReadOnly: true, needsPermission: false,
    execute: async (_id, rawParams) => {
      const svc = get(); if (!svc) return jsonToolResult({ ok: false, error: 'disabled' })
      const p = rawParams as { includeThumbnail?: boolean }
      try { return jsonToolResult(await svc.listSources(p.includeThumbnail)) }
      catch { return jsonToolResult({ ok: false, error: 'capture_failed' }) }
    },
  }, ctx))

  // screen_record_start：参数与设计 §3.1 第二行严格一致
  // screen_record_stop：无参数
  // screen_record_status：无参数
}
```

其余三工具按设计 §3.1 表对应实现。所有工具 `execute` 统一 try-catch，未知异常→ `capture_failed`，不抛给 Agent 循环。**`isReadOnly` 和 `needsPermission` 值（设计 §3 没明确但按风险分级）：**
- `list_sources`：isReadOnly=true, needsPermission=false
- `start`：isReadOnly=false, needsPermission=true（需走确认弹窗管线）
- `stop`：isReadOnly=false, needsPermission=false
- `status`：isReadOnly=true, needsPermission=false

bridge-tool-registrar.ts 的 `registerAll()` 末尾在 `registerAppUiTools()` 下一行调用：

```ts
// screen-record 四工具（始终注册，内部总开关由 screenRecord.enabled 决定是否真执行）
this.registerScreenRecordTools()
```
并新增 `private registerScreenRecordTools()` 方法，内部调用 `registerScreenRecordTools(toolRegistry, toolContext, { getService: () => getScreenRecordService() })`。`getScreenRecordService()` 是 Task 1.3 main/index.ts 导出的 accessor，import 加在 bridge-tool-registrar.ts 顶部（保持同一 import 组）。

**Step 3: 测试 + 类型**

```bash
cd apps/windows
npx vitest run src/main/agent-runtime/bridge-screen-record-tools.test.ts
pnpm --filter @mtbot/windows typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/main/agent-runtime/bridge-screen-record-tools.ts \
  apps/windows/src/main/agent-runtime/bridge-screen-record-tools.test.ts \
  apps/windows/src/main/agent-runtime/bridge-tool-registrar.ts
git commit -m "feat(screen-record): AI 四工具桥接 screen_record_list_sources/start/stop/status"
```

---

## Part 4：IPC 三处同步 + 简易 UI 面板

### Task 4.1：三处同步（preload ElectronAPI + 渲染进程封装）

**Files:**
- Modify: `apps/windows/src/preload/index.ts` — `contextBridge.exposeInMainWorld('electronAPI', ...)` 追加 `screenRecord` 对象（方法名与 main/ipc 一一对应）
- Modify: `apps/windows/src/preload/index.ts` 顶部类型 `ElectronAPI` interface（如果在本文件内；否则在 shared/*.d.ts 搜位置）追加 screenRecord 方法签名
- Create: `apps/windows/src/renderer/services/screen-record-api.ts` — render 侧对 ElectronAPI.screenRecord 的薄封装（类型安全），subscribe 事件复用 voiceEventSubscribers 单路复用模式

**Step 1: preload 暴露（严格三处同步检查表）**

| Main IPC (ipcMain.handle/on) | Preload ElectronAPI 方法 | Renderer screen-record-api.ts 函数 |
|---|---|---|
| handle('screen-record:list-sources') | `screenRecord.listSources(p): Promise<ListResult>` | `listSources(includeThumbnail?)` |
| handle('screen-record:start') | `screenRecord.start(params): Promise<StartResult>` | `start(params)` |
| handle('screen-record:stop') | `screenRecord.stop(): Promise<StopResult>` | `stop()` |
| handle('screen-record:status') | `screenRecord.status(): Promise<StatusResult>` | `status()` |
| on('screen-record:confirm-respond') | `screenRecord.respondConfirm(p): void`（send，不是 invoke） | `respondConfirm(sessionId, allow, remember?)` |
| on('screen-record:chunk') | `screenRecord.sendChunk(p): void` | `sendChunk(...)` |
| on('screen-record:stream-ended') | `screenRecord.notifyStreamEnded(p): void` | `notifyStreamEnded()` |
| on('screen-record:capture-error') | `screenRecord.notifyCaptureError(p): void` | `notifyCaptureError()` |
| **(事件，反向)** main→renderer | （事件订阅） preload 提供 `screenRecord.addEventListener(cb)` / `removeEventListener(cb)` | `onEvent(cb): () => void` 单路复用 |

**Step 2: 事件单路复用实现**：完全照抄 `preload/index.ts` 的 `voiceEventSubscribers` 模式（搜索 voiceEventSubscribers 即可见），建 `screenRecordEventSubscribers`，一条 `ipcRenderer.on('screen-record:event:*'` 广播到 Set，避免 Subscriber 过多 MaxListenersExceeded。

**Step 3: 类型检查**

```bash
cd apps/windows
pnpm typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/preload/index.ts \
  apps/windows/src/renderer/services/screen-record-api.ts
git commit -m "feat(screen-record): IPC 三处同步 — main/preload/renderer 九层方法对应"
```

---

### Task 4.2：轻量面板（Popover）+ AI 触发确认弹窗

**Files:**
- Create: `apps/windows/src/renderer/components/ScreenRecord/ScreenRecordPanel.tsx`（简易面板）
- Create: `apps/windows/src/renderer/components/ScreenRecord/ScreenRecordConfirmDialog.tsx`（确认弹窗）
- Create: `apps/windows/src/renderer/components/ScreenRecord/index.ts`
- Create: `apps/windows/src/renderer/hooks/useScreenRecord.ts`（状态订阅 + 单例 capture）
- Optional CSS: 复用 `SettingsHub/SettingsHubModal.module.css` 或 `ModalBase`（搜索 `ModalBase` 找弹层组件）

**Step 1: useScreenRecord.ts hook**

```ts
// 单例模式：整个 renderer 一个 ScreenRecordCapture；组件卸载不销毁（录屏不跟组件生死走）
// 订阅 screenRecordApi.onEvent → 本地 React 状态
// 暴露：sources, status, start, stop, respondConfirm, lastRecording { path, size, duration }
```

**Step 2: ScreenRecordPanel（设计 §4.2 轻量面板 6 条）**

1. 源选择：screen/window 分组 + 搜索框（input onInput 过滤 name）；Lumii 自身源置顶 + 标签「本窗（免确认）」。
2. 「包含麦克风」开关：默认值 = 设置 `screenRecord.includeMicDefault`（useSettings().settings.screenRecord.includeMicDefault）。
3. 开始/停止按钮 + 录制中 `formatDuration(elapsedMs)` 计时（MM:SS，>1h 显示 H:MM:SS）。
4. 最近一条成片：展示 `lastRecording.path`（相对 `~/.lumii`，过长截断中间加省略号）+「打开文件夹」按钮（`shell.showItemInFolder` 经 ElectronAPI 暴露，若无则写 `openExplorer: (p)=>ipcRenderer.send('shell:show-item', p)`）。
5. 「始终允许录屏」开关：双向绑定 useSettings().settings.screenRecord.alwaysAllow，onChange `saveSettings({ screenRecord: { alwaysAllow: v } })`。
6. 空状态：无录制中 + 无成片时，展示占位「尚未录制」。

**Step 3: ScreenRecordConfirmDialog（设计 §4.3 AI 触发确认弹窗 5 条）**

1. 文案：`AI 请求录制「{sourceName}」`，sourceType（屏幕/窗口）显示图标。
2. 缩略图：若 `thumbnailDataUrl` 非空，居中展示 320x180 缩略；空则占位矩形。
3. 允许 / 拒绝按钮；允许复选框「始终允许 Lumii Agent 录屏（本次开始生效）」→ checked 时 respondConfirm 带 `rememberAlwaysAllow=true`，Service 保存到 settings（注意：settings 是 localStorage，main 侧 readSettings 要重新读才能生效；Service 的 rememberAlwaysAllow 实现：`respondConfirm` 内 → 若 remember=true → 发 IPC 给 renderer saveSettings 或主进程侧直接写 JSON 到同一文件；MVP 优先发 IPC → renderer useSettings().update()）。
4. 倒计时：基于 event.confirmStartedAt + timeoutSec，每秒刷新剩余秒数，到 0 自动拒绝。
5. 超时未操作 → 调用 respondConfirm(allow=false, reason 由 Service 内部 confirmation_timeout 统一触发，Dialog 不用自己发拒绝)。

**Step 4: 接主入口** → 面板先挂在 SettingsHub 内作为一个独立子页（或作为 ChatPage 顶栏按钮 Popover，由 Part 5 决定）；MVP 先挂到 `SettingsHubModal.tsx` 新增分类「录屏」（对齐 `MergedSettingsCategory` 已有枚举，如果硬编码可暂用 `'screenRecord'` 字符串）。确认弹窗全局挂载到 `App.tsx` 的根 Modal 层，由 useScreenRecord 的 `pendingConfirm` state 控制显示。

**Step 5: 类型检查 + 构建**

```bash
cd apps/windows
pnpm typecheck
```

**Step 6: 提交**

```bash
git add apps/windows/src/renderer/components/ScreenRecord/ScreenRecordPanel.tsx \
  apps/windows/src/renderer/components/ScreenRecord/ScreenRecordConfirmDialog.tsx \
  apps/windows/src/renderer/components/ScreenRecord/index.ts \
  apps/windows/src/renderer/hooks/useScreenRecord.ts
git commit -m "feat(screen-record): 简易面板（源选择/开关/成片） + AI 确认弹窗（缩略图/倒计时）"
```

---

## Part 5：托盘 + 顶栏入口 + 设置接入

### Task 5.1：托盘菜单动态项（开始/停止录屏 + 红点提示）

**Files:**
- Modify: `apps/windows/src/main/tray-manager.ts` — 构造函数 config 追加两个回调 `onStartScreenRecord: () => void`、`onStopScreenRecord: () => void`；新增方法 `updateScreenRecordState(isRecording: boolean, elapsedMs?: number)`；`updateContextMenu()` 根据 isRecording 切换菜单项。
- Modify: `apps/windows/src/main/index.ts` — 实例化 trayManager 时传 onStartScreenRecord（若当前 idle 则 mainWindow 调 IPC 打开面板并 bringToFront；已有源则直接问上次源？MVP 只打开面板）、onStopScreenRecord（调 service.stop()，不在乎返回）；并订阅 Service 的 emitStatusChanged → trayManager.updateScreenRecordState。

**托盘菜单项变更点：**

```
显示窗口
-------------------
（宠物模式项保留）
录屏子菜单 →
  （recording 时） 停止录屏 (⏱ 00:42)
  （idle 时）      开始录屏…
-------------------
设置 / 退出
```

点「开始录屏…」时：
- 若当前无预选 sourceId（service.status.sourceId 为 idle 一般无）→ 打开主窗口 → 调 `mainWindow.webContents.send('screen-record:open-panel')` → renderer 监听后展开 Panel（App.tsx 内监听）。不可静默失败，必须让用户看到源选择面板。**不能直接 start 默认第一个屏**（没源会 source_unavailable 或用户不知在录哪屏，设计 §4.1 托盘第二段明确要求）。

**Step 3: 构建通过**

```bash
cd apps/windows
pnpm typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/main/tray-manager.ts apps/windows/src/main/index.ts
git commit -m "feat(screen-record): 托盘菜单录屏项（recording 倒计时 + idle 打开面板选择源）"
```

---

### Task 5.2：主窗口顶栏录屏入口 + 录制中红点计时

**Files:**
- Modify: `apps/windows/src/renderer/components/layout/Topbar/Topbar.tsx`（或搜 `Topbar.tsx` 的实际路径；先 Grep 确认路径）— 在设置按钮旁加图标按钮（录屏 icon 用 lucide-react `Video` / `VideoOff`；没装 lucide 就 SVG inline）+ 状态 badge（红点「● REC」+ 计时 MM:SS，recording 态显示）
- 点击顶栏按钮：idle 态展开 ScreenRecordPanel（同上发事件或 import Panel 直接受控 open）；recording 态弹确认「停止当前录制？」→ stop()。
- 顶栏录屏状态刷新：useScreenRecord().status

**Step 1: Grep Topbar.tsx 真实路径**，确认后再改（避免盲改路径错）。

**Step 2: 图标**：若项目未引入 lucide，用内联 SVG 画摄像机和圆形红色 REC；样式复用 Sidebar 按钮。

**Step 3: 类型检查 + 热重启看效果（非必须测试，手测在 Part 6 做）**

```bash
cd apps/windows
pnpm typecheck
```

**Step 4: 提交**

```bash
git add apps/windows/src/renderer/components/layout/Topbar/Topbar.tsx
git commit -m "feat(screen-record): 顶栏录屏按钮 + recording 中 REC 红点与 MM:SS 计时"
```

---

### Task 5.3：设置页「录屏」小节接入（四设置键）

**Files:**
- Modify: `apps/windows/src/renderer/components/SettingsHub/SettingsHubModal.tsx`（或 SettingsPage 下的 `PrivacyPanel`/`GeneralPanel`；MVP 放隐私设置区较合适）— 追加四行开关/数字输入：
  1. 总开关「启用录屏功能」（screenRecord.enabled，关闭后四工具全 disabled）
  2. 始终允许（AI 非自身源免确认）：带警告色副标题「开启后 Agent 可不经确认录制除本软件外的任意屏幕与窗口，请谨慎」
  3. 默认包含麦克风（新录制时 includeMic 开关默认值）
  4. AI 触发确认弹窗超时秒数：`<input type="number" min=10 max=600 step=5>`，值=confirmTimeoutSec

所有字段与 useSettings.ts 的 settings.screenRecord 双向绑定；修改后立即保存。关闭总开关时，顶栏图标置灰且 tooltip 显示「录屏功能已关闭，请到设置启用」。

**Step 2: 类型检查**

```bash
cd apps/windows
pnpm typecheck
```

**Step 3: 提交**

```bash
git add apps/windows/src/renderer/components/SettingsHub/SettingsHubModal.tsx
git commit -m "feat(screen-record): 设置页四键（enabled/alwaysAllow/includeMicDefault/confirmTimeoutSec）"
```

---

## Part 6：测试补齐 + MVP 整体验收

### Task 6.1：补齐 screen-record-service.test.ts 剩余用例（设计 §9.1 清单全部 12 条）

**Files:**
- Modify: `apps/windows/src/main/screen-record/screen-record-service.test.ts` — 追加：
  1. 两个快速 start 并发保护（同一 tick 下两次 await，第二次必须 already_recording）
  2. 确认超时（fake timers：fake setTimeout 到 confirmTimeoutSec + 1ms → status = idle，result = confirmation_timeout）
  3. before-quit flush（recording 态调 flushBeforeQuit → writer.end() 被调，status=idle）
  4. handleRendererGone（模拟 renderer crashed → writer.end()，stop 返回 `{ ok:false, error:'capture_failed', partialPath }`，且文件仍可播放（mock writer 已写 3 块则 bytes>0 即可）
  5. 写盘失败（writer.write 抛 → service.handleChunk 切 error 态；下次 stop 返回 write_failed）
  6. 停录后文件大小为 0 → capture_failed + 删除空文件（mock fs.unlink 确认调用）
  7. permission_denied（pending_confirm 中 respondConfirm(allow=false) → status=idle，start 结果 reason=permission_denied）

**Step 2: 跑**

```bash
cd apps/windows
npx vitest run src/main/screen-record/screen-record-service.test.ts
```

**Step 3: 提交**

```bash
git add apps/windows/src/main/screen-record/screen-record-service.test.ts
git commit -m "test(screen-record): 补齐 service 12 条单测（并发/超时/flush/crash/写盘/空文件）"
```

---

### Task 6.2：自动化回归（typecheck + 全部 screen-record 测试）

**Files:**（无新增，纯命令）

```bash
# Workspace 根
pnpm typecheck
cd apps/windows
npx vitest run src/shared/screen-record.test.ts \
  src/main/screen-record \
  src/main/agent-runtime/bridge-screen-record-tools.test.ts \
  src/renderer/screen-record
pnpm lint --filter @mtbot/windows
```

任一红 → 修到全绿再进入手工。

**提交：** 若修了 bug 才提交；无 bug 跳过 commit。

---

### Task 6.3：MVP 手工验收（设计 §9.3 清单 14 条，逐条过不跳过）

**前置条件：** `pnpm dev` 起 dev；准备两个显示器或至少一个第三方窗口（记事本/资源管理器）开着；麦克风可用但随时可拔测降级。

打开终端按序执行：

| # | 验收项（设计 §9.3 原文） | 操作 | 期望 | 记录通过/失败 |
|---|---|---|---|---|
| 1 | 能录整屏与指定非 Lumii 窗口，得到可播放 WebM | 面板选 Screen 1 → 开始 → 3s → 停止；文件双击用 VLC/浏览器打开 | 播放 3 秒画面无损坏；大小 > 0 | [ ] |
| 2 | 能录 Lumii 自身且不弹确认 | 面板选「灵栖 Lumii（本窗）」→ 开始 | 无确认弹窗；立即进入 recording；3s 停后成片可播 | [ ] |
| 3a | 非自身源默认弹确认 | AI 工具：`screen_record_start {sourceId of 记事本}` | 渲染进程弹 ScreenRecordConfirmDialog | [ ] |
| 3b | 始终允许生效；可撤销 | 勾选「始终允许」后允许 → 再 AI start 同一源 → 设置关 alwaysAllow → 再 AI start | 第 2 次不弹窗；第 3 次又弹 | [ ] |
| 4a | 麦克风开 | includeMic=true 说话 3 秒 → 成片播 | 有清晰人声（可能轻微 <500ms 偏移，MVP 接受） | [ ] |
| 4b | 麦失败时无声降级 | 录制中拔麦（或设备管理器禁用）→ 开录 | 不整体失败；成片有画面无音；stop 返回 warning='mic_muted'（若 UI 展示） | [ ] |
| 5 | AI 四工具闭环：list→start→stop→路径 | 在对话框连续发「列出录屏源→用第一个非自身开始录 5 秒→停」 | 工具返回 { ok, path, durationMs≈5000, bytes>0 } | [ ] |
| 6 | list_sources 默认无缩略图 | AI 传 `{}` 调 list_sources | 返回 sources[].thumbnailDataUrl 全 '' | [ ] |
| 6b | includeThumbnail:true 有缩略图 | AI 传 `{includeThumbnail:true}` | 每条源 thumbnailDataUrl 非空且以 `data:image/png;base64,` 开头 | [ ] |
| 7 | start sourceId 已失效立即返回 source_unavailable | 打开记事本 → list 拿到 sourceId → 关记事本 → start 用该 id | `{ok:false,error:'source_unavailable'}` | [ ] |
| 8 | 磁盘 <500MB start 前拒绝（mock 测过；手工可改磁盘空间逻辑放临时日志确认走分支） | 临时把 MIN_FREE_DISK_BYTES 改到超大 → 重启 dev → 开始录 | `insufficient_disk_space`；确认不产生空文件 | [ ]（再改回原值）|
| 9 | 目标窗口录制中关闭时自动 finalize 并返回 stream_ended | 开录记事本 → 录 2 秒后手动关闭记事本 | service 态自动 stopping→idle；成片路径存在；错误码=stream_ended 但 bytes>0 | [ ] |
| 10 | renderer 崩溃时主进程自动 finalize（模拟：devtools 控制台输入 `window.close()` 不行；用进程管理器 kill Renderer 子进程，或 Task 1.3 fake 触发 handleRendererGone）| 开录 2s → kill renderer 子进程 | 主进程日志 capture_failed；recordings/ 下文件 >0 且可播（最后一帧停住） | [ ] |
| 11 | 简易 UI / 托盘可开始停止；状态指示有 | 托盘「开始录屏…」→ 面板选源开始；顶栏 REC+计时；托盘「停止录屏」→ 成片生成 | UI 与托盘状态一致；无卡死 | [ ] |
| 12 | 托盘点开始录屏无预选源时打开面板（设计 §4.1 托盘句末）| 退出 app 重启 → 第一下托盘点「开始录屏…」 | 主窗显示 + ScreenRecordPanel 展开，无静默 start | [ ] |
| 13 | 文件落在 `{dataRoot}/recordings/`，文件名格式 recording-yyyyMMdd-HHmmss.webm | 打开 `~/.lumii/recordings/`（路径按实际 resolveRecordingsDir 返回）| 目录存在；最新文件正则 `/^recording-\d{8}-\d{6}\.webm$/` 匹配 | [ ] |
| 14 | stop 在 idle 幂等（不报错） | 不录 → 直接 AI `screen_record_stop` | 返回 `{ ok:false, error:'no_active_session' }`，Agent 不视为异常 | [ ] |

**14 条全部通过，MVP 完成。任一条不通过 → 回 Part 对应 Task 修，修好重跑整份清单。**

最终提交（如无其它改动可跳过 commit；若手测中修了 bug，单独 commit 并在消息里列修点）：

```bash
git add -A
git commit -m "feat(screen-record): MVP 验收通过（设计 14 条全绿）"
```

---

## 已知限制（开发时不得超范围修，只注释在代码里 MVP 不实现）

对照设计 §6 末尾三条，开发中如果碰到下列情况，**不要自行试图修**，只在对应代码附近加一行中文注释标「MVP 已知限制：xxx（设计 §6）」，保持原样交付：

1. 窗口最小化可能黑屏 → 不修；面板 UI 启动 start 前加一行轻提示文字：「提示：录制单窗口时，请保持目标窗口可见，最小化可能导致黑屏」
2. 多显示器 Electron 命名 Screen 1 / Screen 2 → 不修；list_sources 返回 name 原样
3. 音画时间偏移 <500ms → 不修；MediaRecorder 启动后立即开始，不做 AudioContext delay 补偿

## 执行方式

1. 新建 git worktree 或分支：`git checkout -b feat/screen-record`
2. 使用 `executing-plans` skill 按 Task 顺序串行：Part 0 → Part 1 Task 1.1/1.2/1.3 → Part 2 Task 2.1 → Part 3 Task 3.1 → Part 4 Task 4.1/4.2 → Part 5 Task 5.1/5.2/5.3 → Part 6 Task 6.1/6.2/6.3
3. 每完成一个 Task 立即提交；Part 6.3 手测完 14 条绿再合 PR
4. **任何偏离都要先改 docs/plans/2026-08-15-screen-record-implementation.md 并 commit，再改代码**（计划是唯一真源，代码服从计划，不允许先写码再补计划）
