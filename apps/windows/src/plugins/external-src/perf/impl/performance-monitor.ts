import { createWriteStream, readdirSync, unlinkSync, existsSync, mkdirSync, renameSync, readFileSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import type {
  PerfEvent,
  PerfLogEntry,
  PerfSummary,
  PerformanceMonitorConfig,
} from '../../../../shared/performance'

/** 今日事件在内存里最多保留多少条（页面按今日回放，再多的直接丢最旧的） */
const MAX_TODAY_EVENTS = 5000

/**
 * 性能监控：只记**慢/贵**事件，不记常规运行数据。
 *
 * 2026-10-29 前的版本每 60 秒给每个 IPC 通道写一条聚合、给内存写一条快照，
 * 一天下来 5480 条里只有 142 条（2.6%）是真的慢调用——信号被自己埋掉了。
 * 现在常规调用只在内存里累计计数（`getSummary` 用来给出「慢几次 / 总共几次」的分母），
 * 只有超过阈值的事件才进队列、才落盘。
 *
 * 落盘仍是 JSONL + 日期/大小轮转（7 天保留），与业务日志分开存放。
 */
export class PerformanceMonitor {
  private eventQueue: PerfLogEntry[] = []
  /** 今日已产生的事件（含从磁盘回放的），供诊断页展示；有上限，避免长期运行吃内存 */
  private todayEvents: PerfEvent[] = []
  private currentLogStream: WriteStream | null = null
  private currentLogDate: string
  private config: PerformanceMonitorConfig
  private readonly MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
  private readonly MAX_LOG_FILES = 7 // 7天保留
  private currentFileSize = 0

  // ---- 常规计数（不落盘）----
  private ipcTotals = new Map<string, { calls: number; slowCalls: number; errors: number; maxMs: number }>()
  private ipcTotalCalls = 0
  private ipcSlowCalls = 0
  private ipcErrors = 0
  private startupPhases = new Map<string, number>()

  // ---- 内存尖峰判定 ----
  private lastMemory: { rss: number; heapUsed: number; at: number } | null = null
  private peakRss = 0
  private lastMemoryEventAt = 0
  /** 子进程上一次的内存读数（按 pid），用于判断涨幅 */
  private childMemory = new Map<number, { pid: number; type: string; rss: number; privateBytes: number }>()
  /** 子进程上一次上报尖峰的时刻（按 pid），用于各自的冷却窗口 */
  private childMemorySpikeAt = new Map<number, number>()

  constructor(config: PerformanceMonitorConfig) {
    this.config = config
    this.currentLogDate = this.formatDate(new Date())

    if (this.config.enabled && this.config.logDir) {
      this.ensureLogDir()
      // 先回放当天已有日志，再打开追加流——诊断页启动即可看到今日全部事件
      this.hydrateTodayFromDisk()
      this.initializeLogStream()
    }
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  /**
   * 列出当天的 perf 日志文件（含 .N 归档段），按从旧到新排序。
   * 归档规则：base → .1 → .2…，故归档序号越大越旧，base（序号 0）最新。
   */
  private listTodayLogFiles(): string[] {
    if (!this.config.logDir) return []
    const date = this.currentLogDate
    const todayPattern = new RegExp(`^perf-${date}(?:\\.\\d+)?\\.jsonl$`)
    const files = readdirSync(this.config.logDir).filter((f) => todayPattern.test(f))
    return files.sort((a, b) => this.archiveIndex(b) - this.archiveIndex(a))
  }

  /** 归档序号：perf-date.jsonl → 0；perf-date.N.jsonl → N */
  private archiveIndex(filename: string): number {
    const match = filename.match(/\.(\d+)\.jsonl$/)
    return match ? Number(match[1]) : 0
  }

  /**
   * 从当天 perf jsonl（含归档段）回放事件。
   *
   * 只回放慢事件与启动阶段；不认识的 kind（旧版本的 ipc.aggregate / memory.snapshot /
   * renderer.memory）直接跳过——升级后第一天会同时读到两种格式，跳过比报错合适。
   *
   * 回放不清空常规计数：那些是「本进程本次运行」的口径，与历史无关。
   */
  hydrateTodayFromDisk(): void {
    if (!this.config.enabled || !this.config.logDir) return
    if (!existsSync(this.config.logDir)) return

    try {
      for (const file of this.listTodayLogFiles()) {
        this.replayLogFile(join(this.config.logDir, file))
      }
    } catch {
      // 回放失败不影响性能监控主路径
    }
  }

  /** 逐行解析 jsonl，把可回放事件放进今日事件列表 */
  private replayLogFile(filePath: string): void {
    if (!existsSync(filePath)) return
    const content = readFileSync(filePath, 'utf-8')
    if (!content) return

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let raw: unknown
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      const event = asHydratableEvent(raw)
      if (event) this.pushTodayEvent(event)
    }
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

    // 必须监听 error 事件：WriteStream 的 error 若无监听者，会作为未捕获异常
    // 抛出并终止进程（如目标文件被并发删除、磁盘写满等）。这里仅静默忽略，
    // 与 file-logger.ts 的处理方式一致——性能日志写入失败不应影响主流程。
    this.currentLogStream.on('error', () => {
      // 忽略写入失败，避免性能监控自身拖垮主进程
    })
  }

  /**
   * 等待流达到指定生命周期事件（'open' 表示底层文件已在磁盘上创建完成，
   * 'close' 表示文件描述符已释放、之前的写入已全部落盘）。
   *
   * fs.createWriteStream() 的底层 fs.open() 是异步的：调用 createWriteStream()
   * 后文件不会立即出现在磁盘上；调用 .end() 后文件描述符也不会立即释放。
   * 任何依赖"文件是否已存在/已可重命名"的同步操作（renameSync、基于 readdirSync
   * 的计数清理）如果在这些事件真正触发前执行，就会在 Windows 上遇到
   * ENOENT（文件尚未创建）或"文件被占用"（描述符尚未释放）之类的间歇性失败。
   * 若等待过程中先触发了 error（如磁盘写满），也直接放行，避免调用方永久挂起。
   */
  private awaitStreamEvent(stream: WriteStream, event: 'open' | 'close'): Promise<void> {
    return new Promise(resolve => {
      const done = () => resolve()
      stream.once(event, done)
      stream.once('error', done)
    })
  }

  getCurrentLogDate(): string {
    return this.currentLogDate
  }

  private async checkDateRoll(): Promise<void> {
    if (!this.config.enabled || !this.config.logDir) return

    const newDate = this.formatDate(new Date())
    if (newDate === this.currentLogDate) return

    this.currentLogDate = newDate
    this.todayEvents = []
    const oldStream = this.currentLogStream
    if (oldStream) {
      oldStream.end()
      // 等旧文件的描述符真正释放，保证它在磁盘上的内容已完整落盘
      await this.awaitStreamEvent(oldStream, 'close')
    }

    this.initializeLogStream()
    if (this.currentLogStream) {
      await this.awaitStreamEvent(this.currentLogStream, 'open')
    }

    // 日期滚动时机会顺带清理过期日志，7 天保留策略无需依赖外部调用方
    this.cleanOldLogs()
  }

  /**
   * 按大小轮转当前日志文件
   *
   * 把已写满的 perf-{date}.jsonl 归档为 perf-{date}.1.jsonl，为避免覆盖
   * 已存在的历史归档，先从最大编号开始依次把 .N 重命名为 .N+1（从后往前挪位），
   * 腾出 .1 这个位置后再归档当前文件。
   *
   * 归档前必须等旧流的 'close' 事件：Windows 上重命名一个仍被打开写入的
   * 文件会失败（句柄未释放），且流内部可能还有尚未落盘的缓冲写入。
   */
  private async rotateFileBySize(): Promise<void> {
    if (!this.config.logDir) return

    const oldStream = this.currentLogStream
    if (oldStream) {
      oldStream.end()
      await this.awaitStreamEvent(oldStream, 'close')
    }

    const baseFile = join(this.config.logDir, `perf-${this.currentLogDate}.jsonl`)
    if (existsSync(baseFile)) {
      try {
        let maxIndex = 0
        while (
          existsSync(join(this.config.logDir, `perf-${this.currentLogDate}.${maxIndex + 1}.jsonl`))
        ) {
          maxIndex += 1
        }

        for (let i = maxIndex; i >= 1; i--) {
          const from = join(this.config.logDir, `perf-${this.currentLogDate}.${i}.jsonl`)
          const to = join(this.config.logDir, `perf-${this.currentLogDate}.${i + 1}.jsonl`)
          renameSync(from, to)
        }

        renameSync(baseFile, join(this.config.logDir, `perf-${this.currentLogDate}.1.jsonl`))
      } catch {
        // 归档失败（如权限问题）时忽略，新流仍会在基础文件名上以追加模式打开
      }
    }

    this.initializeLogStream()
    if (this.currentLogStream) {
      await this.awaitStreamEvent(this.currentLogStream, 'open')
    }
  }

  private async writeEvent(event: PerfLogEntry): Promise<void> {
    if (!this.config.enabled || !this.config.logDir) return

    await this.checkDateRoll()

    const line = JSON.stringify(event) + '\n'
    const lineSize = Buffer.byteLength(line, 'utf8')

    if (this.currentFileSize + lineSize > this.MAX_FILE_SIZE) {
      await this.rotateFileBySize()
    }

    if (this.currentLogStream) {
      const stream = this.currentLogStream
      await new Promise<void>(resolve => {
        stream.write(line, () => {
          // 写入失败已经由 stream 的 'error' 监听器静默吞掉
          resolve()
        })
      })
      this.currentFileSize += lineSize
    }
  }

  // ------------------------------------------------------------------
  // 采集入口
  // ------------------------------------------------------------------

  /** IPC 调用：只累计计数；超阈值或出错才产生事件 */
  recordIpcCall(channel: string, durationMs: number, error: boolean): void {
    if (!this.config.enabled) return

    const stat = this.ipcTotals.get(channel) ?? { calls: 0, slowCalls: 0, errors: 0, maxMs: 0 }
    stat.calls += 1
    stat.maxMs = Math.max(stat.maxMs, durationMs)
    this.ipcTotalCalls += 1

    if (error) {
      stat.errors += 1
      this.ipcErrors += 1
      this.recordEvent({
        timestamp: Date.now(),
        kind: 'ipc.error',
        name: channel,
        duration: durationMs,
      })
    } else if (durationMs > this.config.ipcSlowThresholdMs) {
      stat.slowCalls += 1
      this.ipcSlowCalls += 1
      this.recordEvent({
        timestamp: Date.now(),
        kind: 'ipc.slow',
        name: channel,
        duration: durationMs,
      })
    }
    this.ipcTotals.set(channel, stat)
  }

  recordStartupPhase(phase: string, durationMs: number): void {
    if (!this.config.enabled) return
    this.startupPhases.set(phase, durationMs)
    // 启动阶段只进 summary，不进事件列表——它不是「慢事件」，混在一起会改变筛选口径
    this.enqueue({
      timestamp: Date.now(),
      kind: 'startup.phase',
      phase,
      duration: durationMs,
    })
  }

  /** 通用慢事件入口：IPC / 慢查询 / 主线程阻塞 / 长任务 / 内存尖峰都走这里 */
  recordEvent(event: PerfEvent): void {
    if (!this.config.enabled) return
    this.pushTodayEvent(event)
    this.enqueue(event)
  }

  /**
   * 内存采样：每 60 秒调用一次，但只在「越过绝对阈值」或「相对上次上报涨幅过大」时
   * 才产生事件。平时只是更新内存里的当前与峰值读数。
   */
  sampleMemory(snapshot: { rss: number; heapUsed: number }): void {
    if (!this.config.enabled) return

    this.peakRss = Math.max(this.peakRss, snapshot.rss)
    const prev = this.lastMemory
    this.lastMemory = { ...snapshot, at: Date.now() }

    if (!prev) return

    const now = Date.now()
    if (now - this.lastMemoryEventAt < this.config.memorySpikeCooldownMs) return

    const overLimit = snapshot.rss > this.config.memoryRssThresholdBytes
    const grewFast = snapshot.rss - prev.rss > this.config.memoryGrowthThresholdBytes
    if (!overLimit && !grewFast) return

    this.lastMemoryEventAt = now
    this.recordEvent({
      timestamp: now,
      kind: 'memory.spike',
      name: 'main',
      detail: {
        rss: snapshot.rss,
        heapUsed: snapshot.heapUsed,
        deltaRss: snapshot.rss - prev.rss,
        reason: overLimit ? 'over-limit' : 'growth',
      },
    })
  }

  /**
   * 子进程（渲染层 / GPU / utility）内存采样：只在越过阈值时才记一条。
   *
   * 为什么单独看渲染进程：2026-10-29 实测主窗口渲染进程 1.33GB，主进程才 488MB ——
   * 只盯主进程会完全漏掉占用大头。每个进程各自判定、各自冷却，互不掩盖。
   */
  sampleChildProcesses(
    processes: ReadonlyArray<{ pid: number; type: string; rss: number; privateBytes: number }>,
  ): void {
    if (!this.config.enabled) return

    // 只挑真正占地方的：GPU / utility 进程一般几十 MB，不必逐分钟跟
    for (const proc of processes) {
      if (!/renderer|Tab|GPU/i.test(proc.type)) continue
      const prev = this.childMemory.get(proc.pid)
      this.childMemory.set(proc.pid, proc)
      if (!prev) continue

      const overLimit = proc.privateBytes > this.config.memoryRssThresholdBytes
      const grewFast = proc.privateBytes - prev.privateBytes > this.config.memoryGrowthThresholdBytes
      const now = Date.now()
      const lastAt = this.childMemorySpikeAt.get(proc.pid) ?? 0
      if (!overLimit && !grewFast) continue
      if (now - lastAt < this.config.memorySpikeCooldownMs) continue

      this.childMemorySpikeAt.set(proc.pid, now)
      this.recordEvent({
        timestamp: now,
        kind: 'memory.spike',
        name: `child:${proc.type}#${proc.pid}`,
        detail: {
          rss: proc.rss,
          privateBytes: proc.privateBytes,
          deltaPrivateBytes: proc.privateBytes - prev.privateBytes,
          reason: overLimit ? 'over-limit' : 'growth',
        },
      })
    }
  }

  private pushTodayEvent(event: PerfEvent) {
    this.todayEvents.push(event)
    if (this.todayEvents.length > MAX_TODAY_EVENTS) this.todayEvents.shift()
  }

  private enqueue(event: PerfLogEntry) {
    if (this.eventQueue.length >= (this.config.maxQueueSize || 200)) {
      this.eventQueue.shift()
    }
    this.eventQueue.push(event)
  }

  getQueueSize(): number {
    return this.eventQueue.length
  }

  // ------------------------------------------------------------------
  // 读取
  // ------------------------------------------------------------------

  /** 今日事件（含重启前从磁盘回放的），按时间升序 */
  listEvents(since?: number): PerfEvent[] {
    return since === undefined ? [...this.todayEvents] : this.todayEvents.filter(e => e.timestamp >= since)
  }

  /** 诊断页顶部摘要 */
  getSummary(): PerfSummary {
    const byKind: Record<string, number> = {}
    let slowestMs = 0
    for (const e of this.todayEvents) {
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
      if (e.duration && e.duration > slowestMs) slowestMs = e.duration
    }

    const byChannel: PerfSummary['ipc']['byChannel'] = {}
    for (const [channel, stat] of this.ipcTotals) {
      byChannel[channel] = { ...stat }
    }

    let startupTotal = 0
    const phases: Record<string, number> = {}
    for (const [phase, duration] of this.startupPhases) {
      phases[phase] = duration
      startupTotal += duration
    }

    const errorRate = this.ipcTotalCalls > 0 ? this.ipcErrors / this.ipcTotalCalls : 0
    const slowRate = this.ipcTotalCalls > 0 ? this.ipcSlowCalls / this.ipcTotalCalls : 0
    let health: PerfSummary['health'] = 'good'
    if (errorRate > 0.1 || this.ipcErrors > 10) health = 'critical'
    else if (slowRate > 0.1 || this.ipcSlowCalls > 5) health = 'warning'

    return {
      generatedAt: Date.now(),
      today: {
        total: this.todayEvents.length,
        byKind,
        slowestMs,
        truncated: this.todayEvents.length >= MAX_TODAY_EVENTS,
      },
      ipc: {
        totalCalls: this.ipcTotalCalls,
        slowCalls: this.ipcSlowCalls,
        errors: this.ipcErrors,
        byChannel,
      },
      startupStats: {
        totalDuration: startupTotal,
        phases,
      },
      memory: {
        rss: this.lastMemory?.rss ?? 0,
        heapUsed: this.lastMemory?.heapUsed ?? 0,
        peakRss: this.peakRss,
      },
      logDir: this.config.logDir ?? '',
      health,
    }
  }

  // ------------------------------------------------------------------
  // 落盘
  // ------------------------------------------------------------------

  async flush(): Promise<void> {
    // writeEvent() 内部可能触发日期/大小轮转（均为异步），必须逐条 await，
    // 保证轮转完成后才继续写下一条，否则并发的轮转会相互踩踏
    for (const event of this.eventQueue) {
      await this.writeEvent(event)
    }
    this.eventQueue = []
  }

  cleanOldLogs() {
    if (!this.config.logDir || !existsSync(this.config.logDir)) return

    try {
      const files = readdirSync(this.config.logDir)
        .filter(f => f.startsWith('perf-') && f.endsWith('.jsonl'))
        .sort()
        .reverse()

      for (let i = this.MAX_LOG_FILES; i < files.length; i++) {
        const filePath = join(this.config.logDir, files[i])
        unlinkSync(filePath)
      }
    } catch {
      // 忽略清理错误
    }
  }

  destroy() {
    this.currentLogStream?.end()
  }
}

/** jsonl 原始行 → 可回放事件；旧格式（聚合/快照）与脏行一律返回 null */
export function asHydratableEvent(raw: unknown): PerfEvent | null {
  if (raw == null || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  if (typeof e.timestamp !== 'number' || typeof e.kind !== 'string') return null
  if (e.kind === 'startup.phase') return null // 启动阶段只进 summary，不进事件列表
  if (!SLOW_KINDS.has(e.kind)) return null
  if (typeof e.name !== 'string' || !e.name) return null

  const event: PerfEvent = {
    timestamp: e.timestamp,
    kind: e.kind as PerfEvent['kind'],
    name: e.name,
  }
  if (typeof e.duration === 'number' && Number.isFinite(e.duration)) event.duration = e.duration
  if (e.detail != null && typeof e.detail === 'object') {
    const detail: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(e.detail as Record<string, unknown>)) {
      if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) detail[k] = v
    }
    event.detail = detail
  }
  return event
}

const SLOW_KINDS = new Set<string>([
  'ipc.slow',
  'ipc.error',
  'db.slow',
  'main.loop.lag',
  'renderer.longtask',
  'renderer.interaction',
  'memory.spike',
])
