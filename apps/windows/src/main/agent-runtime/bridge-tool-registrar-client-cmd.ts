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

  // session_compact — 压缩上下文
  const sessionCompactConfig: MtBotToolConfig = {
    ...sessionCompactToolConfig,
    execute: async (_id, rawParams) => {
      const { sessionKey, keepRecentTurns = 6 } = rawParams as { sessionKey: string; keepRecentTurns?: number }
      forwardIpcEvent({ type: 'session:compact-request', sessionKey, keepRecentTurns })
      return jsonToolResult({ ok: true, message: `已请求压缩会话 ${sessionKey}，保留最近 ${keepRecentTurns} 轮` })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sessionCompactConfig, ctx))

  // session_resume — 切换到指定会话
  const sessionResumeConfig: MtBotToolConfig = {
    ...sessionResumeToolConfig,
    execute: async (_id, rawParams) => {
      const { sessionKey } = rawParams as { sessionKey: string }
      forwardIpcEvent({ type: 'session:switch-request', sessionKey })
      return jsonToolResult({ ok: true, message: `已请求切换到会话 ${sessionKey}` })
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

  // memory_manage — 工作记忆单条增删改 + list/clear
  const resolveAgentId = (toolCallId: string): string => {
    const instanceId =
      deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
    return (instanceId && deps.getDefinitionIdByInstanceId(instanceId)) ?? 'default'
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
      }
      const memoryManager = getMemoryManager()
      if (!memoryManager) return jsonToolResult({ ok: false, message: 'memoryManager not initialized' })
      const agentId = resolveAgentId(toolCallId)
      const userId = 'local-user'

      switch (p.action) {
        case 'list': {
          const entries = memoryManager.listActive(agentId, userId)
          return jsonToolResult({
            ok: true,
            agentId,
            count: entries.length,
            entries: entries.map((e) => ({ id: e.id, category: e.category, content: e.content })),
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
