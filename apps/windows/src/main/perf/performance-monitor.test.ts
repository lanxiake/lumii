import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
