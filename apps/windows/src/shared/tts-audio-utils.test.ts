import { describe, it, expect } from 'vitest'
import { concatWithGaps, normalizeLoudness } from './tts-audio-utils'

const rms = (s: ArrayLike<number>) => {
  let sum = 0
  for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!
  return Math.sqrt(sum / s.length)
}
const tone = (amp: number, n = 2400) => Array.from({ length: n }, (_, i) => amp * Math.sin(i / 5))

describe('段间响度统一', () => {
  it('拉到中位响度，且不削波', () => {
    const [a, b, c] = normalizeLoudness([tone(0.1), tone(0.2), tone(0.4)])
    expect(rms(a!)).toBeCloseTo(rms(b!), 3)
    expect(rms(c!)).toBeCloseTo(rms(b!), 3)
    expect(Math.max(...a!.map(Math.abs))).toBeLessThanOrEqual(0.95)
  })

  it('增益受峰值限制、静音段原样返回', () => {
    const silent = new Array(100).fill(0)
    const [loud, , quiet, s] = normalizeLoudness([tone(0.9), tone(0.9), [...tone(0.05), 0.9], silent])
    expect(Math.max(...quiet!.map(Math.abs))).toBeLessThanOrEqual(0.95 + 1e-9)
    expect(s).toBe(silent)
    expect(loud).toHaveLength(2400)
  })

  it('只有一段时不改动', () => {
    const only = tone(0.3)
    expect(normalizeLoudness([only])[0]).toBe(only)
  })
})

describe('分段拼接', () => {
  it('段间插静音，空段跳过', () => {
    const out = concatWithGaps([[0.5, 0.5], [], [0.25]], 10, 0.2)
    // 2 + 2(静音) + 1，空段不额外插静音
    expect(Array.from(out)).toEqual([0.5, 0.5, 0, 0, 0.25])
  })

  it('全空返回空数组', () => {
    expect(concatWithGaps([[], []], 24000)).toHaveLength(0)
  })
})
