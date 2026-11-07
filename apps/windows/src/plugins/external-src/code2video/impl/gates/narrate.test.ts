import { describe, expect, it, vi } from 'vitest'

import {
  cuesToSrt,
  narrateSection,
  probeWavDurationMs,
  srtTime,
  stepDurationsFromCues,
  type NarrateDeps,
} from './narrate'

describe('srtTime', () => {
  it('格式正确', () => {
    expect(srtTime(0)).toBe('00:00:00,000')
    expect(srtTime(1234)).toBe('00:00:01,234')
    expect(srtTime(3_600_000)).toBe('01:00:00,000')
    expect(srtTime(86_399_999)).toBe('23:59:59,999')
  })

  it('不进负数', () => {
    expect(srtTime(-500)).toBe('00:00:00,000')
  })
})

describe('cuesToSrt', () => {
  it('按顺序编号并带时间轴', () => {
    const srt = cuesToSrt([
      { step: 0, text: '第一句', startMs: 0, endMs: 1500 },
      { step: 1, text: '第二句', startMs: 1800, endMs: 3200 },
    ])
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\n第一句')
    expect(srt).toContain('2\n00:00:01,800 --> 00:00:03,200\n第二句')
  })

  it('offset 把节内时间换成全片时间', () => {
    const srt = cuesToSrt([{ step: 0, text: 'x', startMs: 0, endMs: 1000 }], 60_000)
    expect(srt).toContain('00:01:00,000 --> 00:01:01,000')
  })
})

describe('probeWavDurationMs', () => {
  function wav(byteRate: number, seconds: number): Buffer {
    const dataLen = byteRate * seconds
    const buf = Buffer.alloc(44 + dataLen)
    buf.write('RIFF', 0, 'ascii')
    buf.write('WAVE', 8, 'ascii')
    buf.writeUInt32LE(byteRate, 28)
    return buf
  }

  it('从 WAV 头算时长', () => {
    expect(probeWavDurationMs(wav(1000, 2))).toBe(2000)
  })

  it('不是 WAV 返回 null', () => {
    const buf = Buffer.alloc(100)
    buf.write('OggS', 0, 'ascii')
    expect(probeWavDurationMs(buf)).toBeNull()
  })

  it('太短返回 null', () => {
    expect(probeWavDurationMs(Buffer.alloc(10))).toBeNull()
  })
})

describe('stepDurationsFromCues', () => {
  // 单位是毫秒——调用方必须自己除以 1000 再赋给 stepSeconds。
  // 实测漏除导致一节算出 13720 秒（3.8 小时），渲染了 8000+ 帧。
  it('返回值是毫秒', () => {
    const d = stepDurationsFromCues([{ step: 0, text: 'a', startMs: 0, endMs: 3000 }], 1)
    expect(d[0]).toBe(3000) // 不是 3
  })

  it('按语音时长分配每一步', () => {
    const d = stepDurationsFromCues(
      [
        { step: 0, text: 'a', startMs: 0, endMs: 3000 },
        { step: 1, text: 'b', startMs: 3000, endMs: 4500 },
      ],
      2,
    )
    expect(d).toEqual([3000, 1500])
  })

  it('没有语音的步给兜底时长（不能是 0）', () => {
    const d = stepDurationsFromCues([{ step: 0, text: 'a', startMs: 0, endMs: 3000 }], 3)
    expect(d[0]).toBe(3000)
    expect(d[1]).toBeGreaterThan(0)
    expect(d[2]).toBeGreaterThan(0)
  })

  it('同一步多句累加', () => {
    const d = stepDurationsFromCues(
      [
        { step: 0, text: 'a', startMs: 0, endMs: 1000 },
        { step: 0, text: 'b', startMs: 1000, endMs: 2500 },
      ],
      1,
    )
    expect(d[0]).toBe(2500)
  })

  it('越界的 step 被忽略', () => {
    const d = stepDurationsFromCues(
      [
        { step: 0, text: 'a', startMs: 0, endMs: 2000 },
        { step: 99, text: 'x', startMs: 2000, endMs: 9000 },
      ],
      1,
    )
    expect(d).toEqual([2000])
  })
})

describe('narrateSection', () => {
  function deps(over: Partial<NarrateDeps> = {}, durationMs: number | null = 2000): NarrateDeps {
    return {
      generateAudioFile: vi.fn(async (t: string, dir: string) => `${dir}/${t.length}.wav`),
      probeDurationMs: vi.fn(async () => durationMs),
      log: vi.fn(),
      ...over,
    }
  }

  it('逐句生成并按顺序排时间轴', async () => {
    const r = await narrateSection({ lines: ['第一句', '第二句'], destDir: '/tmp' }, deps())
    expect(r.ok).toBe(true)
    expect(r.cues).toHaveLength(2)
    expect(r.cues[0]!.startMs).toBe(0)
    expect(r.cues[1]!.startMs).toBeGreaterThan(r.cues[0]!.endMs) // 中间有停顿
  })

  it('空白行跳过', async () => {
    const r = await narrateSection({ lines: ['有', '  ', '也有'], destDir: '/tmp' }, deps())
    expect(r.cues).toHaveLength(2)
    // 步号保留原下标：第 3 句的 step 是 2
    expect(r.cues[1]!.step).toBe(2)
  })

  // 一句话合成失败不该让整条视频出不来
  it('某句失败时降级估算时长，不抛异常', async () => {
    const r = await narrateSection(
      { lines: ['会失败的一句', '正常'], destDir: '/tmp' },
      deps({
        generateAudioFile: vi.fn(async (t: string) => {
          if (t.startsWith('会')) throw new Error('TTS down')
          return '/tmp/x.wav'
        }),
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.cues).toHaveLength(2)
    expect(r.issues.some((i) => i.kind === 'segment_failed')).toBe(true)
    // 失败那句仍有时长（按字数估），不是 0
    expect(r.cues[0]!.endMs).toBeGreaterThan(0)
  })

  it('空音频判为失败并降级', async () => {
    const r = await narrateSection({ lines: ['句子'], destDir: '/tmp' }, deps({}, 30))
    expect(r.issues.some((i) => i.kind === 'empty_audio')).toBe(true)
  })

  it('没有任何可读内容时返回 not ok', async () => {
    const r = await narrateSection({ lines: ['', '  '], destDir: '/tmp' }, deps())
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.kind === 'tts_unavailable')).toBe(true)
  })
})
