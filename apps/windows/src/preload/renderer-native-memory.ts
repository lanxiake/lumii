/**
 * 渲染进程原生内存采集（preload 侧）
 *
 * 为什么放在 preload 而不是渲染层：`process.getBlinkMemoryInfo()` / `getHeapStatistics()`
 * 和 `webFrame.getResourceUsage()` 都要走 Electron 模块，而业务渲染层跑在主世界
 * （contextIsolation: true，没有 require），只有 preload 能拿到这几个接口。
 * 拿到的读数由渲染层的探针并进采样，一起上报主进程。
 *
 * 这几项存在的意义：2026-09-15 实测主窗口渲染进程私有内存 2.6GB，而 JS 堆只有 112MB，
 * DOM 7k 节点、页面图片 1.7MB、canvas 0——「页面口径」全加起来也填不上缺口。
 * 缺口只能在 V8 堆外的 malloc / ArrayBuffer、Blink 分配器、Blink 资源缓存里，
 * 这里就是把这三处各读一个数出来。
 *
 * 每一个读数都各自 try 一次：这些接口在不同平台/版本上未必齐全，缺一个不该让
 * 整条采样作废，读不到就记 0。
 */

import { webFrame } from 'electron'
import type { RendererNativeMemory } from '../main/perf/performance-types'

const ZERO: RendererNativeMemory = {
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

/** 非有限数一律归零：NaN/Infinity 写进 jsonl 会让整行不再是合法 JSON */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * 读一次原生口径。异步是因为 process.getProcessMemoryInfo() 返回 Promise；
 * 任一读数失败只影响它自己。
 */
export async function readRendererNativeMemory(): Promise<RendererNativeMemory> {
  const out: RendererNativeMemory = { ...ZERO }

  try {
    const usage = process.memoryUsage()
    out.rss = num(usage.rss)
    out.heapTotal = num(usage.heapTotal)
    out.heapUsed = num(usage.heapUsed)
    out.external = num(usage.external)
    out.arrayBuffers = num(usage.arrayBuffers)
  } catch {
    // 沙箱化的 preload 没有 Node 的 process，忽略
  }

  try {
    const heap = process.getHeapStatistics()
    out.v8UsedHeap = num(heap.usedHeapSize)
    out.v8TotalPhysical = num(heap.totalPhysicalSize)
    out.v8Malloced = num(heap.mallocedMemory)
    out.v8PeakMalloced = num(heap.peakMallocedMemory)
  } catch {
    // 忽略
  }

  try {
    const blink = process.getBlinkMemoryInfo()
    out.blinkAllocated = num(blink.allocated)
    out.blinkTotal = num(blink.total)
  } catch {
    // 忽略
  }

  try {
    const res = webFrame.getResourceUsage()
    out.resImages = num(res.images.size)
    out.resImagesLive = num(res.images.liveSize)
    out.resScripts = num(res.scripts.size)
    out.resCss = num(res.cssStyleSheets.size)
    out.resFonts = num(res.fonts.size)
    out.resOther = num(res.other.size)
  } catch {
    // 忽略
  }

  try {
    const mem = await process.getProcessMemoryInfo()
    out.selfPrivate = num(mem.private)
    out.selfWorkingSet = num(mem.residentSet)
  } catch {
    // 忽略
  }

  return out
}
