import { describe, it, expect } from 'vitest'
import { sparkHeights, SPARK_BARS } from './spark-heights'

const calls = (...ns: number[]) => ns.map((calls) => ({ calls }))

describe('sparkHeights', () => {
  it('无数据时给一排等高矮柱', () => {
    const out = sparkHeights([])
    expect(out).toHaveLength(SPARK_BARS)
    expect(new Set(out)).toEqual(new Set([8]))
  })

  it('桶数少于柱数也要输出固定根数，不留空洞', () => {
    const out = sparkHeights(calls(1, 2, 3))
    expect(out).toHaveLength(SPARK_BARS)
    expect(out.every((h) => h >= 8 && h <= 100)).toBe(true)
  })

  it('最大桶顶到 100%，零桶落到最小 8%', () => {
    const out = sparkHeights(Array.from({ length: SPARK_BARS }, (_, i) => ({ calls: i === 0 ? 0 : 50 })))
    expect(out[0]).toBe(8)
    expect(Math.max(...out)).toBe(100)
  })

  it('桶数多于柱数时按等分聚合取最大值', () => {
    // 88 个桶 → 每 4 个并一根；把峰值放在第 5 个桶，应落在第 2 根柱
    const buckets = Array.from({ length: SPARK_BARS * 4 }, (_, i) => ({ calls: i === 4 ? 99 : 1 }))
    const out = sparkHeights(buckets)
    expect(out).toHaveLength(SPARK_BARS)
    expect(out[1]).toBe(100)
    expect(out[0]).toBeLessThan(100)
  })

  it('全零桶不会除零，全部落到最小高度', () => {
    const out = sparkHeights(calls(0, 0, 0, 0))
    expect(new Set(out)).toEqual(new Set([8]))
  })
})
