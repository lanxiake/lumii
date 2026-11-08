/**
 * 开机高潮纯函数自检。
 */
import { describe, expect, it } from 'vitest'
import {
  audioCueForProgress,
  cognitionPullStrength,
  coreGlowMultiplier,
} from './boot-climax'

describe('boot-climax 高潮判定', () => {
  it('后段阶段用 climax 音效，中前段用 pulse', () => {
    expect(audioCueForProgress(6, 11)).toBe('pulse')
    expect(audioCueForProgress(9, 11)).toBe('climax')
    expect(audioCueForProgress(11, 11)).toBe('pulse')
    expect(audioCueForProgress(0, 11)).toBe('none')
  })

  it('仅 cognition 且未卡住时产生向心拉力', () => {
    expect(cognitionPullStrength({ act: 'energize', stalled: false, beatPhase: 0 })).toBe(0)
    expect(cognitionPullStrength({ act: 'cognition', stalled: true, beatPhase: 0 })).toBe(0)
    expect(cognitionPullStrength({ act: 'cognition', stalled: false, beatPhase: 0 })).toBeGreaterThan(1)
  })

  it('cognition 核心光晕倍率高于常态', () => {
    expect(coreGlowMultiplier('neural', false)).toBe(1)
    expect(coreGlowMultiplier('cognition', false)).toBeGreaterThan(1.2)
    expect(coreGlowMultiplier('cognition', true)).toBe(1.15)
  })
})
