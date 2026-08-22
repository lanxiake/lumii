import type { PerformanceMonitor } from './performance-monitor'

/**
 * 包装一个 IPC handler，自动测量执行耗时并上报给 PerformanceMonitor。
 * 无论 handler 是同步还是异步、成功还是抛错，都会记录一次调用
 * （error=true 表示本次调用失败），耗时统计口径与 recordIpcCall 的
 * ipcSlowThresholdMs 判定保持一致。参数类型用泛型 TArgs 透传，
 * 保留调用方原始 handler 的参数类型（包含 Electron 的 IpcMainInvokeEvent），
 * 而不是收窄成 unknown[] 破坏类型推断。
 */
export function createMeasuredHandler<TArgs extends unknown[], TResult>(
  channel: string,
  originalHandler: (...args: TArgs) => TResult | Promise<TResult>,
  monitor: PerformanceMonitor,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
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
