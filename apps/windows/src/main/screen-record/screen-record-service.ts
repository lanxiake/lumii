/**
 * ScreenRecordService — 主进程录屏会话编排（状态机 / 确认 / 写盘）
 * 设计：docs/design/2026-08-15-screen-record-design.md §2.1
 */

import { randomUUID } from 'node:crypto'
import type {
  ScreenRecordConfig,
  ScreenRecordErrorCode,
  ScreenRecordListSourcesResult,
  ScreenRecordSource,
  ScreenRecordStartParams,
  ScreenRecordStartResult,
  ScreenRecordStatus,
  ScreenRecordStatusResult,
  ScreenRecordStopResult,
} from '../../shared/screen-record'
import {
  MAX_DURATION_SEC_CAP,
  MIN_FREE_DISK_BYTES,
  SCREEN_RECORD_SETTINGS_DEFAULTS,
} from '../../shared/screen-record'

/** 写流抽象（测试可注入 mock） */
export interface ScreenRecordWriteStream {
  path: string
  /** 追加写入一块数据 */
  write: (buf: Uint8Array) => void
  /** 关闭流并 flush */
  end: () => Promise<void>
  /** 已写入字节数 */
  bytesWritten: () => number
  /** 若文件为空则删除并返回 true */
  unlinkIfEmpty: () => Promise<boolean>
}

/** ScreenRecordService 依赖（DIP，方便测） */
export interface ScreenRecordServiceDeps {
  /** 列出源（内部调 desktopCapturer.getSources + 标 isLumii） */
  getSources: (includeThumbnail: boolean) => Promise<ScreenRecordSource[]>
  /** 读取录屏设置段 */
  readSettings: () => Promise<ScreenRecordConfig>
  /** 录屏落盘根目录 */
  resolveRecordingsDir: () => string
  /** 启动时磁盘剩余字节数 */
  getFreeDiskBytes: (dirPath: string) => Promise<number>
  /** 通知渲染进程开流 */
  notifyRendererStartCapture: (
    sessionId: string,
    sourceId: string,
    includeMic: boolean,
    maxDurationSec: number,
  ) => void
  /** 通知渲染停止采集 */
  notifyRendererStopCapture: (sessionId: string) => void
  /** 通知取消 pending */
  notifyRendererCancelled: (sessionId: string, reason: ScreenRecordErrorCode) => void
  /** 弹 AI 确认弹窗 */
  notifyRendererConfirmRequested: (payload: {
    sessionId: string
    sourceName: string
    sourceType: string
    sourceId: string
    thumbnailDataUrl?: string
    timeoutSec: number
    startedAt: number
  }) => void
  /** 广播状态变化 */
  emitStatusChanged: (detail: ScreenRecordStatusResult) => void
  /** 开文件写流 */
  createWriteStream: () => Promise<ScreenRecordWriteStream>
  /** 当前时间 ms */
  nowMs: () => number
  /** 测试用：推进时钟（可选） */
  advanceMs?: (ms: number) => void
  /** 用户勾选「始终允许」时持久化设置 */
  persistAlwaysAllow?: (value: boolean) => Promise<void>
}

/** 运行时内部状态 */
interface InternalState {
  status: ScreenRecordStatus
  sessionId: string | null
  sourceId: string | null
  sourceName: string | null
  sourceType: 'screen' | 'window' | null
  isLumii: boolean
  startedAt: number | null
  includeMic: boolean
  maxDurationSec: number
  writer: ScreenRecordWriteStream | null
  confirmStartedAt: number | null
  confirmTimeoutSec: number
  confirmTimer: ReturnType<typeof setTimeout> | null
  maxDurationTimer: ReturnType<typeof setTimeout> | null
  nextChunkIndex: number
  captureFailedReason: string | null
  micMuted: boolean
  lastFinalizeError: ScreenRecordErrorCode | null
  /** start 互斥锁，防止并发叠态 */
  startLock: boolean
}

/** 对外服务接口 */
export interface ScreenRecordService {
  listSources: (includeThumbnail?: boolean) => Promise<ScreenRecordListSourcesResult>
  start: (params: ScreenRecordStartParams) => Promise<ScreenRecordStartResult>
  stop: () => Promise<ScreenRecordStopResult>
  getStatus: () => ScreenRecordStatusResult
  respondConfirm: (p: {
    sessionId: string
    allow: boolean
    rememberAlwaysAllow?: boolean
  }) => Promise<void>
  handleChunk: (p: {
    sessionId: string
    chunkBase64: string
    index: number
    isLast: boolean
  }) => Promise<void>
  handleStreamEnded: (p: { sessionId: string }) => Promise<void>
  handleCaptureError: (p: { sessionId: string; reason: string }) => Promise<void>
  handleRendererGone: () => Promise<void>
  flushBeforeQuit: () => Promise<void>
}

/** 创建空闲初始状态 */
function createIdleState(): InternalState {
  return {
    status: 'idle',
    sessionId: null,
    sourceId: null,
    sourceName: null,
    sourceType: null,
    isLumii: false,
    startedAt: null,
    includeMic: true,
    maxDurationSec: 1800,
    writer: null,
    confirmStartedAt: null,
    confirmTimeoutSec: SCREEN_RECORD_SETTINGS_DEFAULTS.confirmTimeoutSec,
    confirmTimer: null,
    maxDurationTimer: null,
    nextChunkIndex: 0,
    captureFailedReason: null,
    micMuted: false,
    lastFinalizeError: null,
    startLock: false,
  }
}

/**
 * 工厂：创建 ScreenRecordService 实例（单一活跃会话）。
 */
export function createScreenRecordService(deps: ScreenRecordServiceDeps): ScreenRecordService {
  let state = createIdleState()

  /** 清除确认超时定时器 */
  function clearConfirmTimer(): void {
    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer)
      state.confirmTimer = null
    }
  }

  /** 清除最大时长定时器 */
  function clearMaxDurationTimer(): void {
    if (state.maxDurationTimer) {
      clearTimeout(state.maxDurationTimer)
      state.maxDurationTimer = null
    }
  }

  /** 重置为 idle（不关写流；调用方需先 finalize） */
  function resetToIdle(): void {
    clearConfirmTimer()
    clearMaxDurationTimer()
    state = createIdleState()
  }

  /** 构建当前 status 快照 */
  function buildStatusDetail(): ScreenRecordStatusResult {
    if (state.status === 'idle' && !state.sessionId) {
      return { ok: true, status: 'idle' }
    }
    const now = deps.nowMs()
    const elapsedMs =
      state.startedAt != null ? Math.max(0, now - state.startedAt) : undefined
    let confirmTimeoutSec: number | undefined
    if (state.status === 'pending_confirm' && state.confirmStartedAt != null) {
      const elapsed = Math.floor((now - state.confirmStartedAt) / 1000)
      confirmTimeoutSec = Math.max(0, state.confirmTimeoutSec - elapsed)
    }
    return {
      ok: true,
      status: state.status,
      sessionId: state.sessionId ?? undefined,
      sourceId: state.sourceId ?? undefined,
      sourceName: state.sourceName ?? undefined,
      elapsedMs,
      startedAt: state.startedAt ?? undefined,
      pendingConfirm: state.status === 'pending_confirm',
      confirmTimeoutSec,
      confirmStartedAt: state.confirmStartedAt ?? undefined,
      includeMic: state.includeMic,
    }
  }

  /** 广播状态变化 */
  function emitStatus(): void {
    deps.emitStatusChanged(buildStatusDetail())
  }

  /** 关闭写流并返回 path/bytes；空文件删除并标 capture_failed */
  async function finalizeWriter(
    errorHint?: ScreenRecordErrorCode,
  ): Promise<{ path: string; bytes: number; error?: ScreenRecordErrorCode }> {
    const writer = state.writer
    if (!writer) {
      return { path: '', bytes: 0, error: errorHint ?? 'no_active_session' }
    }
    try {
      await writer.end()
    } catch {
      return { path: writer.path, bytes: writer.bytesWritten(), error: 'write_failed' }
    }
    const bytes = writer.bytesWritten()
    if (bytes === 0) {
      try {
        await writer.unlinkIfEmpty()
      } catch {
        // ignore
      }
      return { path: writer.path, bytes: 0, error: errorHint ?? 'capture_failed' }
    }
    return { path: writer.path, bytes, error: errorHint }
  }

  /** 进入 recording：建写流 + 通知 renderer + 起 maxDuration 定时器 */
  async function enterRecording(opts: {
    sessionId: string
    source: ScreenRecordSource
    includeMic: boolean
    maxDurationSec: number
  }): Promise<ScreenRecordStartResult> {
    const writer = await deps.createWriteStream()
    const startedAt = deps.nowMs()
    state = {
      ...state,
      status: 'recording',
      sessionId: opts.sessionId,
      sourceId: opts.source.sourceId,
      sourceName: opts.source.name,
      sourceType: opts.source.type,
      isLumii: opts.source.isLumii,
      startedAt,
      includeMic: opts.includeMic,
      maxDurationSec: opts.maxDurationSec,
      writer,
      confirmStartedAt: null,
      confirmTimer: null,
      nextChunkIndex: 0,
      captureFailedReason: null,
      lastFinalizeError: null,
      startLock: false,
    }
    deps.notifyRendererStartCapture(
      opts.sessionId,
      opts.source.sourceId,
      opts.includeMic,
      opts.maxDurationSec,
    )
    clearMaxDurationTimer()
    state.maxDurationTimer = setTimeout(() => {
      void stopInternal('max_duration')
    }, opts.maxDurationSec * 1000)
    emitStatus()
    return { ok: true, status: 'recording', sessionId: opts.sessionId, startedAt }
  }

  /** 内部 stop（含 stream_ended / crash / maxDuration） */
  async function stopInternal(
    reason: 'user' | 'max_duration' | 'stream_ended' | 'capture_failed' | 'write_failed' | 'quit',
  ): Promise<ScreenRecordStopResult> {
    if (state.status === 'idle') {
      return { ok: false, error: 'no_active_session' }
    }

    // pending_confirm：取消确认
    if (state.status === 'pending_confirm') {
      const sessionId = state.sessionId!
      clearConfirmTimer()
      deps.notifyRendererCancelled(sessionId, 'permission_denied')
      resetToIdle()
      emitStatus()
      return { ok: true, path: '', durationMs: 0, bytes: 0 }
    }

    if (state.status !== 'recording' && state.status !== 'stopping' && state.status !== 'error') {
      return { ok: false, error: 'usage' }
    }

    const sessionId = state.sessionId
    const startedAt = state.startedAt ?? deps.nowMs()
    state.status = 'stopping'
    emitStatus()
    if (sessionId) {
      deps.notifyRendererStopCapture(sessionId)
    }
    clearMaxDurationTimer()

    let errorHint: ScreenRecordErrorCode | undefined
    if (reason === 'stream_ended') errorHint = 'stream_ended'
    if (reason === 'capture_failed') errorHint = 'capture_failed'
    if (reason === 'write_failed') errorHint = 'write_failed'
    if (state.captureFailedReason) errorHint = 'capture_failed'

    const finalized = await finalizeWriter(errorHint)
    const durationMs = Math.max(0, deps.nowMs() - startedAt)
    const warning = state.micMuted ? ('mic_muted' as const) : undefined
    const path = finalized.path
    const bytes = finalized.bytes

    resetToIdle()
    emitStatus()

    if (finalized.error && reason !== 'user' && reason !== 'max_duration' && reason !== 'quit') {
      return {
        ok: false,
        error: finalized.error,
        message: reason,
        partialPath: path || undefined,
      }
    }
    if (finalized.error === 'capture_failed' || finalized.error === 'write_failed') {
      return {
        ok: false,
        error: finalized.error,
        partialPath: path || undefined,
      }
    }
    if (!path) {
      return { ok: false, error: 'capture_failed' }
    }
    return { ok: true, path, durationMs, bytes, warning }
  }

  async function listSources(
    includeThumbnail = false,
  ): Promise<ScreenRecordListSourcesResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled) {
      return { ok: false, error: 'disabled' }
    }
    try {
      const sources = await deps.getSources(includeThumbnail)
      return { ok: true, sources }
    } catch (e) {
      return {
        ok: false,
        error: 'capture_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function start(params: ScreenRecordStartParams): Promise<ScreenRecordStartResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled) {
      return { ok: false, error: 'disabled' }
    }

    if (state.startLock || state.status === 'recording' || state.status === 'pending_confirm' || state.status === 'stopping') {
      return { ok: false, error: 'already_recording' }
    }

    if (typeof params.maxDurationSec === 'number' && params.maxDurationSec < 0) {
      return { ok: false, error: 'usage', message: 'maxDurationSec must be >= 0' }
    }

    state.startLock = true
    try {
      // 重验证 sourceId
      const sources = await deps.getSources(false)
      const source = sources.find((s) => s.sourceId === params.sourceId)
      if (!source) {
        state.startLock = false
        return { ok: false, error: 'source_unavailable' }
      }

      const recordingsDir = deps.resolveRecordingsDir()
      const free = await deps.getFreeDiskBytes(recordingsDir)
      if (free < MIN_FREE_DISK_BYTES) {
        state.startLock = false
        return { ok: false, error: 'insufficient_disk_space' }
      }

      const includeMic =
        params.includeMic !== undefined ? params.includeMic : settings.includeMicDefault
      let maxDurationSec = params.maxDurationSec ?? 1800
      if (maxDurationSec > MAX_DURATION_SEC_CAP) {
        maxDurationSec = MAX_DURATION_SEC_CAP
      }

      const sessionId = randomUUID()
      const needConfirm = !source.isLumii && !settings.alwaysAllow

      if (needConfirm) {
        const startedAt = deps.nowMs()
        state = {
          ...createIdleState(),
          status: 'pending_confirm',
          sessionId,
          sourceId: source.sourceId,
          sourceName: source.name,
          sourceType: source.type,
          isLumii: source.isLumii,
          includeMic,
          maxDurationSec,
          confirmStartedAt: startedAt,
          confirmTimeoutSec: settings.confirmTimeoutSec,
          startLock: false,
        }
        deps.notifyRendererConfirmRequested({
          sessionId,
          sourceName: source.name,
          sourceType: source.type,
          sourceId: source.sourceId,
          thumbnailDataUrl: source.thumbnailDataUrl || undefined,
          timeoutSec: settings.confirmTimeoutSec,
          startedAt,
        })
        clearConfirmTimer()
        state.confirmTimer = setTimeout(() => {
          if (state.status === 'pending_confirm' && state.sessionId === sessionId) {
            deps.notifyRendererCancelled(sessionId, 'confirmation_timeout')
            resetToIdle()
            emitStatus()
          }
        }, settings.confirmTimeoutSec * 1000)
        emitStatus()
        return {
          ok: true,
          status: 'needs_confirmation',
          sessionId,
          confirmTimeoutSec: settings.confirmTimeoutSec,
          sourceName: source.name,
          sourceType: source.type,
        }
      }

      return await enterRecording({ sessionId, source, includeMic, maxDurationSec })
    } catch (e) {
      state.startLock = false
      return {
        ok: false,
        error: 'capture_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function stop(): Promise<ScreenRecordStopResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled && state.status === 'idle') {
      return { ok: false, error: 'disabled' }
    }
    // 总开关关闭但仍在录：允许 stop finalize
    if (state.status === 'idle') {
      if (!settings.enabled) return { ok: false, error: 'disabled' }
      return { ok: false, error: 'no_active_session' }
    }
    return stopInternal('user')
  }

  function getStatus(): ScreenRecordStatusResult {
    // 同步读取：enabled 关闭时若 idle 返回 disabled；进行中仍返回真实状态
    // 为保持测试「四操作均 disabled」，idle 时再读缓存不便；此处用同步占位：
    // 实际由 list/start/stop 异步读 settings。getStatus 在 enabled=false 且 idle 时
    // 通过最近一次 start/list 的副作用无法得知，故在此做一次「尽力」：
    // 若调用方先 listSources 失败，getStatus 仍可能 ok。计划要求 getStatus().error === 'disabled'，
    // 因此我们在 service 内缓存最近一次 settings.enabled。
    if (cachedEnabled === false && state.status === 'idle') {
      return { ok: false, error: 'disabled' }
    }
    return buildStatusDetail()
  }

  let cachedEnabled = true

  /** 包装 list/start/stop 时刷新 enabled 缓存 */
  const originalList = listSources
  const originalStart = start
  const originalStop = stop

  async function listSourcesWrapped(
    includeThumbnail = false,
  ): Promise<ScreenRecordListSourcesResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    return originalList(includeThumbnail)
  }

  async function startWrapped(
    params: ScreenRecordStartParams,
  ): Promise<ScreenRecordStartResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    return originalStart(params)
  }

  async function stopWrapped(): Promise<ScreenRecordStopResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    return originalStop()
  }

  async function respondConfirm(p: {
    sessionId: string
    allow: boolean
    rememberAlwaysAllow?: boolean
  }): Promise<void> {
    if (state.status !== 'pending_confirm' || state.sessionId !== p.sessionId) {
      return
    }
    clearConfirmTimer()
    if (p.rememberAlwaysAllow && deps.persistAlwaysAllow) {
      await deps.persistAlwaysAllow(true)
    }
    if (!p.allow) {
      deps.notifyRendererCancelled(p.sessionId, 'permission_denied')
      resetToIdle()
      emitStatus()
      return
    }

    // 允许：重验证源 + 磁盘，再开录
    const sources = await deps.getSources(false)
    const source = sources.find((s) => s.sourceId === state.sourceId)
    if (!source) {
      deps.notifyRendererCancelled(p.sessionId, 'source_unavailable')
      resetToIdle()
      emitStatus()
      return
    }
    const free = await deps.getFreeDiskBytes(deps.resolveRecordingsDir())
    if (free < MIN_FREE_DISK_BYTES) {
      deps.notifyRendererCancelled(p.sessionId, 'insufficient_disk_space')
      resetToIdle()
      emitStatus()
      return
    }
    const includeMic = state.includeMic
    const maxDurationSec = state.maxDurationSec
    const sessionId = p.sessionId
    await enterRecording({ sessionId, source, includeMic, maxDurationSec })
  }

  async function handleChunk(p: {
    sessionId: string
    chunkBase64: string
    index: number
    isLast: boolean
  }): Promise<void> {
    if (state.status !== 'recording' && state.status !== 'stopping') return
    if (state.sessionId !== p.sessionId) return
    if (p.index !== state.nextChunkIndex) return
    if (!state.writer) return
    try {
      const buf = Buffer.from(p.chunkBase64, 'base64')
      state.writer.write(new Uint8Array(buf))
      state.nextChunkIndex += 1
    } catch {
      state.captureFailedReason = 'write_failed'
      await stopInternal('write_failed')
    }
  }

  async function handleStreamEnded(p: { sessionId: string }): Promise<void> {
    if (state.sessionId !== p.sessionId) return
    if (state.status !== 'recording') return
    await stopInternal('stream_ended')
  }

  async function handleCaptureError(p: {
    sessionId: string
    reason: string
  }): Promise<void> {
    if (state.sessionId !== p.sessionId) return
    // 麦不可用：降级无声，不整体失败
    if (p.reason === 'mic_unavailable') {
      state.micMuted = true
      return
    }
    state.captureFailedReason = p.reason
    if (state.status === 'recording') {
      await stopInternal('capture_failed')
    }
  }

  async function handleRendererGone(): Promise<void> {
    if (state.status === 'recording' || state.status === 'stopping') {
      state.captureFailedReason = 'renderer_gone'
      await stopInternal('capture_failed')
      return
    }
    if (state.status === 'pending_confirm') {
      const sessionId = state.sessionId
      if (sessionId) {
        deps.notifyRendererCancelled(sessionId, 'capture_failed')
      }
      resetToIdle()
      emitStatus()
    }
  }

  async function flushBeforeQuit(): Promise<void> {
    if (state.status === 'pending_confirm') {
      const sessionId = state.sessionId
      if (sessionId) {
        deps.notifyRendererCancelled(sessionId, 'permission_denied')
      }
      resetToIdle()
      emitStatus()
      return
    }
    if (state.status === 'recording' || state.status === 'stopping' || state.status === 'error') {
      await stopInternal('quit')
    }
  }

  return {
    listSources: listSourcesWrapped,
    start: startWrapped,
    stop: stopWrapped,
    getStatus,
    respondConfirm,
    handleChunk,
    handleStreamEnded,
    handleCaptureError,
    handleRendererGone,
    flushBeforeQuit,
  }
}
