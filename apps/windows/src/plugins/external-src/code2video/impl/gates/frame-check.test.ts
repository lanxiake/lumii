/**
 * 抽帧自检的测试。
 *
 * 造帧用合成数据：纯色背景 + 若干矩形色块。这样每个判据都有一个
 * 确定的、可复算的输入，而不是「看起来差不多」。
 */
import { describe, expect, it } from 'vitest'

import { analyzeFrame, checkFrame, parseHexColor, type FrameStats } from './frame-check'

const W = 100
const H = 100
const BG: [number, number, number] = [0, 0, 0]

/** 造一帧：在黑色底上画若干个矩形（可指定颜色） */
function makeFrame(
  rects: Array<{ x: number; y: number; w: number; h: number; rgb?: [number, number, number] }>,
): Buffer {
  const buf = Buffer.alloc(W * H * 4, 0)
  for (const r of rects) {
    const [cr, cg, cb] = r.rgb ?? [255, 255, 255]
    for (let y = r.y; y < Math.min(H, r.y + r.h); y++) {
      for (let x = r.x; x < Math.min(W, r.x + r.w); x++) {
        const o = (y * W + x) * 4
        buf[o] = cb
        buf[o + 1] = cg
        buf[o + 2] = cr
        buf[o + 3] = 255
      }
    }
  }
  return buf
}

function statsOf(
  rects: Array<{ x: number; y: number; w: number; h: number; rgb?: [number, number, number] }>,
): FrameStats {
  return analyzeFrame(makeFrame(rects), W, H, BG)
}

describe('analyzeFrame', () => {
  it('纯背景：没有内容', () => {
    const s = statsOf([])
    expect(s.inkPixels).toBe(0)
    expect(s.bbox).toBeNull()
    expect(s.largestBlobPixels).toBe(0)
  })

  it('一个矩形：包围盒与连通域都正确', () => {
    const s = statsOf([{ x: 20, y: 30, w: 40, h: 20 }])
    expect(s.inkPixels).toBe(40 * 20)
    expect(s.bbox).toEqual({ x: 20, y: 30, w: 40, h: 20 })
    expect(s.largestBlobPixels).toBe(40 * 20)
  })

  it('两个分离的矩形：连通域只算最大那个', () => {
    const s = statsOf([
      { x: 5, y: 5, w: 10, h: 10 },
      { x: 60, y: 60, w: 30, h: 30 },
    ])
    expect(s.inkPixels).toBe(100 + 900)
    expect(s.largestBlobPixels).toBe(900)
  })

  it('包围盒覆盖所有内容', () => {
    const s = statsOf([
      { x: 10, y: 10, w: 5, h: 5 },
      { x: 80, y: 80, w: 5, h: 5 },
    ])
    expect(s.bbox).toEqual({ x: 10, y: 10, w: 75, h: 75 })
  })
})

describe('checkFrame', () => {
  it('空白帧被抓到', () => {
    const issues = checkFrame(statsOf([]), 0)
    expect(issues.some((i) => i.kind === 'blank_frame')).toBe(true)
  })

  it('内容极少的帧也算空白（低于 0.3%）', () => {
    // 1px × 1px = 0.01%
    const issues = checkFrame(statsOf([{ x: 50, y: 50, w: 1, h: 1 }]), 0)
    expect(issues.some((i) => i.kind === 'blank_frame')).toBe(true)
  })

  it('正常一帧没有问题', () => {
    const issues = checkFrame(statsOf([{ x: 20, y: 20, w: 60, h: 60 }]), 0)
    expect(issues).toHaveLength(0)
  })

  it('白字压在黑块上（高对比）不报', () => {
    const s = statsOf([
      { x: 10, y: 30, w: 60, h: 50, rgb: [20, 20, 20] },
      { x: 20, y: 40, w: 40, h: 8, rgb: [245, 245, 245] },
    ])
    expect(checkFrame(s, 0)).toHaveLength(0)
  })

  // anything2explainer 的反例 05：背景散落几十个小图标
  it('碎屑感被抓到', () => {
    const rects = Array.from({ length: 30 }, (_, i) => ({
      x: (i % 6) * 16 + 2,
      y: Math.floor(i / 6) * 16 + 2,
      w: 3,
      h: 3,
    }))
    const issues = checkFrame(statsOf(rects), 0)
    expect(issues.some((i) => i.kind === 'scattered')).toBe(true)
  })

  // anything2explainer 的反例 01：手机占画面不到 1/4 且无光
  it('内容太小被抓到', () => {
    const issues = checkFrame(statsOf([{ x: 46, y: 46, w: 8, h: 8 }]), 0)
    expect(issues.some((i) => i.kind === 'too_small')).toBe(true)
  })

  it('内容偏在一角被抓到', () => {
    const issues = checkFrame(statsOf([{ x: 2, y: 2, w: 30, h: 30 }]), 0)
    expect(issues.some((i) => i.kind === 'off_center')).toBe(true)
  })

  it('居中的大块内容不报偏角', () => {
    const issues = checkFrame(statsOf([{ x: 25, y: 25, w: 50, h: 50 }]), 0)
    expect(issues.some((i) => i.kind === 'off_center')).toBe(false)
  })

  // 对比度问题不在这层判：试过两种像素判据都不区分不出「黑底白字」与
  // 「浅蓝块+蓝字」，改到数据层用元素语义判（checkSceneLayout）
  it('纯色帧不会被误判为问题（对比度不在这一层判）', () => {
    const s = statsOf([
      { x: 10, y: 30, w: 60, h: 50, rgb: [20, 20, 20] },
      { x: 20, y: 40, w: 40, h: 8, rgb: [245, 245, 245] },
    ])
    expect(checkFrame(s, 0)).toHaveLength(0)
  })

  it('帧号进到 detail 里', () => {
    const issues = checkFrame(statsOf([]), 7)
    expect(issues[0]?.detail).toContain('第 8 帧')
  })

  it('尺寸为 0 时不崩也不报', () => {
    expect(
      checkFrame({ width: 0, height: 0, inkPixels: 0, bbox: null, largestBlobPixels: 0 }, 0),
    ).toHaveLength(0)
  })
})

describe('parseHexColor', () => {
  it('解析六位十六进制', () => {
    expect(parseHexColor('#1c2b26')).toEqual([0x1c, 0x2b, 0x26])
    expect(parseHexColor('#FFFFFF')).toEqual([255, 255, 255])
  })

  it('transparent 与非十六进制走 fallback', () => {
    expect(parseHexColor('transparent', [1, 2, 3])).toEqual([1, 2, 3])
    expect(parseHexColor('rgb(1,2,3)', [1, 2, 3])).toEqual([1, 2, 3])
  })

  it('三位简写不被接受（返回 fallback）', () => {
    expect(parseHexColor('#fff', [9, 9, 9])).toEqual([9, 9, 9])
  })
})
