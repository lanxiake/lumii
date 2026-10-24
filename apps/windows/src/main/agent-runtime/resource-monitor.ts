/**
 * 资源占用采样。
 *
 * 只做「观察」：采样进程 CPU / 堆与系统内存，供任务卡与开发者面板展示。
 * 不做自动降级 —— 那是调度器的事。
 *
 * CPU 百分比必须用两次 `cpuUsage()` 的差值除以「墙钟时间 × 核数」，
 * 直接取瞬时值会算出 800% 这种数字。
 */

import os from 'node:os'

export interface ResourceSnapshot {
  readonly timestamp: number
  readonly cpu: { readonly user: number; readonly system: number; readonly percent: number }
  readonly memory: { readonly heapUsed: number; readonly heapTotal: number; readonly rss: number }
  readonly system: {
    readonly totalMemory: number
    readonly freeMemory: number
    readonly cpuCount: number
  }
}

export interface ResourceMonitorOptions {
  /** 采样间隔，默认 5s */
  readonly intervalMs?: number
  /** 保留最近多少个采样点（默认 120 ≈ 10 分钟） */
  readonly bufferSize?: number
  readonly now?: () => number
  readonly cpuUsage?: () => NodeJS.CpuUsage
  readonly memoryUsage?: () => NodeJS.MemoryUsage
}

export class ResourceMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastCpu: { usage: NodeJS.CpuUsage; at: number } | null = null
  private snapshots: ResourceSnapshot[] = []
  private readonly intervalMs: number
  private readonly bufferSize: number
  private readonly now: () => number
  private readonly cpuUsage: () => NodeJS.CpuUsage
  private readonly memoryUsage: () => NodeJS.MemoryUsage

  constructor(options: ResourceMonitorOptions = {}) {
    this.intervalMs = options.intervalMs ?? 5_000
    this.bufferSize = options.bufferSize ?? 120
    this.now = options.now ?? (() => Date.now())
    this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage())
    this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage())
  }

  /** 采一次样；两次采样之间的 CPU 占用按差值算 */
  takeSnapshot(): ResourceSnapshot {
    const at = this.now()
    const usage = this.cpuUsage()
    let percent = 0
    if (this.lastCpu) {
      const elapsedUs = Math.max(1, (at - this.lastCpu.at) * 1000)
      const usedUs = (usage.user - this.lastCpu.usage.user) + (usage.system - this.lastCpu.usage.system)
      const cpuCount = Math.max(1, os.cpus().length)
      percent = Math.min(100, Math.max(0, (usedUs / (elapsedUs * cpuCount)) * 100))
    }
    this.lastCpu = { usage, at }

    const mem = this.memoryUsage()
    return {
      timestamp: at,
      cpu: { user: usage.user, system: usage.system, percent: Math.round(percent * 10) / 10 },
      memory: { heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss },
      system: { totalMemory: os.totalmem(), freeMemory: os.freemem(), cpuCount: os.cpus().length },
    }
  }

  /** 开始周期采样；重复调用会先停掉旧的 */
  start(callback?: (snapshot: ResourceSnapshot) => void): void {
    this.stop()
    this.timer = setInterval(() => {
      const snapshot = this.takeSnapshot()
      this.snapshots.push(snapshot)
      if (this.snapshots.length > this.bufferSize) this.snapshots.shift()
      callback?.(snapshot)
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    // 清掉基线，下次 start 后的第一次采样不会拿很久以前的差值算出离谱数字
    this.lastCpu = null
  }

  get running(): boolean {
    return this.timer !== null
  }

  /** 最近的采样点（最旧在前） */
  get history(): readonly ResourceSnapshot[] {
    return this.snapshots
  }

  /** 采样窗口内的峰值，供任务卡提示「内存涨到多少」 */
  peak(): { cpuPercent: number; rss: number } {
    let cpuPercent = 0
    let rss = 0
    for (const snapshot of this.snapshots) {
      if (snapshot.cpu.percent > cpuPercent) cpuPercent = snapshot.cpu.percent
      if (snapshot.memory.rss > rss) rss = snapshot.memory.rss
    }
    return { cpuPercent, rss }
  }
}

let sharedMonitor: ResourceMonitor | null = null
let activeTasks = 0

/**
 * 有后台任务时才采样：任务全跑完就停，避免空闲时白烧 CPU。
 *
 * 任务数由 taskStarted / taskFinished 维护——用计数而不是布尔，
 * 是因为多个任务并发时先结束的那个不该把采样关掉。
 */
export function taskStartedSampling(): void {
  activeTasks += 1
  if (activeTasks > 1) return
  sharedMonitor ??= new ResourceMonitor()
  sharedMonitor.start()
}

export function taskFinishedSampling(): void {
  activeTasks = Math.max(0, activeTasks - 1)
  if (activeTasks > 0) return
  sharedMonitor?.stop()
}

/** 当前采样器（无任务时为 null），供开发者面板读峰值 */
export function getResourceMonitor(): ResourceMonitor | null {
  return activeTasks > 0 ? sharedMonitor : null
}

/** 仅供单测：把全局状态清干净，避免用例间互相污染 */
export function resetSamplingForTests(): void {
  sharedMonitor?.stop()
  sharedMonitor = null
  activeTasks = 0
}
