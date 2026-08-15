/**
 * 画面守卫（黑/白屏检测 + 输出尺寸）单测
 */
import { describe, expect, it } from 'vitest'
import { computeCaptureSize, isBlankFrame, BLANK_HOLD_MS } from './frame-guard'

/** 构造纯色采样像素（RGBA） */
function solid(v: number, count = 32 * 18): Uint8ClampedArray {
  const data = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i++) {
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  return data
}

describe('computeCaptureSize', () => {
  it('小于上限时只做偶数对齐', () => {
    expect(computeCaptureSize(1281, 721)).toEqual({ width: 1280, height: 720 })
  })

  it('超过上限时等比缩放', () => {
    const r = computeCaptureSize(3840, 2160)
    expect(r.width).toBe(1920)
    expect(r.height).toBe(1080)
  })

  it('非法尺寸回退到 1280x720', () => {
    expect(computeCaptureSize(0, 0)).toEqual({ width: 1280, height: 720 })
  })
})

describe('isBlankFrame', () => {
  it('全黑 / 全白判为空帧', () => {
    expect(isBlankFrame(solid(0))).toBe(true)
    expect(isBlankFrame(solid(255))).toBe(true)
    expect(isBlankFrame(solid(3))).toBe(true)
    expect(isBlankFrame(solid(252))).toBe(true)
  })

  it('中间灰度或有内容的画面不判为空帧', () => {
    expect(isBlankFrame(solid(128))).toBe(false)
    const mixed = solid(0)
    // 约 7% 非黑像素即视为有内容
    for (let i = 0; i < 40; i++) {
      mixed[i * 4] = 200
      mixed[i * 4 + 1] = 180
      mixed[i * 4 + 2] = 160
    }
    expect(isBlankFrame(mixed)).toBe(false)
  })

  it('白屏带少量边框/阴影杂点仍判为空帧', () => {
    const nearWhite = solid(255)
    // 576 采样点中 10 个非白（约 1.7%），典型窗口边框/圆角残留
    for (let i = 0; i < 10; i++) {
      nearWhite[i * 4] = 120
      nearWhite[i * 4 + 1] = 120
      nearWhite[i * 4 + 2] = 120
    }
    expect(isBlankFrame(nearWhite)).toBe(true)
  })

  it('空数据不判为空帧（避免误冻结）', () => {
    expect(isBlankFrame(new Uint8ClampedArray(0))).toBe(false)
  })
})

describe('BLANK_HOLD_MS', () => {
  it('冻结阈值为正数', () => {
    expect(BLANK_HOLD_MS).toBeGreaterThan(0)
  })
})
