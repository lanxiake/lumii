import { createServiceKey } from '@mtbot/plugin-core'

import type { BrowserWindow } from 'electron'

import type { PerformanceMonitor } from '../perf/performance-monitor'
import type { UpdaterService } from '../updater-service'
import type { ScreenRecordService } from '../screen-record'
import type { TrayManager } from '../tray-manager'
import type { VoiceCallService } from '../voice/voice-service'
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
/**
 * 延迟引用的容器。
 *
 * **不能用 `provide(key, () => x)`**：`ServiceContainer` 把函数值当工厂，
 * 首次 get 就求值并缓存——那样拿到的是「第一次调用那一刻的值」，之后永远不变
 * （实测：主窗口 getter 被缓存成 null，录屏扩展始终等不到窗口）。
 * 显式包一层对象，`get()` 每次现取。
 */
export interface LateRef<T> {
  get(): T | null
}

export const S = {
  /** 性能监控。扩展可以 recordMetric/recordStartupPhase，内部队列不对外开放。 */
  perf: createServiceKey<PerformanceMonitor>('perf'),
  /** 自动更新。宿主在窗口创建后调 setMainWindow。 */
  updater: createServiceKey<UpdaterService>('updater'),
  /** 云同步管理器。 */
  cloudSync: createServiceKey<CloudSyncManager>('cloudSync'),
  /** 云同步调度器。宿主在配置就绪后调 start()。 */
  syncScheduler: createServiceKey<SyncScheduler>('syncScheduler'),
  /** Agent Runtime（S7 才创建，扩展在 S1 就要能引用） */
  agentRuntime: createServiceKey<LateRef<AgentRuntimeBridge>>('agentRuntime'),
  /** 主窗口（S2–S5 才创建） */
  mainWindow: createServiceKey<LateRef<BrowserWindow>>('mainWindow'),
  /** 托盘（S2–S5 才创建） */
  tray: createServiceKey<LateRef<TrayManager>>('tray'),
  /** 语音服务（S7 才创建） */
  voice: createServiceKey<LateRef<VoiceCallService>>('voice'),
  /** 录屏服务（扩展提供；窗口就绪后才创建） */
  screenRecord: createServiceKey<ScreenRecordService>('screenRecord'),
} as const
