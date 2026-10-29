import { app } from 'electron'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { PerformanceMonitor } from './impl/performance-monitor'
import { resolvePerfLogsDir } from '../../../main/paths'
import { registerPerformanceIpc } from './ipc'
import { findBlockingSuspects, getInflightSpans } from '../../../shared/performance'

/** 内存采样间隔：只用来判断「有没有尖峰」，不上报常规读数 */
const MEMORY_SAMPLE_INTERVAL_MS = 60_000
/** 主线程阻塞阈值 */
const LOOP_LAG_THRESHOLD_MS = 100
/**
 * 事件循环延迟探针的采样步长（毫秒）。
 *
 * 这是**直方图分辨率**，不是上报间隔：monitorEventLoopDelay 每 resolution 毫秒采一次样，
 * 读到的 `max` 天然被量化到「至少一个步长」。填 1000 会让任何阻塞都报成 ~1000ms
 * （2026-10-29 真机实测：5 条全是 999–1011ms，量什么都一样），因此必须远小于阈值。
 */
const LOOP_DELAY_RESOLUTION_MS = 10
/** 主进程 RSS 尖峰阈值：2GB（2026-09-15 渲染进程 4GB 堆崩溃复盘的同一量级） */
const MEMORY_RSS_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024
/** 10 分钟内涨 300MB 即视为尖峰 */
const MEMORY_GROWTH_THRESHOLD_BYTES = 300 * 1024 * 1024

/**
 * 性能监控扩展：只记**慢/贵**事件。
 *
 * 采集面三个，全部按「超阈值才记」（慢 SQL 是第四个，但它的钩子在**核心侧**接）：
 * - IPC：`createMeasuredHandler` 调 `recordIpcCall`（核心已接线），常规调用只计不落盘；
 * - 主线程阻塞：`monitorEventLoopDelay` 兜住所有没列白名单的同步阻塞；
 * - 内存尖峰：每分钟看一次，只在越限或快速上涨时记一条。
 *
 * 慢 SQL 的监听器为什么不在 apply 里挂：本扩展是独立 esbuild bundle，
 * `@mtbot/agent-runtime` 会被内联成**第二份模块实例**，`LocalDatabase` 在主进程 bundle 里
 * 读的是另一份，监听器写进去等于静默失效。接线放在 `main/index.ts` 的核心侧。
 *
 * 落盘 / 队列 / 轮转仍在 PerformanceMonitor 里。flush / cleanOldLogs / destroy 留在
 * performCleanup —— 那几步要在「其他服务都关完之后」执行，早于它们做会丢掉退出前最后一段数据。
 */
export const perfExtension = {
  manifest: {
    id: 'com.lumii.perf',
    name: '性能监控',
    version: '0.2.0',
    description: '慢 IPC、慢 SQL、主线程阻塞、内存尖峰与启动阶段',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    // 官方可选扩展：由 build-official-extensions.mjs 打包，启动时同步到 ~/.lumii/extensions
    origin: 'official' as const,
    main: './main.js',
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.perf',
    provides: ['perf'],
    apply(ctx) {
      const monitor = new PerformanceMonitor({
        enabled: true,
        ipcSlowThresholdMs: 200,
        memoryRssThresholdBytes: MEMORY_RSS_THRESHOLD_BYTES,
        memoryGrowthThresholdBytes: MEMORY_GROWTH_THRESHOLD_BYTES,
        memorySpikeCooldownMs: 5 * 60_000,
        maxQueueSize: 200,
        logDir: resolvePerfLogsDir(),
      })

      // ---- 主线程阻塞：1 秒上报一次，读这段时间里最大的那一次延迟 ----
      const loopDelay = monitorEventLoopDelay({ resolution: LOOP_DELAY_RESOLUTION_MS })
      loopDelay.enable()
      let lastReportAt = Date.now()
      const loopTimer = setInterval(() => {
        const lagMs = loopDelay.max / 1e6
        const now = Date.now()
        const windowStart = lastReportAt
        lastReportAt = now
        loopDelay.reset()
        if (lagMs < LOOP_LAG_THRESHOLD_MS) return
        const spans = getInflightSpans()
        // 栈上抓不到的（异步回调里的同步代码）：按时间窗回看刚结束的慢 SQL / 慢 IPC
        const suspects = findBlockingSuspects(windowStart, now)
        monitor.recordEvent({
          timestamp: now,
          kind: 'main.loop.lag',
          name: spans[spans.length - 1] ?? suspects[0]?.name ?? 'unknown',
          duration: Math.round(lagMs),
          detail: {
            ...(spans.length > 0 ? { inflight: spans.join(' > ') } : {}),
            ...(suspects.length > 0
              ? { suspects: suspects.slice(0, 3).map((s) => `${s.name}:${Math.round(s.durationMs)}ms`).join('; ') }
              : {}),
          },
        })
      }, 1000)

      // ---- 内存：只判断尖峰，不落常规读数 ----
      // 除了主进程自身，还要看**渲染进程**：2026-10-29 实测主窗口渲染进程工作集 1.33GB，
      // 而主进程 RSS 只有 488MB —— 只盯主进程会完全漏掉这个占用大头。
      const memoryTimer = setInterval(() => {
        const usage = process.memoryUsage()
        monitor.sampleMemory({ rss: usage.rss, heapUsed: usage.heapUsed })
        monitor.sampleChildProcesses(
          app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            rss: metric.memory.workingSetSize * 1024,
            privateBytes: (metric.memory.privateBytes ?? 0) * 1024,
          })),
        )
        void monitor.flush().catch((err) => {
          ctx.log.error('性能日志落盘失败', err)
        })
      }, MEMORY_SAMPLE_INTERVAL_MS)

      // 诊断 IPC 随扩展作用域挂载：停用即整批摘掉
      registerPerformanceIpc({ handle: (ch, fn) => ctx.registerIpc?.(ch, fn) }, () => monitor)

      ctx.effect(() => {
        clearInterval(loopTimer)
        clearInterval(memoryTimer)
        loopDelay.disable()
      })
      ctx.provide(S.perf, monitor)
      ctx.log.info('性能监控已启动（只记慢事件）')
    },
  }),
}

// 外部扩展加载器按 `export default { manifest, definition }` 读取；
// 内置导入仍用命名导出，两者可以共存。
export default perfExtension
