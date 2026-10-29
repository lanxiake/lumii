import type { PerfMonitorLike } from '../../shared/performance'
import { beginPerfSpan, endPerfSpan, recordBlockingSuspect } from '../../shared/performance'

/**
 * 包装一个 IPC handler，自动测量执行耗时并上报给 PerfMonitorLike。
 * 无论 handler 是同步还是异步、成功还是抛错，都会记录一次调用
 * （error=true 表示本次调用失败），耗时统计口径与 recordIpcCall 的
 * ipcSlowThresholdMs 判定保持一致。
 *
 * 同时把函数名压进「正在执行」栈、把结束时的耗时登记为「阻塞嫌疑」：
 * 主线程阻塞探针触发时靠这两样回答「卡在哪个入口」。栈放 shared 是为了让
 * perf 扩展读得到而不用反向 import 核心（守卫 ⑪/⑫）。
 *
 * 为什么要登记而不只靠栈：实测 156 条阻塞里只有 1 条触发时仍在栈上 —— 探针每秒
 * 才看一次，`await` 之后同步跑完的耗时早就出栈了。按时间窗回看才抓得住。
 */
export function createMeasuredHandler<TArgs extends unknown[], TResult>(
  channel: string,
  originalHandler: (...args: TArgs) => TResult | Promise<TResult>,
  monitor: PerfMonitorLike,
): (...args: TArgs) => Promise<TResult> {
  return async (...args: TArgs) => {
    beginPerfSpan(channel)
    const startTime = performance.now()

    try {
      const result = await originalHandler(...args)
      const duration = performance.now() - startTime

      monitor.recordIpcCall(channel, duration, false)
      recordBlockingSuspect(`ipc ${channel}`, duration)

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      monitor.recordIpcCall(channel, duration, true)
      recordBlockingSuspect(`ipc ${channel}`, duration)

      throw error
    } finally {
      endPerfSpan(channel)
    }
  }
}
