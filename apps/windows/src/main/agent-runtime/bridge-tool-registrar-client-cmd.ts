/**
 * 客户端命令工具（斜杠命令的 Agent 可调用版本）与 Agent 团队管理工具
 * （生成/优化/移除自定义 Agent）。
 *
 * 从 bridge-tool-registrar.ts 抽离，纯函数式注册，仅依赖注入的 deps。
 */

import {
  createMtBotTool,
  type MtBotToolConfig,
  type ToolExecutionContext,
  sessionCreateToolConfig,
  sessionClearToolConfig,
  sessionCompactToolConfig,
  sessionResumeToolConfig,
  sessionListToolConfig,
  settingsThinkToolConfig,
  settingsBackendToolConfig,
  infoStatusToolConfig,
  memoryManageToolConfig,
  agentTeamGenerateToolConfig,
  agentTeamOptimizeToolConfig,
  agentRemoveToolConfig,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'
import { buildSessionListRows, SESSION_SCAN_LIMIT } from './session-list-rows'
import { getChannelAdapter } from '../channel/channel-adapter-registry'

/** 本地单用户标识（与 bridge-conversation-manager 的用法一致） */
const LOCAL_USER_ID = 'local-user'

/**
 * 反查本轮消息的来源渠道，用于把会话切换落到正确的渠道 adapter 上。
 *
 * 走 instance 的 presence 而不是 sessionKey 前缀：跨渠道接续之后 sessionKey 属于
 * 目标会话（可能是客户端或另一个渠道的），从它反推出来的是「会话归属」而不是
 * 「这条消息从哪来」——而该改的是后者。
 *
 * channel_send 省略 channel/to 时也走这里取默认值（replyTo 是回信地址，
 * 群聊里与 channelUserId 不同）。导出供 bridge-tool-registrar-integration 复用。
 */
export function resolveOriginChannel(
  deps: BridgeToolRegistrarDeps,
  toolCallId: string,
): { channelType: string; channelUserId: string; channelLabel: string; replyTo: string | null } | null {
  const instanceId = deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
  if (!instanceId) return null
  const presence = deps.instanceStates.get(instanceId)?.presence
  // ipc = 用户在客户端，本来就没有渠道路由要改
  if (!presence?.channelType || !presence.channelUserId || presence.channelType === 'ipc') return null
  return {
    channelType: presence.channelType,
    channelUserId: presence.channelUserId,
    channelLabel: presence.channelLabel ?? presence.channelType,
    replyTo: presence.replyTo ?? null,
  }
}

/** 注册客户端命令工具（斜杠命令的 Agent 可调用版本） */
export function registerClientCommandTools(deps: BridgeToolRegistrarDeps, ctx: ToolExecutionContext): void {
  const ipcChannel = deps.ipcChannel
  const forwardIpcEvent = ipcChannel.forwardIpcEvent.bind(ipcChannel)
  const getConversationRepo = deps.getConversationRepo
  const getMemoryManager = deps.getMemoryManager

  // session_create — 通知渲染进程新建会话
  const sessionCreateConfig: MtBotToolConfig = {
    ...sessionCreateToolConfig,
    execute: async () => {
      forwardIpcEvent({ type: 'session:create-request' })
      return jsonToolResult({ ok: true, message: '已请求创建新会话' })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionCreateConfig, ctx))

  // session_clear — 删除指定会话的所有消息
  const sessionClearConfig: MtBotToolConfig = {
    ...sessionClearToolConfig,
    execute: async (_id, rawParams) => {
      const { sessionKey } = rawParams as { sessionKey: string }
      const conversationRepo = getConversationRepo()
      if (!conversationRepo) return jsonToolResult({ ok: false, message: 'conversationRepo not initialized' })
      const messages = conversationRepo.loadRecentMessages(sessionKey, 5000)
      for (const msg of messages) {
        conversationRepo.deleteMessage(msg.id, sessionKey)
      }
      forwardIpcEvent({ type: 'session:cleared', sessionKey })
      return jsonToolResult({ ok: true, deletedCount: messages.length })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionClearConfig, ctx))

  // session_compact — 直接在主进程压缩。
  // 原实现只发 session:compact-request 事件，而渲染层无人监听该事件（真正的手动压缩
  // 走 user:compact-context），于是工具回 ok 却什么都没发生；渠道场景更是连窗口都没有。
  const sessionCompactConfig: MtBotToolConfig = {
    ...sessionCompactToolConfig,
    execute: async (toolCallId, rawParams) => {
      const { sessionKey, keepRecentTurns = 6 } = rawParams as { sessionKey?: string; keepRecentTurns?: number }
      // 缺省压缩当前会话：模型手里本来就没有别的 key，强迫它填只会诱发编造
      const target =
        sessionKey?.trim() ||
        (() => {
          const instanceId = deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
          return instanceId ? deps.instanceToConversation.get(instanceId) : undefined
        })()
      if (!target) {
        return jsonToolResult({ ok: false, message: '未指定会话，且无法确定当前会话（可用 session_list 查看）。' })
      }

      const result = await deps.compactSession(target, keepRecentTurns)
      if (!result.success) {
        return jsonToolResult({ ok: false, message: result.error ?? `压缩失败：${target}` })
      }
      // 压缩已完成；这条事件只用来让渲染层把视图刷新成压缩后的样子，没有窗口时静默丢弃
      forwardIpcEvent({ type: 'session:compact-request', sessionKey: target, keepRecentTurns })
      return jsonToolResult({
        ok: true,
        sessionKey: target,
        messagesRemoved: result.messagesRemoved,
        hadSummary: result.hadSummary,
        message:
          result.messagesRemoved > 0
            ? `已压缩会话，移出 ${result.messagesRemoved} 条较早的消息${result.hadSummary ? '（并生成摘要）' : ''}。`
            : '当前没有可压缩的消息。',
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionCompactConfig, ctx))

  // session_list — 列出最近会话（含来源渠道与当前会话标记），供模型挑一个再切
  const sessionListConfig: MtBotToolConfig = {
    ...sessionListToolConfig,
    execute: async (toolCallId, rawParams) => {
      const { query, limit } = rawParams as { query?: string; limit?: number }
      const conversationRepo = getConversationRepo()
      if (!conversationRepo) return jsonToolResult({ ok: false, message: 'conversationRepo not initialized' })

      const instanceId = deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
      const currentSessionKey = instanceId ? deps.instanceToConversation.get(instanceId) : undefined

      const sessions = buildSessionListRows(
        conversationRepo.listActiveConversations(LOCAL_USER_ID, SESSION_SCAN_LIMIT),
        { keyword: query, limit, currentSessionKey },
      )

      return jsonToolResult({
        ok: true,
        count: sessions.length,
        currentSessionKey: currentSessionKey ?? null,
        sessions,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionListConfig, ctx))

  // session_resume — 切换到指定会话（客户端界面 + 渠道消息路由）
  const sessionResumeConfig: MtBotToolConfig = {
    ...sessionResumeToolConfig,
    execute: async (toolCallId, rawParams) => {
      const { sessionKey } = rawParams as { sessionKey: string }
      const target = String(sessionKey ?? '').trim()
      if (!target) return jsonToolResult({ ok: false, message: 'sessionKey is required' })

      const conversationRepo = getConversationRepo()
      const conv = conversationRepo?.getConversation(target)
      if (!conv) {
        return jsonToolResult({
          ok: false,
          message: `会话不存在：${target}。请先用 session_list 查看可切换的会话。`,
        })
      }
      const title = conv.title ?? target

      // 客户端界面切过去（原有行为）
      forwardIpcEvent({ type: 'session:switch-request', sessionKey: target })

      // 来源是聊天渠道时，还要把该渠道后续消息路由到目标会话 ——
      // 只发上面的 IPC 事件的话，用户在微信里说「切到 X」只有客户端切了，
      // 下一条微信消息仍旧回到原会话。
      const origin = resolveOriginChannel(deps, toolCallId)
      if (!origin) {
        return jsonToolResult({ ok: true, sessionKey: target, title, message: `已切换到会话「${title}」。` })
      }

      const adapter = getChannelAdapter(origin.channelType)
      if (!adapter?.setActiveSessionKey) {
        return jsonToolResult({
          ok: true,
          sessionKey: target,
          title,
          message: `客户端已切到会话「${title}」，但${origin.channelLabel}当前不可路由，该渠道后续消息可能仍在原会话。`,
        })
      }

      adapter.setActiveSessionKey(origin.channelUserId, target, 'resume')
      log.info(
        `[session_resume] 渠道路由已切换 channel=${origin.channelType} user=${origin.channelUserId} → ${target}`,
      )
      return jsonToolResult({
        ok: true,
        sessionKey: target,
        title,
        message: `已切换到会话「${title}」。后续来自${origin.channelLabel}的消息将进入该会话。`,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionResumeConfig, ctx))

  // settings_think — 设置思考级别
  const settingsThinkConfig: MtBotToolConfig = {
    ...settingsThinkToolConfig,
    execute: async (_id, rawParams) => {
      const { level } = rawParams as { level: string }
      forwardIpcEvent({ type: 'settings:think-level', level })
      return jsonToolResult({ ok: true, level })
    },
  }
  deps.toolRegistry.register(createMtBotTool(settingsThinkConfig, ctx))

  // settings_backend — 切换 ACP 后端
  const settingsBackendConfig: MtBotToolConfig = {
    ...settingsBackendToolConfig,
    execute: async (_id, rawParams) => {
      const { backendId } = rawParams as { backendId: string }
      if (deps.config.setAcpBackend) {
        const result = await deps.config.setAcpBackend(backendId)
        if (!result.ok) return jsonToolResult({ ok: false, error: result.error })
      }
      forwardIpcEvent({ type: 'settings:backend-changed', backendId })
      return jsonToolResult({ ok: true, backendId })
    },
  }
  deps.toolRegistry.register(createMtBotTool(settingsBackendConfig, ctx))

  // info_status — 查询会话状态
  const infoStatusConfig: MtBotToolConfig = {
    ...infoStatusToolConfig,
    execute: async (_id, rawParams) => {
      const { sessionKey } = rawParams as { sessionKey: string }
      const conversationRepo = getConversationRepo()
      if (!conversationRepo) return jsonToolResult({ ok: false, message: 'conversationRepo not initialized' })
      const messages = conversationRepo.loadRecentMessages(sessionKey, 5000)
      const conv = conversationRepo.getConversation(sessionKey)
      return jsonToolResult({
        ok: true,
        sessionKey,
        messageCount: messages.length,
        title: conv?.title ?? null,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(infoStatusConfig, ctx))

  // memory_manage — 工作记忆单条增删改 + list/window/clear
  const resolveInstanceId = (toolCallId: string): string | undefined =>
    deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
  const resolveAgentId = (toolCallId: string): string => {
    const instanceId = resolveInstanceId(toolCallId)
    return (instanceId && deps.getDefinitionIdByInstanceId(instanceId)) ?? 'default'
  }
  /**
   * 读作用域：definition 设 memory.readView === "user" 的 Agent（汇总型，如 chronicler）
   * 跨 Agent 读取该用户的记忆——它的素材本就来自其他 Agent 的工作痕迹；
   * 其余 Agent 缺省只读自己写的。写操作一律按 agentId 归属（读共享、写归属）。
   */
  const resolveReadScope = (toolCallId: string): 'agent' | 'user' => {
    const instanceId = resolveInstanceId(toolCallId)
    return instanceId ? deps.getMemoryReadScopeByInstanceId(instanceId) : 'agent'
  }
  const memoryManageConfig: MtBotToolConfig = {
    ...memoryManageToolConfig,
    execute: async (toolCallId, rawParams) => {
      const p = rawParams as {
        action: string
        id?: string
        content?: string
        category?: 'project' | 'reference' | 'general'
        importance?: number
        days?: number
        since?: string
        limit?: number
        offset?: number
      }
      const memoryManager = getMemoryManager()
      if (!memoryManager) return jsonToolResult({ ok: false, message: 'memoryManager not initialized' })
      const agentId = resolveAgentId(toolCallId)
      const readScope = resolveReadScope(toolCallId)
      const userId = 'local-user'

      switch (p.action) {
        case 'list': {
          const entries =
            readScope === 'user'
              ? memoryManager.listActiveAllAgents(userId)
              : memoryManager.listActive(agentId, userId)
          return jsonToolResult({
            ok: true,
            agentId,
            scope: readScope,
            count: entries.length,
            entries: entries.map((e) => ({
              id: e.id,
              agent_id: e.agent_id,
              category: e.category,
              content: e.content,
            })),
          })
        }
        case 'window': {
          // 时间窗全量枚举：分页、不叠加条数上限、不经相关性门控。
          // 供日报/周复盘取「自上次 daily 以来」「最近 N 天」的低 importance 当日条目。
          const since =
            (p.since ?? '').trim() ||
            new Date(Date.now() - Math.max(0.01, p.days ?? 1) * 86_400_000).toISOString()
          const { entries, total, hasMore } = memoryManager.listByWindow({
            userId,
            agentId,
            scope: readScope,
            since,
            limit: p.limit,
            offset: p.offset,
          })
          return jsonToolResult({
            ok: true,
            agentId,
            scope: readScope,
            since,
            total,
            count: entries.length,
            hasMore,
            entries: entries.map((e) => ({
              id: e.id,
              // 汇总型 Agent 靠它区分「这条工作是谁记的」；同用户下来源 Agent 不同但服务同一个用户
              agent_id: e.agent_id,
              category: e.category,
              importance: e.importance,
              created_at: e.created_at,
              last_used: e.last_used,
              content: e.content,
            })),
          })
        }
        case 'add': {
          const content = (p.content ?? '').trim()
          if (!content) return jsonToolResult({ ok: false, message: 'content is required for add' })
          const entry = memoryManager.addMemory({
            agentId,
            userId,
            category: p.category ?? 'general',
            content,
            importance: p.importance,
          })
          return jsonToolResult({ ok: true, id: entry.id, category: entry.category })
        }
        case 'update': {
          const id = (p.id ?? '').trim()
          const content = (p.content ?? '').trim()
          if (!id) return jsonToolResult({ ok: false, message: 'id is required for update' })
          if (!content) return jsonToolResult({ ok: false, message: 'content is required for update' })
          memoryManager.updateMemory(id, content)
          return jsonToolResult({ ok: true, id })
        }
        case 'delete': {
          const id = (p.id ?? '').trim()
          if (!id) return jsonToolResult({ ok: false, message: 'id is required for delete' })
          memoryManager.deleteMemory(id)
          return jsonToolResult({ ok: true, id })
        }
        case 'archive': {
          const id = (p.id ?? '').trim()
          if (!id) return jsonToolResult({ ok: false, message: 'id is required for archive' })
          memoryManager.archiveMemory(id)
          return jsonToolResult({ ok: true, id })
        }
        case 'clear': {
          const deletedCount = memoryManager.clearAllForAgent(agentId, userId)
          return jsonToolResult({ ok: true, agentId, deletedCount })
        }
        default:
          return jsonToolResult({ ok: false, message: `unknown action: ${p.action}` })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(memoryManageConfig, ctx))

  log.info('[registerClientCommandTools] client command tools registered')
}

/** 注册 Agent 团队管理工具（生成/优化/移除自定义 Agent） */
export function registerAgentManagementTools(deps: BridgeToolRegistrarDeps, ctx: ToolExecutionContext): void {
  // agent_team_generate — 批量 fork 系统 Agent 创建团队
  const agentTeamGenerateConfig: MtBotToolConfig = {
    ...agentTeamGenerateToolConfig,
    execute: async (_id, rawParams) => {
      const { agents } = rawParams as {
        teamDescription: string
        agents: Array<{ systemAgentId: string; name: string; description?: string }>
      }
      if (!deps.config.forkAgent) return jsonToolResult({ ok: false, error: 'forkAgent not configured' })
      const results: Array<{ name: string; agentId?: string; ok: boolean; error?: string }> = []
      for (const agent of agents) {
        const res = await deps.config.forkAgent(agent.systemAgentId, {
          name: agent.name,
          description: agent.description,
        })
        results.push({ name: agent.name, agentId: res.agentId, ok: res.ok, error: res.error })
      }
      const succeeded = results.filter(r => r.ok).length
      deps.ipcChannel.forwardIpcEvent({ type: 'agent:team:generated', agents: results })
      return jsonToolResult({ ok: true, created: succeeded, total: agents.length, results })
    },
  }
  deps.toolRegistry.register(createMtBotTool(agentTeamGenerateConfig, ctx))

  // agent_team_optimize — 批量更新 Agent 配置
  const agentTeamOptimizeConfig: MtBotToolConfig = {
    ...agentTeamOptimizeToolConfig,
    execute: async (_id, rawParams) => {
      const { agentUpdates, reason } = rawParams as {
        agentUpdates: Array<{ agentId: string; name?: string; description?: string; soulContent?: string }>
        reason?: string
      }
      if (!deps.config.updateAgent) return jsonToolResult({ ok: false, error: 'updateAgent not configured' })
      const results: Array<{ agentId: string; ok: boolean; error?: string }> = []
      for (const update of agentUpdates) {
        const { agentId, ...data } = update
        const res = await deps.config.updateAgent(agentId, data as Record<string, unknown>)
        results.push({ agentId, ok: res.ok, error: res.error })
      }
      const succeeded = results.filter(r => r.ok).length
      deps.ipcChannel.forwardIpcEvent({ type: 'agent:team:optimized', agentIds: results.filter(r => r.ok).map(r => r.agentId) })
      return jsonToolResult({ ok: true, updated: succeeded, total: agentUpdates.length, reason, results })
    },
  }
  deps.toolRegistry.register(createMtBotTool(agentTeamOptimizeConfig, ctx))

  // agent_remove — 删除自定义 Agent
  const agentRemoveConfig: MtBotToolConfig = {
    ...agentRemoveToolConfig,
    execute: async (_id, rawParams) => {
      const { agentId, agentName } = rawParams as { agentId: string; agentName?: string }
      if (!deps.config.deleteAgent) return jsonToolResult({ ok: false, error: 'deleteAgent not configured' })
      const res = await deps.config.deleteAgent(agentId)
      if (res.ok) {
        deps.ipcChannel.forwardIpcEvent({ type: 'agent:removed', agentId })
      }
      return jsonToolResult({ ok: res.ok, agentId, agentName, error: res.error })
    },
  }
  deps.toolRegistry.register(createMtBotTool(agentRemoveConfig, ctx))

  log.info('[registerAgentManagementTools] agent management tools registered')
}
