import { createServiceKey } from '@mtbot/plugin-core'

import type { BrowserWindow } from 'electron'

import type { PerformanceMonitor } from '../perf/performance-monitor'
import type { UpdaterService } from '../updater-service'
import type { ScreenRecordService } from '../screen-record'
import type { TrayManager } from '../tray-manager'
import type { VoiceCallService } from '../../plugins/builtin/voice/voice-service'
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
  /** 工作空间目录（S6 才解析出来；用 LateRef 现取，别缓存成启动那一刻的值） */
  workspaceDir: createServiceKey<LateRef<string>>('workspaceDir'),
  /** 渠道出站 Hub（S1 建，Provider 由各渠道插件装配时注册） */
  channelHub: createServiceKey<LateRef<import('../channel/channel-hub-bootstrap').ChannelHub>>('channelHub'),
  /** 托盘（S2–S5 才创建） */
  tray: createServiceKey<LateRef<TrayManager>>('tray'),
  /** 语音服务（由 extensions/voice.ts 在窗口就绪后提供） */
  voice: createServiceKey<VoiceCallService>('voice'),
  /**
   * 系统提示词风格（实验功能插件提供）。停用后核心读不到 ⇒ 回落默认档。
   * 类型用结构化的最小面，避免核心反向 import 插件实现。
   */
  promptStyle: createServiceKey<{ get(): Promise<{ style: 'detailed' | 'terse' | 'minimal' }> }>('promptStyle'),
  /** 跨渠道会话接续（插件提供；停用后核心按「功能关闭」处理） */
  channelContinuity: createServiceKey<import('../channel/continuity-accessor').ChannelContinuityService>('channelContinuity'),
  /** 自主进化（插件提供；停用后核心拿不到 ⇒ 心跳/规划/反馈全部 no-op） */
  autonomous: createServiceKey<import('../../plugins/builtin/autonomous/service').AutonomousService>('autonomous'),
  /** 应用配置（部分插件 IPC 需要写 app.json） */
  /** 用量查询（插件提供；停用后 query 不可用） */
  usage: createServiceKey<import('../../plugins/builtin/usage/service-api').UsageService>('usage'),
  /** 技能进化（插件默认停用 ⇒ 服务不存在 ⇒ 注入跳过） */
  skillEvolution: createServiceKey<import('../../plugins/builtin/skill-evolution/service-api').SkillEvolutionService>('skillEvolution'),
  /** 浏览器控制（插件提供；停用后启动/停止/取上下文全部 no-op） */
  browser: createServiceKey<import('../../plugins/builtin/browser/service-api').BrowserService>('browser'),
  config: createServiceKey<LateRef<import('../config-manager').ConfigManager>>('config'),
  /** 录屏服务（扩展提供；窗口就绪后才创建） */
  screenRecord: createServiceKey<ScreenRecordService>('screenRecord'),
} as const
