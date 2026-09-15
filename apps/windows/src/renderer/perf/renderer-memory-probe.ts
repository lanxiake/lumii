/**
 * 渲染进程内存采样器
 *
 * 每分钟采一次，交给主进程写进 perf 日志（与进程级 memory.snapshot 同一份 jsonl）。
 *
 * 起因：2026-09-15 主窗口渲染进程因 V8 堆撞上 4GB 上限而崩溃（exitCode=0x80000003），
 * 崩溃前进程私有内存已到 5.4GB。当时日志里只有进程级读数，看不出这些内存落在
 * JS 对象上还是 DOM / 解码位图 / 合成器上，事后无法定位。这份采样把两类口径并排留档：
 *
 * - jsHeap*：V8 堆（JS 侧持有）
 * - domNodes / imgs / canvas / iframes：Blink 侧体量
 * - sessions / messages / contentChars：运行时 store 的数据体量
 * - native：V8 堆外 / Blink 分配器 / Blink 资源缓存 / 进程级读数（preload 侧读）
 *
 * native 那一组是 2026-09-15 复测后补的：当时渲染进程私有内存 2.6GB，而上面
 * 页面口径全部加起来不到 10MB——说明缺口根本不在页面上。没有 native 就只能看到
 * 「有 2.4GB 不知去向」，有了它才能分辨是 Blink 分配器、资源缓存，还是堆外 ArrayBuffer。
 *
 * 采样发往主进程而非写本地日志，渲染进程崩溃后样本仍在主进程手里。
 */

import type { RendererMemorySample, RendererPageSample, RendererNativeMemory } from '@main/perf/performance-types'
import { runtimeStore } from '../hooks/business/useAgentRuntime/agent-runtime-store'

/** 采样间隔：够密能看清趋势，又不至于自己污染读数 */
const SAMPLE_INTERVAL_MS = 60_000

/** 首个采样延迟一拍：挂载瞬间的读数没有参考价值 */
const FIRST_SAMPLE_DELAY_MS = 10_000

/** Chromium 专有的 performance.memory，标准 DOM 类型里没有 */
interface ChromiumMemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

function readHeap(): ChromiumMemoryInfo | null {
  const perf = performance as Performance & { memory?: ChromiumMemoryInfo }
  return perf.memory ?? null
}

/**
 * Blink 侧（不进 V8 堆）的记账：图片解码位图、canvas 后备存储、iframe 文档。
 * 这些正是「进程私有内存远大于 jsHeap」时的头号嫌疑，JS 堆快照里看不到它们。
 */
function readBlinkSide(): Pick<
  RendererMemorySample,
  'imgs' | 'imageBytes' | 'canvases' | 'canvasBytes' | 'iframes'
> {
  let imgs = 0
  let imageBytes = 0
  for (const img of Array.from(document.getElementsByTagName('img'))) {
    imgs++
    // 未加载完成的 naturalWidth 为 0，不计入
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      imageBytes += img.naturalWidth * img.naturalHeight * 4
    }
  }

  const canvases = Array.from(document.getElementsByTagName('canvas'))
  let canvasBytes = 0
  for (const c of canvases) canvasBytes += c.width * c.height * 4

  return {
    imgs,
    imageBytes,
    canvases: canvases.length,
    canvasBytes,
    iframes: document.getElementsByTagName('iframe').length,
  }
}

/** 运行时 store 的数据体量：会话数只增不减，是 JS 侧最可疑的无界结构 */
function readStoreSize(): Pick<
  RendererMemorySample,
  'sessions' | 'messages' | 'contentChars' | 'fileEvents' | 'compactionEvents' | 'topSessions'
> {
  const state = runtimeStore.getState()
  let messages = 0
  let contentChars = 0
  let fileEvents = 0
  let compactionEvents = 0
  const perSession: { key: string; count: number }[] = []

  for (const [key, session] of state.sessions) {
    messages += session.messages.length
    fileEvents += session.fileEvents.length
    compactionEvents += session.compactionEvents.length
    perSession.push({ key, count: session.messages.length })
    for (const msg of session.messages) {
      for (const block of msg.content) {
        if (block.type === 'text') contentChars += block.text.length
      }
      for (const part of msg.parts) {
        if ('text' in part && typeof part.text === 'string') contentChars += part.text.length
      }
      contentChars += msg.thinkingText?.length ?? 0
    }
  }

  perSession.sort((a, b) => b.count - a.count)
  const topSessions = perSession
    .slice(0, 3)
    .map((s) => `${s.key.slice(0, 12)}:${s.count}`)
    .join(',')

  return {
    sessions: state.sessions.size,
    messages,
    contentChars,
    fileEvents,
    compactionEvents,
    topSessions,
  }
}

/** 采集一次完整样本（不含 native——那部分由 preload 另读） */
export function collectRendererMemorySample(): RendererPageSample {
  const heap = readHeap()
  return {
    jsHeapUsed: heap?.usedJSHeapSize ?? 0,
    jsHeapLimit: heap?.jsHeapSizeLimit ?? 0,
    domNodes: document.getElementsByTagName('*').length,
    ...readBlinkSide(),
    ...readStoreSize(),
  }
}

/** native 读不到时的占位：宁可记 0，也不能让整条采样丢掉 */
const ZERO_NATIVE: RendererNativeMemory = {
  rss: 0,
  heapTotal: 0,
  heapUsed: 0,
  external: 0,
  arrayBuffers: 0,
  v8UsedHeap: 0,
  v8TotalPhysical: 0,
  v8Malloced: 0,
  v8PeakMalloced: 0,
  blinkAllocated: 0,
  blinkTotal: 0,
  resImages: 0,
  resImagesLive: 0,
  resScripts: 0,
  resCss: 0,
  resFonts: 0,
  resOther: 0,
  selfPrivate: 0,
  selfWorkingSet: 0,
}

/** native 读取失败的告警只打一次，避免每分钟刷屏 */
let nativeReadWarned = false

/** 上报一次采样；失败静默——采样本身不该影响业务 */
async function reportSample(): Promise<void> {
  const api = window.electronAPI?.performance
  if (!api?.recordRendererMemory) return

  const page = collectRendererMemorySample()

  let native = ZERO_NATIVE
  try {
    native = (await api.readRendererNativeMemory?.()) ?? ZERO_NATIVE
  } catch (err) {
    if (!nativeReadWarned) {
      nativeReadWarned = true
      console.warn('[RendererMemoryProbe] 原生内存读数失败，本次按 0 记录', err)
    }
  }

  const sample: RendererMemorySample = { ...page, native }

  try {
    await api.recordRendererMemory(sample)
  } catch {
    // 主进程未注册处理器（如 preload 版本不匹配）时忽略
  }
}

/**
 * 启动采样。重复调用无副作用（只挂一次定时器）。
 */
export function startRendererMemoryProbe(): void {
  const flag = '__lumiiRendererMemoryProbeStarted'
  const holder = globalThis as typeof globalThis & Record<string, unknown>
  if (holder[flag]) return
  holder[flag] = true

  if (!window.electronAPI?.performance?.recordRendererMemory) {
    console.warn('[RendererMemoryProbe] preload 未暴露 recordRendererMemory，采样已跳过')
    return
  }

  // 每次启动重新起算告警闩（生产里只启动一次，等价于初始值；测试里可反复起停）
  nativeReadWarned = false

  setTimeout(reportSample, FIRST_SAMPLE_DELAY_MS)
  setInterval(reportSample, SAMPLE_INTERVAL_MS)
}
