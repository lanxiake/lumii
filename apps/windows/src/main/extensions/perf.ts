import { app } from 'electron'
import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { PerformanceMonitor } from '../perf/performance-monitor'
import { resolvePerfLogsDir } from '../paths'

const MEMORY_SNAPSHOT_INTERVAL_MS = 60_000

/**
 * 性能监控扩展：IPC 耗时、慢调用、启动阶段、内存快照。
 *
 * 从 index.ts 的 initPerformanceMonitor() 迁来，行为不变。唯一的结构差异：
 * 定时器改由作用域持有（`ctx.effect`），禁用本扩展即自动停掉，不需要在
 * performCleanup 里单独 clearInterval。
 *
 * 注意：flush / cleanOldLogs / destroy 仍留在 performCleanup —— 那几步要在
 * 「其他服务都关完之后」执行，早于它们做会丢掉退出前最后一段数据。
 */
export const perfExtension = {
  manifest: {
    id: 'com.lumii.perf',
    name: '性能监控',
    version: '0.1.0',
    description: 'IPC 耗时、慢调用、启动阶段与内存快照',
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
        memorySnapshotIntervalMs: MEMORY_SNAPSHOT_INTERVAL_MS,
        maxQueueSize: 200,
        logDir: resolvePerfLogsDir(),
      })

      const timer = setInterval(() => {
        const memoryUsage = process.memoryUsage()
        monitor.recordMemorySnapshot({
          timestamp: Date.now(),
          kind: 'memory.snapshot',
          mainProcess: {
            heapUsed: memoryUsage.heapUsed,
            heapTotal: memoryUsage.heapTotal,
            external: memoryUsage.external,
            arrayBuffers: memoryUsage.arrayBuffers,
            rss: memoryUsage.rss,
          },
          childProcesses: app.getAppMetrics().map(metric => ({
            pid: metric.pid,
            type: metric.type,
            workingSetSize: metric.memory.workingSetSize,
            privateBytes: metric.memory.privateBytes ?? 0,
          })),
        })
        void monitor.flush().catch(err => {
          ctx.log.error('性能日志落盘失败', err)
        })
      }, MEMORY_SNAPSHOT_INTERVAL_MS)

      ctx.effect(() => clearInterval(timer))
      ctx.provide(S.perf, monitor)
      ctx.log.info('性能监控已启动')
    },
  }),
}

// 外部扩展加载器按 `export default { manifest, definition }` 读取；
// 内置导入仍用命名导出，两者可以共存。
export default perfExtension
