import { describe, it, expect } from 'vitest'
import { DEG_TO_RAD, poseRotationRadians } from './pose-units'

describe('pose-units — 度转弧度', () => {
  it('6 度是 0.105 弧度，不是 6', () => {
    // 这条就是那个真实故障的判据：注视的 ±6° 被直接写进 PIXI 的 rotation（要弧度），
    // 等于 ±344°，表现为「宠物朝光标反方向歪」，而且幅度更大。
    expect(poseRotationRadians(6)).toBeCloseTo(0.10472, 5)
    expect(poseRotationRadians(6)).not.toBeCloseTo(6, 1)
  })

  it('整圈与半圈的锚点', () => {
    expect(poseRotationRadians(360)).toBeCloseTo(Math.PI * 2, 9)
    expect(poseRotationRadians(180)).toBeCloseTo(Math.PI, 9)
  })

  it('分量相加后再换算（程序化旋转 + 注视倾斜）', () => {
    expect(poseRotationRadians(2, 4)).toBeCloseTo(poseRotationRadians(6), 9)
    expect(poseRotationRadians(2, 4)).toBeCloseTo(6 * DEG_TO_RAD, 9)
  })

  it('非有限分量被忽略（NaN 旋转会让角色直接消失）', () => {
    expect(poseRotationRadians(NaN, 6)).toBeCloseTo(6 * DEG_TO_RAD, 9)
    expect(poseRotationRadians(0, Infinity)).toBe(0)
    expect(poseRotationRadians()).toBe(0)
  })
})
