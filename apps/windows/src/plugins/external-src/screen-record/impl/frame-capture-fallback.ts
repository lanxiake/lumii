/**
 * 截帧录制 fallback 集成层：当 MediaRecorder 失败时自动切换
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { framesToVideo } from './frames-to-video'

export interface FrameCaptureFallbackDeps {
  captureFrame: (
    sourceId: string,
    maxDimension: number,
  ) => Promise<
    | { ok: true; jpeg: Buffer; width: number; height: number }
    | { ok: false; error: string; message?: string }
  >
  writeFrame: (filePath: string, jpeg: Buffer) => Promise<void>
  nowMs: () => number
  framesDir: string
}

interface FrameSession {
  sessionId: string
  sourceId: string
  fps: number
  framesDir: string
  startedAt: number
  frameCount: number
  timer: NodeJS.Timeout | null
  activeElapsedMs: number
  segmentStartedAt: number | null
  status: 'recording' | 'paused'
}

/**
 * 截帧录制会话管理器（内部使用，由 ScreenRecordService 调度）
 */
export function createFrameCaptureFallback(deps: FrameCaptureFallbackDeps) {
  let session: FrameSession | null = null

  async function start(sourceId: string, fps = 10): Promise<{ ok: true; sessionId: string }> {
    if (session) {
      throw new Error('Frame capture already active')
    }

    const sessionId = randomUUID()
    const framesDir = path.join(deps.framesDir, `session-${sessionId}`)

    const startedAt = deps.nowMs()
    session = {
      sessionId,
      sourceId,
      fps,
      framesDir,
      startedAt,
      frameCount: 0,
      timer: null,
      activeElapsedMs: 0,
      segmentStartedAt: startedAt,
      status: 'recording',
    }

    scheduleNextFrame()
    return { ok: true, sessionId }
  }

  function scheduleNextFrame(): void {
    if (!session || session.status !== 'recording') return

    const intervalMs = 1000 / session.fps
    session.timer = setTimeout(() => {
      void captureAndWriteFrame()
    }, intervalMs)
  }

  async function captureAndWriteFrame(): Promise<void> {
    if (!session || session.status !== 'recording') return

    const result = await deps.captureFrame(session.sourceId, 1920)
    if (result.ok) {
      const framePath = path.join(
        session.framesDir,
        `frame-${String(session.frameCount).padStart(6, '0')}.jpg`,
      )
      try {
        await deps.writeFrame(framePath, result.jpeg)
        session.frameCount += 1
      } catch {
        // 写入失败：继续
      }
    }

    scheduleNextFrame()
  }

  function pause(): void {
    if (!session || session.status !== 'recording') return

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    const now = deps.nowMs()
    if (session.segmentStartedAt !== null) {
      session.activeElapsedMs += Math.max(0, now - session.segmentStartedAt)
      session.segmentStartedAt = null
    }

    session.status = 'paused'
  }

  function resume(): void {
    if (!session || session.status !== 'paused') return

    session.segmentStartedAt = deps.nowMs()
    session.status = 'recording'
    scheduleNextFrame()
  }

  async function stop(outputPath: string): Promise<{
    ok: true
    path: string
    durationMs: number
    frameCount: number
  }> {
    if (!session) {
      throw new Error('No active frame capture session')
    }

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    const now = deps.nowMs()
    if (session.status === 'recording' && session.segmentStartedAt !== null) {
      session.activeElapsedMs += Math.max(0, now - session.segmentStartedAt)
    }

    const { framesDir, fps, activeElapsedMs, frameCount } = session
    session = null

    // 合成视频
    const composeResult = await framesToVideo({
      framesDir,
      outputPath,
      fps,
    })

    if (!composeResult.ok) {
      throw new Error(`Frame composition failed: ${composeResult.message}`)
    }

    return {
      ok: true,
      path: outputPath,
      durationMs: activeElapsedMs,
      frameCount,
    }
  }

  function isActive(): boolean {
    return session !== null
  }

  return {
    start,
    pause,
    resume,
    stop,
    isActive,
  }
}
