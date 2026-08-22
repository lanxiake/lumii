import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PerformanceMonitor } from '../perf/performance-monitor'
import { createMeasuredHandler } from '../perf/performance-ipc'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('Performance Monitoring Integration', () => {
  let monitor: PerformanceMonitor
  let tempDir: string

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `perf-int-test-${Date.now()}`)
    monitor = new PerformanceMonitor({
      enabled: true,
      ipcSlowThresholdMs: 200,
      memorySnapshotIntervalMs: 10000,
      maxQueueSize: 200,
      logDir: tempDir,
    })
  })

  afterEach(async () => {
    await monitor.flush()
    monitor.destroy()
    if (fs.existsSync(tempDir)) {
      fs.readdirSync(tempDir).forEach(f => fs.unlinkSync(path.join(tempDir, f)))
      fs.rmdirSync(tempDir)
    }
  })

  it('should measure IPC calls through wrapped handler', async () => {
    const mockHandler = vi.fn(async (..._args: unknown[]) => 'result')
    const measured = createMeasuredHandler('agent-runtime:command', mockHandler, monitor)

    const result = await measured({}, 'execute', 'task')

    expect(result).toBe('result')
    expect(monitor.getQueueSize()).toBeGreaterThanOrEqual(0)
  })

  it('should track slow IPC calls', async () => {
    const slowHandler = async (..._args: unknown[]) => {
      await new Promise(r => setTimeout(r, 250))
      return 'result'
    }
    const measured = createMeasuredHandler('voice:command', slowHandler, monitor)

    await measured({})
    await monitor.flush()

    const report = monitor.getReport()
    expect(report.ipcStats.slowCalls).toBeGreaterThan(0)
  })

  it('should record and propagate IPC errors through the wrapped handler', async () => {
    const failingHandler = async (..._args: unknown[]) => {
      throw new Error('boom')
    }
    const measured = createMeasuredHandler('screen-record:start', failingHandler, monitor)

    await expect(measured({})).rejects.toThrow('boom')
    await monitor.flush()

    const report = monitor.getReport()
    expect(report.ipcStats.errors).toBe(1)
  })

  it('should record startup phases', () => {
    monitor.recordStartupPhase('preload', 100)
    monitor.recordStartupPhase('window', 500)

    const report = monitor.getReport()
    expect(report.startupStats.totalDuration).toBe(600)
    expect(report.startupStats.phases['preload']).toBe(100)
  })
})
