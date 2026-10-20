import { createServiceKey } from '@mtbot/plugin-core'

import type { PerformanceMonitor } from '../perf/performance-monitor'

/**
 * 主进程服务 key 表：类型的单一来源。
 *
 * 用一张表而不是 declaration merging —— 表能被 grep 到、能被守卫扫到，
 * 而分散在各模块的 `declare module` 会悄悄漂移。
 *
 * 约定：**拿到服务 ≠ 能改它的状态**。扩展只应该用这里的服务做它需要的那部分事。
 */
export const S = {
  /** 性能监控。扩展可以 recordMetric/recordStartupPhase，内部队列不对外开放。 */
  perf: createServiceKey<PerformanceMonitor>('perf'),
} as const
