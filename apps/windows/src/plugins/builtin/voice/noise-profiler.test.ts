/**
 * 环境画像分档 + 能量门修正。
 *
 * 这条是"噪声自适应"的核心判据：安静房间放松能量门、嘈杂环境收紧，
 * 避免两种极端（轻声被吞 / 键盘声被当语音）。
 */
import { describe, expect, it } from 'vitest'
import { NoiseProfiler } from './noise-profiler'

function feed(p: NoiseProfiler, rms: number, n = 64) {
  for (let i = 0; i < n; i++) p.push(rms)
}

describe('NoiseProfiler', () => {
  it('样本不足时不乱下结论', () => {
    const p = new NoiseProfiler()
    p.push(0.001)
    expect(p.floor()).toBeNull()
    expect(p.scene()).toBe('normal')
    expect(p.gateScale()).toBe(1)
  })

  it('安静房间 → 放松能量门（<1）', () => {
    const p = new NoiseProfiler()
    feed(p, 0.001)
    expect(p.scene()).toBe('quiet')
    expect(p.gateScale()).toBeLessThan(1)
  })

  it('普通环境 → 系数不变', () => {
    const p = new NoiseProfiler()
    feed(p, 0.01)
    expect(p.scene()).toBe('normal')
    expect(p.gateScale()).toBe(1)
  })

  it('嘈杂环境 → 收紧能量门（>1）', () => {
    const p = new NoiseProfiler()
    feed(p, 0.06)
    expect(p.scene()).toBe('noisy')
    expect(p.gateScale()).toBeGreaterThan(1)
  })

  it('窗口滚动：环境变安静后能跟着改判', () => {
    const p = new NoiseProfiler()
    feed(p, 0.06)
    expect(p.scene()).toBe('noisy')
    feed(p, 0.001)
    expect(p.scene()).toBe('quiet')
  })

  it('忽略非法输入', () => {
    const p = new NoiseProfiler()
    p.push(Number.NaN)
    p.push(-1)
    expect(p.floor()).toBeNull()
  })

  it('reset 清空样本', () => {
    const p = new NoiseProfiler()
    feed(p, 0.06)
    p.reset()
    expect(p.floor()).toBeNull()
  })
})
