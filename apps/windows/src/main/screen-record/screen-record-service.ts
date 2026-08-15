/**
 * ScreenRecordService — 主进程录屏会话编排（状态机 / 确认 / 写盘）
 * 设计：docs/design/2026-08-15-screen-record-design.md §2.1
 */

import { randomUUID } from 'node:crypto'
import type {
  ScreenRecordConfig,
  ScreenRecordErrorCode,
  ScreenRecordListSourcesResult,
  ScreenRecordMarker,
  ScreenRecordMarkParams,
  ScreenRecordMarkResult,
  ScreenRecordSource,
  ScreenRecordStartParams,
  ScreenRecordStartResult,
  ScreenRecordStatus,
  ScreenRecordStatusResult,
  ScreenRecordStopResult,
  ScreenRecordStopParams,
  ScreenRecordPauseResult,
  ScreenRecordResumeResult,
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
    includeSystemAudio: boolean,
  ) => void
  /** 通知渲染停止采集 */
  notifyRendererStopCapture: (sessionId: string) => void
  /** 通知渲染暂停采集（MediaRecorder.pause） */
  notifyRendererPauseCapture: (sessionId: string) => void
  /** 通知渲染继续采集（MediaRecorder.resume） */
  notifyRendererResumeCapture: (sessionId: string) => void
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
  /** 可选：成片写盘完成通知（UI 自动打开面板定位新成片） */
  notifyRendererRecordingSaved?: (p: {
    path: string
    durationMs: number
    bytes: number
    mp4Path?: string
  }) => void
  /** 开文件写流 */
  createWriteStream: () => Promise<ScreenRecordWriteStream>
  /** 当前时间 ms */
  nowMs: () => number
  /** 测试用：推进时钟（可选） */
  advanceMs?: (ms: number) => void
  /** 用户勾选「始终允许」时持久化设置 */
  persistAlwaysAllow?: (value: boolean) => Promise<void>
  /**
   * WebM → MP4；未注入时 exportMp4 仅 warning=mp4_failed。
   */
  convertWebmToMp4?: (
    input: string,
    output: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * 删除文件（MP4 转码成功后清理源 WebM）；失败仅记日志，不阻断 stop。
   */
  removeFile?: (filePath: string) => Promise<void>
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
  /** 已累计的活跃录制毫秒（不含当前 segment；暂停时并入） */
  activeElapsedMs: number
  /** 当前 recording segment 起始墙钟；paused/idle 时为 null */
  segmentStartedAt: number | null
  includeMic: boolean
  includeSystemAudio: boolean
  maxDurationSec: number
  writer: ScreenRecordWriteStream | null
  confirmStartedAt: number | null
  confirmTimeoutSec: number
  confirmTimer: ReturnType<typeof setTimeout> | null
  maxDurationTimer: ReturnType<typeof setTimeout> | null
  nextChunkIndex: number
  captureFailedReason: string | null
  /** 目标窗口最小化/隐藏导致画面冻结 */
  targetHidden: boolean
  micMuted: boolean
  systemAudioMuted: boolean
  lastFinalizeError: ScreenRecordErrorCode | null
  /** start 互斥锁，防止并发叠态 */
  startLock: boolean
  /** 本会话活跃时钟打点（教程 timeline） */
  timeline: ScreenRecordMarker[]
}

/** 对外服务接口 */
export interface ScreenRecordService {
  listSources: (includeThumbnail?: boolean) => Promise<ScreenRecordListSourcesResult>
  start: (params: ScreenRecordStartParams) => Promise<ScreenRecordStartResult>
  stop: (params?: ScreenRecordStopParams) => Promise<ScreenRecordStopResult>
  /** 暂停录制（仅 recording） */
  pause: () => Promise<ScreenRecordPauseResult>
  /** 继续录制（仅 paused） */
  resume: () => Promise<ScreenRecordResumeResult>
  /**
   * 活跃时钟打点（仅 recording）。
   * 教程：resume 后先 mark 再操作；stop 返回 timeline 供 narrate cues。
   */
  mark: (params: ScreenRecordMarkParams) => ScreenRecordMarkResult
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
    activeElapsedMs: 0,
    segmentStartedAt: null,
    includeMic: true,
    includeSystemAudio: true,
    maxDurationSec: 1800,
    writer: null,
    confirmStartedAt: null,
    confirmTimeoutSec: SCREEN_RECORD_SETTINGS_DEFAULTS.confirmTimeoutSec,
    confirmTimer: null,
    maxDurationTimer: null,
    nextChunkIndex: 0,
    captureFailedReason: null,
    targetHidden: false,
    micMuted: false,
    systemAudioMuted: false,
    lastFinalizeError: null,
    startLock: false,
    timeline: [],
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

  /** 当前活跃录制毫秒（不含暂停墙钟） */
  function computeActiveElapsedMs(): number {
    let ms = state.activeElapsedMs
    if (state.status === 'recording' && state.segmentStartedAt != null) {
      ms += Math.max(0, deps.nowMs() - state.segmentStartedAt)
    }
    return Math.max(0, ms)
  }

  /** 按剩余活跃时长调度 maxDuration 自动 stop */
  function scheduleMaxDurationTimer(): void {
    clearMaxDurationTimer()
    const remaining = state.maxDurationSec * 1000 - computeActiveElapsedMs()
    if (remaining <= 0) {
      void stopInternal('max_duration')
      return
    }
    state.maxDurationTimer = setTimeout(() => {
      void stopInternal('max_duration')
    }, remaining)
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
      state.status === 'recording' || state.status === 'paused' || state.status === 'stopping'
        ? computeActiveElapsedMs()
        : state.startedAt != null
          ? Math.max(0, now - state.startedAt)
          : undefined
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
      targetHidden: state.targetHidden || undefined,
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
    includeSystemAudio: boolean
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
      activeElapsedMs: 0,
      segmentStartedAt: startedAt,
      includeMic: opts.includeMic,
      includeSystemAudio: opts.includeSystemAudio,
      maxDurationSec: opts.maxDurationSec,
      writer,
      confirmStartedAt: null,
      confirmTimer: null,
      nextChunkIndex: 0,
      captureFailedReason: null,
      targetHidden: false,
      lastFinalizeError: null,
      micMuted: false,
      systemAudioMuted: false,
      startLock: false,
      timeline: [],
    }
    deps.notifyRendererStartCapture(
      opts.sessionId,
      opts.source.sourceId,
      opts.includeMic,
      opts.maxDurationSec,
      opts.includeSystemAudio,
    )
    scheduleMaxDurationTimer()
    emitStatus()
    return { ok: true, status: 'recording', sessionId: opts.sessionId, startedAt }
  }

  /** 内部 stop（含 stream_ended / crash / maxDuration） */
  async function stopInternal(
    reason: 'user' | 'max_duration' | 'stream_ended' | 'capture_failed' | 'write_failed' | 'quit',
    stopParams?: ScreenRecordStopParams,
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
      return { ok: true, path: '', durationMs: 0, bytes: 0, timeline: [] }
    }

    if (state.status !== 'recording' && state.status !== 'paused' && state.status !== 'stopping' && state.status !== 'error') {
      return { ok: false, error: 'usage' }
    }

    const sessionId = state.sessionId
    // 若仍在 recording，先把当前 segment 并入活跃时长
    if (state.status === 'recording' && state.segmentStartedAt != null) {
      state.activeElapsedMs += Math.max(0, deps.nowMs() - state.segmentStartedAt)
      state.segmentStartedAt = null
    }
    const durationMs = state.activeElapsedMs
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
    let warning:
      | 'mic_muted'
      | 'system_audio_muted'
      | 'audio_degraded'
      | 'mp4_failed'
      | undefined =
      state.micMuted && state.systemAudioMuted
        ? ('audio_degraded' as const)
        : state.micMuted
          ? ('mic_muted' as const)
          : state.systemAudioMuted
            ? ('system_audio_muted' as const)
            : undefined
    const path = finalized.path
    const bytes = finalized.bytes
    // 须在 resetToIdle 前取出 timeline（idle 会清空会话态）
    const timeline = [...state.timeline].sort((a, b) => a.atMs - b.atMs)

    resetToIdle()
    emitStatus()

    if (finalized.error && reason !== 'user' && reason !== 'max_duration' && reason !== 'quit') {
      const message =
        reason === 'stream_ended'
          ? path
            ? '目标窗口已关闭，已保存已录片段'
            : '目标窗口已关闭，未能保存有效片段'
          : reason
      return {
        ok: false,
        error: finalized.error,
        message,
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

    let resultPath = path
    let mp4Path: string | undefined
    const settings = await deps.readSettings()
    const wantMp4 =
      stopParams?.exportMp4 !== undefined ? stopParams.exportMp4 : settings.exportMp4Default
    if (wantMp4) {
      const out = path.replace(/\.webm$/i, '.mp4')
      const convert = deps.convertWebmToMp4
      if (!convert) {
        if (!warning) warning = 'mp4_failed'
      } else {
        const r = await convert(path, out)
        if (r.ok) {
          mp4Path = out
          // 勾选导出 MP4 且转码成功：删掉源 WebM，成片以 MP4 为准
          if (deps.removeFile && /\.webm$/i.test(path)) {
            try {
              await deps.removeFile(path)
              resultPath = out
            } catch {
              // 删除失败仍返回双路径，UI 至少能用到 mp4
            }
          } else {
            resultPath = out
          }
        } else if (!warning) {
          warning = 'mp4_failed'
        }
      }
    }

    deps.notifyRendererRecordingSaved?.({
      path: resultPath,
      durationMs,
      bytes,
      mp4Path,
    })

    return { ok: true, path: resultPath, durationMs, bytes, warning, mp4Path, timeline }
  }

  /**
   * 活跃时钟打点：仅 recording；paused 提示先 resume。
   */
  function mark(params: ScreenRecordMarkParams): ScreenRecordMarkResult {
    const label = typeof params?.label === 'string' ? params.label.trim() : ''
    if (!label) {
      return { ok: false, error: 'usage', message: 'label required' }
    }
    if (state.status !== 'recording') {
      return {
        ok: false,
        error: 'not_recording',
        message:
          state.status === 'paused'
            ? '当前已暂停：请先 screen_record_resume，再 mark'
            : '仅 recording 态可打点',
      }
    }
    const atMs = computeActiveElapsedMs()
    const marker: ScreenRecordMarker = {
      id: `m_${atMs}_${state.timeline.length}`,
      atMs,
      label,
      kind: params.kind ?? 'beat',
    }
    state.timeline.push(marker)
    return { ok: true, marker, elapsedMs: atMs }
  }

  /** 暂停：recording → paused */
  async function pause(): Promise<ScreenRecordPauseResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    if (!settings.enabled && state.status === 'idle') {
      return { ok: false, error: 'disabled' }
    }
    if (state.status !== 'recording') {
      return { ok: false, error: 'not_recording' }
    }
    const now = deps.nowMs()
    if (state.segmentStartedAt != null) {
      state.activeElapsedMs += Math.max(0, now - state.segmentStartedAt)
      state.segmentStartedAt = null
    }
    state.status = 'paused'
    clearMaxDurationTimer()
    if (state.sessionId) {
      deps.notifyRendererPauseCapture(state.sessionId)
    }
    const elapsedMs = state.activeElapsedMs
    emitStatus()
    return { ok: true, status: 'paused', elapsedMs }
  }

  /** 继续：paused → recording */
  async function resume(): Promise<ScreenRecordResumeResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    if (!settings.enabled && state.status === 'idle') {
      return { ok: false, error: 'disabled' }
    }
    if (state.status !== 'paused') {
      return { ok: false, error: 'not_paused' }
    }
    state.segmentStartedAt = deps.nowMs()
    state.status = 'recording'
    if (state.sessionId) {
      deps.notifyRendererResumeCapture(state.sessionId)
    }
    scheduleMaxDurationTimer()
    const elapsedMs = computeActiveElapsedMs()
    emitStatus()
    return { ok: true, status: 'recording', elapsedMs }
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

    if (state.startLock || state.status === 'recording' || state.status === 'paused' || state.status === 'pending_confirm' || state.status === 'stopping') {
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
      const includeSystemAudio =
        params.includeSystemAudio !== undefined
          ? params.includeSystemAudio
          : settings.includeSystemAudioDefault
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
          includeSystemAudio,
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

      return await enterRecording({
        sessionId,
        source,
        includeMic,
        includeSystemAudio,
        maxDurationSec,
      })
    } catch (e) {
      state.startLock = false
      return {
        ok: false,
        error: 'capture_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async function stop(params?: ScreenRecordStopParams): Promise<ScreenRecordStopResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled && state.status === 'idle') {
      return { ok: false, error: 'disabled' }
    }
    // 总开关关闭但仍在录：允许 stop finalize
    if (state.status === 'idle') {
      if (!settings.enabled) return { ok: false, error: 'disabled' }
      return { ok: false, error: 'no_active_session' }
    }
    return stopInternal('user', params)
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

  async function stopWrapped(params?: ScreenRecordStopParams): Promise<ScreenRecordStopResult> {
    const settings = await deps.readSettings()
    cachedEnabled = settings.enabled
    return originalStop(params)
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
    const includeSystemAudio = state.includeSystemAudio
    const maxDurationSec = state.maxDurationSec
    const sessionId = p.sessionId
    await enterRecording({ sessionId, source, includeMic, includeSystemAudio, maxDurationSec })
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
    if (state.status !== 'recording' && state.status !== 'paused') return
    await stopInternal('stream_ended')
  }

  async function handleCaptureError(p: {
    sessionId: string
    reason: string
  }): Promise<void> {
    if (state.sessionId !== p.sessionId) return
    // 麦/系统声不可用：降级无声，不整体失败
    if (p.reason === 'mic_unavailable') {
      state.micMuted = true
      return
    }
    if (p.reason === 'system_audio_unavailable') {
      state.systemAudioMuted = true
      return
    }
    // 目标窗口最小化/隐藏：采集层已冻结画面，录制继续，仅提示
    if (p.reason === 'target_window_hidden') {
      if (!state.targetHidden) {
        state.targetHidden = true
        emitStatus()
      }
      return
    }
    // 画面恢复：清除提示
    if (p.reason === 'target_window_visible') {
      if (state.targetHidden) {
        state.targetHidden = false
        emitStatus()
      }
      return
    }
    state.captureFailedReason = p.reason
    if (state.status === 'recording' || state.status === 'paused') {
      await stopInternal('capture_failed')
    }
  }

  async function handleRendererGone(): Promise<void> {
    if (state.status === 'recording' || state.status === 'paused' || state.status === 'stopping') {
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
    if (
      state.status === 'recording' ||
      state.status === 'paused' ||
      state.status === 'stopping' ||
      state.status === 'error'
    ) {
      await stopInternal('quit')
    }
  }

  return {
    listSources: listSourcesWrapped,
    start: startWrapped,
    stop: stopWrapped,
    pause,
    resume,
    mark,
    getStatus,
    respondConfirm,
    handleChunk,
    handleStreamEnded,
    handleCaptureError,
    handleRendererGone,
    flushBeforeQuit,
  }
}
