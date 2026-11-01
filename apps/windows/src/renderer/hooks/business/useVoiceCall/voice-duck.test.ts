import { describe, expect, it } from 'vitest'
import {
  DUCK_MAX_THRESHOLD,
  DUCK_MIN_THRESHOLD,
  DuckFloorTracker,
  duckThreshold,
} from './voice-duck'

describe('压音门槛', () => {
  it('安静房间（floor≈0.003）落到下限，空调声不触发', () => {
    expect(duckThreshold(0.003)).toBe(DUCK_MIN_THRESHOLD)
  })

  it('嘈杂环境（floor≈0.03）被封顶，不会落进"压了但主进程不认"的空档', () => {
    expect(duckThreshold(0.03)).toBe(DUCK_MAX_THRESHOLD)
  })

  it('中间区间按 2.5 倍放大', () => {
    expect(duckThreshold(0.008)).toBeCloseTo(0.02, 5)
  })

  it('没有样本时按上限算：宁可少压，不乱压', () => {
    expect(duckThreshold(null)).toBe(DUCK_MAX_THRESHOLD)
    expect(duckThreshold(0)).toBe(DUCK_MAX_THRESHOLD)
  })
})

describe('DuckFloorTracker', () => {
  it('样本不足时不给门槛（返回上限）', () => {
    const t = new DuckFloorTracker()
    for (let i = 0; i < 10; i++) t.push(0.01)
    expect(t.floor()).toBeNull()
    expect(t.threshold()).toBe(DUCK_MAX_THRESHOLD)
  })

  it('攒满后按 25 分位估底噪', () => {
    const t = new DuckFloorTracker()
    for (let i = 0; i < 64; i++) t.push(0.002 + i * 0.0001)
    const floor = t.floor()!
    expect(floor).toBeGreaterThan(0.002)
    expect(floor).toBeLessThan(0.005)
  })

  it('滚出用户说话的响帧：窗口滑动后底噪回到静音水平', () => {
    const t = new DuckFloorTracker()
    for (let i = 0; i < 64; i++) t.push(0.002)
    for (let i = 0; i < 64; i++) t.push(0.5) // 用户说了很久
    for (let i = 0; i < 64; i++) t.push(0.002) // 又安静下来
    expect(t.floor()!).toBeLessThan(0.01)
  })
})
