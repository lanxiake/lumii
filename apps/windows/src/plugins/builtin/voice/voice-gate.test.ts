/**
 * 能量门：噪声底估计 + 三档灵敏度。
 *
 * 锁的是**默认行为不变**：标准档系数 1.0，所以 `listeningGate` 必须等于
 * 「baseline × energyGateMultiplier × 环境系数」——与拆分前逐位相同。
 * 这条不锁住的话，以后谁调档位表都可能悄悄改了默认灵敏度。
 */
import { describe, it, expect } from 'vitest'
import { VoiceGate, SENSITIVITY_SCALE, INITIAL_NOISE_BASELINE, NOISE_ESTIMATE_FRAMES, frameRms } from './voice-gate'

function feedSilence(g: VoiceGate, rms: number, n = NOISE_ESTIMATE_FRAMES, listening = true): void {
  for (let i = 0; i < n; i++) g.pushSilenceFrame(rms, listening)
}

describe('VoiceGate', () => {
  it('初始噪声底取 0.01（与拆分前一致）', () => {
    expect(new VoiceGate().noiseBaseline()).toBe(INITIAL_NOISE_BASELINE)
  })

  it('前 N 帧走均值估算，之后 EMA 跟随', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.05, NOISE_ESTIMATE_FRAMES)
    // 30 帧均值估完，baseline 应已从 0.01 拉向 0.05
    expect(g.noiseBaseline()).toBeGreaterThan(0.04)

    const afterEstimate = g.noiseBaseline()
    feedSilence(g, 0.05, 1)
    // EMA 一步只走 5%，不会跳变
    expect(g.noiseBaseline()).toBeCloseTo(afterEstimate * 0.95 + 0.05 * 0.05, 6)
  })

  it('非 listening 时不跟 EMA（思考/播报期间的静音不该带走噪声底）', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.02)
    feedSilence(g, 0.02, 1)
    const fixed = g.noiseBaseline()
    feedSilence(g, 0.5, 10, false)
    expect(g.noiseBaseline()).toBe(fixed)
  })

  it('标准档 = 旧行为（环境系数直接乘上去）', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.01) // normal 环境，gateScale = 1
    expect(g.scene()).toBe('normal')
    const baseline = g.noiseBaseline()
    expect(g.listeningGate(1.5, 'standard')).toBeCloseTo(baseline * 1.5, 6)
  })

  it('三档单调：灵敏 < 标准 < 严格', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.01)
    const sensitive = g.listeningGate(1.5, 'sensitive')
    const standard = g.listeningGate(1.5, 'standard')
    const strict = g.listeningGate(1.5, 'strict')
    expect(sensitive).toBeLessThan(standard)
    expect(strict).toBeGreaterThan(standard)
    expect(SENSITIVITY_SCALE.standard).toBe(1)
  })

  it('安静房间自动放松、嘈杂环境自动收紧', () => {
    const quiet = new VoiceGate()
    feedSilence(quiet, 0.001)
    const noisy = new VoiceGate()
    feedSilence(noisy, 0.06)
    // 用同一倍率、同一档位比较：安静房间的绝对门槛应显著更低
    expect(quiet.listeningGate(1.5, 'standard')).toBeLessThan(
      noisy.listeningGate(1.5, 'standard') * 0.4,
    )
  })

  it('打断门槛不吃环境系数与档位（那是 speaking 分支自己的事）', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.06) // noisy
    expect(g.interruptGate(2.5)).toBeCloseTo(g.noiseBaseline() * 2.5, 6)
  })

  it('reset 回到初始态', () => {
    const g = new VoiceGate()
    feedSilence(g, 0.06)
    g.reset()
    expect(g.noiseBaseline()).toBe(INITIAL_NOISE_BASELINE)
    expect(g.scene()).toBe('normal')
  })

  it('frameRms：空帧为 0，满幅方波为 1', () => {
    expect(frameRms(new Float32Array(0))).toBe(0)
    expect(frameRms(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1, 6)
  })
})
