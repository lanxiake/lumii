import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
}))

import { setupPerformanceIpcHandlers } from './performance-ipc'
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
})
