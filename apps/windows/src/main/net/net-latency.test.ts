/**
 * 网络延迟探测：中位数/抖动计算、预热排除、失败降级、自适应选组
 *
 * 走 mock 的 undici.fetch + mock 的单调时钟，不碰真实网络，也完全确定。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { PingResult } from '../../shared/net-latency-types'

type FakeResponse = { body: ReturnType<typeof emptyBody> }

const fetchMock = vi.fn<(url: string) => Promise<FakeResponse>>()

vi.mock('undici', () => ({
  fetch: (url: string) => fetchMock(url),
  Agent: class {
    close(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

/** 空响应体：drainBody 只要求 getReader() */
function emptyBody() {
  return {
    getReader: () => ({
      read: async () => ({ done: true, value: undefined }),
      cancel: async () => undefined,
    }),
  }
}

type Mod = typeof import('./net-latency')
let mod: Mod

/** 单调时钟：由 mock 的 fetch 在请求期间推进 */
let nowMs = 0
/** 每个 URL 的每次请求耗时（含预热那一次） */
const durations = new Map<string, number[]>()

function prime(url: string, values: number[]): void {
  durations.set(url, [...values])
}

beforeEach(async () => {
  vi.resetModules()
  vi.restoreAllMocks()
  fetchMock.mockReset()
  durations.clear()
  nowMs = 0
  vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
  fetchMock.mockImplementation(async (url: string) => {
    const queue = durations.get(url)
    const d = queue?.shift()
    if (d === undefined) throw new Error(`未预设耗时: ${url}`)
    nowMs += d
    return { body: emptyBody() }
  })
  mod = await import('./net-latency')
})

describe('net-latency / 统计函数', () => {
  it('中位数：奇数取中间，偶数取中间两个均值，空集为 0', () => {
    expect(mod.median([5])).toBe(5)
    expect(mod.median([100, 300, 200])).toBe(200)
    expect(mod.median([100, 200, 300, 500])).toBe(250)
    expect(mod.median([])).toBe(0)
  })

  it('抖动：相邻样本差值的平均绝对值；样本不足为 0', () => {
    expect(mod.jitter([100])).toBe(0)
    expect(mod.jitter([100, 300, 200])).toBe(150) // (|200| + |100|) / 2
    expect(mod.jitter([100, 100, 100])).toBe(0)
  })
})

describe('net-latency / 自适应选组', () => {
  const r = (ok: boolean, ms?: number): PingResult => ({ group: 'domestic', ok, ...(ms != null ? { ms } : {}) })

  it('两组都可达时取中位数更低的', () => {
    expect(mod.pickBestGroup(r(true, 10), r(true, 20))).toBe('domestic')
    expect(mod.pickBestGroup(r(true, 20), r(true, 10))).toBe('international')
  })

  it('并列时稳定偏向国内', () => {
    expect(mod.pickBestGroup(r(true, 30), r(true, 30))).toBe('domestic')
  })

  it('只有一组可达时取可达者', () => {
    expect(mod.pickBestGroup(r(false), r(true, 10))).toBe('international')
    expect(mod.pickBestGroup(r(true, 10), r(false))).toBe('domestic')
  })

  it('都不可达返回 null', () => {
    expect(mod.pickBestGroup(r(false), r(false))).toBeNull()
  })
})

describe('net-latency / 探测', () => {
  it('预热一次不计入统计；主数字取中位数并给出最低与抖动', async () => {
    // 只给国内组预设耗时（预热 500，样本 100 / 300 / 200）；
    // 国外组不预设 → 立刻失败，不推进虚拟时钟，保证本用例完全确定
    prime(mod.DOMESTIC_PING_URL, [500, 100, 300, 200])

    const report = await mod.probeLatency()
    const d = report.domestic
    expect(d.ok).toBe(true)
    expect(d.ms).toBe(200) // 中位数
    expect(d.minMs).toBe(100)
    expect(d.jitterMs).toBe(150)
    expect(d.samples).toBe(3)
    // 预热 + 3 次采样 = 4 次请求
    expect(fetchMock.mock.calls.filter(([u]) => u === mod.DOMESTIC_PING_URL)).toHaveLength(4)
    // 未预设耗时的组如期失败，且 best 落到可达的国内
    expect(report.international.ok).toBe(false)
    expect(report.best).toBe('domestic')
  })

  it('国内不可达时 best 落到国外', async () => {
    prime(mod.INTERNATIONAL_PING_URL, [500, 40, 45, 50])
    const report = await mod.probeLatency()
    expect(report.domestic.ok).toBe(false)
    expect(report.international.ok).toBe(true)
    expect(report.best).toBe('international')
  })

  it('两组都失败时 best 为 null，且各自带上失败原因', async () => {
    const report = await mod.probeLatency()
    expect(report.domestic.ok).toBe(false)
    expect(report.international.ok).toBe(false)
    expect(report.domestic.error).toContain('未预设耗时')
    expect(report.best).toBeNull()
  })
})
