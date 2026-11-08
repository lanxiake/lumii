/**
 * 五幕密度阶梯自检：前段必须严格递增，避免仪表过早全开。
 */
import { describe, expect, it } from 'vitest'
import {
  ACT_DENSITY,
  coreTargetForAct,
  earlyDensitySeries,
  ringStrengthForAct,
} from './boot-density'

/** 断言序列严格递增 */
function expectStrictlyIncreasing(values: number[]): void {
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBeGreaterThan(values[i - 1])
  }
}

describe('boot-density 五幕层次', () => {
  it('前四幕核心/顶栏/进度条密度严格递增', () => {
    expectStrictlyIncreasing(earlyDensitySeries('core'))
    expectStrictlyIncreasing(earlyDensitySeries('topbar'))
    expectStrictlyIncreasing(earlyDensitySeries('bar'))
  })

  it('装甲与遥测在 dark/dormant 关闭，neural→energize 再抬升', () => {
    expect(ACT_DENSITY.dark.armor).toBe(0)
    expect(ACT_DENSITY.dormant.armor).toBe(0)
    expect(ACT_DENSITY.dark.telemetry).toBe(0)
    expect(ACT_DENSITY.neural.armor).toBeGreaterThan(0)
    expect(ACT_DENSITY.energize.armor).toBeGreaterThan(ACT_DENSITY.neural.armor)
    expect(ACT_DENSITY.energize.telemetry).toBeGreaterThan(ACT_DENSITY.neural.telemetry)
  })

  it('能量环仅 energize 起锚，cognition 略降让戏', () => {
    expect(ringStrengthForAct('neural')).toBe(0)
    expect(ringStrengthForAct('energize')).toBe(1)
    expect(ringStrengthForAct('cognition')).toBeLessThan(ringStrengthForAct('energize'))
  })

  it('卡住态抬高早幕核心底光且不低于常态', () => {
    expect(coreTargetForAct('dark', true)).toBeGreaterThan(coreTargetForAct('dark', false))
    expect(coreTargetForAct('energize', true)).toBeGreaterThanOrEqual(
      coreTargetForAct('energize', false),
    )
  })
})
