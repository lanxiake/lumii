import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  shell: { openPath: vi.fn(async () => '') },
  app: {
    getAppMetrics: vi.fn(() => [
      { type: 'Tab', pid: 100, memory: { workingSetSize: 2048, privateBytes: 1024 } },
    ]),
  },
}))

import { registerPerformanceIpc, normalizeIncomingEvent } from './ipc'
import type { PerformanceMonitor } from './impl/performance-monitor'

describe('normalizeIncomingEvent', () => {
  it('拒绝非对象、未知 kind、空 name', () => {
    expect(normalizeIncomingEvent(null)).toBeNull()
    expect(normalizeIncomingEvent({ kind: 'nope', name: 'x' })).toBeNull()
    expect(normalizeIncomingEvent({ kind: 'ipc.slow', name: '   ' })).toBeNull()
  })

  it('丢弃非有限数的 duration，保留 detail 里的标量', () => {
    const event = normalizeIncomingEvent({
      kind: 'renderer.longtask',
      name: 'self',
      duration: NaN,
      detail: { entryType: 'longtask', ok: 1, bad: { x: 1 }, nan: NaN },
    })
    expect(event).not.toBeNull()
    expect(event!.duration).toBeUndefined()
    expect(event!.detail).toEqual({ entryType: 'longtask', ok: 1 })
  })

  it('detail 键数与字符串长度都受上限约束', () => {
    const detail: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) detail[`k${i}`] = 'x'.repeat(500)
    const event = normalizeIncomingEvent({ kind: 'db.slow', name: 's', detail })
    expect(Object.keys(event!.detail!).length).toBeLessThanOrEqual(8)
    expect((event!.detail!.k0 as string).length).toBeLessThanOrEqual(200)
  })
})

describe('Performance IPC Handlers', () => {
  const registrar = { handle: vi.fn() }
  let mockMonitor: PerformanceMonitor

  // 取最后一次注册的 handler：重注册时后者覆盖前者（与 IpcTable 的语义一致）
  const channelOf = (name: string) =>
    registrar.handle.mock.calls.filter((c) => c[0] === name).at(-1)?.[1] as (
      event: unknown,
      ...args: unknown[]
    ) => unknown

  beforeEach(() => {
    vi.clearAllMocks()
    mockMonitor = {
      getSummary: vi.fn(() => ({ generatedAt: 1, health: 'good' })),
      listEvents: vi.fn(() => []),
      recordEvent: vi.fn(),
    } as unknown as PerformanceMonitor
    registerPerformanceIpc(registrar, () => mockMonitor)
  })

  it('注册四条通道，且不再有 getHistory / recordRendererMemory', () => {
    const channels = registrar.handle.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'performance:getSummary',
      'performance:listEvents',
      'performance:recordEvent',
      'performance:capture',
      'performance:openLogFolder',
    ])
  })

  it('perf 不可用时 getSummary 抛错，listEvents 返回空数组', async () => {
    registerPerformanceIpc(registrar, () => null)
    await expect(channelOf('performance:getSummary')({})).rejects.toThrow('perf_disabled')
    expect(await channelOf('performance:listEvents')({})).toEqual([])
  })

  it('listEvents 透传 since', async () => {
    await channelOf('performance:listEvents')({}, { since: 123 })
    expect(mockMonitor.listEvents).toHaveBeenCalledWith(123)
    await channelOf('performance:listEvents')({}, { since: 'bad' })
    expect(mockMonitor.listEvents).toHaveBeenLastCalledWith(undefined)
  })

  it('recordEvent 补齐时间戳后交给 monitor；坏载荷被拒且不落事件', async () => {
    const ok = await channelOf('performance:recordEvent')({}, {
      kind: 'renderer.interaction',
      name: 'switch-session',
      duration: 900,
    })
    expect(ok).toEqual({ success: true })
    expect(mockMonitor.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'renderer.interaction', name: 'switch-session', duration: 900 }),
    )
    expect(typeof vi.mocked(mockMonitor.recordEvent).mock.calls[0]![0].timestamp).toBe('number')

    const bad = await channelOf('performance:recordEvent')({}, { kind: 'nope', name: 'x' })
    expect(bad).toMatchObject({ success: false, error: 'invalid-event' })
    expect(mockMonitor.recordEvent).toHaveBeenCalledTimes(1)
  })

  it('capture 记录一次手动内存现场', async () => {
    const result = await channelOf('performance:capture')({})
    expect(result).toEqual({ success: true })
    const event = vi.mocked(mockMonitor.recordEvent).mock.calls[0]![0]
    expect(event.kind).toBe('memory.spike')
    expect(event.name).toBe('manual')
    expect(event.detail?.processes).toContain('Tab#100')
  })
})
