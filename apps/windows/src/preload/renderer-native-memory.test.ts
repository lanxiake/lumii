/**
 * 渲染进程原生内存采集（preload 侧）
 *
 * 这几个读数就是为了回答「进程私有内存 2.6GB，JS 堆只有 112MB，剩下的是什么」，
 * 每个数都要落在正确的字段和量纲上（Blink 的口径是 KB，资源缓存是字节），
 * 单位串了就等于下次又查不出来，所以逐个锁住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  webFrame: { getResourceUsage: vi.fn() },
}))

import { webFrame } from 'electron'
import { readRendererNativeMemory } from './renderer-native-memory'

/** Electron 的 renderer process 上挂着这些接口，Node 原生 process 上没有 */
const proc = process as unknown as Record<string, unknown>

/** 装一整套可用的 Electron 接口读数 */
function stubElectronApis(): void {
  proc.memoryUsage = () => ({
    rss: 2_600_000_000,
    heapTotal: 300 * 1024 * 1024,
    heapUsed: 209 * 1024 * 1024,
    external: 12 * 1024 * 1024,
    arrayBuffers: 8 * 1024 * 1024,
  })
  proc.getHeapStatistics = () => ({
    usedHeapSize: 209 * 1024 * 1024,
    totalPhysicalSize: 300 * 1024 * 1024,
    mallocedMemory: 4 * 1024 * 1024,
    peakMallocedMemory: 6 * 1024 * 1024,
  })
  proc.getBlinkMemoryInfo = () => ({ allocated: 1_500_000, total: 1_800_000 })
  proc.getProcessMemoryInfo = async () => ({ private: 2_620_000, residentSet: 2_583_000, shared: 40_000 })
  vi.mocked(webFrame.getResourceUsage).mockReturnValue({
    images: { count: 3, size: 2 * 1024 * 1024, liveSize: 1 * 1024 * 1024 },
    scripts: { count: 100, size: 30 * 1024 * 1024, liveSize: 30 * 1024 * 1024 },
    cssStyleSheets: { count: 10, size: 4 * 1024 * 1024, liveSize: 4 * 1024 * 1024 },
    xslStyleSheets: { count: 0, size: 0, liveSize: 0 },
    fonts: { count: 2, size: 1024 * 1024, liveSize: 1024 * 1024 },
    other: { count: 5, size: 512 * 1024, liveSize: 512 * 1024 },
  })
}

const READ_METHODS = [
  'memoryUsage',
  'getHeapStatistics',
  'getBlinkMemoryInfo',
  'getProcessMemoryInfo',
]

beforeEach(() => {
  stubElectronApis()
})

afterEach(() => {
  for (const m of READ_METHODS) delete proc[m]
  vi.restoreAllMocks()
  vi.mocked(webFrame.getResourceUsage).mockReset()
})

describe('readRendererNativeMemory', () => {
  it('把 V8 / Blink / 资源缓存 / 进程级的读数各归各位', async () => {
    const m = await readRendererNativeMemory()

    expect(m.rss).toBe(2_600_000_000)
    expect(m.arrayBuffers).toBe(8 * 1024 * 1024)
    expect(m.v8UsedHeap).toBe(209 * 1024 * 1024)
    expect(m.v8Malloced).toBe(4 * 1024 * 1024)
    expect(m.blinkAllocated).toBe(1_500_000)
    expect(m.blinkTotal).toBe(1_800_000)
    expect(m.resImages).toBe(2 * 1024 * 1024)
    expect(m.resImagesLive).toBe(1 * 1024 * 1024)
    expect(m.resScripts).toBe(30 * 1024 * 1024)
    expect(m.resCss).toBe(4 * 1024 * 1024)
    expect(m.resFonts).toBe(1024 * 1024)
    expect(m.resOther).toBe(512 * 1024)
    expect(m.selfPrivate).toBe(2_620_000)
    expect(m.selfWorkingSet).toBe(2_583_000)
  })

  it('单个接口抛错只让它自己记 0，其余读数照常返回', async () => {
    proc.getBlinkMemoryInfo = () => {
      throw new Error('not supported')
    }
    const m = await readRendererNativeMemory()

    expect(m.blinkTotal).toBe(0)
    expect(m.blinkAllocated).toBe(0)
    // 其它口径不受牵连
    expect(m.v8UsedHeap).toBe(209 * 1024 * 1024)
    expect(m.resImages).toBe(2 * 1024 * 1024)
    expect(m.selfPrivate).toBe(2_620_000)
  })

  it('接口整个不存在时全部记 0，不抛错', async () => {
    for (const m of READ_METHODS) delete proc[m]
    vi.mocked(webFrame.getResourceUsage).mockImplementation(() => {
      throw new Error('no webFrame')
    })

    const m = await readRendererNativeMemory()
    expect(Object.values(m).every(v => v === 0)).toBe(true)
  })

  it('脏值（NaN / 负数 / 非数）归零，不写进采样', async () => {
    proc.getHeapStatistics = () => ({
      usedHeapSize: Number.NaN,
      totalPhysicalSize: -1,
      mallocedMemory: Infinity,
      peakMallocedMemory: 'x' as unknown as number,
    })
    const m = await readRendererNativeMemory()

    expect(m.v8UsedHeap).toBe(0)
    expect(m.v8TotalPhysical).toBe(0)
    expect(m.v8Malloced).toBe(0)
    expect(m.v8PeakMalloced).toBe(0)
  })
})
