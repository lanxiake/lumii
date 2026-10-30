/**
 * `ENABLE_SKILL_ACTIVATION_FOR` —— 技能激活解析的灰度名单。
 *
 * 动因：`ENABLE_SKILL_ACTIVATION` 从 v12 起默认 false，而它唯一的效果是让
 * `autoActivationScope`（由 `updateAutoScopeBatch` 基于真实命中率算出来的）
 * 真正生效。也就是说这套东西在生产里从未跑过。
 *
 * 直接翻 true = 一次性改动所有 Agent 的技能可见面。名单让它能先挑一个低风险
 * Agent 观察。**默认空名单必须与引入前逐字一致**——这是本用例守的第一件事。
 */
import { describe, expect, it } from 'vitest'
import { createFeatureFlags, DEFAULT_FEATURE_FLAGS } from './feature-flags.js'

describe('ENABLE_SKILL_ACTIVATION_FOR', () => {
  it('默认关闭且名单为空（现网行为不变）', () => {
    expect(DEFAULT_FEATURE_FLAGS.ENABLE_SKILL_ACTIVATION).toBe(false)
    expect(DEFAULT_FEATURE_FLAGS.ENABLE_SKILL_ACTIVATION_FOR).toEqual([])
  })

  it('覆盖名单不影响全局开关', () => {
    const flags = createFeatureFlags({ ENABLE_SKILL_ACTIVATION_FOR: ['chronicler'] })
    expect(flags.ENABLE_SKILL_ACTIVATION).toBe(false)
    expect(flags.ENABLE_SKILL_ACTIVATION_FOR).toEqual(['chronicler'])
  })

  it('未覆盖时拿到的是默认空数组，不会共享同一个可变引用', () => {
    const a = createFeatureFlags()
    const b = createFeatureFlags({ ENABLE_SKILL_ACTIVATION_FOR: ['x'] })
    expect(a.ENABLE_SKILL_ACTIVATION_FOR).toEqual([])
    expect(b.ENABLE_SKILL_ACTIVATION_FOR).toEqual(['x'])
  })
})
