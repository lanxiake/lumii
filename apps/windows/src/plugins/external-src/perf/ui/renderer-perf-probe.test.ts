import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const recordEvent = vi.fn(async (_event: unknown) => ({ success: true }))

beforeEach(() => {
  vi.resetModules()
  recordEvent.mockClear()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    performance: {
      recordEvent,
        readRendererNativeMemory: async () => ({ rss: 123, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0, v8UsedHeap: 0, v8TotalPhysical: 0, v8Malloced: 5, v8PeakMalloced: 5, blinkAllocated: 0, blinkTotal: 7, resImages: 0, resImagesLive: 9, resScripts: 0, resCss: 0, resFonts: 0, resOther: 0, selfPrivate: 0, selfWorkingSet: 0 }),
    },
  }
  // jsdom 没有 longtask，这里给一个只会记录的假 observer
  ;(globalThis as any).PerformanceObserver = class FakePerformanceObserver {
    static instances: any[] = []
    cb: (list: any) => void
    constructor(cb: (list: any) => void) {
      this.cb = cb
      FakePerformanceObserver.instances.push(this)
    }
    observe() {}
    disconnect() {}
    static emit(entries: any[]) {
      for (const i of FakePerformanceObserver.instances) i.cb({ getEntries: () => entries })
    }
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  delete (globalThis as any).PerformanceObserver
})

async function load() {
  return import('./renderer-perf-probe')
}

describe('renderer-perf-probe', () => {
  it('长任务超过 50ms 才上报', async () => {
    const { startRendererPerfProbe } = await load()
    const stop = startRendererPerfProbe()
    const PO = (globalThis as any).PerformanceObserver
    PO.emit([{ name: 'self', duration: 20, entryType: 'longtask' }])
    PO.emit([{ name: 'self', duration: 120, entryType: 'longtask' }])
    expect(recordEvent).toHaveBeenCalledTimes(1)
    expect(recordEvent.mock.calls[0]![0]).toMatchObject({
      kind: 'renderer.longtask',
      name: 'self',
      duration: 120,
    })
    stop()
  })

  it('内存首次采样只建基线，超阈值才上报且带原生口径', async () => {
    const { startRendererPerfProbe } = await load()
    const heap = { usedJSHeapSize: 100 * 1024 * 1024 }
    ;(performance as any).memory = heap

    // 必须在启动前切假定时器：定时器是启动时挂上的，之后再 useFakeTimers 换不掉它
    vi.useFakeTimers()
    const stop = startRendererPerfProbe()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recordEvent).not.toHaveBeenCalled()

    // 涨了 400MB → 超过 growth 阈值
    heap.usedJSHeapSize = 500 * 1024 * 1024
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recordEvent).toHaveBeenCalledTimes(1)
    expect(recordEvent.mock.calls[0]![0]).toMatchObject({
      kind: 'memory.spike',
      name: 'renderer',
      detail: expect.objectContaining({ reason: 'growth', jsHeapUsed: 500 * 1024 * 1024 }),
    })
    stop()
    vi.useRealTimers()
    delete (performance as any).memory
  })

  it('常驻超阈值只报一次跃迁，冷却期内不重复', async () => {
    const { startRendererPerfProbe } = await load()
    // 私有内存走 native 读数：1.4GB 一直超阈值
    const big = { rss: 1, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0, v8UsedHeap: 0, v8TotalPhysical: 0, v8Malloced: 0, v8PeakMalloced: 0, blinkAllocated: 0, blinkTotal: 0, resImages: 0, resImagesLive: 0, resScripts: 0, resCss: 0, resFonts: 0, resOther: 0, selfPrivate: 1.4 * 1024 * 1024, selfWorkingSet: 1.5 * 1024 * 1024 }
    ;(window as unknown as { electronAPI: { performance: Record<string, unknown> } }).electronAPI.performance.readRendererNativeMemory = async () => big
    ;(performance as any).memory = { usedJSHeapSize: 100 * 1024 * 1024 }

    vi.useFakeTimers()
    const stop = startRendererPerfProbe()
    await vi.advanceTimersByTimeAsync(60_000) // 基线
    await vi.advanceTimersByTimeAsync(60_000) // 第 1 条
    expect(recordEvent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000) // 冷却期内，不重复
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recordEvent).toHaveBeenCalledTimes(1)
    stop()
    vi.useRealTimers()
    delete (performance as any).memory
  })

  it('停用后可以重新启动，重复启动返回同一个停止函数', async () => {
    const { startRendererPerfProbe } = await load()
    const stop = startRendererPerfProbe()
    expect(startRendererPerfProbe()).toBe(stop)
    stop()
    const restarted = startRendererPerfProbe()
    expect(restarted).not.toBe(stop)
    restarted()
  })
})
