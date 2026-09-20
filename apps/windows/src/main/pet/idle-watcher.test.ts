/**
 * idle-watcher 单元测试
 *
 * 这里守的是三条性质：
 *  1. **阶段不变就不发**——1Hz 轮询全年只该在三次状态切换时产生 IPC；
 *  2. **进宠物模式立刻定初值**——宠物模式可以由 CLI/智能体在用户不在时拉起；
 *  3. **关掉开关能把睡着的宠物叫醒**——否则它会永远停在睡着的那张脸上。
 *
 * 空闲秒数是注入的，所以本测试不碰 Electron（真值由 pet-mode-ipc 从 powerMonitor 取）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PetIdleStage } from '@mtbot/pet-core'
import {
  IDLE_ASLEEP_ENV,
  IDLE_DROWSY_ENV,
  IDLE_POLL_INTERVAL_MS,
  isIdleWatching,
  resolveIdleThresholds,
  startIdleWatching,
  stopIdleWatching,
  _resetIdleWatcherForTest,
  type IdleWatcherDeps,
} from './idle-watcher'

/** 阈值压到秒级，测试里才不用 advance 6 分钟 */
const FAST = { drowsySec: 2, asleepSec: 4 }

function makeDeps(
  over: Partial<IdleWatcherDeps> = {},
): IdleWatcherDeps & { sent: PetIdleStage[] } {
  const sent: PetIdleStage[] = []
  return {
    sent,
    getIdleSeconds: () => 0,
    send: (stage) => sent.push(stage),
    isEnabled: () => true,
    thresholds: FAST,
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetIdleWatcherForTest()
  delete process.env[IDLE_DROWSY_ENV]
  delete process.env[IDLE_ASLEEP_ENV]
})
afterEach(() => {
  _resetIdleWatcherForTest()
  vi.useRealTimers()
  delete process.env[IDLE_DROWSY_ENV]
  delete process.env[IDLE_ASLEEP_ENV]
})

describe('idle-watcher — 只在阶段变化时发', () => {
  it('启动即定初值：用户不在时被 CLI 拉起宠物模式，应当直接就睡着', () => {
    const deps = makeDeps({ getIdleSeconds: () => 999 })
    startIdleWatching(deps)
    // 不 advance 任何时间——初值必须同步算出来
    expect(deps.sent).toEqual(['asleep'])
  })

  it('秒数在阈值内增长时不发第二条', () => {
    const deps = makeDeps()
    startIdleWatching(deps)
    expect(deps.sent).toEqual(['awake']) // 初值 0s

    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual(['awake'])
  })

  it('跨过两档阈值各发一次，顺序是 awake → drowsy → asleep', () => {
    let idle = 0
    const deps = makeDeps({ getIdleSeconds: () => idle })
    startIdleWatching(deps)

    idle = 2 // 打盹阈值
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    idle = 3 // 还在打盹，不该再发
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    idle = 4 // 睡着阈值
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    idle = 100 // 睡很久，仍是同一档
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS * 5)

    expect(deps.sent).toEqual(['awake', 'drowsy', 'asleep'])
  })

  it('用户一有输入（秒数归零）立刻醒来', () => {
    let idle = 999
    const deps = makeDeps({ getIdleSeconds: () => idle })
    startIdleWatching(deps)
    expect(deps.sent).toEqual(['asleep'])

    idle = 0
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual(['asleep', 'awake'])
  })
})

describe('idle-watcher — 开关', () => {
  it('开关关着时不发（定时器仍留着，随时能开回来）', () => {
    let enabled = false
    let idle = 999
    const deps = makeDeps({ isEnabled: () => enabled, getIdleSeconds: () => idle })
    startIdleWatching(deps)
    expect(deps.sent).toEqual([])

    enabled = true
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual(['asleep'])
    expect(isIdleWatching()).toBe(true)
  })

  it('睡着时关掉开关 → 推一次 awake，宠物被叫醒', () => {
    let enabled = true
    const deps = makeDeps({ isEnabled: () => enabled, getIdleSeconds: () => 999 })
    startIdleWatching(deps)
    expect(deps.sent).toEqual(['asleep'])

    enabled = false
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual(['asleep', 'awake'])

    // 只推一次，不会每秒重复叫醒
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS * 5)
    expect(deps.sent).toEqual(['asleep', 'awake'])
  })

  it('从未推送过就关着开关时不发（省掉一条无意义的 awake）', () => {
    const deps = makeDeps({ isEnabled: () => false })
    startIdleWatching(deps)
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS * 3)
    expect(deps.sent).toEqual([])
  })
})

describe('idle-watcher — 生命周期', () => {
  it('start 幂等：重复调用不叠加定时器', () => {
    const a = makeDeps()
    const b = makeDeps()
    startIdleWatching(a)
    startIdleWatching(b)
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(a.sent.length).toBeGreaterThan(0)
    expect(b.sent).toEqual([])
  })

  it('stop 之后不再发', () => {
    const deps = makeDeps()
    startIdleWatching(deps)
    stopIdleWatching()
    expect(isIdleWatching()).toBe(false)
    const n = deps.sent.length
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS * 5)
    expect(deps.sent).toHaveLength(n)
  })

  it('重启后重算初值：宠物窗口可能刚被重建，它那边的默认是醒着', () => {
    const a = makeDeps({ getIdleSeconds: () => 999 })
    startIdleWatching(a)
    stopIdleWatching()

    const b = makeDeps({ getIdleSeconds: () => 999 })
    startIdleWatching(b)
    expect(b.sent).toEqual(['asleep'])
  })

  it('getIdleSeconds 抛异常不会打断定时器', () => {
    let calls = 0
    const deps = makeDeps({
      getIdleSeconds: () => {
        calls++
        if (calls === 1) throw new Error('模拟 powerMonitor 失败')
        return 999
      },
    })
    startIdleWatching(deps)
    expect(deps.sent).toEqual([]) // 首轮抛了，什么都没发
    vi.advanceTimersByTime(IDLE_POLL_INTERVAL_MS)
    expect(deps.sent).toEqual(['asleep']) // 定时器还活着
  })

  it('轮询间隔是 1s（改了要有意识：它决定了醒来跟不跟手）', () => {
    expect(IDLE_POLL_INTERVAL_MS).toBe(1000)
  })
})

describe('idle-watcher — 阈值覆盖（手测/验证脚本用）', () => {
  it('没设环境变量时返回空对象（用默认阈值）', () => {
    expect(resolveIdleThresholds()).toEqual({})
  })

  it('环境变量生效', () => {
    process.env[IDLE_DROWSY_ENV] = '3'
    process.env[IDLE_ASLEEP_ENV] = '8'
    expect(resolveIdleThresholds()).toEqual({ drowsySec: 3, asleepSec: 8 })
  })

  it('环境变量非法时忽略，不产生永远睡着的宠物', () => {
    process.env[IDLE_DROWSY_ENV] = 'abc'
    process.env[IDLE_ASLEEP_ENV] = '-5'
    expect(resolveIdleThresholds()).toEqual({})
  })
})
