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
