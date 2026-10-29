import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PerformanceMonitor } from '../../plugins/external-src/perf/impl/performance-monitor'
import { createMeasuredHandler } from '../kernel/measured-handler'
import { getInflightSpans } from '../../shared/performance'
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
      memoryRssThresholdBytes: 2 * 1024 * 1024 * 1024,
      memoryGrowthThresholdBytes: 300 * 1024 * 1024,
      memorySpikeCooldownMs: 5 * 60_000,
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

  it('测量包装后的 handler，常规调用不产生慢事件', async () => {
    const mockHandler = vi.fn(async (..._args: unknown[]) => 'result')
    const measured = createMeasuredHandler('agent-runtime:command', mockHandler, monitor)

    const result = await measured({}, 'execute', 'task')

    expect(result).toBe('result')
    expect(monitor.listEvents()).toHaveLength(0)
    expect(monitor.getSummary().ipc.totalCalls).toBe(1)
  })

  it('慢调用的耗时会进事件列表', async () => {
    const slowHandler = async (..._args: unknown[]) => {
      await new Promise(r => setTimeout(r, 250))
      return 'result'
    }
    const measured = createMeasuredHandler('voice:command', slowHandler, monitor)

    await measured({})

    const events = monitor.listEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'ipc.slow', name: 'voice:command' })
    expect(events[0]!.duration).toBeGreaterThanOrEqual(200)
  })

  it('抛错的 handler 记一条 ipc.error 并把异常原样上抛', async () => {
    const failingHandler = async (..._args: unknown[]) => {
      throw new Error('boom')
    }
    const measured = createMeasuredHandler('screen-record:start', failingHandler, monitor)

    await expect(measured({})).rejects.toThrow('boom')
    expect(monitor.listEvents()[0]).toMatchObject({ kind: 'ipc.error', name: 'screen-record:start' })
    expect(monitor.getSummary().ipc.errors).toBe(1)
  })

  it('handler 执行期间压栈，结束后出栈', async () => {
    let seen: string[] = []
    const measured = createMeasuredHandler('agent-runtime:command', async (..._args: unknown[]) => {
      seen = getInflightSpans()
      return 1
    }, monitor)

    await measured({})
    expect(seen).toContain('agent-runtime:command')
    expect(getInflightSpans()).not.toContain('agent-runtime:command')
  })

  it('启动阶段写进 summary（不混进慢事件列表）', () => {
    monitor.recordStartupPhase('preload', 100)
    monitor.recordStartupPhase('window', 500)

    const summary = monitor.getSummary()
    expect(summary.startupStats.totalDuration).toBe(600)
    expect(summary.startupStats.phases['preload']).toBe(100)
    expect(monitor.listEvents()).toHaveLength(0)
  })
})
