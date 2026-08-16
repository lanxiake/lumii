/**
 * AgentRuntimeBridge 生命周期与通知层
 *
 * 拆自 bridge.ts，封装：
 * - 实例销毁（destroy / destroyAll）
 * - 活动快照推送（pushActivitySnapshot）
 * - 最近活跃会话维护（setLastActiveConversation）
 * - 渲染进程通知（notifyIncomingMessage / notifyNavigateToSession / triggerCronNotification）
 * - Agent 定义缓存维护（syncUserAgentDefinitions / listCachedAgentDefinitions / removeCachedAgentDefinition / refreshCachedAgentDefinition）
 */

import {
  type AgentRegistry,
  type AgentDefinitionStore,
  type MessageBus,
  type AgentRuntimeEvent,
  type ConversationRepo,
  type AgentDefinition,
  type AgentRuntimeFeatureFlags,
  AgentOrchestrator,
  BUILT_IN_AGENTS,
  findBuiltInAgent,
} from '@mtbot/agent-runtime'
import type { InstanceState, InstanceStateStore } from './bridge-instance-state'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { PermissionController } from './permission-controller'
import type { AskUserQuestionController } from './ask-user-question-controller'
import type { CronScheduler } from './cron-scheduler'
import { agentRuntimeLog as log, CHILD_AGENT_DISALLOWED_TOOLS, findAgentInstanceByRecipient } from './bridge-utils'
import type { AgentLifecycleSnapshot } from './bridge-types'

export interface BridgeLifecycleDeps {
  agentRegistry: AgentRegistry
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  instanceToRootSessionKey: Map<string, string>
  getConversationRepo: () => ConversationRepo | null
  messageBus: MessageBus
  permissionController: PermissionController
  askUserQuestionController: AskUserQuestionController
  ipcChannel: BridgeRendererIpcChannel
  getCronScheduler: () => CronScheduler | undefined
  getDefinitionStore: () => AgentDefinitionStore | null
  toolStartTimeMap: Map<string, number>
  toolCallInstanceMap: Map<string, string>
  nodeStreamCallbacks: Map<string, (event: AgentRuntimeEvent) => void>
  /** 设置 lastActiveConvId */
  setLastActiveConvId: (key: string) => void
  /** 关闭数据库 + 重置 repos 等运行状态（destroyAll 的善后；orchestrator 由本类内部清理） */
  finalizeShutdown: () => void
  /** 系统级定时通知（来自 config.showCronNotification） */
  showCronNotification?: (title: string, body: string) => void
  /** 创建 Agent 实例（用于 orchestrator.createChildInstance 回调） */
  createInstance: (
    def: AgentDefinition,
    sessionKey?: string,
    conversationId?: string,
    opts?: { parentInstanceId?: string },
  ) => Promise<string>
  /** 发送消息（用于 orchestrator.prompt 回调） */
  prompt: (instanceId: string, message: string) => Promise<void>
  /** 读取当前 feature flags（主题5：VERDICT 消费 killswitch） */
  getFeatureFlags: () => AgentRuntimeFeatureFlags
}

export class BridgeLifecycle {
  private orchestrator: AgentOrchestrator | null = null
  /** 运行中被请求失效、已推迟到本轮结束再销毁的实例 */
  private readonly pendingInvalidation = new Set<string>()

  constructor(private readonly deps: BridgeLifecycleDeps) {}

  /**
   * 请求让实例失效（Provider 配置变更、MCP 工具列表变更等场景）。
   *
   * 运行中的实例**不能**立即销毁：destroy 会解绑事件订阅并把实例置为 destroyed，
   * pi-agent-core 的循环检测到后直接退出且不抛异常，工具结果再也回不到模型，
   * 表现为对话永久卡死。因此这里改为记账，等本轮跑完再销毁。
   *
   * @returns 'destroyed' 已立即销毁；'deferred' 实例运行中，已推迟
   */
  invalidate(instanceId: string): 'destroyed' | 'deferred' {
    if (this.deps.agentRegistry.get(instanceId)?.state === 'running') {
      this.pendingInvalidation.add(instanceId)
      log.info(`[invalidate] 实例 ${instanceId} 运行中，推迟到本轮结束后销毁`)
      return 'deferred'
    }
    this.destroy(instanceId)
    return 'destroyed'
  }

  /** 实例是否已被标记为待失效（尚未销毁） */
  isPendingInvalidation(instanceId: string): boolean {
    return this.pendingInvalidation.has(instanceId)
  }

  /**
   * 消费待失效标记：已标记则立即销毁，调用方随后按新配置重建实例。
   *
   * @returns 是否确实销毁了实例
   */
  consumePendingInvalidation(instanceId: string): boolean {
    if (!this.pendingInvalidation.has(instanceId)) return false
    log.info(`[consumePendingInvalidation] 销毁待失效实例 ${instanceId}，下次使用时按新配置重建`)
    this.destroy(instanceId)
    return true
  }

  /**
   * 运行中的实例被强制销毁时补发一条终止事件。
   *
   * 销毁会切断该实例的事件订阅，渲染侧再也收不到 turn:end / idle，
   * isStreaming 将永远停在 true（界面一直转圈）。这里显式推 agent:error 收尾。
   */
  private notifyRunTerminatedByDestroy(instanceId: string, state: InstanceState | undefined): void {
    const ctx = state?.ctx
    if (!ctx) return
    this.deps.ipcChannel.forwardIpcEvent({
      type: 'agent:error',
      runId: ctx.runId,
      sessionKey: ctx.rootSessionKey,
      errorCode: 'INSTANCE_DESTROYED',
      errorMessage:
        '本轮执行已被中止：运行期间 Agent 实例被重建（通常由模型配置或工具列表变更触发）。请重新发送消息。',
      isRetryable: true,
    })
    log.warn(
      `[destroy] 实例 ${instanceId} 在运行中被销毁，已补发 agent:error 收尾 runId=${ctx.runId}`,
    )
  }

  /** 删除所有以 `${instanceId}:` 开头的复合键条目 */
  private clearPrefixedMapEntries(map: Map<string, unknown>, instanceId: string): void {
    const prefix = `${instanceId}:`
    for (const key of map.keys()) {
      if (key.startsWith(prefix)) map.delete(key)
    }
  }

  /** 销毁实例 */
  destroy(instanceId: string): void {
    this.pendingInvalidation.delete(instanceId)
    const rootKey = this.deps.instanceToRootSessionKey.get(instanceId)
    const state = this.deps.instanceStates.get(instanceId)
    // 需在 agentRegistry.destroy 之前取，销毁后状态即变为 destroyed
    const wasRunning = this.deps.agentRegistry.get(instanceId)?.state === 'running'
    if (state?.proactivityScheduler) {
      state.proactivityScheduler.stop()
    }
    const streamMsgId = state?.streamingAssistantMsgId
    const convId = this.deps.instanceToConversation.get(instanceId)
    const conversationRepo = this.deps.getConversationRepo()
    if (streamMsgId && convId && conversationRepo) {
      try {
        conversationRepo.deleteMessage(streamMsgId, convId)
      } catch {
        // 忽略销毁时清理失败
      }
    }
    state?.unsubscribe?.()
    this.deps.messageBus.unregister(instanceId)
    this.deps.instanceToRootSessionKey.delete(instanceId)
    this.deps.instanceToConversation.delete(instanceId)
    this.deps.agentRegistry.destroy(instanceId)
    this.deps.instanceStates.delete(instanceId)
    this.clearPrefixedMapEntries(this.deps.toolStartTimeMap as Map<string, unknown>, instanceId)
    for (const [key, val] of this.deps.toolCallInstanceMap) {
      if (val === instanceId) this.deps.toolCallInstanceMap.delete(key)
    }
    this.deps.nodeStreamCallbacks.delete(instanceId)
    log.info(`Destroyed agent: ${instanceId}`)
    if (wasRunning) {
      this.notifyRunTerminatedByDestroy(instanceId, state)
    }
    if (rootKey) {
      this.pushActivitySnapshot(rootKey)
    }
  }

  /** 销毁所有实例并关闭数据库 */
  destroyAll(): void {
    this.deps.permissionController.clearAll()
    this.deps.askUserQuestionController.clearAll()

    log.info('[destroyAll] 开始销毁所有实例前，先最终确认所有流式消息')
    const conversationRepo = this.deps.getConversationRepo()
    if (conversationRepo) {
      const finalizedCount = conversationRepo.finalizeAllStreamingMessages()
      log.info(`[destroyAll] 已最终确认 ${finalizedCount} 条流式消息`)
    }

    try {
      for (const s of this.deps.instanceStates.values()) {
        s.proactivityScheduler?.stop()
        s.unsubscribe?.()
      }
      this.deps.agentRegistry.destroyAll()
      this.deps.instanceToConversation.clear()
      this.deps.toolCallInstanceMap.clear()
      for (const id of this.deps.instanceToRootSessionKey.keys()) {
        this.deps.messageBus.unregister(id)
      }
      this.deps.instanceToRootSessionKey.clear()
      this.deps.instanceStates.clear()
    } finally {
      this.orchestrator = null
      this.deps.finalizeShutdown()
    }
    this.deps.getCronScheduler()?.stop()
    log.info('All agent instances destroyed, database closed')
  }

  /** 惰性创建 AgentOrchestrator（依赖 definitionStore 与已注册的工具） */
  ensureOrchestrator(): AgentOrchestrator {
    if (!this.orchestrator) {
      this.orchestrator = new AgentOrchestrator(this.deps.agentRegistry, this.deps.messageBus, {
        resolveDefinition: async (typeKey) => {
          const store = this.deps.getDefinitionStore()
          if (store) {
            const d = await store.get(typeKey)
            if (d) return d
          }
          return findBuiltInAgent(typeKey) ?? BUILT_IN_AGENTS[0]!
        },
        createChildInstance: async (opts) => {
          const parentDisallowed = opts.definition.disallowedTools ?? []
          const childDisallowed = [
            ...parentDisallowed,
            ...CHILD_AGENT_DISALLOWED_TOOLS.filter((t) => !parentDisallowed.includes(t)),
          ]
          const childDef: AgentDefinition = {
            ...opts.definition,
            canSpawnSubAgents: false,
            disallowedTools: childDisallowed,
            ...(opts.allowedTools?.length ? {
              tools: (opts.allowedTools as string[]).filter(
                (t) => !CHILD_AGENT_DISALLOWED_TOOLS.includes(t),
              ),
            } : {}),
          }
          return this.deps.createInstance(childDef, opts.sessionKey, opts.conversationId, {
            parentInstanceId: opts.parentInstanceId,
          })
        },
        getConversationId: (instanceId) => this.deps.instanceToConversation.get(instanceId),
        prompt: (id, msg) => this.deps.prompt(id, msg),
        followUp: (id, msg) => {
          this.deps.agentRegistry.get(id)?.followUp(msg)
        },
        destroy: (id) => {
          this.destroy(id)
        },
        getInstance: (id) => this.deps.agentRegistry.get(id),
        findInstanceByRecipient: (to) => findAgentInstanceByRecipient(this.deps.agentRegistry.getAll(), to),
        getDisplayNameForInstance: (id) => {
          const inst = this.deps.agentRegistry.get(id)
          if (!inst) return id
          return findBuiltInAgent(inst.definitionId)?.name ?? inst.definitionId
        },
        isVerdictConsumptionEnabled: () => this.deps.getFeatureFlags().ENABLE_VERDICT_CONSUMPTION,
      })
    }
    return this.orchestrator
  }

  /** 按 Agent 定义 ID 聚合运行时快照 */
  getLifecycleSnapshot(definitionId: string): AgentLifecycleSnapshot {
    const instances = this.deps.agentRegistry.getByDefinitionId(definitionId)
    let totalTurns = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let runningCount = 0
    let runningSinceMin: number | null = null

    for (const inst of instances) {
      const m = this.deps.instanceStates.get(inst.id)?.metrics
      if (m) {
        totalTurns += m.completedTurns
        totalInputTokens += m.inputTokens
        totalOutputTokens += m.outputTokens
      }
      if (inst.state === 'running') {
        runningCount++
        const started = m?.runningStartedAt ?? null
        if (started != null && (runningSinceMin == null || started < runningSinceMin)) {
          runningSinceMin = started
        }
      }
    }

    let subAgentsRunning = 0
    for (const inst of this.deps.agentRegistry.getAll()) {
      if (inst.state !== 'running') continue
      const parentId = this.deps.agentRegistry.getParentId(inst.id)
      if (!parentId) continue
      const parent = this.deps.agentRegistry.get(parentId)
      if (parent?.definitionId === definitionId) {
        subAgentsRunning++
      }
    }

    return {
      definitionId,
      instanceCount: instances.length,
      runningCount,
      anyRunning: runningCount > 0,
      runningSinceMs: runningSinceMin,
      totalTurns,
      totalInputTokens,
      totalOutputTokens,
      subAgentsRunning,
    }
  }

  /** 推送当前对话下的活动 Agent 列表（主 + 子） */
  pushActivitySnapshot(rootSessionKey: string): void {
    const agents = this.deps.agentRegistry.getAll()
      .filter((inst) => this.deps.instanceToRootSessionKey.get(inst.id) === rootSessionKey)
      .map((inst) => ({
        instanceId: inst.id,
        name: findBuiltInAgent(inst.definitionId)?.name ?? inst.definitionId,
        state: inst.state,
        isSubAgent: Boolean(this.deps.agentRegistry.getParentId(inst.id)),
      }))
    this.deps.ipcChannel.forwardIpcEvent({
      type: 'agent:activity:snapshot',
      rootSessionKey,
      agents,
    })
  }

  /** 更新当前活跃会话 ID */
  setLastActiveConversation(sessionKey: string): void {
    const key = sessionKey.trim()
    if (!key) return
    this.deps.setLastActiveConvId(key)
  }

  /** 通知渲染进程：外部通道有用户消息进入 */
  notifyIncomingMessage(sessionKey: string, text: string, messageId?: string): void {
    const id = messageId ?? `incoming-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.deps.ipcChannel.forwardIpcEvent({
      type: 'conversation:message:new',
      sessionKey,
      message: {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      },
    })
    log.info(`[notifyIncomingMessage] 已推送用户消息到渲染进程: sessionKey=${sessionKey} textLen=${text.length}`)
  }

  /** 通知渲染进程：导航到指定会话 */
  notifyNavigateToSession(sessionKey: string, title?: string): void {
    this.deps.ipcChannel.forwardIpcEvent({
      type: 'conversation:navigate',
      sessionKey,
      title,
    } as import('../../shared/agent-runtime-events').AgentRuntimeEvent)
    log.info(`[notifyNavigateToSession] 已推送导航事件: sessionKey=${sessionKey}`)
  }

  /** 触发系统级 Cron 通知 */
  triggerCronNotification(title: string, body: string): void {
    if (this.deps.showCronNotification) {
      this.deps.showCronNotification(title, body)
      log.info(`[triggerCronNotification] 已发送系统通知 title="${title}" body="${body.slice(0, 60)}"`)
    } else {
      log.warn(`[triggerCronNotification] showCronNotification 未注入，通知丢失 body="${body.slice(0, 60)}"`)
    }
  }

  // ── Agent 定义缓存维护 ──

  async syncUserAgentDefinitions(): Promise<{ synced: number; failed: number }> {
    const store = this.deps.getDefinitionStore()
    if (!store) {
      throw new Error('AgentRuntimeBridge not initialized')
    }
    return store.syncUserAgents()
  }

  listCachedAgentDefinitions(): ReturnType<AgentDefinitionStore['listCachedRows']> {
    return this.deps.getDefinitionStore()?.listCachedRows() ?? []
  }

  removeCachedAgentDefinition(agentId: string): boolean {
    return this.deps.getDefinitionStore()?.removeCached(agentId) ?? false
  }

  async refreshCachedAgentDefinition(agentId: string): Promise<void> {
    await this.deps.getDefinitionStore()?.refreshOne(agentId)
  }
}
