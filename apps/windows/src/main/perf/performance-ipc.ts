import type { PerformanceMonitor } from './performance-monitor'

/**
 * 包装一个 IPC handler，自动测量执行耗时并上报给 PerformanceMonitor。
 * 无论 handler 是同步还是异步、成功还是抛错，都会记录一次调用
 * （error=true 表示本次调用失败），耗时统计口径与 recordIpcCall 的
 * ipcSlowThresholdMs 判定保持一致。参数类型统一为 unknown[]：
 * IPC handler 的第一个参数是 Electron 的 IpcMainInvokeEvent，其余为
 * 渲染进程传入的业务参数，这里不区分类型，直接原样转发给原始 handler。
 */
export function createMeasuredHandler<TResult>(
  channel: string,
  originalHandler: (...args: unknown[]) => TResult | Promise<TResult>,
  monitor: PerformanceMonitor,
): (...args: unknown[]) => Promise<TResult> {
  return async (...args: unknown[]) => {
    const startTime = performance.now()

    try {
      const result = await originalHandler(...args)
      const duration = performance.now() - startTime

      monitor.recordIpcCall(channel, duration, false)

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      monitor.recordIpcCall(channel, duration, true)

      throw error
    }
  }
}
