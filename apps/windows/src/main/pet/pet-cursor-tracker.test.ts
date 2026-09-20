/**
 * pet-cursor-tracker 单元测试
 *
 * 这里守的是「**只在需要时发**」这条性质：注视是锦上添花的功能，
 * 为它持续付 IPC 成本（用户不动鼠标时也在发）是不可接受的。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cursor = vi.hoisted(() => ({ x: 100, y: 200 }))

vi.mock('electron', () => ({
  screen: { getCursorScreenPoint: () => ({ x: cursor.x, y: cursor.y }) },
}))

import {
  CURSOR_POLL_INTERVAL_MS,
  isCursorTracking,
  startCursorTracking,
  stopCursorTracking,
  _resetCursorTrackerForTest,
  type CursorTrackerDeps,
} from './pet-cursor-tracker'

function makeDeps(over: Partial<CursorTrackerDeps> = {}): CursorTrackerDeps & { sent: { x: number; y: number }[] } {
  const sent: { x: number; y: number }[] = []
  return {
    sent,
    send: (x, y) => sent.push({ x, y }),
    getWindowBounds: () => ({ x: 10, y: 20 }),
    isEnabled: () => true,
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  cursor.x = 100
  cursor.y = 200
  _resetCursorTrackerForTest()
})
afterEach(() => {
  _resetCursorTrackerForTest()
  vi.useRealTimers()
})

describe('pet-cursor-tracker', () => {
  it('首次轮询即推送，且坐标换算成窗口内坐标', () => {
    const deps = makeDeps()
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual([{ x: 90, y: 180 }]) // 100-10, 200-20
  })

  it('位置没变时不发 —— 用户不动鼠标就不该有任何流量', () => {
    const deps = makeDeps()
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS * 10)
    expect(deps.sent).toHaveLength(1)

    cursor.x = 150
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    expect(deps.sent).toHaveLength(2)
    expect(deps.sent[1]).toEqual({ x: 140, y: 180 })
  })

  it('开关关掉时不发（定时器仍留着，随时能开回来）', () => {
    let enabled = false
    const deps = makeDeps({ isEnabled: () => enabled })
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS * 5)
    expect(deps.sent).toHaveLength(0)
    expect(isCursorTracking()).toBe(true)

    enabled = true
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    expect(deps.sent).toHaveLength(1)
  })

  it('窗口不可用（bounds 为 null）时跳过本轮', () => {
    const deps = makeDeps({ getWindowBounds: () => null })
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS * 3)
    expect(deps.sent).toHaveLength(0)
  })

  it('start 幂等：重复调用不叠加定时器', () => {
    const a = makeDeps()
    const b = makeDeps()
    startCursorTracking(a)
    startCursorTracking(b)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(0)
  })

  it('stop 之后不再发', () => {
    const deps = makeDeps()
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    stopCursorTracking()
    expect(isCursorTracking()).toBe(false)
    cursor.x = 999
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS * 5)
    expect(deps.sent).toHaveLength(1)
  })

  it('重启后清掉上次位置：窗口可能刚被移动过，沿用旧坐标会推一次错位数据', () => {
    const a = makeDeps()
    startCursorTracking(a)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    stopCursorTracking()

    const b = makeDeps()
    startCursorTracking(b)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    // 光标没动，但这是新会话 → 应该重新推一次
    expect(b.sent).toHaveLength(1)
  })

  it('send 抛异常不会打断定时器（注视不该让宠物窗口出问题）', () => {
    let calls = 0
    const deps = makeDeps({
      send: () => {
        calls++
        throw new Error('模拟推送失败')
      },
    })
    startCursorTracking(deps)
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    cursor.x = 300
    vi.advanceTimersByTime(CURSOR_POLL_INTERVAL_MS)
    expect(calls).toBe(2) // 第二次仍被调用，说明定时器还活着
  })

  it('轮询间隔是 33ms 左右（30Hz；改了要有意识）', () => {
    expect(CURSOR_POLL_INTERVAL_MS).toBe(33)
  })
})
