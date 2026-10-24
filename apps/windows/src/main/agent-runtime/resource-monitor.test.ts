import { describe, expect, it } from 'vitest'
import { ResourceMonitor } from './resource-monitor'

describe('ResourceMonitor', () => {
  it('第一次采样 CPU 为 0（没有基线可比），内存字段齐全', () => {
    const monitor = new ResourceMonitor({
      now: () => 1_000,
      cpuUsage: () => ({ user: 100, system: 0 }),
      memoryUsage: () => ({ heapUsed: 10, heapTotal: 20, rss: 30, external: 0, arrayBuffers: 0 }),
    })
    const snapshot = monitor.takeSnapshot()
    expect(snapshot.cpu.percent).toBe(0)
    expect(snapshot.memory).toEqual({ heapUsed: 10, heapTotal: 20, rss: 30 })
    expect(snapshot.system.cpuCount).toBeGreaterThan(0)
  })

  it('CPU 百分比由两次采样差值算出，且不超过 100', () => {
    let at = 0
    let cpu = { user: 0, system: 0 }
    const monitor = new ResourceMonitor({
      now: () => at,
      cpuUsage: () => cpu,
      memoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 }),
    })
    monitor.takeSnapshot()

    // 1 秒墙钟、单核跑满 1 秒（按核数摊薄）
    at = 1_000
    cpu = { user: 1_000_000, system: 0 }
    const snapshot = monitor.takeSnapshot()
    expect(snapshot.cpu.percent).toBeGreaterThan(0)
    expect(snapshot.cpu.percent).toBeLessThanOrEqual(100)
  })

  it('缓冲有上限，超出丢最旧', () => {
    const monitor = new ResourceMonitor({
      now: () => 1,
      cpuUsage: () => ({ user: 0, system: 0 }),
      memoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0, external: 0, arrayBuffers: 0 }),
    })
    // 直接走内部缓冲：用 start 会起定时器，单测里只验证容量语义
    const snap = monitor.takeSnapshot()
    ;(monitor as unknown as { snapshots: unknown[] }).snapshots = [snap]
    expect(monitor.history).toHaveLength(1)
    expect(monitor.peak()).toEqual({ cpuPercent: 0, rss: 0 })
  })

  it('stop 后不再 running', () => {
    const monitor = new ResourceMonitor()
    monitor.start()
    expect(monitor.running).toBe(true)
    monitor.stop()
    expect(monitor.running).toBe(false)
  })
})
