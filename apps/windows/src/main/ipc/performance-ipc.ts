import { ipcMain, shell } from 'electron'
import type { PerformanceMonitor } from '../perf/performance-monitor'
import { resolvePerfLogsDir } from '../paths'
import { createLogger } from '../logger'

const log = createLogger('ipc/performance')

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

  // 手动捕获一次内存快照
  ipcMain.handle('performance:capture', async () => {
    try {
      const memoryUsage = process.memoryUsage()
      performanceMonitor.recordMemorySnapshot({
        timestamp: Date.now(),
        kind: 'memory.snapshot',
        mainProcess: {
          heapUsed: memoryUsage.heapUsed,
          external: memoryUsage.external,
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
