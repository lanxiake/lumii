import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFrameCaptureRecorder, type FrameCaptureRecorderDeps } from './frame-capture-recorder'

describe('FrameCaptureRecorder', () => {
  let deps: FrameCaptureRecorderDeps
  let mockNow: number

  beforeEach(() => {
    mockNow = 1000000
    deps = {
      captureFrame: vi.fn().mockResolvedValue({
        ok: true,
        jpeg: Buffer.from('fake-jpeg'),
        width: 1920,
        height: 1080,
      }),
      writeFrame: vi.fn().mockResolvedValue(undefined),
      nowMs: vi.fn(() => mockNow),
    }
  })

  it('开始录制并定时截帧', async () => {
    const recorder = createFrameCaptureRecorder(deps)

    const result = await recorder.start({
      sourceId: 'window:123',
      fps: 10,
      framesDir: '/tmp/test',
    })

    expect(result.ok).toBe(true)
    expect(result).toHaveProperty('sessionId')

    // 等待至少一帧被捕获
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(deps.captureFrame).toHaveBeenCalledWith('window:123', 1920)
    expect(deps.writeFrame).toHaveBeenCalled()
  })

  it('暂停时停止截帧', async () => {
    const recorder = createFrameCaptureRecorder(deps)
    await recorder.start({
      sourceId: 'window:123',
      fps: 10,
      framesDir: '/tmp/test',
    })

    vi.clearAllMocks()
    const pauseResult = recorder.pause()
    expect(pauseResult.ok).toBe(true)

    // 等待足够时间确认不再截帧
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.captureFrame).not.toHaveBeenCalled()
  })

  it('继续录制后恢复截帧', async () => {
    const recorder = createFrameCaptureRecorder(deps)
    await recorder.start({
      sourceId: 'window:123',
      fps: 10,
      framesDir: '/tmp/test',
    })

    recorder.pause()
    vi.clearAllMocks()

    const resumeResult = recorder.resume()
    expect(resumeResult.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.captureFrame).toHaveBeenCalled()
  })

  it('停止时返回帧数和时长', async () => {
    const recorder = createFrameCaptureRecorder(deps)
    await recorder.start({
      sourceId: 'window:123',
      fps: 10,
      framesDir: '/tmp/test',
    })

    // 模拟时间推进
    mockNow += 500

    const stopResult = recorder.stop()
    expect(stopResult.ok).toBe(true)
    if (stopResult.ok) {
      expect(stopResult.frameCount).toBeGreaterThan(0)
      expect(stopResult.fps).toBe(10)
      expect(stopResult.durationMs).toBe(500)
    }
  })

  it('捕获失败时继续录制不中断', async () => {
    deps.captureFrame = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'window_hidden' })
      .mockResolvedValue({
        ok: true,
        jpeg: Buffer.from('fake-jpeg'),
        width: 1920,
        height: 1080,
      })

    const recorder = createFrameCaptureRecorder(deps)
    await recorder.start({
      sourceId: 'window:123',
      fps: 10,
      framesDir: '/tmp/test',
    })

    await new Promise((resolve) => setTimeout(resolve, 250))

    // 第一次失败不阻止后续帧
    expect(deps.captureFrame).toHaveBeenCalledTimes(2)
  })
})
