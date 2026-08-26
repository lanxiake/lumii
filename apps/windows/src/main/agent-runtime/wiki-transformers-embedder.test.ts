/**
 * meanPoolAndNormalize / resolve 回退逻辑单测（不加载真实模型）
 */
import { describe, expect, it } from 'vitest'
import { meanPoolAndNormalize } from './wiki-transformers-embedder'

describe('meanPoolAndNormalize', () => {
  it('对 [seq, hidden] 做均值池化并 L2 归一化', () => {
    const data = new Float32Array([1, 0, 3, 0])
    const out = meanPoolAndNormalize({ data, dims: [2, 2] })
    expect(out.length).toBe(2)
    const norm = Math.sqrt(out[0]! * out[0]! + out[1]! * out[1]!)
    expect(norm).toBeCloseTo(1, 5)
    expect(out[0]).toBeGreaterThan(out[1]!)
  })
})
