/**
 * IPC 性能聚合器
 *
 * 60 秒滚动窗口而非逐条上报：IPC 调用频率可达每秒数十次，逐条落盘/上报
 * 会让性能监控本身变成性能负担。窗口关闭时才产出一条 ipc.aggregate 事件，
 * 把统计成本摊薄到可忽略的水平。
 *
 * 200ms 慢调用阈值：低于此值的抖动多是渲染进程繁忙或系统调度，
 * 不代表 IPC 通道本身有问题；超过则大概率是主进程侧阻塞或跨进程序列化过大。
 *
 * minDuration/maxDuration 用 Infinity/-Infinity 起始，是为了让 Math.min/Math.max
 * 在首次调用时也能正确取到实际值（避免用 0 起始导致 min 永远是 0）。
 * 对外读取（rotateWindow 产出事件、getIpcStats 汇总）时才把哨兵值折算成 0，
 * 因为「本窗口无调用」对外应表现为 0，而不是暴露内部实现用的哨兵。
 */
import type {
  IpcCallStats,
  IpcStats,
  MemorySnapshotEvent,
  MemoryStats,
  StartupStats,
  PerformanceReport,
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

/** 把 min/max 哨兵值（Infinity/-Infinity，代表本窗口无调用）折算成对外可见的 0 */
function resolveMinMax(minDuration: number, maxDuration: number): { min: number; max: number } {
  return {
    min: minDuration === Infinity ? 0 : minDuration,
    max: maxDuration === -Infinity ? 0 : maxDuration,
  }
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
      const { min, max } = resolveMinMax(data.minDuration, data.maxDuration)
      this.windowAggregates.push({
        timestamp: this.currentWindowStart + this.WINDOW_DURATION_MS,
        kind: 'ipc.aggregate',
        windowStart: this.currentWindowStart,
        windowEnd: this.currentWindowStart + this.WINDOW_DURATION_MS,
        channel,
        totalCalls: data.totalCalls,
        totalDuration: data.totalDuration,
        errors: data.errorCalls,
        minDuration: min,
        maxDuration: max,
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
      const { min, max } = resolveMinMax(data.minDuration, data.maxDuration)

      channelBreakdown[channel] = {
        channel,
        totalCalls: data.totalCalls,
        successCalls: data.successCalls,
        errorCalls: data.errorCalls,
        totalDuration: data.totalDuration,
        minDuration: min,
        maxDuration: max,
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

  /** 返回的数组只会随调用累积增长，从不清空或整体替换——PerformanceMonitor 的游标截取逻辑依赖此契约 */
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
