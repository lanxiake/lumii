/**
 * 画质档位、字幕样式、响度统一。
 *
 * 这几个都是「参数算错不会报错，但成品看着不对」的类型——
 * 字幕字号算错是横向溢出被裁掉，响度不统一是跨节忽大忽小。
 */
import { describe, expect, it } from 'vitest'

import { loudnormFilter, QUALITY, resolveQuality, TARGET_LOUDNESS } from './quality'

describe('画质档位', () => {
  it('三档的帧率递增', () => {
    expect(QUALITY.draft.fps).toBeLessThan(QUALITY.standard.fps)
    expect(QUALITY.standard.fps).toBeLessThan(QUALITY.high.fps)
  })

  // CRF 越小画质越好，所以档位越高数值越小
  it('三档的 CRF 递减（越小越好）', () => {
    expect(QUALITY.draft.crf).toBeGreaterThan(QUALITY.standard.crf)
    expect(QUALITY.standard.crf).toBeGreaterThan(QUALITY.high.crf)
  })

  it('草稿档最快（veryfast）', () => {
    expect(QUALITY.draft.preset).toBe('veryfast')
  })

  it('未知档位退回 standard 而不是报错', () => {
    expect(resolveQuality(undefined)).toEqual(QUALITY.standard)
    expect(resolveQuality('nonsense')).toEqual(QUALITY.standard)
    expect(resolveQuality('draft')).toEqual(QUALITY.draft)
    expect(resolveQuality('high')).toEqual(QUALITY.high)
  })

  it('帧率都在合理范围（不会低于 10 也不会超过 30）', () => {
    for (const q of Object.values(QUALITY)) {
      expect(q.fps).toBeGreaterThanOrEqual(10)
      expect(q.fps).toBeLessThanOrEqual(30)
    }
  })
})

describe('响度统一', () => {
  it('目标响度在通行区间', () => {
    expect(TARGET_LOUDNESS.I).toBeGreaterThanOrEqual(-18)
    expect(TARGET_LOUDNESS.I).toBeLessThanOrEqual(-14)
  })

  it('滤波器串带齐三个参数', () => {
    const f = loudnormFilter()
    expect(f).toContain('loudnorm')
    expect(f).toContain(`I=${TARGET_LOUDNESS.I}`)
    expect(f).toContain(`TP=${TARGET_LOUDNESS.TP}`)
    expect(f).toContain(`LRA=${TARGET_LOUDNESS.LRA}`)
  })
})
