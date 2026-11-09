import { describe, it, expect, beforeEach, vi } from 'vitest'
import { framesToVideo } from './frames-to-video'
import * as ffmpegRunner from '../../../../main/ffmpeg-runner'

vi.mock('../../../../main/ffmpeg-runner')

describe('framesToVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('调用 ffmpeg 合成视频', async () => {
    vi.mocked(ffmpegRunner.runFfmpeg).mockResolvedValue({ ok: true })

    const result = await framesToVideo({
      framesDir: '/tmp/frames',
      outputPath: '/tmp/output.mp4',
      fps: 10,
    })

    expect(result.ok).toBe(true)
    expect(ffmpegRunner.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining([
        '-framerate',
        '10',
        '-i',
        expect.stringContaining('frame-%06d.jpg'),
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '/tmp/output.mp4',
      ]),
    )
  })

  it('ffmpeg 失败时返回错误', async () => {
    vi.mocked(ffmpegRunner.runFfmpeg).mockResolvedValue({
      ok: false,
      message: 'encoding failed',
    })

    const result = await framesToVideo({
      framesDir: '/tmp/frames',
      outputPath: '/tmp/output.mp4',
      fps: 10,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('encoding failed')
    }
  })

  it('支持自定义 CRF 质量', async () => {
    vi.mocked(ffmpegRunner.runFfmpeg).mockResolvedValue({ ok: true })

    await framesToVideo({
      framesDir: '/tmp/frames',
      outputPath: '/tmp/output.mp4',
      fps: 10,
      crf: 18,
    })

    expect(ffmpegRunner.runFfmpeg).toHaveBeenCalledWith(
      expect.arrayContaining(['-crf', '18']),
    )
  })
})
