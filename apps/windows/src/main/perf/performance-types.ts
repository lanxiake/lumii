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
