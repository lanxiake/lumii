/**
 * 渲染层性能探针
 *
 * 两件事，全部「超阈值才上报」，平时零噪音：
 * - **长任务**：`PerformanceObserver('longtask')`，>50ms 的合成器任务；
 * - **内存尖峰**：每分钟读一次，只在越过绝对阈值或相对上次上报涨得多时上报。
 *   平时不落盘：改前每分钟一条内存快照，一天 1300+ 条，把慢事件的比例压到了 2.6%。
 *
 * 关键交互的计时**不在这里**：打点在 ChatPage / switch-session 这些核心位置，
 * 而渲染层核心不允许 import 插件实现（守卫 ⑭），故由 `renderer/utils/perf-marks.ts`
 * 直接调 preload 的 `performance.recordEvent`。
 *
 * 停用 perf 扩展时必须真的停：通道已摘掉还在 invoke 的话控制台会一片红。
 */

import type { RendererNativeMemory, RendererPerfEvent } from '@shared/performance'

/**
 * 长任务上报阈值。
 *
 * 浏览器的 longtask **本来就是「>50ms」才会产生条目**，所以阈值填 50 等于全收：
 * 2026-10-29 真机实测一天 3107 条，占 perf 日志 94%，p50 只有 62ms —— 真正的卡顿
 * （>200ms）只有 19 条，被埋在中间。100ms 是正确的分界：用户能感知到的卡顿在
 * 100ms 以上（RAIL 的 100ms 响应预算），低于它的长任务属正常帧预算波动。
 */
const LONGTASK_THRESHOLD_MS = 100
/** 内存采样间隔 */
const MEMORY_SAMPLE_INTERVAL_MS = 60_000
/**
 * 渲染进程私有内存阈值。
 *
 * **不能用 `performance.memory.usedJSHeapSize` 判**：2026-10-29 实测渲染进程工作集
 * 1.33GB，而 JS 堆远未到 1.5GB 上限 —— DOM / 解码位图 / 合成器都在堆外，按堆判永远不触发。
 * 口径改用 preload 读到的 `selfPrivate`（与主进程 `memory.snapshot.privateBytes` 同源）。
 */
const PRIVATE_THRESHOLD_BYTES = 1.2 * 1024 * 1024 * 1024
/** 相对上次上报的涨幅阈值 */
const HEAP_GROWTH_BYTES = 300 * 1024 * 1024
/** 内存尖峰的静默期：常驻超阈值不是事件，只报跃迁 */
const MEMORY_SPIKE_COOLDOWN_MS = 10 * 60_000

/** 上一次上报尖峰的时刻（0 = 还没报过） */
let lastSpikeAt = 0

function report(event: RendererPerfEvent): void {
  const api = window.electronAPI?.performance
  if (!api?.recordEvent) return
  void api.recordEvent(event).catch(() => {
    // 主进程未注册（扩展被停用 / preload 版本不匹配）时静默
  })
}

/**
 * 长任务观察。
 *
 * `attribution` 在 Chromium 上通常为空数组（跨源隔离下不给更多信息），
 * 所以 name 多为 `unknown`——它管的是「这台机器此刻卡了多久」，不是「卡在哪个函数」。
 * 要归因到函数靠主进程的 `main.loop.lag` + 打点栈。
 */
function observeLongTasks(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => undefined

  let observer: PerformanceObserver
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONGTASK_THRESHOLD_MS) continue
        report({
          kind: 'renderer.longtask',
          name: entry.name || 'unknown',
          duration: Math.round(entry.duration),
          detail: { entryType: entry.entryType },
        })
      }
    })
    observer.observe({ type: 'longtask', buffered: true })
  } catch {
    // 不支持 longtask 的运行时（jsdom / 旧内核）直接放弃，不影响别的采集
    return () => undefined
  }
  return () => observer.disconnect()
}

/** 读取渲染进程内存；读不到就返回 null */
function readHeapBytes(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } }
  const used = perf.memory?.usedJSHeapSize
  return typeof used === 'number' && Number.isFinite(used) ? used : null
}

const ZERO_NATIVE: RendererNativeMemory = {
  rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0,
  v8UsedHeap: 0, v8TotalPhysical: 0, v8Malloced: 0, v8PeakMalloced: 0,
  blinkAllocated: 0, blinkTotal: 0, resImages: 0, resImagesLive: 0,
  resScripts: 0, resCss: 0, resFonts: 0, resOther: 0,
  selfPrivate: 0, selfWorkingSet: 0,
}

/**
 * 内存采样：只在尖峰时上报，并随事件带上原生口径（V8 堆外 / Blink / 资源缓存）。
 *
 * 判定口径是**进程私有内存**而不是 JS 堆：2026-10-29 实测渲染进程 1.33GB 时
 * `usedJSHeapSize` 离 1.5GB 上限还远，按堆判永远不会触发（那天一条 `memory.spike` 都没有）。
 * 私有内存要走 preload 读，所以**每次都读**，读不到才退回 JS 堆。
 */
async function sampleMemory(
  lastReported: { bytes: number; at: number },
): Promise<{ bytes: number; at: number }> {
  let native = ZERO_NATIVE
  try {
    native = (await window.electronAPI?.performance?.readRendererNativeMemory?.()) ?? ZERO_NATIVE
  } catch {
    // 读不到就走 JS 堆兜底
  }

  // 私有内存（KB → 字节）；读不到时退回 JS 堆
  const privateBytes = native.selfPrivate > 0 ? native.selfPrivate * 1024 : 0
  const heapBytes = readHeapBytes() ?? 0
  const bytes = privateBytes > 0 ? privateBytes : heapBytes
  if (bytes === 0) return lastReported

  const now = Date.now()
  const overLimit = bytes > PRIVATE_THRESHOLD_BYTES
  const grewFast = lastReported.bytes > 0 && bytes - lastReported.bytes > HEAP_GROWTH_BYTES
  // 首次采样只建基线，不报——挂载瞬间的读数没有参考价值
  if (lastReported.at === 0) return { bytes, at: now }
  if (!overLimit && !grewFast) return lastReported

  // 冷却：一旦常驻超阈值，不加冷却就会每分钟一条（2026-10-29 实测 14:41–14:47 连报 7 条，
  // 数值全在 1.32GB 上下打转 —— 那是稳定态，不是事件）。
  // 只报「状态跃迁」：自上一条起又涨了 HEAP_GROWTH_BYTES 以上，或已过 10 分钟静默期。
  const quietFor = now - lastSpikeAt
  const grewSinceReport = lastReported.at > 0 && bytes - lastReported.bytes > HEAP_GROWTH_BYTES
  if (lastSpikeAt > 0 && quietFor < MEMORY_SPIKE_COOLDOWN_MS && !grewSinceReport) {
    return { bytes, at: now }
  }

  lastSpikeAt = now
  report({
    kind: 'memory.spike',
    name: 'renderer',
    detail: {
      // 判定口径：privateBytes 是进程私有内存，jsHeapUsed 只作对照
      privateBytes,
      jsHeapUsed: heapBytes,
      deltaBytes: bytes - lastReported.bytes,
      reason: overLimit ? 'over-limit' : 'growth',
      rss: native.rss,
      blinkTotal: native.blinkTotal,
      resImagesLive: native.resImagesLive,
      v8Malloced: native.v8Malloced,
      domNodes: document.getElementsByTagName('*').length,
    },
  })
  return { bytes, at: now }
}

/** 当前这次启动的停止函数（重复启动时复用同一个） */
let stopCurrent: (() => void) | null = null

/**
 * 启动探针。重复调用无副作用（只挂一次），返回停止函数。
 *
 * 返回停止函数而不是空：perf 是可选扩展，停用后必须真的停，
 * 否则通道已摘掉、探针还在每分钟 invoke（控制台一片红）。
 */
export function startRendererPerfProbe(): () => void {
  const flag = '__lumiiRendererPerfProbeStarted'
  const holder = globalThis as typeof globalThis & Record<string, unknown>
  if (holder[flag]) return stopCurrent ?? (() => undefined)
  holder[flag] = true

  if (!window.electronAPI?.performance?.recordEvent) {
    console.warn('[RendererPerfProbe] preload 未暴露 recordEvent，探针已跳过')
    return () => undefined
  }

  const stopLongTask = observeLongTasks()

  let lastReported = { bytes: 0, at: 0 }
  const memoryTimer = setInterval(() => {
    void sampleMemory(lastReported).then((next) => {
      lastReported = next
    })
  }, MEMORY_SAMPLE_INTERVAL_MS)

  const stop = (): void => {
    clearInterval(memoryTimer)
    stopLongTask()
    delete holder[flag]
    stopCurrent = null
  }
  stopCurrent = stop
  return stop
}
