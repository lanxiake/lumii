/**
 * 服务商首字节延迟（Task 4.4）
 *
 * 覆盖：无样本、中位数（奇偶）、窗口截断、未配对起点不产生样本、本地模型标注。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/lumii-test' }, shell: {} }))

type Mod = typeof import('./provider-latency')

let mod: Mod
let now: number

beforeEach(async () => {
  // 模块内的环形缓冲是模块级状态，每个用例要拿到干净的一份
  vi.resetModules()
  mod = await import('./provider-latency')
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})

/** 走完一轮：start → 经过 ttfb 毫秒 → 首个 delta */
function oneRun(instanceId: string, ttfbMs: number, model = 'gpt-4o'): void {
  mod.markRunStart(instanceId)
  now += ttfbMs
  mod.markFirstToken(instanceId, model)
}

describe('provider-latency', () => {
  it('无样本时不给中位数，而不是报 0ms', () => {
    expect(mod.getLatency()).toEqual({ sampleCount: 0, isLocal: false })
  })

  it('奇数样本取中间值', () => {
    for (const ms of [100, 500, 300]) oneRun('i1', ms)
    expect(mod.getLatency().medianMs).toBe(300)
  })

  it('偶数样本取中间两个的均值', () => {
    for (const ms of [100, 200, 300, 500]) oneRun('i1', ms)
    expect(mod.getLatency().medianMs).toBe(250)
  })

  it('单次异常慢不会把中位数拉飞', () => {
    for (const ms of [100, 110, 120, 130, 30_000]) oneRun('i1', ms)
    expect(mod.getLatency().medianMs).toBe(120)
  })

  it('只保留最近 20 次样本', () => {
    // 前 20 次都是 1000ms，随后 20 次都是 100ms，窗口应只剩后者
    for (let i = 0; i < 20; i++) oneRun('i1', 1000)
    for (let i = 0; i < 20; i++) oneRun('i1', 100)
    const r = mod.getLatency()
    expect(r.sampleCount).toBe(20)
    expect(r.medianMs).toBe(100)
  })

  it('没有 delta 的一轮不产生样本，且清理后不会被下一轮误配', () => {
    mod.markRunStart('i1')
    now += 9999
    mod.clearRun('i1')
    expect(mod.getLatency().sampleCount).toBe(0)

    oneRun('i1', 150)
    expect(mod.getLatency().medianMs).toBe(150)
  })

  it('同一轮多个 delta 只记一次', () => {
    mod.markRunStart('i1')
    now += 200
    mod.markFirstToken('i1', 'gpt-4o')
    now += 5000
    mod.markFirstToken('i1', 'gpt-4o')
    expect(mod.getLatency().sampleCount).toBe(1)
    expect(mod.getLatency().medianMs).toBe(200)
  })

  it('多实例并发各自配对，互不串线', () => {
    mod.markRunStart('a')
    now += 100
    mod.markRunStart('b')
    now += 100
    mod.markFirstToken('a', 'gpt-4o') // a 等了 200
    now += 100
    mod.markFirstToken('b', 'gpt-4o') // b 等了 200
    expect(mod.getLatency().sampleCount).toBe(2)
    expect(mod.getLatency().medianMs).toBe(200)
  })

  it('本地模型标注 isLocal，UI 才能改写文案', () => {
    oneRun('i1', 80, 'ollama/qwen3:8b')
    expect(mod.getLatency().isLocal).toBe(true)
    oneRun('i1', 80, 'gpt-4o')
    expect(mod.getLatency().isLocal).toBe(false)
  })
})
