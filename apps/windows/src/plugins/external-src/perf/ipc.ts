import { app, shell } from 'electron'
import type { PerformanceMonitor } from './impl/performance-monitor'
import type { PerfEvent, PerfEventKind, PerfSummary } from '../../../shared/performance'
import { resolvePerfLogsDir } from '../../../main/paths'
import { createLogger } from '../../../main/logger'

const log = createLogger('ipc/performance')

const VALID_KINDS = new Set<string>([
  'ipc.slow',
  'ipc.error',
  'db.slow',
  'main.loop.lag',
  'renderer.longtask',
  'renderer.interaction',
  'memory.spike',
])

/** detail 只放短字符串与数字；单个值上限防止渲染层塞进大块正文 */
const MAX_DETAIL_STRING = 200
const MAX_DETAIL_KEYS = 8

/**
 * 规整渲染进程上报的慢事件。
 *
 * 采样来自渲染进程，属于跨进程边界：类型断言挡不住运行时脏数据，
 * 而一个 NaN/Infinity 写进 jsonl 会让整行不再是合法 JSON。
 * 非对象、kind 不认识、name 为空一律丢弃——宁可少一条，也不要污染日志。
 */
export function normalizeIncomingEvent(raw: unknown): Omit<PerfEvent, 'timestamp'> | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.kind !== 'string' || !VALID_KINDS.has(r.kind)) return null
  if (typeof r.name !== 'string' || !r.name.trim()) return null

  const event: Omit<PerfEvent, 'timestamp'> = {
    kind: r.kind as PerfEventKind,
    name: r.name.slice(0, MAX_DETAIL_STRING),
  }
  if (typeof r.duration === 'number' && Number.isFinite(r.duration) && r.duration >= 0) {
    event.duration = Math.min(r.duration, Number.MAX_SAFE_INTEGER)
  }
  if (r.detail != null && typeof r.detail === 'object') {
    const detail: Record<string, string | number> = {}
    for (const [k, v] of Object.entries(r.detail as Record<string, unknown>)) {
      if (Object.keys(detail).length >= MAX_DETAIL_KEYS) break
      if (typeof v === 'string') detail[k] = v.slice(0, MAX_DETAIL_STRING)
      else if (typeof v === 'number' && Number.isFinite(v)) detail[k] = v
    }
    event.detail = detail
  }
  return event
}

/**
 * 注册性能诊断 IPC。
 *
 * `getMonitor` 而不是直接传实例：perf 可能被运行期卸载/重装/热重载；
 * 每次调用现取容器里的最新实例，卸载后自动变成「不可用」。
 *
 * 通道经**注册器**挂载（扩展 apply 里传 `ctx.registerIpc`），停用时随作用域摘除——
 * 直接 `ipcMain.handle` 摘不掉，守卫 ⑫ 会红。
 */
export function registerPerformanceIpc(
  registrar: { handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void },
  getMonitor: () => PerformanceMonitor | null,
): void {
  // 诊断页顶部摘要（今日计数 / 最慢 / 启动阶段 / 内存 / 健康度）
  registrar.handle('performance:getSummary', async (): Promise<PerfSummary> => {
    const monitor = getMonitor()
    if (!monitor) throw new Error('perf_disabled')
    return monitor.getSummary()
  })

  // 今日全部慢事件（含重启前从磁盘回放的），供明细/排行/时间线共用
  registrar.handle('performance:listEvents', async (_event, opts?: { since?: number }) => {
    const monitor = getMonitor()
    if (!monitor) return []
    return monitor.listEvents(typeof opts?.since === 'number' ? opts.since : undefined)
  })

  // 渲染层上报慢事件（长任务 / 关键交互 / 内存尖峰）
  registrar.handle('performance:recordEvent', async (_event, raw: unknown) => {
    const monitor = getMonitor()
    if (!monitor) return { success: false, error: 'perf_disabled' }
    const normalized = normalizeIncomingEvent(raw)
    if (!normalized) {
      log.warn('[recordEvent] 载荷非法，已忽略')
      return { success: false, error: 'invalid-event' }
    }
    monitor.recordEvent({ timestamp: Date.now(), ...normalized })
    return { success: true }
  })

  // 手动采集一次内存现场（排查「现在为什么这么占内存」时用得上）
  registrar.handle('performance:capture', async () => {
    const monitor = getMonitor()
    if (!monitor) return { success: false, error: 'perf_disabled' }
    const usage = process.memoryUsage()
    const metrics = app.getAppMetrics().map(metric => ({
      type: metric.type,
      pid: metric.pid,
      rss: metric.memory.workingSetSize * 1024,
      privateBytes: (metric.memory.privateBytes ?? 0) * 1024,
    }))
    monitor.recordEvent({
      timestamp: Date.now(),
      kind: 'memory.spike',
      name: 'manual',
      detail: {
        rss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        processes: metrics.map(m => `${m.type}#${m.pid}:${Math.round(m.privateBytes / 1048576)}MB`).join(';'),
      },
    })
    log.info('[capture] 手动内存现场已记录')
    return { success: true }
  })

  // 打开性能日志文件夹（跨天历史只能靠它，页面只展示今日）
  registrar.handle('performance:openLogFolder', async () => {
    try {
      const logPath = resolvePerfLogsDir()
      const openError = await shell.openPath(logPath)
      if (openError) {
        log.warn(`[openLogFolder] 打开失败: ${openError}`)
        return { success: false, error: openError }
      }
      return { success: true }
    } catch (err) {
      log.error('[openLogFolder] 打开日志文件夹失败', err)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
