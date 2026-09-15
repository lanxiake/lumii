import { ipcMain, shell } from 'electron'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import type { RendererMemorySample, RendererNativeMemory } from '../perf/performance-types'
import { resolvePerfLogsDir } from '../paths'
import { createLogger } from '../logger'

const log = createLogger('ipc/performance')

/** 单个字段的上界：超过即视为脏数据，按上限截断而不是原样落盘 */
const MAX_SAMPLE_VALUE = Number.MAX_SAFE_INTEGER
/** topSessions 摘要串长度上限 */
const MAX_TOP_SESSIONS_CHARS = 200

/**
 * 取一个非负整数计数，非法值一律归零。
 *
 * 采样来自渲染进程，属于跨进程边界：类型断言挡不住运行时脏数据，
 * 而一个 NaN/Infinity 写进 jsonl 会让整行不再是合法 JSON。
 */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.trunc(value), MAX_SAMPLE_VALUE)
}

/**
 * 规整渲染进程上报的原生口径。缺字段/脏字段一律归零——这些读数来自
 * Electron 的各路接口，个别平台本就可能读不到。
 */
function normalizeNativeMemory(raw: unknown): RendererNativeMemory {
  const r = (raw != null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    rss: toCount(r.rss),
    heapTotal: toCount(r.heapTotal),
    heapUsed: toCount(r.heapUsed),
    external: toCount(r.external),
    arrayBuffers: toCount(r.arrayBuffers),
    v8UsedHeap: toCount(r.v8UsedHeap),
    v8TotalPhysical: toCount(r.v8TotalPhysical),
    v8Malloced: toCount(r.v8Malloced),
    v8PeakMalloced: toCount(r.v8PeakMalloced),
    blinkAllocated: toCount(r.blinkAllocated),
    blinkTotal: toCount(r.blinkTotal),
    resImages: toCount(r.resImages),
    resImagesLive: toCount(r.resImagesLive),
    resScripts: toCount(r.resScripts),
    resCss: toCount(r.resCss),
    resFonts: toCount(r.resFonts),
    resOther: toCount(r.resOther),
    selfPrivate: toCount(r.selfPrivate),
    selfWorkingSet: toCount(r.selfWorkingSet),
  }
}

/**
 * 规整渲染进程内存采样。非对象载荷整体判非法，字段级脏数据按零处理——
 * 采样宁可少几个字段，也不能因为一个坏值丢掉整次记录。
 */
export function normalizeRendererSample(raw: unknown): RendererMemorySample | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  return {
    jsHeapUsed: toCount(r.jsHeapUsed),
    jsHeapLimit: toCount(r.jsHeapLimit),
    domNodes: toCount(r.domNodes),
    imgs: toCount(r.imgs),
    imageBytes: toCount(r.imageBytes),
    canvases: toCount(r.canvases),
    canvasBytes: toCount(r.canvasBytes),
    iframes: toCount(r.iframes),
    sessions: toCount(r.sessions),
    messages: toCount(r.messages),
    contentChars: toCount(r.contentChars),
    fileEvents: toCount(r.fileEvents),
    compactionEvents: toCount(r.compactionEvents),
    topSessions: typeof r.topSessions === 'string' ? r.topSessions.slice(0, MAX_TOP_SESSIONS_CHARS) : '',
    native: normalizeNativeMemory(r.native),
  }
}

export function setupPerformanceIpcHandlers(performanceMonitor: PerformanceMonitor): void {
  // 获取性能诊断报告
  ipcMain.handle('performance:getReport', async () => {
    try {
      const report = performanceMonitor.getReport()
      log.info(`[getReport] 报告生成完成，健康状态: ${report.health}`)
      return report
    } catch (err) {
      log.error('[getReport] 生成报告失败', err)
      throw new Error('Failed to generate performance report')
    }
  })

  // 获取历史时间序列（IPC 60秒窗口聚合 + 内存快照序列），供设置页画趋势图
  ipcMain.handle('performance:getHistory', async () => {
    try {
      const ipcAggregates = performanceMonitor.getIpcAggregateHistory()
      const memorySnapshots = performanceMonitor.getMemorySnapshotHistory()
      log.info(
        `[getHistory] 历史序列查询完成, ipc聚合窗口数=${ipcAggregates.length}, 内存快照数=${memorySnapshots.length}`,
      )
      return { ipcAggregates, memorySnapshots }
    } catch (err) {
      log.error('[getHistory] 获取历史序列失败', err)
      throw new Error('Failed to get performance history')
    }
  })

  // 手动捕获一次内存快照
  ipcMain.handle('performance:capture', async () => {
    try {
      const memoryUsage = process.memoryUsage()
      performanceMonitor.recordMemorySnapshot({
        timestamp: Date.now(),
        kind: 'memory.snapshot',
        mainProcess: {
          heapUsed: memoryUsage.heapUsed,
          heapTotal: memoryUsage.heapTotal,
          external: memoryUsage.external,
          arrayBuffers: memoryUsage.arrayBuffers,
          rss: memoryUsage.rss,
        },
        childProcesses: [],
      })
      log.info('[capture] 手动内存快照已捕获')
      return { success: true }
    } catch (err) {
      log.error('[capture] 快照捕获失败', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 渲染进程内存采样：渲染层每分钟上报一次，与 memory.snapshot 落在同一份 perf 日志里。
  // 时间戳与 pid 由主进程补——渲染层自填的 pid 没有可信度，而崩溃后要靠它认领进程。
  ipcMain.handle('performance:recordRendererMemory', async (event, raw: unknown) => {
    try {
      const sample = normalizeRendererSample(raw)
      if (!sample) {
        log.warn('[recordRendererMemory] 采样载荷非法，已忽略')
        return { success: false, error: 'invalid-sample' }
      }
      performanceMonitor.recordRendererMemory({
        timestamp: Date.now(),
        kind: 'renderer.memory',
        pid: event.sender.getOSProcessId(),
        ...sample,
      })
      return { success: true }
    } catch (err) {
      log.error('[recordRendererMemory] 采样写入失败', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 打开性能日志文件夹
  ipcMain.handle('performance:openLogFolder', async () => {
    try {
      const logPath = resolvePerfLogsDir()
      const openError = await shell.openPath(logPath)
      if (openError) {
        // shell.openPath 失败时返回错误描述字符串而非抛异常
        log.warn(`[openLogFolder] 打开失败: ${openError}`)
        return { success: false, error: openError }
      }
      log.info(`[openLogFolder] 已打开日志文件夹: ${logPath}`)
      return { success: true }
    } catch (err) {
      log.error('[openLogFolder] 打开日志文件夹失败', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
