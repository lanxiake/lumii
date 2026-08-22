import { describe, it, expect, beforeEach } from 'vitest'
import { PerformanceAggregator } from './performance-aggregator'
import type { IpcSlowEvent, MemorySnapshotEvent } from './performance-types'

describe('PerformanceAggregator', () => {
  let aggregator: PerformanceAggregator

  beforeEach(() => {
    aggregator = new PerformanceAggregator()
  })

  it('should aggregate IPC events by channel', () => {
    const now = Date.now()
    aggregator.recordIpcCall('agent-runtime:command', 150, false)
    aggregator.recordIpcCall('agent-runtime:command', 180, false)
    aggregator.recordIpcCall('voice:command', 120, false)

    const stats = aggregator.getIpcStats()
    expect(stats.totalCalls).toBe(3)
    expect(stats.channelBreakdown['agent-runtime:command'].totalCalls).toBe(2)
    expect(stats.channelBreakdown['voice:command'].totalCalls).toBe(1)
  })

  it('should calculate average latency across all channels', () => {
    aggregator.recordIpcCall('agent-runtime:command', 100, false)
    aggregator.recordIpcCall('agent-runtime:command', 200, false)
    aggregator.recordIpcCall('voice:command', 150, false)

    const stats = aggregator.getIpcStats()
    expect(stats.averageLatency).toBe(150) // (100 + 200 + 150) / 3
  })

  it('should track slow calls separately', () => {
    aggregator.recordIpcCall('agent-runtime:command', 150, false)
    aggregator.recordIpcCall('agent-runtime:command', 250, false)
    aggregator.recordIpcCall('agent-runtime:command', 300, false)

    const stats = aggregator.getIpcStats()
    expect(stats.slowCalls).toBe(2) // 250ms and 300ms exceed 200ms threshold
  })

  it('should track IPC errors', () => {
    aggregator.recordIpcCall('agent-runtime:command', 100, false)
    aggregator.recordIpcCall('agent-runtime:command', 50, true)
    aggregator.recordIpcCall('voice:command', 80, true)

    const stats = aggregator.getIpcStats()
    expect(stats.errors).toBe(2)
    expect(stats.channelBreakdown['agent-runtime:command'].errorCalls).toBe(1)
  })

  it('should rotate aggregate event every 60 seconds', () => {
    const now = Date.now()
    aggregator.recordIpcCall('agent-runtime:command', 150, false)

    // Simulate 65 seconds passing
    const nextWindow = now + 65000
    aggregator.recordIpcCall('agent-runtime:command', 100, false, nextWindow)

    const events = aggregator.getAggregateEvents()
    // Should have at least one aggregate event from the previous window
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].kind).toBe('ipc.aggregate')
  })

  it('should record startup phases', () => {
    aggregator.recordStartupPhase('preload', 100)
    aggregator.recordStartupPhase('window', 500)
    aggregator.recordStartupPhase('agent-runtime', 800)

    const stats = aggregator.getStartupStats()
    expect(stats.phases['preload']).toBe(100)
    expect(stats.phases['window']).toBe(500)
    expect(stats.totalDuration).toBe(1400)
  })

  it('should record memory snapshots', () => {
    const snapshot: MemorySnapshotEvent = {
      timestamp: Date.now(),
      kind: 'memory.snapshot',
      mainProcess: { heapUsed: 100, external: 10, rss: 300 },
      childProcesses: [],
    }
    aggregator.recordMemorySnapshot(snapshot)

    const stats = aggregator.getMemoryStats()
    expect(stats.current.mainProcess.heapUsed).toBe(100)
    expect(stats.peak.mainProcess.heapUsed).toBe(100)
  })

  it('should track memory peak', () => {
    aggregator.recordMemorySnapshot({
      timestamp: Date.now(),
      kind: 'memory.snapshot',
      mainProcess: { heapUsed: 100, external: 10, rss: 300 },
      childProcesses: [],
    })
    aggregator.recordMemorySnapshot({
      timestamp: Date.now() + 1000,
      kind: 'memory.snapshot',
      mainProcess: { heapUsed: 150, external: 20, rss: 400 },
      childProcesses: [],
    })

    const stats = aggregator.getMemoryStats()
    expect(stats.peak.mainProcess.heapUsed).toBe(150)
    expect(stats.current.mainProcess.heapUsed).toBe(150)
  })

  it('should determine health status based on metrics', () => {
    // Good: low latency, no errors
    aggregator.recordIpcCall('agent-runtime:command', 50, false)
    aggregator.recordIpcCall('agent-runtime:command', 60, false)
    let report = aggregator.generateReport()
    expect(report.health).toBe('good')

    // Warning: some slow calls but not errors
    const agg2 = new PerformanceAggregator()
    agg2.recordIpcCall('agent-runtime:command', 250, false)
    agg2.recordIpcCall('agent-runtime:command', 280, false)
    report = agg2.generateReport()
    expect(['warning', 'good']).toContain(report.health)

    // Critical: many errors
    const agg3 = new PerformanceAggregator()
    for (let i = 0; i < 5; i++) {
      agg3.recordIpcCall('agent-runtime:command', 100, true)
    }
    report = agg3.generateReport()
    expect(report.health).toBe('critical')
  })
})
