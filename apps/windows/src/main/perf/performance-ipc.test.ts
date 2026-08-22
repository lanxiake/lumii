import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { createMeasuredHandler } from './performance-ipc'
import type { PerformanceMonitor } from './performance-monitor'

describe('performance-ipc', () => {
  let mockMonitor: PerformanceMonitor
  const mockEvent = {} as IpcMainInvokeEvent

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
    } as unknown as PerformanceMonitor
  })

  it('should wrap handler and measure execution time', async () => {
    const originalHandler = vi.fn(async () => 'success')
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    const result = await wrappedHandler(mockEvent, 'arg1', 'arg2')

    expect(result).toBe('success')
    expect(originalHandler).toHaveBeenCalledWith(mockEvent, 'arg1', 'arg2')
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

    await expect(wrappedHandler(mockEvent, 'arg1')).rejects.toThrow('Test error')

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

    await wrappedHandler(mockEvent)

    const calls = (mockMonitor.recordIpcCall as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBe(1)
    const [channel, duration, error] = calls[0]
    expect(channel).toBe('test-channel')
    expect(duration).toBeGreaterThanOrEqual(100)
    expect(duration).toBeLessThan(300) // 宽松范围，避免 CI 抖动导致误判
    expect(error).toBe(false)
  })

  it('should pass through all arguments correctly', async () => {
    const originalHandler = vi.fn(async (_event, arg1, arg2, arg3) => {
      return { arg1, arg2, arg3 }
    })
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    const result = await wrappedHandler(mockEvent, 'hello', 42, { key: 'value' })

    expect(result).toEqual({
      arg1: 'hello',
      arg2: 42,
      arg3: { key: 'value' },
    })
  })

  it('should handle synchronous handlers', async () => {
    const originalHandler = vi.fn(() => 'sync-result')
    const wrappedHandler = createMeasuredHandler('test-channel', originalHandler, mockMonitor)

    const result = await wrappedHandler(mockEvent, 'arg')

    expect(result).toBe('sync-result')
    expect(mockMonitor.recordIpcCall).toHaveBeenCalledWith(
      'test-channel',
      expect.any(Number),
      false,
    )
  })
})
