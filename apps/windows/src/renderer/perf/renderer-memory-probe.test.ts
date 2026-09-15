/**
 * 渲染进程内存采样器
 *
 * 这份采样是渲染进程 OOM 崩溃时唯一能区分「JS 堆持有」与「Blink 侧体量」的凭据，
 * 算错口径就等于下次出事仍然查不出来，所以各口计数都要锁住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { RendererMemorySample, RendererNativeMemory } from '@main/perf/performance-types'
import {
  collectRendererMemorySample,
  startRendererMemoryProbe,
} from './renderer-memory-probe'
import { resetRuntimeStore, updateSessionState, getDefaultPerSessionState } from '../hooks/business/useAgentRuntime/agent-runtime-store'

const PROBE_FLAG = '__lumiiRendererMemoryProbeStarted'

/** 一份字段齐全的 native 读数，供测试按需覆写 */
function fakeNative(overrides: Partial<RendererNativeMemory> = {}): RendererNativeMemory {
  return {
    rss: 2_600_000_000,
    heapTotal: 300 * 1024 * 1024,
    heapUsed: 209 * 1024 * 1024,
    external: 12 * 1024 * 1024,
    arrayBuffers: 8 * 1024 * 1024,
    v8UsedHeap: 209 * 1024 * 1024,
    v8TotalPhysical: 300 * 1024 * 1024,
    v8Malloced: 4 * 1024 * 1024,
    v8PeakMalloced: 6 * 1024 * 1024,
    blinkAllocated: 1_500_000,
    blinkTotal: 1_800_000,
    resImages: 2 * 1024 * 1024,
    resImagesLive: 2 * 1024 * 1024,
    resScripts: 30 * 1024 * 1024,
    resCss: 4 * 1024 * 1024,
    resFonts: 1024 * 1024,
    resOther: 512 * 1024,
    selfPrivate: 5_300_000,
    selfWorkingSet: 5_200_000,
    ...overrides,
  }
}

/** 装一个只关心 recordRendererMemory 的 preload 假实现（其余方法补齐仅为满足类型） */
function stubPerformanceApi(
  recordRendererMemory: (sample: RendererMemorySample) => Promise<{ success: boolean }>,
  readRendererNativeMemory: () => Promise<RendererNativeMemory> = async () => fakeNative(),
): void {
  window.electronAPI = {
    ...window.electronAPI,
    performance: {
      getReport: vi.fn(),
      capture: vi.fn(),
      openLogFolder: vi.fn(),
      getHistory: vi.fn(),
      recordRendererMemory,
      readRendererNativeMemory,
    },
  } as typeof window.electronAPI
}

/** jsdom 没有 performance.memory（Chromium 专有），按需注入 */
function stubHeap(used: number, limit: number): void {
  Object.defineProperty(window.performance, 'memory', {
    value: { usedJSHeapSize: used, totalJSHeapSize: used, jsHeapSizeLimit: limit },
    configurable: true,
  })
}

/** jsdom 的 img 不会有 naturalWidth/naturalHeight，手动造一张「已解码」的图 */
function appendDecodedImg(width: number, height: number): void {
  const img = document.createElement('img')
  Object.defineProperty(img, 'naturalWidth', { value: width })
  Object.defineProperty(img, 'naturalHeight', { value: height })
  document.body.appendChild(img)
}

function appendCanvas(width: number, height: number): void {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  document.body.appendChild(canvas)
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetRuntimeStore()
  delete (globalThis as Record<string, unknown>)[PROBE_FLAG]
  vi.useRealTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>)[PROBE_FLAG]
})

describe('collectRendererMemorySample', () => {
  it('读取 V8 堆用量与上限', () => {
    stubHeap(209 * 1024 * 1024, 4096 * 1024 * 1024)
    const sample = collectRendererMemorySample()
    expect(sample.jsHeapUsed).toBe(209 * 1024 * 1024)
    expect(sample.jsHeapLimit).toBe(4096 * 1024 * 1024)
  })

  it('performance.memory 缺失时堆读数归零而不是 NaN', () => {
    delete (window.performance as unknown as Record<string, unknown>).memory
    const sample = collectRendererMemorySample()
    expect(sample.jsHeapUsed).toBe(0)
    expect(sample.jsHeapLimit).toBe(0)
  })

  it('按 naturalWidth×naturalHeight×4 估算已解码图片位图', () => {
    appendDecodedImg(100, 50)
    appendDecodedImg(10, 10)
    const sample = collectRendererMemorySample()
    expect(sample.imgs).toBe(2)
    expect(sample.imageBytes).toBe(100 * 50 * 4 + 10 * 10 * 4)
  })

  it('未解码完成的图片计入数量但不计字节', () => {
    document.body.appendChild(document.createElement('img'))
    const sample = collectRendererMemorySample()
    expect(sample.imgs).toBe(1)
    expect(sample.imageBytes).toBe(0)
  })

  it('统计 canvas 后备存储与 iframe 数量', () => {
    appendCanvas(1400, 900)
    document.body.appendChild(document.createElement('iframe'))
    const sample = collectRendererMemorySample()
    expect(sample.canvases).toBe(1)
    expect(sample.canvasBytes).toBe(1400 * 900 * 4)
    expect(sample.iframes).toBe(1)
  })

  it('统计文档元素总数', () => {
    document.body.innerHTML = '<div><span>a</span><span>b</span></div>'
    // html / head / body / div / span / span
    expect(collectRendererMemorySample().domNodes).toBe(6)
  })

  it('汇总运行时 store 的会话体量，并按消息数给出前三名', () => {
    updateSessionState('sess-a', (prev) => ({
      ...prev,
      messages: [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'x'.repeat(100) }], parts: [], timestamp: 0, isStreaming: false, toolCalls: [] },
        { id: 'm2', role: 'user', content: [{ type: 'text', text: 'y'.repeat(50) }], parts: [], timestamp: 0, isStreaming: false, toolCalls: [] },
      ],
      fileEvents: new Array(3).fill({}) as never,
    }))
    updateSessionState('sess-b', (prev) => ({
      ...prev,
      messages: [
        { id: 'm3', role: 'assistant', content: [], parts: [{ type: 'text', id: 'p1', text: 'z'.repeat(10), status: 'done' }], timestamp: 0, isStreaming: false, toolCalls: [] },
      ],
    }))
    expect(getDefaultPerSessionState().messages).toHaveLength(0)

    const sample = collectRendererMemorySample()
    expect(sample.sessions).toBe(2)
    expect(sample.messages).toBe(3)
    expect(sample.contentChars).toBe(160)
    expect(sample.fileEvents).toBe(3)
    expect(sample.topSessions.startsWith('sess-a:2')).toBe(true)
  })
})

describe('startRendererMemoryProbe', () => {
  it('启动后按延迟上报一次采样', async () => {
    vi.useFakeTimers()
    const recordRendererMemory = vi.fn(async (_sample: RendererMemorySample) => ({ success: true }))
    stubPerformanceApi(recordRendererMemory)
    stubHeap(1024, 4096)

    startRendererMemoryProbe()
    expect(recordRendererMemory).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordRendererMemory).toHaveBeenCalledTimes(1)
    expect(recordRendererMemory.mock.calls[0]![0]).toMatchObject({ jsHeapUsed: 1024 })

    // 之后每分钟一次
    await vi.advanceTimersByTimeAsync(60_000)
    expect(recordRendererMemory).toHaveBeenCalledTimes(2)
  })

  it('重复调用只挂一次定时器', async () => {
    vi.useFakeTimers()
    const recordRendererMemory = vi.fn(async (_sample: RendererMemorySample) => ({ success: true }))
    stubPerformanceApi(recordRendererMemory)

    startRendererMemoryProbe()
    startRendererMemoryProbe()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(recordRendererMemory).toHaveBeenCalledTimes(1)
  })

  it('preload 未暴露接口时告警并跳过，不抛错', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.electronAPI = {
      ...window.electronAPI,
      performance: {} as never,
    } as typeof window.electronAPI

    expect(() => startRendererMemoryProbe()).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('把 preload 读到的原生口径并进采样一起上报', async () => {
    vi.useFakeTimers()
    const recordRendererMemory = vi.fn(async (_sample: RendererMemorySample) => ({ success: true }))
    // 2.6GB 进程私有内存 vs 112MB JS 堆——正是这次要查的那种账
    const native = fakeNative({ selfPrivate: 2_600_000, blinkTotal: 1_900_000 })
    stubPerformanceApi(recordRendererMemory, async () => native)
    stubHeap(112 * 1024 * 1024, 4096 * 1024 * 1024)

    startRendererMemoryProbe()
    await vi.advanceTimersByTimeAsync(10_000)

    const sent = recordRendererMemory.mock.calls[0]![0]
    expect(sent.native).toEqual(native)
    expect(sent.jsHeapUsed).toBe(112 * 1024 * 1024)
  })

  it('原生读数抛错时整条采样仍要上报，native 记 0', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recordRendererMemory = vi.fn(async (_sample: RendererMemorySample) => ({ success: true }))
    stubPerformanceApi(recordRendererMemory, async () => {
      throw new Error('getBlinkMemoryInfo 不可用')
    })

    startRendererMemoryProbe()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(recordRendererMemory).toHaveBeenCalledTimes(1)
    expect(recordRendererMemory.mock.calls[0]![0].native.blinkTotal).toBe(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('原生读数持续失败时告警只打一次，不每分钟刷屏', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const recordRendererMemory = vi.fn(async (_sample: RendererMemorySample) => ({ success: true }))
    stubPerformanceApi(recordRendererMemory, async () => {
      throw new Error('不可用')
    })

    startRendererMemoryProbe()
    await vi.advanceTimersByTimeAsync(10_000 + 60_000 * 3)

    expect(recordRendererMemory).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
