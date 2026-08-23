import { createWriteStream, readdirSync, unlinkSync, existsSync, mkdirSync, renameSync } from 'fs'
import type { WriteStream } from 'fs'
import { join } from 'path'
import { PerformanceAggregator } from './performance-aggregator'
import type {
  PerformanceEvent,
  PerformanceMonitorConfig,
  MemorySnapshotEvent,
  StartupPhaseEvent,
} from './performance-types'

export class PerformanceMonitor {
  private aggregator: PerformanceAggregator
  private eventQueue: PerformanceEvent[] = []
  private currentLogStream: WriteStream | null = null
  private currentLogDate: string
  private config: PerformanceMonitorConfig
  private readonly MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
  private readonly MAX_LOG_FILES = 7 // 7天保留
  private currentFileSize = 0
  /**
   * 已写入日志的聚合事件数量。
   *
   * aggregator.getAggregateEvents() 是非破坏性只读方法（返回全部累积事件的
   * 防御性拷贝，Task 2 的测试已固定这一契约），每次调用都会返回从一开始
   * 累积至今的完整数组，而不会「消费」掉已经取走的部分。若每次 flush() 都
   * 把它整体重新写入日志，历史聚合事件会被反复重复写入。这里用一个游标
   * 记录已经写过多少条，每次 flush 只取新增的尾部部分写入。
   */
  private lastFlushedAggregateCount = 0

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
    const oldStream = this.currentLogStream
    if (oldStream) {
      oldStream.end()
      // 等旧文件的描述符真正释放，保证它在磁盘上的内容已完整落盘，
      // 之后基于 readdirSync 的清理逻辑才能看到准确的文件列表
      await this.awaitStreamEvent(oldStream, 'close')
    }

    this.initializeLogStream()
    if (this.currentLogStream) {
      // 等新文件真正在磁盘上创建完成，否则 cleanOldLogs() 的 readdirSync
      // 可能统计不到它，导致清理数量算少（少删了本该淘汰的旧文件）
      await this.awaitStreamEvent(this.currentLogStream, 'open')
    }

    // 日期滚动时机会顺带清理过期日志，7 天保留策略无需依赖外部调用方
    // 记得手动触发 cleanOldLogs()，与 file-logger.ts 的 checkDateRoll() 行为一致
    this.cleanOldLogs()
  }

  /**
   * 按大小轮转当前日志文件
   *
   * 把已写满的 perf-{date}.jsonl 归档为 perf-{date}.1.jsonl，为避免覆盖
   * 已存在的历史归档，先从最大编号开始依次把 .N 重命名为 .N+1（从后往前挪位），
   * 腾出 .1 这个位置后再归档当前文件。归档全部完成后再在基础文件名上
   * 打开一个新的空文件流，写入才能真正被限制在 MAX_FILE_SIZE 以内。
   *
   * 归档前必须等旧流的 'close' 事件：Windows 上重命名一个仍被打开写入的
   * 文件会失败（句柄未释放），且流内部可能还有尚未落盘的缓冲写入，
   * 过早重命名会丢数据或让归档文件内容不完整。
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
        // 找到当前已存在的最大归档编号
        let maxIndex = 0
        while (
          existsSync(join(this.config.logDir, `perf-${this.currentLogDate}.${maxIndex + 1}.jsonl`))
        ) {
          maxIndex += 1
        }

        // 从最大编号开始往前挪位，避免相互覆盖
        for (let i = maxIndex; i >= 1; i--) {
          const from = join(this.config.logDir, `perf-${this.currentLogDate}.${i}.jsonl`)
          const to = join(this.config.logDir, `perf-${this.currentLogDate}.${i + 1}.jsonl`)
          renameSync(from, to)
        }

        renameSync(baseFile, join(this.config.logDir, `perf-${this.currentLogDate}.1.jsonl`))
      } catch {
        // 归档失败（如权限问题）时忽略，新流仍会在基础文件名上以追加模式打开，
        // 不影响后续事件正常写入，只是本次未能完成归档
      }
    }

    this.initializeLogStream()
    if (this.currentLogStream) {
      await this.awaitStreamEvent(this.currentLogStream, 'open')
    }
  }

  private async writeEvent(event: PerformanceEvent): Promise<void> {
    if (!this.config.enabled || !this.config.logDir) return

    await this.checkDateRoll()

    const line = JSON.stringify(event) + '\n'
    const lineSize = Buffer.byteLength(line, 'utf8')

    if (this.currentFileSize + lineSize > this.MAX_FILE_SIZE) {
      // 触发按大小轮转：先关闭当前流、把写满的文件归档为编号文件，
      // 再在基础文件名上打开一个全新的空文件流
      await this.rotateFileBySize()
    }

    if (this.currentLogStream) {
      const stream = this.currentLogStream
      await new Promise<void>(resolve => {
        stream.write(line, () => {
          // 写入失败已经由 stream 的 'error' 监听器静默吞掉，这里不需要再处理，
          // 只需要保证 flush() 在所有写入真正落盘后才返回
          resolve()
        })
      })
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
      phase: phase as StartupPhaseEvent['phase'],
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

  async flush(): Promise<void> {
    // 先写入队列中的事件。writeEvent() 内部可能触发日期/大小轮转（均为异步），
    // 必须逐条 await，保证轮转完成后才继续写下一条，否则并发的轮转会相互踩踏
    for (const event of this.eventQueue) {
      await this.writeEvent(event)
    }
    this.eventQueue = []

    // 写入聚合事件：getAggregateEvents() 每次都返回全量累积数组，
    // 只截取自上次 flush 以来新增的部分，避免重复写入历史记录
    const allAggregateEvents = this.aggregator.getAggregateEvents()
    // 防御性收敛游标：正常情况下该数组只会增长，但若未来 aggregator 的实现
    // 变化导致数组变短，直接 slice 一个越界游标不会抛错，却会产生错误的
    // "从头再写一遍" 行为。这里把游标钳制在数组长度以内，此时视为"没有新增"，
    // 而不是让下游产生未定义行为。
    const safeCursor = Math.min(this.lastFlushedAggregateCount, allAggregateEvents.length)
    const newAggregateEvents = allAggregateEvents.slice(safeCursor)
    for (const event of newAggregateEvents) {
      await this.writeEvent(event)
    }
    this.lastFlushedAggregateCount = allAggregateEvents.length
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
    } catch {
      // 忽略清理错误
    }
  }

  destroy() {
    this.currentLogStream?.end()
  }
}
