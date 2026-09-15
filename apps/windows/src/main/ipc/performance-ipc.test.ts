import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))

import { setupPerformanceIpcHandlers, normalizeRendererSample } from './performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import { ipcMain } from 'electron'

describe('Performance IPC Handlers', () => {
  let mockMonitor: PerformanceMonitor

  beforeEach(() => {
    vi.clearAllMocks()
    mockMonitor = {
      getReport: vi.fn(() => ({
        generatedAt: Date.now(),
        startupStats: { totalDuration: 1000, phases: { preload: 100, window: 500 }, completed: true },
        ipcStats: {
          totalCalls: 10,
          slowCalls: 1,
          errors: 0,
          channelBreakdown: {},
          averageLatency: 50,
        },
        memoryStats: {
          current: { mainProcess: { heapUsed: 100, external: 10, rss: 300 }, childProcesses: [] },
          peak: { mainProcess: { heapUsed: 100, external: 10, rss: 300 }, childProcesses: [] },
        },
        health: 'good',
      })),
      recordMemorySnapshot: vi.fn(),
      recordRendererMemory: vi.fn(),
      getIpcAggregateHistory: vi.fn(() => []),
      getMemorySnapshotHistory: vi.fn(() => []),
      cleanOldLogs: vi.fn(),
      destroy: vi.fn(),
    } as unknown as PerformanceMonitor
  })

  it('should register performance:getReport handler', () => {
    setupPerformanceIpcHandlers(mockMonitor)

    expect(ipcMain.handle).toHaveBeenCalledWith(
      'performance:getReport',
      expect.any(Function),
    )
  })

  it('should return performance report', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    const getReportCall = calls.find(c => c[0] === 'performance:getReport')
    const handler = getReportCall![1]

    const report = await handler({})
    expect(report.health).toBe('good')
    expect(report.ipcStats.totalCalls).toBe(10)
  })

  it('should handle performance:capture', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    const captureCall = calls.find(c => c[0] === 'performance:capture')
    const handler = captureCall![1]

    const result = await handler({})
    expect(result.success).toBe(true)
    expect(mockMonitor.recordMemorySnapshot).toHaveBeenCalledTimes(1)
  })

  it('should handle performance:openLogFolder', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    const openCall = calls.find(c => c[0] === 'performance:openLogFolder')
    const handler = openCall![1]

    const result = await handler({})
    expect(result.success).toBeDefined()
  })

  it('should return ipc aggregate and memory snapshot history', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
    const historyCall = calls.find(c => c[0] === 'performance:getHistory')
    const handler = historyCall![1]

    const result = await handler({})
    expect(result.ipcAggregates).toEqual([])
    expect(result.memorySnapshots).toEqual([])
    expect(mockMonitor.getIpcAggregateHistory).toHaveBeenCalledTimes(1)
    expect(mockMonitor.getMemorySnapshotHistory).toHaveBeenCalledTimes(1)
  })

  describe('performance:recordRendererMemory', () => {
    /** 取注册好的处理器；sender 用于提供渲染进程 pid */
    function getRendererMemoryHandler() {
      setupPerformanceIpcHandlers(mockMonitor)
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls
      const call = calls.find(c => c[0] === 'performance:recordRendererMemory')
      return { handler: call![1], event: { sender: { getOSProcessId: () => 4321 } } }
    }

    it('registers the renderer memory handler', () => {
      setupPerformanceIpcHandlers(mockMonitor)
      expect(ipcMain.handle).toHaveBeenCalledWith(
        'performance:recordRendererMemory',
        expect.any(Function),
      )
    })

    it('stamps timestamp and pid in the main process instead of trusting the renderer', async () => {
      const { handler, event } = getRendererMemoryHandler()

      const result = await handler(event, {
        jsHeapUsed: 209 * 1024 * 1024,
        jsHeapLimit: 4096 * 1024 * 1024,
        domNodes: 12139,
        topSessions: '394c9ea33cee:122',
        // 渲染层自填的字段必须被忽略
        pid: 999,
        timestamp: 1,
      })

      expect(result.success).toBe(true)
      const forwarded = (mockMonitor.recordRendererMemory as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(forwarded.kind).toBe('renderer.memory')
      expect(forwarded.pid).toBe(4321)
      expect(forwarded.timestamp).toBeGreaterThan(1)
      expect(forwarded.domNodes).toBe(12139)
    })

    it('rejects a non-object payload', async () => {
      const { handler, event } = getRendererMemoryHandler()

      const result = await handler(event, 'not-a-sample')

      expect(result).toEqual({ success: false, error: 'invalid-sample' })
      expect(mockMonitor.recordRendererMemory).not.toHaveBeenCalled()
    })
  })
})

describe('normalizeRendererSample', () => {
  it('returns null for non-object payloads', () => {
    expect(normalizeRendererSample(null)).toBeNull()
    expect(normalizeRendererSample('x')).toBeNull()
    expect(normalizeRendererSample(42)).toBeNull()
  })

  it('keeps valid counts as integers', () => {
    const sample = normalizeRendererSample({ domNodes: 4700.9, imgs: 2 })
    expect(sample?.domNodes).toBe(4700)
    expect(sample?.imgs).toBe(2)
  })

  it('turns NaN, Infinity, negatives and non-numbers into 0 so the jsonl line stays valid JSON', () => {
    const sample = normalizeRendererSample({
      jsHeapUsed: NaN,
      jsHeapLimit: Infinity,
      domNodes: -1,
      messages: '12',
      sessions: undefined,
    })
    expect(sample).toMatchObject({
      jsHeapUsed: 0,
      jsHeapLimit: 0,
      domNodes: 0,
      messages: 0,
      sessions: 0,
    })
    expect(JSON.parse(JSON.stringify(sample))).toBeTruthy()
  })

  it('truncates the topSessions summary and defaults it to empty string', () => {
    const long = 'x'.repeat(500)
    expect(normalizeRendererSample({ topSessions: long })?.topSessions).toHaveLength(200)
    expect(normalizeRendererSample({ topSessions: 42 })?.topSessions).toBe('')
  })

  it('fills missing fields with 0 rather than dropping the sample', () => {
    const sample = normalizeRendererSample({ jsHeapUsed: 1024 })
    expect(sample).not.toBeNull()
    expect(sample?.jsHeapUsed).toBe(1024)
    expect(sample?.domNodes).toBe(0)
    expect(sample?.topSessions).toBe('')
  })
})
