import { createServiceKey } from '@mtbot/plugin-core'

import type { PerformanceMonitor } from '../perf/performance-monitor'
import type { UpdaterService } from '../updater-service'
import type { CloudSyncManager } from '../cloud-sync/sync-manager'
import type { SyncScheduler } from '../cloud-sync/sync-scheduler'
import type { AgentRuntimeBridge } from '../agent-runtime'

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
  /** 自动更新。宿主在窗口创建后调 setMainWindow。 */
  updater: createServiceKey<UpdaterService>('updater'),
  /** 云同步管理器。 */
  cloudSync: createServiceKey<CloudSyncManager>('cloudSync'),
  /** 云同步调度器。宿主在配置就绪后调 start()。 */
  syncScheduler: createServiceKey<SyncScheduler>('syncScheduler'),
  /**
   * Agent Runtime 的**延迟绑定 getter**。
   *
   * Agent Runtime 要到 S7 才创建，而扩展在 S1b 就激活——直接给实例会让
   * 早激活的扩展拿到 null 并且永远拿不到。给 getter，调用时才解析。
   */
  agentRuntime: createServiceKey<() => AgentRuntimeBridge | null>('agentRuntime'),
} as const
