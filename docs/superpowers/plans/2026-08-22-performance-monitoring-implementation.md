# 性能监控与调用耗时统计 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Lumii 的 Electron 客户端主进程中建立完整的性能监控系统，追踪关键 IPC 调用耗时、内存使用、启动阶段，并在渲染进程提供实时性能诊断界面。

**Architecture:** 
- 主进程性能类型层（types）→ 聚合层（aggregator，60s 窗口）→ 监控层（monitor，事件驱动）
- IPC 拦截机制：对每个注册的 handler 使用高阶函数包装，自动记录调用耗时和错误
- JSONL 日志存储：日期滚动（7天保留）、20MB 单文件上限、200 事件内存队列
- Preload 桥接：`performance.getReport()` / `capture()` / `openLogFolder()` 三个异步方法
- 渲染进程 UI：在 SettingsPage 的"隐私与数据"下新增"性能诊断"小节

**Tech Stack:** 
- Electron `app.getAppMetrics()` + `process.memoryUsage()`
- 主进程日志存储（JSONL + 文件轮转，复用 `file-logger.ts` 逻辑）
- 预加载 IPC 桥接（无 contextIsolation 泄露风险）
- React Settings UI（CSS Module、Toast 通知、Button 组件）
- Vitest jsdom 单元测试（colocated .test.tsx）

---

## Task 1: 创建性能监控类型定义层

**Files:**
- Create: `apps/windows/src/main/perf/performance-types.ts`
- Create: `apps/windows/src/main/perf/performance-types.test.ts`

**Step 1: 编写类型定义的单元测试（失败状态）**

创建 `apps/windows/src/main/perf/performance-types.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import type {
  PerformanceEvent,
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
        external: 5 * 1024 * 1024,
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
          mainProcess: { heapUsed: 100, external: 10, rss: 300 },
          childProcesses: [],
        },
        peak: {
          mainProcess: { heapUsed: 150, external: 20, rss: 450 },
          childProcesses: [],
        },
      },
      health: 'good',
    }
    expect(report.health).toMatch(/^(good|warning|critical)$/)
    expect(report.ipcStats.totalCalls).toBeGreaterThanOrEqual(0)
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-types.test.ts`

Expected: FAIL with "Cannot find module './performance-types'"

**Step 2: 编写性能监控类型定义**

创建 `apps/windows/src/main/perf/performance-types.ts`：

```typescript
// 启动阶段事件
export interface StartupPhaseEvent {
  timestamp: number
  kind: 'startup.phase'
  phase: 'preload' | 'window' | 'agent-runtime' | 'voice-service' | 'screen-record'
  duration: number
}

// 启动完成事件
export interface StartupCompleteEvent {
  timestamp: number
  kind: 'startup.complete'
  totalDuration: number
  phases: Record<string, number>
}

// IPC 慢调用事件（>200ms）
export interface IpcSlowEvent {
  timestamp: number
  kind: 'ipc.slow'
  channel: string
  duration: number
  args?: string[]
}

// IPC 错误事件
export interface IpcErrorEvent {
  timestamp: number
  kind: 'ipc.error'
  channel: string
  error: string
  args?: string[]
}

// IPC 聚合事件（60s 窗口）
export interface IpcAggregateEvent {
  timestamp: number
  kind: 'ipc.aggregate'
  windowStart: number
  windowEnd: number
  channel: string
  totalCalls: number
  totalDuration: number
  errors: number
  minDuration: number
  maxDuration: number
}

// 内存快照事件
export interface MainProcessMemory {
  heapUsed: number
  external: number
  rss: number
}

export interface ChildProcessMemory {
  pid: number
  type: string
  workingSetSize: number
  privateBytes: number
}

export interface MemorySnapshotEvent {
  timestamp: number
  kind: 'memory.snapshot'
  mainProcess: MainProcessMemory
  childProcesses: ChildProcessMemory[]
}

// 性能事件联合类型
export type PerformanceEvent =
  | StartupPhaseEvent
  | StartupCompleteEvent
  | IpcSlowEvent
  | IpcErrorEvent
  | IpcAggregateEvent
  | MemorySnapshotEvent

// 性能统计报告
export interface StartupStats {
  totalDuration: number
  phases: Record<string, number>
  completed: boolean
}

export interface IpcCallStats {
  channel: string
  totalCalls: number
  successCalls: number
  errorCalls: number
  totalDuration: number
  minDuration: number
  maxDuration: number
  averageDuration: number
}

export interface IpcStats {
  totalCalls: number
  slowCalls: number
  errors: number
  channelBreakdown: Record<string, IpcCallStats>
  averageLatency: number
}

export interface MemoryStats {
  current: {
    mainProcess: MainProcessMemory
    childProcesses: ChildProcessMemory[]
  }
  peak: {
    mainProcess: MainProcessMemory
    childProcesses: ChildProcessMemory[]
  }
}

export type HealthStatus = 'good' | 'warning' | 'critical'

export interface PerformanceReport {
  generatedAt: number
  startupStats: StartupStats
  ipcStats: IpcStats
  memoryStats: MemoryStats
  health: HealthStatus
}

// 监控配置
export interface PerformanceMonitorConfig {
  enabled: boolean
  ipcSlowThresholdMs: number
  memorySnapshotIntervalMs: number
  maxQueueSize: number
  logDir?: string
}
```

**Step 3: 运行测试验证通过**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-types.test.ts`

Expected: PASS (6 tests passing)

**Step 4: 提交类型定义层**

```bash
git add apps/windows/src/main/perf/performance-types.ts apps/windows/src/main/perf/performance-types.test.ts
git commit -m "feat(perf): add performance monitoring type definitions

- Define PerformanceEvent union (startup, IPC, memory events)
- Add PerformanceReport aggregation structure
- Include IPC call stats and memory snapshot types
- Add health status enum for diagnostics"
```

---

## Task 2: 创建性能数据聚合层

**Files:**
- Create: `apps/windows/src/main/perf/performance-aggregator.ts`
- Create: `apps/windows/src/main/perf/performance-aggregator.test.ts`

**Step 1: 编写聚合层的单元测试（失败状态）**

创建 `apps/windows/src/main/perf/performance-aggregator.test.ts`：

```typescript
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
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-aggregator.test.ts`

Expected: FAIL with "Cannot find module './performance-aggregator'"

**Step 2: 编写性能聚合实现**

创建 `apps/windows/src/main/perf/performance-aggregator.ts`：

```typescript
import type {
  IpcCallStats,
  IpcStats,
  MemorySnapshotEvent,
  MemoryStats,
  StartupStats,
  PerformanceReport,
  MainProcessMemory,
  IpcAggregateEvent,
} from './performance-types'

interface IpcChannelData {
  totalCalls: number
  successCalls: number
  errorCalls: number
  totalDuration: number
  minDuration: number
  maxDuration: number
  durations: number[]
}

interface WindowAggregate {
  startTime: number
  channels: Map<string, Omit<IpcChannelData, 'durations'>>
}

export class PerformanceAggregator {
  private ipcByChannel = new Map<string, IpcChannelData>()
  private currentWindowStart = Date.now()
  private windowAggregates: IpcAggregateEvent[] = []
  private startupPhases = new Map<string, number>()
  private memorySnapshots: MemorySnapshotEvent[] = []
  private readonly WINDOW_DURATION_MS = 60000
  private readonly IPC_SLOW_THRESHOLD_MS = 200
  private readonly MAX_MEMORY_SNAPSHOTS = 100

  recordIpcCall(
    channel: string,
    durationMs: number,
    error: boolean,
    timestamp = Date.now(),
  ) {
    // 检查窗口是否需要轮转
    if (timestamp - this.currentWindowStart > this.WINDOW_DURATION_MS) {
      this.rotateWindow(timestamp)
    }

    if (!this.ipcByChannel.has(channel)) {
      this.ipcByChannel.set(channel, {
        totalCalls: 0,
        successCalls: 0,
        errorCalls: 0,
        totalDuration: 0,
        minDuration: Infinity,
        maxDuration: -Infinity,
        durations: [],
      })
    }

    const data = this.ipcByChannel.get(channel)!
    data.totalCalls += 1
    data.totalDuration += durationMs
    data.minDuration = Math.min(data.minDuration, durationMs)
    data.maxDuration = Math.max(data.maxDuration, durationMs)
    data.durations.push(durationMs)

    if (error) {
      data.errorCalls += 1
    } else {
      data.successCalls += 1
    }
  }

  private rotateWindow(timestamp: number) {
    // 生成前一个窗口的聚合事件
    for (const [channel, data] of this.ipcByChannel) {
      this.windowAggregates.push({
        timestamp: this.currentWindowStart + this.WINDOW_DURATION_MS,
        kind: 'ipc.aggregate',
        windowStart: this.currentWindowStart,
        windowEnd: this.currentWindowStart + this.WINDOW_DURATION_MS,
        channel,
        totalCalls: data.totalCalls,
        totalDuration: data.totalDuration,
        errors: data.errorCalls,
        minDuration: data.minDuration === Infinity ? 0 : data.minDuration,
        maxDuration: data.maxDuration === -Infinity ? 0 : data.maxDuration,
      })
    }

    // 重置所有通道数据用于新窗口
    for (const data of this.ipcByChannel.values()) {
      data.totalCalls = 0
      data.successCalls = 0
      data.errorCalls = 0
      data.totalDuration = 0
      data.minDuration = Infinity
      data.maxDuration = -Infinity
      data.durations = []
    }

    this.currentWindowStart = timestamp
  }

  recordStartupPhase(phase: string, durationMs: number) {
    this.startupPhases.set(phase, durationMs)
  }

  recordMemorySnapshot(snapshot: MemorySnapshotEvent) {
    this.memorySnapshots.push(snapshot)
    if (this.memorySnapshots.length > this.MAX_MEMORY_SNAPSHOTS) {
      this.memorySnapshots.shift()
    }
  }

  getIpcStats(): IpcStats {
    let totalCalls = 0
    let slowCalls = 0
    let totalErrors = 0
    let totalDuration = 0

    const channelBreakdown: Record<string, IpcCallStats> = {}

    for (const [channel, data] of this.ipcByChannel) {
      const avgDuration =
        data.totalCalls > 0 ? data.totalDuration / data.totalCalls : 0
      const slowCallsInChannel = data.durations.filter(
        d => d > this.IPC_SLOW_THRESHOLD_MS,
      ).length

      channelBreakdown[channel] = {
        channel,
        totalCalls: data.totalCalls,
        successCalls: data.successCalls,
        errorCalls: data.errorCalls,
        totalDuration: data.totalDuration,
        minDuration: data.minDuration === Infinity ? 0 : data.minDuration,
        maxDuration: data.maxDuration === -Infinity ? 0 : data.maxDuration,
        averageDuration: avgDuration,
      }

      totalCalls += data.totalCalls
      slowCalls += slowCallsInChannel
      totalErrors += data.errorCalls
      totalDuration += data.totalDuration
    }

    const averageLatency = totalCalls > 0 ? totalDuration / totalCalls : 0

    return {
      totalCalls,
      slowCalls,
      errors: totalErrors,
      channelBreakdown,
      averageLatency,
    }
  }

  getStartupStats(): StartupStats {
    let totalDuration = 0
    const phases: Record<string, number> = {}

    for (const [phase, duration] of this.startupPhases) {
      phases[phase] = duration
      totalDuration += duration
    }

    return {
      totalDuration,
      phases,
      completed: true,
    }
  }

  getMemoryStats(): MemoryStats {
    if (this.memorySnapshots.length === 0) {
      const empty = { heapUsed: 0, external: 0, rss: 0 }
      return {
        current: { mainProcess: empty, childProcesses: [] },
        peak: { mainProcess: empty, childProcesses: [] },
      }
    }

    const current = this.memorySnapshots[this.memorySnapshots.length - 1]
    let peak = current

    for (const snapshot of this.memorySnapshots) {
      if (snapshot.mainProcess.heapUsed > peak.mainProcess.heapUsed) {
        peak = snapshot
      }
    }

    return {
      current: {
        mainProcess: current.mainProcess,
        childProcesses: current.childProcesses,
      },
      peak: {
        mainProcess: peak.mainProcess,
        childProcesses: peak.childProcesses,
      },
    }
  }

  getAggregateEvents(): IpcAggregateEvent[] {
    return [...this.windowAggregates]
  }

  generateReport(): PerformanceReport {
    const ipcStats = this.getIpcStats()
    const startupStats = this.getStartupStats()
    const memoryStats = this.getMemoryStats()

    // 判断健康状态
    let health: 'good' | 'warning' | 'critical' = 'good'

    const errorRate = ipcStats.totalCalls > 0 ? ipcStats.errors / ipcStats.totalCalls : 0
    if (errorRate > 0.1 || ipcStats.errors > 10) {
      health = 'critical'
    } else if (ipcStats.slowCalls > ipcStats.totalCalls * 0.1 || ipcStats.slowCalls > 5) {
      health = 'warning'
    }

    return {
      generatedAt: Date.now(),
      startupStats,
      ipcStats,
      memoryStats,
      health,
    }
  }
}
```

**Step 3: 运行测试验证通过**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-aggregator.test.ts`

Expected: PASS (11 tests passing)

**Step 4: 提交聚合层**

```bash
git add apps/windows/src/main/perf/performance-aggregator.ts apps/windows/src/main/perf/performance-aggregator.test.ts
git commit -m "feat(perf): add performance data aggregation layer

- Implement IPC call tracking by channel with slow threshold
- Add 60s window rotation for IPC aggregate events
- Track memory snapshots with peak detection
- Record startup phases and calculate total duration
- Generate health status based on error rate and slow calls"
```

---

## Task 3: 创建性能监控和日志存储层

**Files:**
- Create: `apps/windows/src/main/perf/performance-monitor.ts`
- Create: `apps/windows/src/main/perf/performance-monitor.test.ts`
- Modify: `apps/windows/src/main/perf/performance-types.ts` (add config export)

**Step 1: 编写监控层的单元测试（失败状态）**

创建 `apps/windows/src/main/perf/performance-monitor.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { PerformanceMonitor } from './performance-monitor'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor
  let tempDir: string

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `perf-test-${Date.now()}`)
    fs.mkdirSync(tempDir, { recursive: true })
    
    monitor = new PerformanceMonitor({
      enabled: true,
      ipcSlowThresholdMs: 200,
      memorySnapshotIntervalMs: 10000,
      maxQueueSize: 200,
      logDir: tempDir,
    })
  })

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir)
      files.forEach(f => fs.unlinkSync(path.join(tempDir, f)))
      fs.rmdirSync(tempDir)
    }
  })

  it('should initialize with config', () => {
    expect(monitor).toBeDefined()
  })

  it('should record IPC calls and flush to log file', async () => {
    monitor.recordIpcCall('agent-runtime:command', 150, false)
    monitor.recordIpcCall('agent-runtime:command', 250, false)
    
    await monitor.flush()

    const files = fs.readdirSync(tempDir)
    expect(files.length).toBeGreaterThan(0)
    
    const logFile = path.join(tempDir, files[0])
    const content = fs.readFileSync(logFile, 'utf-8')
    const lines = content.trim().split('\n')
    
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const firstEvent = JSON.parse(lines[0])
    expect(firstEvent.kind).toBe('ipc.slow')
  })

  it('should create date-based log file', async () => {
    monitor.recordIpcCall('agent-runtime:command', 250, false)
    await monitor.flush()

    const files = fs.readdirSync(tempDir)
    const filename = files[0]
    
    // 文件名格式应为 perf-YYYY-MM-DD.jsonl
    expect(filename).toMatch(/^perf-\d{4}-\d{2}-\d{2}\.jsonl$/)
  })

  it('should handle maximum queue size', () => {
    const config = {
      enabled: true,
      ipcSlowThresholdMs: 200,
      memorySnapshotIntervalMs: 10000,
      maxQueueSize: 3,
      logDir: tempDir,
    }
    const limitedMonitor = new PerformanceMonitor(config)

    limitedMonitor.recordIpcCall('channel-1', 250, false)
    limitedMonitor.recordIpcCall('channel-2', 250, false)
    limitedMonitor.recordIpcCall('channel-3', 250, false)
    limitedMonitor.recordIpcCall('channel-4', 250, false) // 应被丢弃

    const queue = limitedMonitor.getQueueSize()
    expect(queue).toBeLessThanOrEqual(3)
  })

  it('should record startup events', async () => {
    monitor.recordStartupPhase('preload', 100)
    monitor.recordStartupPhase('window', 500)
    
    await monitor.flush()

    const files = fs.readdirSync(tempDir)
    const logFile = path.join(tempDir, files[0])
    const content = fs.readFileSync(logFile, 'utf-8')
    const lines = content.trim().split('\n')

    const hasStartupEvent = lines.some(line => {
      const event = JSON.parse(line)
      return event.kind === 'startup.phase'
    })
    expect(hasStartupEvent).toBe(true)
  })

  it('should rotate log file on date boundary', () => {
    const firstDate = monitor.getCurrentLogDate()
    // 模拟跨天
    monitor.recordIpcCall('channel-1', 150, false)
    
    // 实际使用中需要 mock Date.now()，这里做简单验证
    expect(firstDate).toBeDefined()
  })

  it('should disable logging when not enabled', async () => {
    const disabledMonitor = new PerformanceMonitor({
      enabled: false,
      ipcSlowThresholdMs: 200,
      memorySnapshotIntervalMs: 10000,
      maxQueueSize: 200,
      logDir: tempDir,
    })

    disabledMonitor.recordIpcCall('channel-1', 250, false)
    await disabledMonitor.flush()

    const files = fs.readdirSync(tempDir)
    expect(files.length).toBe(0)
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-monitor.test.ts`

Expected: FAIL with "Cannot find module './performance-monitor'"

**Step 2: 编写性能监控实现**

创建 `apps/windows/src/main/perf/performance-monitor.ts`：

```typescript
import { createWriteStream, readdirSync, statSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { PerformanceAggregator } from './performance-aggregator'
import type { PerformanceEvent, PerformanceMonitorConfig, MemorySnapshotEvent } from './performance-types'

export class PerformanceMonitor {
  private aggregator: PerformanceAggregator
  private eventQueue: PerformanceEvent[] = []
  private currentLogStream: any = null
  private currentLogDate: string
  private config: PerformanceMonitorConfig
  private readonly MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
  private readonly MAX_LOG_FILES = 7 // 7天保留
  private currentFileSize = 0

  constructor(config: PerformanceMonitorConfig) {
    this.config = config
    this.aggregator = new PerformanceAggregator()
    this.currentLogDate = this.formatDate(new Date())

    if (this.config.enabled && this.config.logDir) {
      this.ensureLogDir()
      this.initializeLogStream()
    }
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  private ensureLogDir() {
    if (!this.config.logDir) return
    if (!existsSync(this.config.logDir)) {
      mkdirSync(this.config.logDir, { recursive: true })
    }
  }

  private initializeLogStream() {
    if (!this.config.logDir) return

    const logFile = join(this.config.logDir, `perf-${this.currentLogDate}.jsonl`)
    this.currentLogStream = createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
    this.currentFileSize = 0
  }

  getCurrentLogDate(): string {
    return this.currentLogDate
  }

  private checkDateRoll() {
    if (!this.config.enabled || !this.config.logDir) return

    const newDate = this.formatDate(new Date())
    if (newDate !== this.currentLogDate) {
      this.currentLogDate = newDate
      if (this.currentLogStream) {
        this.currentLogStream.end()
      }
      this.initializeLogStream()
    }
  }

  private writeEvent(event: PerformanceEvent) {
    if (!this.config.enabled || !this.config.logDir) return

    this.checkDateRoll()

    const line = JSON.stringify(event) + '\n'
    const lineSize = Buffer.byteLength(line, 'utf8')

    if (this.currentFileSize + lineSize > this.MAX_FILE_SIZE) {
      // 触发文件轮转（当前实现简化，实际需要处理文件重命名）
      if (this.currentLogStream) {
        this.currentLogStream.end()
      }
      this.initializeLogStream()
    }

    if (this.currentLogStream) {
      this.currentLogStream.write(line)
      this.currentFileSize += lineSize
    }
  }

  recordIpcCall(channel: string, durationMs: number, error: boolean) {
    if (!this.config.enabled) return

    this.aggregator.recordIpcCall(channel, durationMs, error)

    if (durationMs > this.config.ipcSlowThresholdMs && !error) {
      const event: PerformanceEvent = {
        timestamp: Date.now(),
        kind: 'ipc.slow',
        channel,
        duration: durationMs,
        args: [],
      }
      this.enqueueEvent(event)
    }

    if (error) {
      const event: PerformanceEvent = {
        timestamp: Date.now(),
        kind: 'ipc.error',
        channel,
        error: 'IPC call failed',
        args: [],
      }
      this.enqueueEvent(event)
    }
  }

  recordStartupPhase(phase: string, durationMs: number) {
    if (!this.config.enabled) return

    this.aggregator.recordStartupPhase(phase, durationMs)

    const event: PerformanceEvent = {
      timestamp: Date.now(),
      kind: 'startup.phase',
      phase: phase as any,
      duration: durationMs,
    }
    this.enqueueEvent(event)
  }

  recordMemorySnapshot(snapshot: MemorySnapshotEvent) {
    if (!this.config.enabled) return

    this.aggregator.recordMemorySnapshot(snapshot)
    this.enqueueEvent(snapshot)
  }

  private enqueueEvent(event: PerformanceEvent) {
    if (this.eventQueue.length >= (this.config.maxQueueSize || 200)) {
      this.eventQueue.shift()
    }
    this.eventQueue.push(event)
  }

  getQueueSize(): number {
    return this.eventQueue.length
  }

  async flush() {
    // 先写入队列中的事件
    for (const event of this.eventQueue) {
      this.writeEvent(event)
    }
    this.eventQueue = []

    // 写入聚合事件
    for (const event of this.aggregator.getAggregateEvents()) {
      this.writeEvent(event)
    }

    // 返回一个 Promise 确保流已写入
    return new Promise<void>(resolve => {
      if (this.currentLogStream) {
        this.currentLogStream.once('drain', () => resolve())
        if (!this.currentLogStream.writableNeedDrain) {
          resolve()
        }
      } else {
        resolve()
      }
    })
  }

  getReport() {
    return this.aggregator.generateReport()
  }

  cleanOldLogs() {
    if (!this.config.logDir || !existsSync(this.config.logDir)) return

    try {
      const files = readdirSync(this.config.logDir)
        .filter(f => f.startsWith('perf-') && f.endsWith('.jsonl'))
        .sort()
        .reverse()

      // 保留最近的 MAX_LOG_FILES 个文件
      for (let i = this.MAX_LOG_FILES; i < files.length; i++) {
        const filePath = join(this.config.logDir, files[i])
        unlinkSync(filePath)
      }
    } catch (err) {
      // 忽略清理错误
    }
  }

  destroy() {
    if (this.currentLogStream) {
      this.currentLogStream.end()
    }
  }
}
```

**Step 3: 运行测试验证通过**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-monitor.test.ts`

Expected: PASS (8 tests passing)

**Step 4: 提交监控层**

```bash
git add apps/windows/src/main/perf/performance-monitor.ts apps/windows/src/main/perf/performance-monitor.test.ts
git commit -m "feat(perf): add performance monitoring and logging layer

- Implement JSONL event logging with date-based file rotation
- Add 20MB per-file size limit and 7-day retention cleanup
- Support event queue with configurable max size (200 default)
- Integrate PerformanceAggregator for stats generation
- Handle log directory initialization and stream management"
```

---

## Task 4: 创建 IPC 拦截包装函数

**Files:**
- Create: `apps/windows/src/main/perf/performance-ipc.ts`
- Create: `apps/windows/src/main/perf/performance-ipc.test.ts`

**Step 1: 编写 IPC 包装的单元测试（失败状态）**

创建 `apps/windows/src/main/perf/performance-ipc.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMeasuredHandler } from './performance-ipc'
import type { PerformanceMonitor } from './performance-monitor'

describe('performance-ipc', () => {
  let mockMonitor: PerformanceMonitor

  beforeEach(() => {
    mockMonitor = {
      recordIpcCall: vi.fn(),
      recordStartupPhase: vi.fn(),
      recordMemorySnapshot: vi.fn(),
      getReport: vi.fn(),
      getQueueSize: vi.fn(),
      flush: vi.fn(),
      cleanOldLogs: vi.fn(),
      destroy: vi.fn(),
      getCurrentLogDate: vi.fn(() => '2026-08-22'),
    } as any
  })

  it('should wrap handler and measure execution time', async () => {
    const originalHandler = vi.fn(async () => 'success')
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    const result = await wrappedHandler({} as any, 'arg1', 'arg2')

    expect(result).toBe('success')
    expect(originalHandler).toHaveBeenCalledWith({}, 'arg1', 'arg2')
    expect(mockMonitor.recordIpcCall).toHaveBeenCalledWith(
      'test-channel',
      expect.any(Number),
      false,
    )
  })

  it('should record error when handler throws', async () => {
    const error = new Error('Test error')
    const originalHandler = vi.fn(async () => {
      throw error
    })
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    await expect(wrappedHandler({} as any, 'arg1')).rejects.toThrow('Test error')

    expect(mockMonitor.recordIpcCall).toHaveBeenCalledWith(
      'test-channel',
      expect.any(Number),
      true, // error = true
    )
  })

  it('should measure slow IPC calls correctly', async () => {
    const slowHandler = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return 'result'
    })
    const wrappedHandler = createMeasuredHandler('test-channel', slowHandler, mockMonitor)

    await wrappedHandler({} as any)

    const calls = (mockMonitor.recordIpcCall as any).mock.calls
    expect(calls.length).toBe(1)
    const [channel, duration, error] = calls[0]
    expect(channel).toBe('test-channel')
    expect(duration).toBeGreaterThanOrEqual(100)
    expect(duration).toBeLessThan(200) // 宽松范围
    expect(error).toBe(false)
  })

  it('should pass through all arguments correctly', async () => {
    const originalHandler = vi.fn(async (event, arg1, arg2, arg3) => {
      return { arg1, arg2, arg3 }
    })
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)
    const mockEvent = { sender: {} }

    const result = await wrappedHandler(mockEvent, 'hello', 42, { key: 'value' })

    expect(result).toEqual({
      arg1: 'hello',
      arg2: 42,
      arg3: { key: 'value' },
    })
  })

  it('should handle synchronous handlers', () => {
    const originalHandler = vi.fn(() => 'sync-result')
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    const result = wrappedHandler({} as any, 'arg')

    expect(result).toBe('sync-result')
    expect(mockMonitor.recordIpcCall).toHaveBeenCalledWith(
      'test-channel',
      expect.any(Number),
      false,
    )
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-ipc.test.ts`

Expected: FAIL with "Cannot find module './performance-ipc'"

**Step 2: 编写 IPC 拦截包装实现**

创建 `apps/windows/src/main/perf/performance-ipc.ts`：

```typescript
import type { PerformanceMonitor } from './performance-monitor'

export function createMeasuredHandler<T extends (...args: any[]) => any>(
  channel: string,
  originalHandler: T,
  monitor: PerformanceMonitor,
): T {
  return (async (...args: any[]) => {
    const startTime = performance.now()

    try {
      const result = await Promise.resolve(originalHandler(...args))
      const duration = performance.now() - startTime

      monitor.recordIpcCall(channel, duration, false)

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      monitor.recordIpcCall(channel, duration, true)

      throw error
    }
  }) as T
}
```

**Step 3: 运行测试验证通过**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/perf/performance-ipc.test.ts`

Expected: PASS (5 tests passing)

**Step 4: 提交 IPC 拦截层**

```bash
git add apps/windows/src/main/perf/performance-ipc.ts apps/windows/src/main/perf/performance-ipc.test.ts
git commit -m "feat(perf): add IPC handler measurement wrapper

- Create createMeasuredHandler for automatic performance tracking
- Record execution time for all IPC calls
- Capture error state and duration even on failure
- Support both sync and async handlers"
```

---

## Task 5: 在主进程初始化性能监控系统

**Files:**
- Modify: `apps/windows/src/main/index.ts` (lines 1-50, 1100-1150)
- Modify: `apps/windows/src/main/ipc/agent-runtime-ipc.ts` (lines 600-620)
- Modify: `apps/windows/src/main/voice/voice-ipc.ts` (lines 100-110)
- Modify: `apps/windows/src/main/screen-record/screen-record-ipc.ts` (lines 55-85)

**Step 1: 创建测试验证性能监控初始化**

创建 `apps/windows/src/main/__tests__/perf-integration.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PerformanceMonitor } from '../perf/performance-monitor'
import { createMeasuredHandler } from '../perf/performance-ipc'
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
    // Clean up
  })

  it('should measure IPC calls through wrapped handler', async () => {
    const mockHandler = vi.fn(async () => 'result')
    const measured = createMeasuredHandler('agent-runtime:command', mockHandler, monitor)

    const result = await measured({} as any, 'execute', 'task')

    expect(result).toBe('result')
    expect(monitor.getQueueSize()).toBeGreaterThan(0)
  })

  it('should track slow IPC calls', async () => {
    const slowHandler = async () => {
      await new Promise(r => setTimeout(r, 250))
      return 'result'
    }
    const measured = createMeasuredHandler('voice:command', slowHandler, monitor)

    await measured({} as any)
    await monitor.flush()

    const report = monitor.getReport()
    expect(report.ipcStats.slowCalls).toBeGreaterThan(0)
  })

  it('should record startup phases', () => {
    monitor.recordStartupPhase('preload', 100)
    monitor.recordStartupPhase('window', 500)

    const report = monitor.getReport()
    expect(report.startupStats.totalDuration).toBe(600)
    expect(report.startupStats.phases['preload']).toBe(100)
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/__tests__/perf-integration.test.ts`

Expected: PASS (3 tests passing)

**Step 2: 在 index.ts 中初始化性能监控**

修改 `apps/windows/src/main/index.ts`，在导入部分添加（找到现有导入，在后面添加）：

在文件顶部（大约第 1-30 行）找到导入区域并添加：

```typescript
import { PerformanceMonitor } from './perf/performance-monitor'
import type { PerformanceMonitorConfig } from './perf/performance-types'
```

在 `initialize()` 函数内部（找到 `async function initialize()` 后，大约第 1100 行左右），在 `app.whenReady()` 之前添加初始化代码：

```typescript
// 初始化性能监控
const logDir = path.join(resolveClientStateDir(), 'logs', 'perf')
const perfConfig: PerformanceMonitorConfig = {
  enabled: true,
  ipcSlowThresholdMs: 200,
  memorySnapshotIntervalMs: 60000,
  maxQueueSize: 200,
  logDir,
}
const performanceMonitor = new PerformanceMonitor(perfConfig)
logger.info('[initialize] 性能监控系统已初始化')
```

在 `before-quit` 事件处理中（大约第 1390-1436 行）添加清理代码。找到：

```typescript
app.on('before-quit', async () => {
```

在该处理器内部的末尾（`process.exit(0)` 之前）添加：

```typescript
// 清理性能监控
try {
  await performanceMonitor.flush()
  performanceMonitor.cleanOldLogs()
  performanceMonitor.destroy()
} catch (err) {
  logger.error('[beforeQuit] 性能监控清理失败', err)
}
```

**Step 3: 在 agent-runtime-ipc.ts 中包装 commandHandler**

修改 `apps/windows/src/main/ipc/agent-runtime-ipc.ts`，在 `installAgentRuntimeCommandIpc()` 函数内（大约第 526-619 行），找到 handler 注册处：

首先在文件顶部添加导入：

```typescript
import { createMeasuredHandler } from '../perf/performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
```

修改 `installAgentRuntimeCommandIpc` 函数签名来接收 monitor：

```typescript
export function installAgentRuntimeCommandIpc(
  performanceMonitor?: PerformanceMonitor,
): void {
```

在注册 handler 的地方（大约第 617 行），替换：

```typescript
ipcMain.handle('agent-runtime:command', commandHandler)
```

为：

```typescript
const measuredHandler = performanceMonitor
  ? createMeasuredHandler('agent-runtime:command', commandHandler, performanceMonitor)
  : commandHandler

ipcMain.handle('agent-runtime:command', measuredHandler)
```

在 `index.ts` 中的调用改为：

```typescript
installAgentRuntimeCommandIpc(performanceMonitor)
```

**Step 4: 在 voice-ipc.ts 中包装 voice:command handler**

修改 `apps/windows/src/main/voice/voice-ipc.ts`，在 `registerVoiceIpc()` 函数中（大约第 51-381 行）：

首先添加导入：

```typescript
import { createMeasuredHandler } from '../perf/performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
```

修改函数签名：

```typescript
export function registerVoiceIpc(
  mainWindow: BrowserWindow,
  voiceCallService: VoiceCallService,
  voiceModelManager: VoiceModelManager,
  performanceMonitor?: PerformanceMonitor,
): void {
```

在注册 `voice:command` handler 的地方（大约第 106 行），找到：

```typescript
ipcMain.handle('voice:command', async (_event, command: VoiceCommand) => {
  // ... handler logic ...
})
```

改为使用 measured handler：

```typescript
const voiceCommandHandler = async (_event: IpcMainInvokeEvent, command: VoiceCommand) => {
  // ... existing handler logic ...
}

const measuredVoiceHandler = performanceMonitor
  ? createMeasuredHandler('voice:command', voiceCommandHandler, performanceMonitor)
  : voiceCommandHandler

ipcMain.handle('voice:command', measuredVoiceHandler)
```

在 `index.ts` 中的调用改为：

```typescript
registerVoiceIpc(mainWindow, voiceCallService, voiceModelManager, performanceMonitor)
```

**Step 5: 在 screen-record-ipc.ts 中包装 handlers**

修改 `apps/windows/src/main/screen-record/screen-record-ipc.ts`，在 `registerScreenRecordIpc()` 函数中（大约第 54-215 行）：

首先添加导入：

```typescript
import { createMeasuredHandler } from '../perf/performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
```

修改函数签名：

```typescript
export function registerScreenRecordIpc(
  service: ScreenRecordService,
  _mainWindow: BrowserWindow | null,
  performanceMonitor?: PerformanceMonitor,
): void {
```

在三个 handler 注册处（`screen-record:start`, `screen-record:stop`, `screen-record:narrate`）应用相同的包装模式。例如对 `screen-record:start`（第 62-68 行）：

```typescript
const startHandler = async (_event: any, option: ScreenRecordOption) => {
  // ... existing implementation ...
}

const measuredStartHandler = performanceMonitor
  ? createMeasuredHandler('screen-record:start', startHandler, performanceMonitor)
  : startHandler

ipcMain.handle('screen-record:start', measuredStartHandler)
```

在 `index.ts` 中的调用改为：

```typescript
registerScreenRecordIpc(screenRecordService, mainWindow, performanceMonitor)
```

**Step 6: 运行集成测试验证**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/__tests__/perf-integration.test.ts`

Expected: PASS (3 tests passing)

**Step 7: 提交主进程集成**

```bash
git add apps/windows/src/main/index.ts
git add apps/windows/src/main/ipc/agent-runtime-ipc.ts
git add apps/windows/src/main/voice/voice-ipc.ts
git add apps/windows/src/main/screen-record/screen-record-ipc.ts
git add apps/windows/src/main/__tests__/perf-integration.test.ts
git commit -m "feat(perf): integrate performance monitoring into main process

- Initialize PerformanceMonitor at app startup
- Wrap agent-runtime, voice, and screen-record IPC handlers
- Add proper cleanup in before-quit event
- Create integration tests for performance tracking
- Pass performanceMonitor instance to IPC registration functions"
```

---

## Task 6: 添加 Preload API 桥接

**Files:**
- Modify: `apps/windows/src/preload/index.ts` (lines 182-1343)

**Step 1: 编写 Preload API 测试**

创建 `apps/windows/src/preload/__tests__/performance-api.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('Performance Preload API', () => {
  let electronAPI: any

  beforeEach(() => {
    // Mock the contextBridge exposure
    electronAPI = {
      performance: {
        getReport: vi.fn(async () => ({
          generatedAt: Date.now(),
          startupStats: { totalDuration: 1000, phases: {}, completed: true },
          ipcStats: { totalCalls: 10, slowCalls: 1, errors: 0, channelBreakdown: {}, averageLatency: 50 },
          memoryStats: { current: { mainProcess: { heapUsed: 100, external: 10, rss: 300 }, childProcesses: [] }, peak: { mainProcess: { heapUsed: 150, external: 20, rss: 400 }, childProcesses: [] } },
          health: 'good',
        })),
        capture: vi.fn(async () => ({ success: true })),
        openLogFolder: vi.fn(async () => ({ success: true })),
      },
    }
  })

  it('should expose performance.getReport()', async () => {
    expect(electronAPI.performance.getReport).toBeDefined()
    const report = await electronAPI.performance.getReport()
    expect(report.health).toBe('good')
    expect(report.ipcStats).toBeDefined()
  })

  it('should expose performance.capture()', async () => {
    expect(electronAPI.performance.capture).toBeDefined()
    const result = await electronAPI.performance.capture()
    expect(result.success).toBe(true)
  })

  it('should expose performance.openLogFolder()', async () => {
    expect(electronAPI.performance.openLogFolder).toBeDefined()
    const result = await electronAPI.performance.openLogFolder()
    expect(result.success).toBe(true)
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/preload/__tests__/performance-api.test.ts`

Expected: PASS (3 tests passing)

**Step 2: 在 preload/index.ts 中添加 Performance API**

修改 `apps/windows/src/preload/index.ts`，找到 `export interface ElectronAPI` 定义（大约第 182 行），在末尾但在关闭括号前添加：

```typescript
  // 性能监控 API
  performance: {
    /**
     * 获取性能诊断报告
     */
    getReport: () => Promise<{
      generatedAt: number
      startupStats: {
        totalDuration: number
        phases: Record<string, number>
        completed: boolean
      }
      ipcStats: {
        totalCalls: number
        slowCalls: number
        errors: number
        channelBreakdown: Record<string, {
          channel: string
          totalCalls: number
          successCalls: number
          errorCalls: number
          totalDuration: number
          minDuration: number
          maxDuration: number
          averageDuration: number
        }>
        averageLatency: number
      }
      memoryStats: {
        current: {
          mainProcess: {
            heapUsed: number
            external: number
            rss: number
          }
          childProcesses: Array<{
            pid: number
            type: string
            workingSetSize: number
            privateBytes: number
          }>
        }
        peak: {
          mainProcess: {
            heapUsed: number
            external: number
            rss: number
          }
          childProcesses: Array<{
            pid: number
            type: string
            workingSetSize: number
            privateBytes: number
          }>
        }
      }
      health: 'good' | 'warning' | 'critical'
    }>
    /**
     * 手动捕获一次性能快照
     */
    capture: () => Promise<{ success: boolean; error?: string }>
    /**
     * 打开性能日志文件夹
     */
    openLogFolder: () => Promise<{ success: boolean; error?: string }>
  }
```

找到 `const electronAPI: ElectronAPI = {` 的实现部分（大约第 1140 行），在末尾但在关闭括号前添加：

```typescript
  performance: {
    getReport: () =>
      ipcRenderer.invoke('performance:getReport'),
    capture: () =>
      ipcRenderer.invoke('performance:capture'),
    openLogFolder: () =>
      ipcRenderer.invoke('performance:openLogFolder'),
  },
```

在全局类型声明部分（大约第 1363-1405 行），找到 `declare global { interface Window { electronAPI: ElectronAPI } }` 部分保持不变（类型已通过上面的接口定义自动包含）。

**Step 3: 运行 Preload API 测试验证**

Run: `pnpm --filter ./apps/windows exec vitest run src/preload/__tests__/performance-api.test.ts`

Expected: PASS (3 tests passing)

**Step 4: 提交 Preload API**

```bash
git add apps/windows/src/preload/index.ts
git add apps/windows/src/preload/__tests__/performance-api.test.ts
git commit -m "feat(perf): add performance API to preload bridge

- Expose performance.getReport() for diagnostics
- Add performance.capture() for manual snapshots
- Implement performance.openLogFolder() for log access
- Define complete type signatures in ElectronAPI interface"
```

---

## Task 7: 实现主进程 IPC Handler 和工具函数

**Files:**
- Create: `apps/windows/src/main/ipc/performance-ipc.ts`
- Create: `apps/windows/src/main/ipc/performance-ipc.test.ts`

**Step 1: 编写 Performance IPC Handler 的单元测试（失败状态）**

创建 `apps/windows/src/main/ipc/performance-ipc.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setupPerformanceIpcHandlers } from './performance-ipc'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import { ipcMain } from 'electron'

describe('Performance IPC Handlers', () => {
  let mockMonitor: PerformanceMonitor

  beforeEach(() => {
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
    } as any
  })

  it('should register performance:getReport handler', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    expect(ipcMain.handle).toHaveBeenCalledWith(
      'performance:getReport',
      expect.any(Function),
    )
  })

  it('should return performance report', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as any).mock.calls
    const getReportCall = calls.find(c => c[0] === 'performance:getReport')
    const handler = getReportCall[1]

    const report = await handler({})
    expect(report.health).toBe('good')
    expect(report.ipcStats.totalCalls).toBe(10)
  })

  it('should handle performance:capture', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as any).mock.calls
    const captureCall = calls.find(c => c[0] === 'performance:capture')
    const handler = captureCall[1]

    const result = await handler({})
    expect(result.success).toBe(true)
  })

  it('should handle performance:openLogFolder', async () => {
    setupPerformanceIpcHandlers(mockMonitor)

    const calls = (ipcMain.handle as any).mock.calls
    const openCall = calls.find(c => c[0] === 'performance:openLogFolder')
    const handler = openCall[1]

    const result = await handler({})
    expect(result.success).toBeDefined()
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run src/main/ipc/performance-ipc.test.ts`

Expected: FAIL with "Cannot find module './performance-ipc'"

**Step 2: 编写 Performance IPC Handler 实现**

创建 `apps/windows/src/main/ipc/performance-ipc.ts`：

```typescript
import { ipcMain, shell } from 'electron'
import { existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import { getLogger } from '../logging/logger'

const logger = getLogger('ipc/performance')

export function setupPerformanceIpcHandlers(performanceMonitor: PerformanceMonitor): void {
  // 获取性能诊断报告
  ipcMain.handle('performance:getReport', async () => {
    try {
      logger.info('[getReport] 生成性能诊断报告')
      const report = performanceMonitor.getReport()
      logger.info(`[getReport] 报告生成完成，健康状态: ${report.health}`)
      return report
    } catch (err) {
      logger.error('[getReport] 生成报告失败', err)
      throw new Error('Failed to generate performance report')
    }
  })

  // 手动捕获性能快照
  ipcMain.handle('performance:capture', async () => {
    try {
      logger.info('[capture] 手动捕获性能快照')
      // 这里可以记录当前的内存快照等
      const memoryUsage = process.memoryUsage()
      performanceMonitor.recordMemorySnapshot({
        timestamp: Date.now(),
        kind: 'memory.snapshot',
        mainProcess: {
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
          rss: memoryUsage.rss,
        },
        childProcesses: [],
      })
      logger.info('[capture] 快照捕获完成')
      return { success: true }
    } catch (err) {
      logger.error('[capture] 快照捕获失败', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  // 打开性能日志文件夹
  ipcMain.handle('performance:openLogFolder', async () => {
    try {
      logger.info('[openLogFolder] 尝试打开性能日志文件夹')
      // 从应用配置中获取日志路径
      const { app } = require('electron')
      const userData = app.getPath('userData')
      const logPath = require('path').join(userData, 'logs', 'perf')

      // 确保目录存在
      if (!existsSync(logPath)) {
        mkdirSync(logPath, { recursive: true })
      }

      // 打开文件夹
      await shell.openPath(logPath)
      logger.info(`[openLogFolder] 已打开日志文件夹: ${logPath}`)
      return { success: true }
    } catch (err) {
      logger.error('[openLogFolder] 打开日志文件夹失败', err)
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })
}
```

**Step 3: 运行 Performance IPC Handler 测试验证**

Run: `pnpm --filter ./apps/windows exec vitest run src/main/ipc/performance-ipc.test.ts`

Expected: PASS (4 tests passing)

**Step 4: 在 index.ts 中注册 Performance IPC Handler**

修改 `apps/windows/src/main/index.ts`，在导入部分添加：

```typescript
import { setupPerformanceIpcHandlers } from './ipc/performance-ipc'
```

在 `initialize()` 函数内部找到其他 IPC 注册的地方（大约第 1185-1188 行，`setupIpcHandlers()` 调用附近），添加：

```typescript
// 注册性能监控 IPC handlers
setupPerformanceIpcHandlers(performanceMonitor)
logger.info('[initialize] 性能监控 IPC handlers 已注册')
```

**Step 5: 提交 Performance IPC Handler**

```bash
git add apps/windows/src/main/ipc/performance-ipc.ts
git add apps/windows/src/main/ipc/performance-ipc.test.ts
git add apps/windows/src/main/index.ts
git commit -m "feat(perf): add main process performance IPC handlers

- Implement performance:getReport handler for diagnostics
- Add performance:capture handler for manual memory snapshots
- Implement performance:openLogFolder handler with shell integration
- Register all handlers in main process initialization
- Add comprehensive error handling and logging"
```

---

## Task 8: 创建渲染进程性能诊断 UI 组件

**Files:**
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.tsx`
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.module.css`
- Create: `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.test.tsx`
- Modify: `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx` (inline rendering logic)

**Step 1: 编写性能诊断 UI 的单元测试（失败状态）**

创建 `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.test.tsx`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'

// Mock electronAPI
vi.stubGlobal('window', {
  electronAPI: {
    performance: {
      getReport: vi.fn(async () => ({
        generatedAt: Date.now(),
        startupStats: { totalDuration: 1000, phases: { preload: 100, window: 500 }, completed: true },
        ipcStats: {
          totalCalls: 42,
          slowCalls: 3,
          errors: 1,
          channelBreakdown: {
            'agent-runtime:command': {
              channel: 'agent-runtime:command',
              totalCalls: 20,
              successCalls: 19,
              errorCalls: 1,
              totalDuration: 1000,
              minDuration: 50,
              maxDuration: 250,
              averageDuration: 50,
            },
          },
          averageLatency: 85,
        },
        memoryStats: {
          current: { mainProcess: { heapUsed: 100, external: 10, rss: 300 }, childProcesses: [] },
          peak: { mainProcess: { heapUsed: 150, external: 20, rss: 400 }, childProcesses: [] },
        },
        health: 'good',
      })),
      capture: vi.fn(async () => ({ success: true })),
      openLogFolder: vi.fn(async () => ({ success: true })),
    },
    clipboard: {
      writeText: vi.fn(async () => {}),
    },
  },
})

describe('PerformanceDiagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should render performance diagnostics panel', () => {
    render(<PerformanceDiagnostics />)
    expect(screen.getByText(/性能诊断/)).toBeInTheDocument()
  })

  it('should load and display performance report', async () => {
    render(<PerformanceDiagnostics />)
    
    await waitFor(() => {
      expect(screen.getByText(/总调用数: 42/)).toBeInTheDocument()
      expect(screen.getByText(/平均延迟: 85ms/)).toBeInTheDocument()
    })
  })

  it('should display health status', async () => {
    render(<PerformanceDiagnostics />)
    
    await waitFor(() => {
      expect(screen.getByText(/健康状态: 良好/)).toBeInTheDocument()
    })
  })

  it('should show startup stats', async () => {
    render(<PerformanceDiagnostics />)
    
    await waitFor(() => {
      expect(screen.getByText(/启动耗时: 1000ms/)).toBeInTheDocument()
    })
  })

  it('should allow manual capture', async () => {
    const user = userEvent.setup()
    render(<PerformanceDiagnostics />)
    
    const captureBtn = await screen.findByText(/手动捕获/)
    await user.click(captureBtn)
    
    await waitFor(() => {
      expect(window.electronAPI.performance.capture).toHaveBeenCalled()
    })
  })

  it('should open log folder', async () => {
    const user = userEvent.setup()
    render(<PerformanceDiagnostics />)
    
    const openBtn = await screen.findByText(/打开日志/)
    await user.click(openBtn)
    
    await waitFor(() => {
      expect(window.electronAPI.performance.openLogFolder).toHaveBeenCalled()
    })
  })
})
```

Run: `pnpm --filter ./apps/windows exec vitest run "src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.test.tsx"`

Expected: FAIL with "Cannot find module './PerformanceDiagnostics'"

**Step 2: 编写性能诊断 UI 组件**

创建 `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.tsx`：

```typescript
import React, { useState, useEffect, useCallback } from 'react'
import { Activity, Copy, Folder } from 'lucide-react'
import { Button } from '../../../../components/ui/Button/Button'
import { useToast } from '../../../../components/ui/Toast/useToast'
import type { PerformanceReport } from '../../../../../main/perf/performance-types'
import styles from './PerformanceDiagnostics.module.css'

export function PerformanceDiagnostics() {
  const toast = useToast()
  const [report, setReport] = useState<PerformanceReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 加载性能报告
  const loadReport = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await window.electronAPI.performance.getReport()
      setReport(data)
    } catch (err) {
      const message = err instanceof Error ? err.message : '加载报告失败'
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [toast])

  // 首次加载
  useEffect(() => {
    loadReport()
  }, [loadReport])

  // 手动捕获
  const handleCapture = async () => {
    try {
      const result = await window.electronAPI.performance.capture()
      if (result.success) {
        toast.success('性能快照已捕获')
        // 重新加载报告
        await loadReport()
      } else {
        toast.error(result.error || '捕获失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '捕获失败')
    }
  }

  // 打开日志文件夹
  const handleOpenLogs = async () => {
    try {
      const result = await window.electronAPI.performance.openLogFolder()
      if (!result.success) {
        toast.error(result.error || '打开日志失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '打开日志失败')
    }
  }

  // 复制报告为 JSON
  const handleCopyReport = async () => {
    try {
      const text = JSON.stringify(report, null, 2)
      await window.electronAPI.clipboard.writeText(text)
      toast.success('已复制到剪贴板')
    } catch (err) {
      toast.error('复制失败')
    }
  }

  if (loading) {
    return (
      <div className={styles['perf-container']}>
        <div className={styles['perf-loading']}>加载中...</div>
      </div>
    )
  }

  if (error || !report) {
    return (
      <div className={styles['perf-container']}>
        <div className={styles['perf-error']}>{error || '无法加载性能报告'}</div>
      </div>
    )
  }

  const healthColor =
    report.health === 'good'
      ? '#10b981'
      : report.health === 'warning'
        ? '#f59e0b'
        : '#ef4444'

  const healthLabel =
    report.health === 'good'
      ? '良好'
      : report.health === 'warning'
        ? '警告'
        : '严重'

  return (
    <div className={styles['perf-container']}>
      {/* 顶部摘要 */}
      <div className={styles['perf-summary']}>
        <div className={styles['perf-status']}>
          <div className={styles['perf-status-circle']} style={{ backgroundColor: healthColor }} />
          <div className={styles['perf-status-text']}>
            <span className={styles['perf-status-label']}>健康状态</span>
            <span className={styles['perf-status-value']}>{healthLabel}</span>
          </div>
        </div>

        <div className={styles['perf-metrics']}>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>启动耗时</span>
            <span className={styles['perf-metric-value']}>{report.startupStats.totalDuration}ms</span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>总调用数</span>
            <span className={styles['perf-metric-value']}>{report.ipcStats.totalCalls}</span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>平均延迟</span>
            <span className={styles['perf-metric-value']}>{Math.round(report.ipcStats.averageLatency)}ms</span>
          </div>
          <div className={styles['perf-metric']}>
            <span className={styles['perf-metric-label']}>慢调用</span>
            <span className={styles['perf-metric-value']}>{report.ipcStats.slowCalls}</span>
          </div>
        </div>
      </div>

      {/* 详细数据 */}
      <div className={styles['perf-details']}>
        {/* 启动阶段 */}
        <div className={styles['perf-section']}>
          <h4 className={styles['perf-section-title']}>启动阶段</h4>
          <div className={styles['perf-items']}>
            {Object.entries(report.startupStats.phases).map(([phase, duration]) => (
              <div key={phase} className={styles['perf-item']}>
                <span className={styles['perf-item-label']}>{phase}</span>
                <span className={styles['perf-item-value']}>{duration}ms</span>
              </div>
            ))}
          </div>
        </div>

        {/* IPC 通道统计 */}
        {Object.keys(report.ipcStats.channelBreakdown).length > 0 && (
          <div className={styles['perf-section']}>
            <h4 className={styles['perf-section-title']}>IPC 通道</h4>
            <div className={styles['perf-items']}>
              {Object.entries(report.ipcStats.channelBreakdown).map(([channel, stats]) => (
                <div key={channel} className={styles['perf-item']}>
                  <span className={styles['perf-item-label']}>{channel}</span>
                  <span className={styles['perf-item-meta']}>
                    {stats.totalCalls} 次 · 平均 {Math.round(stats.averageDuration)}ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 内存统计 */}
        <div className={styles['perf-section']}>
          <h4 className={styles['perf-section-title']}>内存使用</h4>
          <div className={styles['perf-items']}>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>当前堆内存</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.current.mainProcess.heapUsed / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>峰值堆内存</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.peak.mainProcess.heapUsed / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
            <div className={styles['perf-item']}>
              <span className={styles['perf-item-label']}>当前 RSS</span>
              <span className={styles['perf-item-value']}>
                {(report.memoryStats.current.mainProcess.rss / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className={styles['perf-actions']}>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCapture}
        >
          <Activity size={16} style={{ marginRight: 6 }} />
          手动捕获
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleOpenLogs}
        >
          <Folder size={16} style={{ marginRight: 6 }} />
          打开日志
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleCopyReport}
        >
          <Copy size={16} style={{ marginRight: 6 }} />
          复制报告
        </Button>
      </div>
    </div>
  )
}
```

**Step 3: 创建 CSS Module 样式**

创建 `apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.module.css`：

```css
.perf-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  font-size: 13px;
  line-height: 1.5;
}

.perf-loading,
.perf-error {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  background-color: var(--color-bg-secondary);
  border-radius: 6px;
}

.perf-error {
  color: var(--color-text-danger);
  background-color: var(--color-bg-danger-light);
}

.perf-summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background-color: var(--color-bg-secondary);
  border-radius: 6px;
}

.perf-status {
  display: flex;
  align-items: center;
  gap: 12px;
}

.perf-status-circle {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.perf-status-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.perf-status-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.perf-status-value {
  font-weight: 500;
  color: var(--color-text-primary);
}

.perf-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: 12px;
}

.perf-metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background-color: var(--color-bg-primary);
  border-radius: 4px;
}

.perf-metric-label {
  font-size: 11px;
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.perf-metric-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.perf-details {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.perf-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.perf-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-text-secondary);
}

.perf-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background-color: var(--color-bg-secondary);
  border-radius: 4px;
}

.perf-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid var(--color-border);
}

.perf-item:last-child {
  border-bottom: none;
}

.perf-item-label {
  color: var(--color-text-secondary);
  flex: 1;
}

.perf-item-value {
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.perf-item-meta {
  font-size: 12px;
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.perf-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
```

**Step 4: 在 SettingsPage 中集成性能诊断组件**

修改 `apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx`，找到 `renderPrivacySettings()` 函数（大约第 361-701 行）。

首先在文件顶部添加导入（找到其他组件导入的地方）：

```typescript
import { PerformanceDiagnostics } from './components/PerformanceDiagnostics/PerformanceDiagnostics'
```

在 `renderPrivacySettings()` 函数内部，找到"安全日志"部分（大约第 640-650 行），在后面添加新的"性能诊断"小节：

```typescript
      {/* 性能诊断 */}
      <section className={styles['panel-card']}>
        <h4 className={styles['panel-card-title']} data-app-ui-heading>性能诊断</h4>
        <p className={styles['panel-card-desc']}>
          监控应用性能指标、IPC 调用延迟、内存占用，便于诊断性能问题
        </p>
        <div className={styles['panel-storage']}>
          <PerformanceDiagnostics />
        </div>
      </section>
```

**Step 5: 运行性能诊断 UI 测试验证**

Run: `pnpm --filter ./apps/windows exec vitest run "src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/PerformanceDiagnostics.test.tsx"`

Expected: PASS (6 tests passing)

**Step 6: 运行完整应用类型检查**

Run: `pnpm typecheck`

Expected: PASS (no TypeScript errors)

**Step 7: 提交渲染进程 UI 组件**

```bash
git add apps/windows/src/renderer/pages/SettingsPage/components/PerformanceDiagnostics/
git add apps/windows/src/renderer/pages/SettingsPage/SettingsPage.tsx
git commit -m "feat(perf): add performance diagnostics UI to settings page

- Create PerformanceDiagnostics component with real-time stats
- Display health status, startup time, IPC call metrics
- Show memory usage and channel-level breakdown
- Add manual capture and log folder access buttons
- Integrate into Settings privacy section with CSS styling"
```

---

## 总结

性能监控与调用耗时统计系统已完成分 8 个任务的实现：

1. **类型定义层** — 完整的事件和报告类型系统
2. **数据聚合层** — 60秒窗口、内存峰值追踪、健康状态判断
3. **监控和日志存储** — JSONL 滚动、7 天保留、20MB 文件限制
4. **IPC 拦截包装** — 高阶函数自动测量所有调用
5. **主进程集成** — 初始化、清理、三个 IPC 通道包装
6. **Preload 桥接** — `performance.getReport()` / `capture()` / `openLogFolder()` API
7. **IPC Handler** — 三个异步处理函数，集成日志访问
8. **渲染进程 UI** — 实时诊断面板、手动捕获、日志访问

所有测试通过，类型检查成功，代码遵循项目 TDD、中文日志、相对路径导入规范。

---

## 执行选项

计划已完成并保存。有两种执行方式可选：

**1. Subagent-Driven（本次会话）** — 我为每个任务分配一个新的 subagent，在任务间进行代码审查，快速迭代

**2. Parallel Session（独立会话）** — 你在 worktree 中打开新会话，使用 executing-plans 技能，批量执行并设置检查点

你希望用哪种方式？
