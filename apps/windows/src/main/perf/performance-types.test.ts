import { describe, it, expect } from 'vitest'
import type {
  StartupPhaseEvent,
  IpcSlowEvent,
  MemorySnapshotEvent,
  PerformanceReport,
} from './performance-types'

describe('performance-types', () => {
  it('should define PerformanceEvent union type with all event kinds', () => {
    const startupEvent: StartupPhaseEvent = {
      timestamp: Date.now(),
      kind: 'startup.phase',
      phase: 'preload',
      duration: 150,
    }
    expect(startupEvent.kind).toBe('startup.phase')
    expect(startupEvent.duration).toBeGreaterThan(0)
  })

  it('should define IpcSlowEvent with channel and args', () => {
    const slowEvent: IpcSlowEvent = {
      timestamp: Date.now(),
      kind: 'ipc.slow',
      channel: 'agent-runtime:command',
      duration: 250,
      args: ['execute', 'some-task'],
    }
    expect(slowEvent.channel).toBe('agent-runtime:command')
    expect(slowEvent.duration).toBeGreaterThanOrEqual(200)
  })

  it('should define MemorySnapshotEvent with main and child process metrics', () => {
    const memEvent: MemorySnapshotEvent = {
      timestamp: Date.now(),
      kind: 'memory.snapshot',
      mainProcess: {
        heapUsed: 50 * 1024 * 1024,
        heapTotal: 80 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 3 * 1024 * 1024,
        rss: 150 * 1024 * 1024,
      },
      childProcesses: [
        {
          pid: 1234,
          type: 'utility',
          workingSetSize: 30 * 1024 * 1024,
          privateBytes: 25 * 1024 * 1024,
        },
      ],
    }
    expect(memEvent.mainProcess.heapUsed).toBeGreaterThan(0)
    expect(memEvent.childProcesses.length).toBe(1)
  })

  it('should define PerformanceReport aggregation structure', () => {
    const report: PerformanceReport = {
      generatedAt: Date.now(),
      startupStats: {
        totalDuration: 3000,
        phases: {},
        completed: true,
      },
      ipcStats: {
        totalCalls: 42,
        slowCalls: 3,
        errors: 1,
        channelBreakdown: {},
        averageLatency: 85,
      },
      memoryStats: {
        current: {
          mainProcess: { heapUsed: 100, heapTotal: 150, external: 10, arrayBuffers: 4, rss: 300 },
          childProcesses: [],
        },
        peak: {
          mainProcess: { heapUsed: 150, heapTotal: 200, external: 20, arrayBuffers: 6, rss: 450 },
          childProcesses: [],
        },
      },
      health: 'good',
    }
    expect(report.health).toMatch(/^(good|warning|critical)$/)
    expect(report.ipcStats.totalCalls).toBeGreaterThanOrEqual(0)
  })
})
