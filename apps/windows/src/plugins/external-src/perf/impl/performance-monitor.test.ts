import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PerformanceMonitor, asHydratableEvent } from './performance-monitor'
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BASE_CONFIG = {
  enabled: true,
  ipcSlowThresholdMs: 200,
  memoryRssThresholdBytes: 2 * 1024 * 1024 * 1024,
  memoryGrowthThresholdBytes: 300 * 1024 * 1024,
  memorySpikeCooldownMs: 5 * 60_000,
  maxQueueSize: 200,
}

let tempDir: string
let monitor: PerformanceMonitor

function makeMonitor(overrides: Partial<typeof BASE_CONFIG> = {}) {
  return new PerformanceMonitor({ ...BASE_CONFIG, ...overrides, logDir: tempDir })
}

function loggedLines(): unknown[] {
  return readdirSync(tempDir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(tempDir, f), 'utf-8').split('\n'))
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'perf-monitor-'))
  monitor = makeMonitor()
})

afterEach(async () => {
  await monitor.flush()
  monitor.destroy()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('PerformanceMonitor：只记慢事件', () => {
  it('常规 IPC 调用只计数，不落盘', async () => {
    for (let i = 0; i < 100; i++) monitor.recordIpcCall('agent-runtime:command', 50, false)
    await monitor.flush()

    expect(loggedLines()).toHaveLength(0)
    const summary = monitor.getSummary()
    expect(summary.ipc.totalCalls).toBe(100)
    expect(summary.ipc.slowCalls).toBe(0)
  })

  it('慢 IPC 超过阈值才落一条', async () => {
    monitor.recordIpcCall('agent-runtime:command', 50, false)
    monitor.recordIpcCall('agent-runtime:command', 250, false)
    await monitor.flush()

    const lines = loggedLines() as Array<Record<string, unknown>>
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      kind: 'ipc.slow',
      name: 'agent-runtime:command',
      duration: 250,
    })
  })

  it('IPC 报错总是落盘（与耗时无关）', async () => {
    monitor.recordIpcCall('voice:command', 10, true)
    await monitor.flush()

    const lines = loggedLines() as Array<Record<string, unknown>>
    expect(lines[0]).toMatchObject({ kind: 'ipc.error', name: 'voice:command' })
  })

  it('启动阶段落盘，但不进今日事件列表', async () => {
    monitor.recordStartupPhase('S1-extensions', 16)
    await monitor.flush()

    const lines = loggedLines() as Array<Record<string, unknown>>
    expect(lines[0]).toMatchObject({ kind: 'startup.phase', phase: 'S1-extensions', duration: 16 })
    expect(monitor.listEvents()).toHaveLength(0)
    expect(monitor.getSummary().startupStats.phases['S1-extensions']).toBe(16)
  })

  it('通用事件（慢 SQL / 长任务）进事件列表并落盘', async () => {
    monitor.recordEvent({
      timestamp: Date.now(),
      kind: 'db.slow',
      name: 'SELECT * FROM messages WHERE id = ?',
      duration: 800,
      detail: { op: 'all', db: 'agent-runtime.db' },
    })
    await monitor.flush()

    expect(monitor.listEvents()).toHaveLength(1)
    const lines = loggedLines() as Array<Record<string, unknown>>
    expect(lines[0]).toMatchObject({ kind: 'db.slow', duration: 800 })
  })
})

describe('PerformanceMonitor：内存尖峰', () => {
  it('首次采样只建基线', () => {
    monitor.sampleMemory({ rss: 3 * 1024 * 1024 * 1024, heapUsed: 1 })
    expect(monitor.listEvents()).toHaveLength(0)
  })

  it('超过 RSS 阈值记一条 over-limit', () => {
    monitor.sampleMemory({ rss: 100 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleMemory({ rss: 2.5 * 1024 * 1024 * 1024, heapUsed: 1 })
    const events = monitor.listEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'memory.spike', name: 'main' })
    expect(events[0]!.detail?.reason).toBe('over-limit')
  })

  it('快速上涨记一条 growth', () => {
    monitor.sampleMemory({ rss: 100 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleMemory({ rss: 500 * 1024 * 1024, heapUsed: 1 })
    expect(monitor.listEvents()[0]!.detail?.reason).toBe('growth')
  })

  it('冷却期内不重复记', () => {
    monitor.sampleMemory({ rss: 100 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleMemory({ rss: 500 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleMemory({ rss: 900 * 1024 * 1024, heapUsed: 1 })
    expect(monitor.listEvents()).toHaveLength(1)
  })

  it('平稳时不出事件，但峰值仍被记住', () => {
    monitor.sampleMemory({ rss: 300 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleMemory({ rss: 320 * 1024 * 1024, heapUsed: 1 })
    expect(monitor.listEvents()).toHaveLength(0)
    expect(monitor.getSummary().memory.peakRss).toBe(320 * 1024 * 1024)
  })
})

describe('PerformanceMonitor：子进程内存', () => {
  it('首次只建基线，越阈值才记一条', () => {
    monitor.sampleChildProcesses([{ pid: 7, type: 'Tab', rss: 100, privateBytes: 100 }])
    expect(monitor.listEvents()).toHaveLength(0)

    monitor.sampleChildProcesses([
      { pid: 7, type: 'Tab', rss: 2.5e9, privateBytes: 2.5e9 },
    ])
    const events = monitor.listEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'memory.spike', name: 'child:Tab#7' })
    expect(events[0]!.detail?.reason).toBe('over-limit')
  })

  it('渲染进程单独判定，不被主进程的状态掩盖', () => {
    monitor.sampleMemory({ rss: 100 * 1024 * 1024, heapUsed: 1 })
    monitor.sampleChildProcesses([{ pid: 9, type: 'Renderer', rss: 100, privateBytes: 100 }])
    monitor.sampleChildProcesses([{ pid: 9, type: 'Renderer', rss: 900, privateBytes: 500 * 1024 * 1024 }])
    const events = monitor.listEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.detail?.reason).toBe('growth')
    expect(events[0]!.detail?.deltaPrivateBytes).toBe(500 * 1024 * 1024 - 100)
  })

  it('GPU / utility 这类小进程不参与判定', () => {
    monitor.sampleChildProcesses([{ pid: 3, type: 'Utility', rss: 1, privateBytes: 1 }])
    monitor.sampleChildProcesses([{ pid: 3, type: 'Utility', rss: 9e9, privateBytes: 9e9 }])
    expect(monitor.listEvents()).toHaveLength(0)
  })
})

describe('PerformanceMonitor：今日回放', () => {
  it('重启后能读到今日已落盘的事件', async () => {
    monitor.recordEvent({ timestamp: Date.now(), kind: 'ipc.slow', name: 'agent-runtime:command', duration: 300 })
    await monitor.flush()
    monitor.destroy()

    const revived = makeMonitor()
    expect(revived.listEvents()).toHaveLength(1)
    // 回放不重复写盘：flush 一次后文件里仍只有一条
    await revived.flush()
    expect(loggedLines()).toHaveLength(1)
    revived.destroy()
  })

  it('旧格式（聚合 / 内存快照）被跳过', async () => {
    const date = new Date()
    const name = `perf-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}.jsonl`
    writeFileSync(
      join(tempDir, name),
      [
        JSON.stringify({ kind: 'ipc.aggregate', timestamp: 1, channel: 'x', totalCalls: 1 }),
        JSON.stringify({ kind: 'memory.snapshot', timestamp: 1, mainProcess: {} }),
        JSON.stringify({ kind: 'ipc.slow', timestamp: 2, name: 'chan', duration: 300 }),
      ].join('\n') + '\n',
    )
    monitor.destroy()

    const revived = makeMonitor()
    expect(revived.listEvents().map((e) => e.name)).toEqual(['chan'])
    revived.destroy()
  })
})

describe('asHydratableEvent', () => {
  it('拒绝脏行与未知 kind', () => {
    expect(asHydratableEvent(null)).toBeNull()
    expect(asHydratableEvent({ kind: 'nope', timestamp: 1, name: 'x' })).toBeNull()
    expect(asHydratableEvent({ kind: 'ipc.slow', timestamp: 1 })).toBeNull()
  })

  it('剔除非法 detail 值，保留合法字段', () => {
    const event = asHydratableEvent({
      kind: 'db.slow',
      timestamp: 5,
      name: 'SELECT ?',
      duration: 120,
      detail: { op: 'all', bad: { nested: 1 }, ok: 3 },
    })
    expect(event).toMatchObject({ kind: 'db.slow', duration: 120 })
    expect(event!.detail).toEqual({ op: 'all', ok: 3 })
  })
})
