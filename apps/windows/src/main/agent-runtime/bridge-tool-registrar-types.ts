/**
 * BridgeToolRegistrar 依赖类型定义
 *
 * 从 bridge-tool-registrar.ts 抽离，供各 register* 拆分文件共享引用。
 */

import type {
  ToolRegistry,
  AgentDefinitionStore,
  AgentOrchestrator,
  TaskRepo,
  MemoryManager,
  ConversationRepo,
  LocalDatabase,
  ToolExecutionContext,
  AgentRuntimeFeatureFlags,
  WikiRepo,
  WikiIngestHook,
} from '@mtbot/agent-runtime'
import type { AgentRuntimeBridgeConfig } from './bridge-types'
import type { InstanceStateStore } from './bridge-instance-state'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { CronScheduler } from './cron-scheduler'

/**
 * 微信会话上下文（与 AgentRuntimeBridge 共享）
 */
export interface WeixinCtxAccessor {
  /** 读取当前活跃的微信会话上下文 */
  getCurrent: () => { channelUserId: string; contextToken: string; botToken?: string; ilinkBaseUrl?: string } | null
  /** 标记本轮已通过 message 工具发送微信消息 */
  markSentViaTool: () => void
}

/**
 * 注册器依赖集合。所有字段都是只读引用，注册器不创建/销毁这些对象。
 */
export interface BridgeToolRegistrarDeps {
  toolRegistry: ToolRegistry
  toolContext: ToolExecutionContext
  config: AgentRuntimeBridgeConfig
  /** 惰性获取 cronScheduler（构造注册器时调度器可能尚未初始化，工具运行时再取） */
  getCronScheduler: () => CronScheduler
  localDb: LocalDatabase
  getTaskRepo: () => TaskRepo | null
  getMemoryManager: () => MemoryManager | null
  getConversationRepo: () => ConversationRepo | null
  getWikiRepo: () => WikiRepo | null
  getWikiIngestHook: () => WikiIngestHook | null
  /** 读取当前 feature flags（主题5：verification-nudge / task_complete 门禁 killswitch） */
  getFeatureFlags: () => AgentRuntimeFeatureFlags
  ipcChannel: BridgeRendererIpcChannel
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  /** 当前正在执行工具的 instance ID（来自 bridge.currentToolExecutorInstanceId） */
  getCurrentToolExecutorInstanceId: () => string | undefined
  /** 由 instanceId 解析 Agent 定义 ID（= 工作记忆的 agentId），用于 memory_manage 精确命中 */
  getDefinitionIdByInstanceId: (instanceId: string) => string | undefined
  toolCallInstanceMap: Map<string, string>
  getDefinitionStore: () => AgentDefinitionStore | null
  /** 惰性获取 orchestrator（首次调用时创建） */
  ensureOrchestrator: () => AgentOrchestrator
  /** 微信会话上下文访问器（message 工具用） */
  weixinCtx: WeixinCtxAccessor
  /** 惰性获取渠道出站 Router（channel_list / channel_send） */
  getChannelRouter: () => import('../channel/channel-outbound-router').ChannelOutboundRouter | null
  /** 图片生成（image_generate 工具用） */
  generateImage: (params: {
    prompt: string
    modelId?: string
    width?: number
    height?: number
    filename?: string
    referenceImagePaths?: string[]
    signal?: AbortSignal
  }) => Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }>
}
