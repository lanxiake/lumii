import { createWriteStream, readdirSync, unlinkSync, existsSync, mkdirSync } from 'fs'
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
  /** 追踪尚未完成的写入，flush() 需等待它们全部落盘后才能返回 */
  private pendingWrites: Promise<void>[] = []

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

  getCurrentLogDate(): string {
    return this.currentLogDate
  }

  private checkDateRoll() {
    if (!this.config.enabled || !this.config.logDir) return

    const newDate = this.formatDate(new Date())
    if (newDate !== this.currentLogDate) {
      this.currentLogDate = newDate
      this.currentLogStream?.end()
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
      this.currentLogStream?.end()
      this.initializeLogStream()
    }

    if (this.currentLogStream) {
      const stream = this.currentLogStream
      const writeCompleted = new Promise<void>((resolve, reject) => {
        stream.write(line, (err?: Error | null) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
      // 若在 flush() 消费之前就发生写入失败，避免产生未处理的 Promise rejection
      // （这会像未监听的 stream 'error' 事件一样导致进程崩溃）。flush() 仍会
      // 通过下面另存的 pendingWrites 引用感知到真实的失败结果。
      this.pendingWrites.push(writeCompleted)
      writeCompleted.catch(() => {
        // 忽略：真正的错误处理已经在 flush() 里通过 Promise.all 传递给调用方
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
    // 先写入队列中的事件
    for (const event of this.eventQueue) {
      this.writeEvent(event)
    }
    this.eventQueue = []

    // 写入聚合事件
    for (const event of this.aggregator.getAggregateEvents()) {
      this.writeEvent(event)
    }

    // 等待本次 flush 触发的所有写入真正落盘，避免调用方在数据写入完成前读取文件
    const writes = this.pendingWrites
    this.pendingWrites = []
    await Promise.all(writes)
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
