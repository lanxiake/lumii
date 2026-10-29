import { describe, it, expect } from 'vitest'
import type { PerfEvent, PerfSummary, StartupPhaseEvent, PerfLogEntry } from './performance'
import {
  beginPerfSpan,
  endPerfSpan,
  findBlockingSuspects,
  getInflightSpans,
  recordBlockingSuspect,
} from './performance'

describe('performance-types', () => {
  it('慢事件共用一种形状', () => {
    const slow: PerfEvent = {
      timestamp: Date.now(),
      kind: 'db.slow',
      name: 'SELECT * FROM messages WHERE id = ?',
      duration: 320,
      detail: { op: 'all', db: 'agent-runtime.db' },
    }
    expect(slow.kind).toBe('db.slow')
    expect(slow.name).toContain('?')
  })

  it('内存尖峰可以没有 duration', () => {
    const spike: PerfEvent = {
      timestamp: Date.now(),
      kind: 'memory.spike',
      name: 'main',
      detail: { rss: 2.5e9, reason: 'over-limit' },
    }
    expect(spike.duration).toBeUndefined()
  })

  it('启动阶段与慢事件可以同处一份日志', () => {
    const phase: StartupPhaseEvent = {
      timestamp: Date.now(),
      kind: 'startup.phase',
      phase: 'S1-extensions',
      duration: 16,
    }
    const entries: PerfLogEntry[] = [phase, { timestamp: 1, kind: 'ipc.slow', name: 'x', duration: 300 }]
    expect(entries).toHaveLength(2)
  })

  it('摘要结构覆盖计数、启动与内存', () => {
    const summary: PerfSummary = {
      generatedAt: 1,
      today: { total: 3, byKind: { 'ipc.slow': 3 }, slowestMs: 500 },
      ipc: {
        totalCalls: 100,
        slowCalls: 3,
        errors: 0,
        byChannel: { 'agent-runtime:command': { calls: 100, slowCalls: 3, errors: 0, maxMs: 500 } },
      },
      startupStats: { totalDuration: 1000, phases: { 'S1-extensions': 16 } },
      memory: { rss: 1, heapUsed: 1, peakRss: 2 },
      logDir: '/tmp',
      health: 'warning',
    }
    expect(summary.health).toBe('warning')
    expect(summary.ipc.byChannel['agent-runtime:command']!.maxMs).toBe(500)
  })
})

describe('打点栈', () => {
  it('先进后出，可嵌套', () => {
    beginPerfSpan('outer')
    beginPerfSpan('inner')
    expect(getInflightSpans()).toEqual(['outer', 'inner'])
    endPerfSpan('inner')
    expect(getInflightSpans()).toEqual(['outer'])
    endPerfSpan('outer')
    expect(getInflightSpans()).toEqual([])
  })

  it('重复名按最近一个出栈', () => {
    beginPerfSpan('x')
    beginPerfSpan('x')
    endPerfSpan('x')
    expect(getInflightSpans()).toEqual(['x'])
    endPerfSpan('x')
    expect(getInflightSpans()).toEqual([])
  })

  it('出栈一个不存在的名字不报错', () => {
    expect(() => endPerfSpan('nope')).not.toThrow()
  })

  it('栈深有上限，漏出栈也不会无限增长', () => {
    for (let i = 0; i < 50; i++) beginPerfSpan(`s${i}`)
    expect(getInflightSpans().length).toBeLessThanOrEqual(32)
    for (let i = 0; i < 50; i++) endPerfSpan(`s${i}`)
    expect(getInflightSpans()).toEqual([])
  })
})

describe('阻塞嫌疑（时间窗回看）', () => {
  it('低于 50ms 的不登记（IPC 每秒几十次，全收会淹没真凶）', () => {
    recordBlockingSuspect('tiny', 10, 1000)
    expect(findBlockingSuspects(0, 2000)).toEqual([])
  })

  it('按耗时降序返回，命中窗口内重叠的条目', () => {
    recordBlockingSuspect('sql-a', 300, 5000)
    recordBlockingSuspect('sql-b', 800, 5040)
    const found = findBlockingSuspects(4900, 5100)
    expect(found.map((s) => s.name)).toEqual(['sql-b', 'sql-a'])
  })

  it('跨窗口的长操作也能被回看到（endsAt 在窗口内、起点在窗口前）', () => {
    // 6.5 秒的 PRAGMA quick_check：结束于 10000
    recordBlockingSuspect('PRAGMA quick_check', 6500, 10000)
    expect(findBlockingSuspects(9990, 10100).map((s) => s.name)).toEqual(['PRAGMA quick_check'])
  })

  it('窗口外的条目不会误报', () => {
    recordBlockingSuspect('old', 500, 1000)
    expect(findBlockingSuspects(50000, 51000)).toEqual([])
  })
})
