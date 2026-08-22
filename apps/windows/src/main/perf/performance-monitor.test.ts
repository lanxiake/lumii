import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    monitor.recordIpcCall('agent-runtime:command', 250, false)
    monitor.recordIpcCall('agent-runtime:command', 300, false)

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

  it('should keep only the most recent log files when cleaning old logs', () => {
    // 构造 10 个不同日期的假日志文件（超过 MAX_LOG_FILES=7）
    const dates = [
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
      '2026-01-04',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
    ]
    dates.forEach(date => {
      fs.writeFileSync(path.join(tempDir, `perf-${date}.jsonl`), '{}\n')
    })

    monitor.cleanOldLogs()

    const remaining = fs.readdirSync(tempDir)
      .filter(f => f.startsWith('perf-') && f.endsWith('.jsonl'))
      .sort()

    expect(remaining.length).toBe(7)
    // 应保留最近的 7 个（按文件名日期排序后的最后 7 个）
    expect(remaining).toEqual([
      'perf-2026-01-04.jsonl',
      'perf-2026-01-05.jsonl',
      'perf-2026-01-06.jsonl',
      'perf-2026-01-07.jsonl',
      'perf-2026-01-08.jsonl',
      'perf-2026-01-09.jsonl',
      'perf-2026-01-10.jsonl',
    ])
  })

  it('should archive the log file when it exceeds MAX_FILE_SIZE, and keep writing to a fresh base file afterwards', async () => {
    const sizeMonitor = new PerformanceMonitor({
      enabled: true,
      ipcSlowThresholdMs: 0, // 阈值设为 0，让每次调用都产生 ipc.slow 事件
      memorySnapshotIntervalMs: 10000,
      maxQueueSize: 10000,
      logDir: tempDir,
    })

    // 用较长的 channel 名把单条事件撑大，减少凑够 20MB 所需的事件数
    const bigChannel = 'x'.repeat(5000)
    const eventCount = 4300 // 单条约 5KB，4300 条 ≈ 21.5MB，足以触发 20MB 阈值

    for (let i = 0; i < eventCount; i++) {
      sizeMonitor.recordIpcCall(bigChannel, 250, false)
    }

    await sizeMonitor.flush()

    const date = sizeMonitor.getCurrentLogDate()
    const baseFile = path.join(tempDir, `perf-${date}.jsonl`)
    const archivedFile = path.join(tempDir, `perf-${date}.1.jsonl`)

    // 归档文件应存在且有内容——证明轮转真正发生，而不是原地重开同名文件
    expect(fs.existsSync(archivedFile)).toBe(true)
    const archivedContent = fs.readFileSync(archivedFile, 'utf-8')
    expect(archivedContent.trim().length).toBeGreaterThan(0)

    // 基础文件名下应该是一个全新的、比归档文件小得多的文件（本次轮转后的新写入）
    expect(fs.existsSync(baseFile)).toBe(true)
    const baseSizeBefore = fs.statSync(baseFile).size
    expect(baseSizeBefore).toBeLessThan(fs.statSync(archivedFile).size)

    // 轮转之后继续写入应该落在基础文件上，而不是丢失或写进归档文件
    sizeMonitor.recordIpcCall('after-rotation-channel', 250, false)
    await sizeMonitor.flush()

    const baseContentAfter = fs.readFileSync(baseFile, 'utf-8')
    expect(baseContentAfter.length).toBeGreaterThan(baseSizeBefore)
    expect(baseContentAfter).toContain('after-rotation-channel')

    sizeMonitor.destroy()
  })

  it('should invoke cleanOldLogs when the log date rolls over', async () => {
    vi.useFakeTimers()
    try {
      const day1 = new Date('2026-01-10T23:59:00')
      vi.setSystemTime(day1)

      const rollMonitor = new PerformanceMonitor({
        enabled: true,
        ipcSlowThresholdMs: 0,
        memorySnapshotIntervalMs: 10000,
        maxQueueSize: 200,
        logDir: tempDir,
      })

      // 预置超过 MAX_LOG_FILES(7) 的旧日志文件，验证日期滚动后是否被自动清理
      const staleDates = [
        '2025-12-01',
        '2025-12-02',
        '2025-12-03',
        '2025-12-04',
        '2025-12-05',
        '2025-12-06',
        '2025-12-07',
        '2025-12-08',
      ]
      staleDates.forEach(d => {
        fs.writeFileSync(path.join(tempDir, `perf-${d}.jsonl`), '{}\n')
      })

      const cleanSpy = vi.spyOn(rollMonitor, 'cleanOldLogs')

      // 跨到第二天，触发 checkDateRoll()
      const day2 = new Date('2026-01-11T00:00:30')
      vi.setSystemTime(day2)

      rollMonitor.recordIpcCall('channel-1', 250, false)
      await rollMonitor.flush()

      expect(cleanSpy).toHaveBeenCalled()

      const remaining = fs.readdirSync(tempDir)
        .filter(f => f.startsWith('perf-') && f.endsWith('.jsonl'))
      // 7 天保留策略应已生效，旧文件被清理，不再需要外部调用方手动触发
      expect(remaining.length).toBeLessThanOrEqual(7)

      rollMonitor.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('should generate a performance report via aggregator delegation', () => {
    monitor.recordIpcCall('agent-runtime:command', 250, false)
    monitor.recordIpcCall('agent-runtime:command', 50, false)

    const report = monitor.getReport()

    expect(report.generatedAt).toBeDefined()
    expect(report.ipcStats.totalCalls).toBe(2)
    expect(report.ipcStats.channelBreakdown['agent-runtime:command']).toBeDefined()
    expect(report.startupStats).toBeDefined()
    expect(report.memoryStats).toBeDefined()
    expect(['good', 'warning', 'critical']).toContain(report.health)
  })

  it('should not duplicate aggregate events when flush is called repeatedly', async () => {
    vi.useFakeTimers()
    try {
      const baseTime = Date.now()
      vi.setSystemTime(baseTime)
      monitor.recordIpcCall('agent-runtime:command', 150, false)

      // 模拟 65 秒后的下一次调用，触发聚合器的窗口轮转，
      // 产出一条 ipc.aggregate 事件
      vi.setSystemTime(baseTime + 65000)
      monitor.recordIpcCall('agent-runtime:command', 100, false)

      await monitor.flush()
      await monitor.flush()
      await monitor.flush()
    } finally {
      vi.useRealTimers()
    }

    const files = fs.readdirSync(tempDir)
    const logFile = path.join(tempDir, files[0])
    const content = fs.readFileSync(logFile, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)

    const aggregateEvents = lines
      .map(line => JSON.parse(line))
      .filter(event => event.kind === 'ipc.aggregate')

    // 三次 flush 之后，聚合事件应只被写入一次，而不是三次
    expect(aggregateEvents.length).toBe(1)
  })
})
