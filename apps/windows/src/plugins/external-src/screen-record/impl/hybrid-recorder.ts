/**
 * 混合录制策略：优先 MediaRecorder，失败时 fallback 到截帧录制
 */
import type { ScreenRecordSource } from '../../../../shared/screen-record'
import { createFrameCaptureRecorder, type FrameCaptureRecorderDeps } from './frame-capture-recorder'
import { framesToVideo } from './frames-to-video'

export type RecordMode = 'media-recorder' | 'frame-capture'

export interface HybridRecorderDeps extends FrameCaptureRecorderDeps {
  /** 尝试启动 MediaRecorder 录制（返回 false 时 fallback） */
  tryStartMediaRecorder: (sessionId: string, sourceId: string) => Promise<boolean>
  /** 停止 MediaRecorder（若已启动） */
  stopMediaRecorder: (sessionId: string) => Promise<void>
  /** 临时目录根路径 */
  tempDir: string
}

export interface HybridRecorderSession {
  sessionId: string
  mode: RecordMode
  sourceId: string
}

/**
 * 混合录制器：自动在 MediaRecorder 和截帧录制间切换
 */
export function createHybridRecorder(deps: HybridRecorderDeps) {
  let currentSession: HybridRecorderSession | null = null
  const frameRecorder = createFrameCaptureRecorder(deps)

  async function start(opts: {
    sessionId: string
    source: ScreenRecordSource
    includeMic: boolean
    maxDurationSec: number
  }): Promise<
    | { ok: true; mode: RecordMode }
    | { ok: false; error: string; fallbackReason?: string }
  > {
    if (currentSession) {
      return { ok: false, error: 'already_recording' }
    }

    // 尝试 MediaRecorder
    const mediaRecorderOk = await deps.tryStartMediaRecorder(
      opts.sessionId,
      opts.source.sourceId,
    )

    if (mediaRecorderOk) {
      currentSession = {
        sessionId: opts.sessionId,
        mode: 'media-recorder',
        sourceId: opts.source.sourceId,
      }
      return { ok: true, mode: 'media-recorder' }
    }

    // Fallback 到截帧录制
    const frameResult = await frameRecorder.start({
      sourceId: opts.source.sourceId,
      fps: 10, // 教程场景默认 10fps
      framesDir: deps.tempDir,
    })

    if (!frameResult.ok) {
      return {
        ok: false,
        error: frameResult.error,
        fallbackReason: 'media_recorder_failed',
      }
    }

    currentSession = {
      sessionId: opts.sessionId,
      mode: 'frame-capture',
      sourceId: opts.source.sourceId,
    }

    return { ok: true, mode: 'frame-capture' }
  }

  function pause(): { ok: true } | { ok: false; error: string } {
    if (!currentSession) {
      return { ok: false, error: 'no_session' }
    }

    if (currentSession.mode === 'frame-capture') {
      return frameRecorder.pause()
    }

    // MediaRecorder 的暂停由外部 ScreenRecordService 处理
    return { ok: true }
  }

  function resume(): { ok: true } | { ok: false; error: string } {
    if (!currentSession) {
      return { ok: false, error: 'no_session' }
    }

    if (currentSession.mode === 'frame-capture') {
      return frameRecorder.resume()
    }

    return { ok: true }
  }

  async function stop(outputPath: string): Promise<
    | { ok: true; mode: RecordMode; path: string; durationMs: number }
    | { ok: false; error: string }
  > {
    if (!currentSession) {
      return { ok: false, error: 'no_session' }
    }

    const mode = currentSession.mode
    const sessionId = currentSession.sessionId

    if (mode === 'media-recorder') {
      await deps.stopMediaRecorder(sessionId)
      currentSession = null
      // MediaRecorder 结果由 ScreenRecordService 处理
      return { ok: true, mode, path: '', durationMs: 0 }
    }

    // 截帧模式：停止 → 合成视频
    const frameResult = frameRecorder.stop()
    if (!frameResult.ok) {
      currentSession = null
      return { ok: false, error: frameResult.error }
    }

    const composeResult = await framesToVideo({
      framesDir: frameResult.framesDir,
      outputPath,
      fps: frameResult.fps,
    })

    currentSession = null

    if (!composeResult.ok) {
      return { ok: false, error: composeResult.message }
    }

    return {
      ok: true,
      mode,
      path: outputPath,
      durationMs: frameResult.durationMs,
    }
  }

  function getStatus() {
    if (!currentSession) {
      return { status: 'idle' as const, mode: null }
    }

    if (currentSession.mode === 'frame-capture') {
      const frameStatus = frameRecorder.getStatus()
      return {
        ...frameStatus,
        mode: 'frame-capture' as const,
      }
    }

    return {
      status: 'recording' as const,
      mode: 'media-recorder' as const,
    }
  }

  return {
    start,
    pause,
    resume,
    stop,
    getStatus,
  }
}
