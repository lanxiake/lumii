import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHybridRecorder, type HybridRecorderDeps } from './hybrid-recorder'

describe('HybridRecorder', () => {
  let deps: HybridRecorderDeps
  let mockNow: number

  beforeEach(() => {
    mockNow = 1000000
    deps = {
      tryStartMediaRecorder: vi.fn().mockResolvedValue(true),
      stopMediaRecorder: vi.fn().mockResolvedValue(undefined),
      captureFrame: vi.fn().mockResolvedValue({
        ok: true,
        jpeg: Buffer.from('fake'),
        width: 1920,
        height: 1080,
      }),
      writeFrame: vi.fn().mockResolvedValue(undefined),
      nowMs: vi.fn(() => mockNow),
      tempDir: '/tmp/test',
    }
  })

  it('优先使用 MediaRecorder', async () => {
    const recorder = createHybridRecorder(deps)

    const result = await recorder.start({
      sessionId: 's1',
      source: {
        sourceId: 'window:123',
        name: 'Test',
        type: 'window',
        isLumii: false,
      },
      includeMic: true,
      maxDurationSec: 1800,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mode).toBe('media-recorder')
    }
    expect(deps.tryStartMediaRecorder).toHaveBeenCalledWith('s1', 'window:123')
  })

  it('MediaRecorder 失败时 fallback 到截帧', async () => {
    deps.tryStartMediaRecorder = vi.fn().mockResolvedValue(false)

    const recorder = createHybridRecorder(deps)
    const result = await recorder.start({
      sessionId: 's1',
      source: {
        sourceId: 'window:123',
        name: 'Test',
        type: 'window',
        isLumii: false,
      },
      includeMic: true,
      maxDurationSec: 1800,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mode).toBe('frame-capture')
    }

    // 等待截帧启动
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.captureFrame).toHaveBeenCalled()
  })

  it('截帧模式支持暂停/继续', async () => {
    deps.tryStartMediaRecorder = vi.fn().mockResolvedValue(false)

    const recorder = createHybridRecorder(deps)
    await recorder.start({
      sessionId: 's1',
      source: {
        sourceId: 'window:123',
        name: 'Test',
        type: 'window',
        isLumii: false,
      },
      includeMic: true,
      maxDurationSec: 1800,
    })

    vi.clearAllMocks()
    const pauseResult = recorder.pause()
    expect(pauseResult.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.captureFrame).not.toHaveBeenCalled()

    const resumeResult = recorder.resume()
    expect(resumeResult.ok).toBe(true)

    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(deps.captureFrame).toHaveBeenCalled()
  })
})
