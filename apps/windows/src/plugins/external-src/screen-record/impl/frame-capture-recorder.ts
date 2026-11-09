/**
 * 基于连续截帧的录屏实现（绕过 MediaRecorder 限制）
 * 适用场景：窗口录制失败但截图可用（如 LiteShell）
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export interface FrameCaptureRecorderDeps {
  /** 抓取单帧（复用现有 captureSourceFrame） */
  captureFrame: (
    sourceId: string,
    maxDimension: number,
  ) => Promise<
    | { ok: true; jpeg: Buffer; width: number; height: number }
    | { ok: false; error: string; message?: string }
  >
  /** 写入帧文件 */
  writeFrame: (filePath: string, jpeg: Buffer) => Promise<void>
  /** 当前时间 ms */
  nowMs: () => number
}

export interface FrameCaptureSession {
  sessionId: string
  sourceId: string
  fps: number
  /** 帧序列临时目录 */
  framesDir: string
  startedAt: number
  /** 已捕获帧数 */
  frameCount: number
  /** 定时器句柄 */
  timer: NodeJS.Timeout | null
  /** 活跃录制毫秒（不含暂停） */
  activeElapsedMs: number
  /** 当前 segment 起始墙钟（暂停时为 null） */
  segmentStartedAt: number | null
  status: 'recording' | 'paused'
}

/**
 * 创建基于截帧的录屏会话
 */
export function createFrameCaptureRecorder(deps: FrameCaptureRecorderDeps) {
  let session: FrameCaptureSession | null = null

  /** 开始录制：按 fps 定时截帧 */
  async function start(opts: {
    sourceId: string
    fps?: number // 默认 10fps（教程场景足够，降低开销）
    framesDir: string
  }): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
    if (session) {
      return { ok: false, error: 'already_recording' }
    }

    const fps = opts.fps ?? 10
    const sessionId = randomUUID()
    const framesDir = path.join(opts.framesDir, `frames-${sessionId}`)

    try {
      await fs.mkdir(framesDir, { recursive: true })
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }
    }

    const startedAt = deps.nowMs()
    session = {
      sessionId,
      sourceId: opts.sourceId,
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

  /** 调度下一帧捕获 */
  function scheduleNextFrame(): void {
    if (!session || session.status !== 'recording') return

    const intervalMs = 1000 / session.fps
    session.timer = setTimeout(() => {
      void captureAndWriteFrame()
    }, intervalMs)
  }

  /** 捕获并写入一帧 */
  async function captureAndWriteFrame(): Promise<void> {
    if (!session || session.status !== 'recording') return

    const result = await deps.captureFrame(session.sourceId, 1920)
    if (!result.ok) {
      // 捕获失败：记录日志但继续（窗口可能临时最小化）
      scheduleNextFrame()
      return
    }

    const framePath = path.join(session.framesDir, `frame-${String(session.frameCount).padStart(6, '0')}.jpg`)
    try {
      await deps.writeFrame(framePath, result.jpeg)
      session.frameCount += 1
    } catch {
      // 写入失败：继续
    }

    scheduleNextFrame()
  }

  /** 暂停：停止定时器，并入已录时长 */
  function pause(): { ok: true } | { ok: false; error: string } {
    if (!session) {
      return { ok: false, error: 'no_session' }
    }
    if (session.status !== 'recording') {
      return { ok: false, error: 'not_recording' }
    }

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
    return { ok: true }
  }

  /** 继续：恢复定时器 */
  function resume(): { ok: true } | { ok: false; error: string } {
    if (!session) {
      return { ok: false, error: 'no_session' }
    }
    if (session.status !== 'paused') {
      return { ok: false, error: 'not_paused' }
    }

    session.segmentStartedAt = deps.nowMs()
    session.status = 'recording'
    scheduleNextFrame()
    return { ok: true }
  }

  /** 停止：返回帧目录和元数据 */
  function stop(): {
    ok: true
    framesDir: string
    frameCount: number
    fps: number
    durationMs: number
  } | { ok: false; error: string } {
    if (!session) {
      return { ok: false, error: 'no_session' }
    }

    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }

    // 并入最后一段时长
    const now = deps.nowMs()
    if (session.status === 'recording' && session.segmentStartedAt !== null) {
      session.activeElapsedMs += Math.max(0, now - session.segmentStartedAt)
    }

    const result = {
      ok: true as const,
      framesDir: session.framesDir,
      frameCount: session.frameCount,
      fps: session.fps,
      durationMs: session.activeElapsedMs,
    }

    session = null
    return result
  }

  /** 查询状态 */
  function getStatus() {
    if (!session) {
      return { status: 'idle' as const }
    }
    return {
      status: session.status,
      frameCount: session.frameCount,
      elapsedMs: session.activeElapsedMs,
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
