/**
 * switchSession 独立实现：切换当前会话，内存已有消息则直接切换+刷新元数据，
 * 否则从 DB 加载历史并与最新内存状态合并（在 setState updater 内完成，避免竞态）。
 * 从 useAgentRuntimeActions 中整体提取——内部无跨 useCallback 闭包依赖，
 * 只使用模块级 store/常量/纯函数，可安全作为独立异步函数存在。
 */

import {
  runtimeStore,
  getDefaultPerSessionState,
  updateSessionState,
} from './agent-runtime-store'
import type { PerSessionState, RuntimeMessage, RuntimeToolCall, RuntimeFileEvent } from './agent-runtime-store'
import type { ContextUsageBreakdownEntry } from '../../../../shared/agent-runtime-events'
import { toRuntimeMsg, debugLog } from './bridge-init'
import { HISTORY_PAGE_SIZE, type DbMessagePage } from './useAgentRuntime.types'

type DbFileRow = {
  id: string; fileName: string; localPath: string; mimeType: string | null
  fileSize: number | null; conversationId: string | null; messageId: string | null
  agentId: string | null; channel: string; category: 'upload' | 'output'
}
type DbTaskRow = {
  id: string; subject: string; description: string | null; status: string; owner: string | null
}

/**
 * 判断会话是否仅由通道 notifyIncomingMessage 注入占位消息、尚未从 DB 加载首页历史。
 * 此类会话 memory 里可能只有 1 条 incoming-* 消息，但 DB 已有完整聊天记录。
 */
function sessionNeedsDbHydration(session: PerSessionState): boolean {
  if (session.messages.length === 0) return false
  if (session.historyPaging.hasMore || session.historyPaging.cursor !== null) return false
  return session.messages.some((m) => m.id.startsWith('incoming-'))
}

/**
 * 丢弃与 DB 已持久化用户消息重复的 incoming-* 占位气泡（通道 notify 与 saveMessage 双写）。
 */
function isIncomingPlaceholderDuplicateOfDb(
  memMsg: RuntimeMessage,
  dbMessages: readonly RuntimeMessage[],
): boolean {
  if (!memMsg.id.startsWith('incoming-') || memMsg.role !== 'user') return false
  const text = memMsg.content[0]?.type === 'text' ? memMsg.content[0].text : ''
  if (!text) return false
  return dbMessages.some((db) => {
    if (db.role !== 'user') return false
    const dbText = db.content[0]?.type === 'text' ? db.content[0].text : ''
    return dbText === text && Math.abs(db.timestamp - memMsg.timestamp) < 120_000
  })
}

/** 将 FileRepo 行转为 RuntimeFileEvent */
function toFileEvents(files: readonly DbFileRow[]): RuntimeFileEvent[] {
  return files.map((f) => ({
    fileId: f.id,
    fileName: f.fileName,
    localPath: f.localPath,
    mimeType: f.mimeType,
    fileSize: f.fileSize,
    conversationId: f.conversationId,
    messageId: f.messageId,
    agentId: f.agentId,
    channel: f.channel,
    category: f.category,
  }))
}

/**
 * 用 TaskRepo 权威任务列表注入一条合成 todo_write，供 TodoPanel 在重启后展示。
 * 追加到最后一条 assistant 消息，aggregateTasks 会以最后一个 tasks[] 为基线。
 */
function injectRestoredTasks(
  sessionKey: string,
  messages: RuntimeMessage[],
  tasks: readonly DbTaskRow[],
): RuntimeMessage[] {
  if (tasks.length === 0) return messages
  const synthetic: RuntimeToolCall = {
    id: '__restored_todo_' + sessionKey,
    name: 'todo_write',
    args: { action: 'list' },
    result: {
      action: 'list',
      status: 'ok',
      tasks: tasks.map((t) => ({
        id: t.id,
        subject: t.subject,
        description: t.description,
        status: t.status,
        owner: t.owner,
      })),
      total: tasks.length,
    },
    status: 'completed',
    isError: false,
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.role !== 'assistant') continue
    const withoutDup = (msg.toolCalls ?? []).filter((tc) => tc.id !== synthetic.id)
    const next = [...messages]
    next[i] = { ...msg, toolCalls: [...withoutDup, synthetic] }
    return next
  }
  return [
    ...messages,
    {
      id: '__restored_todo_msg_' + sessionKey,
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '' }],
      parts: [],
      timestamp: Date.now(),
      isStreaming: false,
      toolCalls: [synthetic],
    },
  ]
}

/**
 * 切换会话
 *
 * 多会话架构下，切换只需：
 * 1. 目标会话内存中已有消息（含后台路由的消息）→ 直接切换，但仍刷新 files/tasks
 * 2. 否则从 DB 加载历史，在 setState updater 内与最新内存状态合并（避免竞态）
 * 后台会话的事件已被持续路由到对应会话，无需缓存恢复。
 */
export async function switchSession(sessionKey: string, preferredModelId?: string): Promise<void> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) return

  // 切换前先 prime 模型偏好，确保 context-usage 返回正确的 contextWindow（而非 128K 默认值）
  if (preferredModelId) {
    await api.sendCommand({ type: 'session:preferredModel:set', sessionKey, modelId: preferredModelId }).catch(() => undefined)
  }

  /** 拉取会话关联的文件与任务（缓存命中与冷加载共用） */
  const fetchSessionMeta = async () => {
    const [dbFilesResult, dbTasksResult] = await Promise.all([
      api.sendCommand({
        type: 'files:list',
        userId: 'local-user',
        conversationId: sessionKey,
      }).catch((err) => {
        debugLog('[switchSession] files:list 失败 sessionKey=' + sessionKey, err)
        return null
      }) as Promise<{ files: readonly DbFileRow[]; total: number } | null>,
      api.sendCommand({
        type: 'tasks:list',
        conversationId: sessionKey,
      }).catch((err) => {
        debugLog('[switchSession] tasks:list 失败 sessionKey=' + sessionKey, err)
        return null
      }) as Promise<{ tasks: readonly DbTaskRow[] } | null>,
    ])
    return {
      fileEvents: toFileEvents(dbFilesResult?.files ?? []),
      tasks: dbTasksResult?.tasks ?? [],
    }
  }

  // 目标会话内存中已有消息 → 直接切换，但仍刷新 files/tasks
  const existingSession = runtimeStore.getState().sessions.get(sessionKey)
  if (existingSession && existingSession.messages.length > 0 && !sessionNeedsDbHydration(existingSession)) {
    runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: sessionKey }))
    try {
      const [contextUsage, meta] = await Promise.all([
        api.sendCommand({
          type: 'conversation:context-usage',
          sessionKey,
        }) as Promise<{
          usedTokens: number
          contextWindow: number
          triggerThreshold: number
          breakdown?: readonly ContextUsageBreakdownEntry[]
        }>,
        fetchSessionMeta(),
      ])
      updateSessionState(sessionKey, (prev) => {
        const ratio = contextUsage.contextWindow > 0
          ? contextUsage.usedTokens / contextUsage.contextWindow
          : 0
        const dbFileIds = new Set(meta.fileEvents.map((f) => f.fileId))
        const onlyInMem = prev.fileEvents.filter((f) => !dbFileIds.has(f.fileId))
        return {
          ...prev,
          messages: injectRestoredTasks(sessionKey, prev.messages as RuntimeMessage[], meta.tasks),
          fileEvents: [...meta.fileEvents, ...onlyInMem],
          contextUsage: {
            usedTokens: contextUsage.usedTokens,
            contextWindow: contextUsage.contextWindow,
            triggerThreshold: contextUsage.triggerThreshold,
            isNearThreshold: ratio > 0.6,
            ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
          },
        }
      })
    } catch (err) {
      debugLog('[switchSession] 刷新缓存会话元数据失败（已忽略） sessionKey=' + sessionKey, err)
    }
    debugLog('[switchSession] 切换到已缓存会话 sessionKey=' + sessionKey + ' msgs=' + existingSession.messages.length)
    return
  }

  // 先切当前会话，再去 DB 拉历史：useAgentRuntimeState 按 currentSessionKey 选消息，
  // 若等三个 IPC 都回来才切（原实现在末尾 setState），这段窗口里 UI 仍显示旧会话，
  // 期间发出的消息与回流的事件会落到「正在显示的会话」之外，表现为回复不渲染。
  // 与上面已缓存分支的顺序保持一致；末尾 setState 仍会再写一次，幂等。
  runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: sessionKey }))

  // 从 DB 加载目标会话历史（只取最新一页，更早的由上滑懒加载补齐）
  const [dbPage, meta, dbContextUsage] = await Promise.all([
    api.sendCommand({
      type: 'conversation:messages',
      sessionKey,
      limit: HISTORY_PAGE_SIZE,
    }) as Promise<DbMessagePage>,
    fetchSessionMeta(),
    api.sendCommand({
      type: 'conversation:context-usage',
      sessionKey,
    }).catch(() => null) as Promise<{
      usedTokens: number
      contextWindow: number
      triggerThreshold: number
      breakdown?: readonly ContextUsageBreakdownEntry[]
    } | null>,
  ])

  const dbFileEvents = meta.fileEvents
  debugLog('[switchSession] 加载历史文件/任务 sessionKey=' + sessionKey + ' files=' + dbFileEvents.length + ' tasks=' + meta.tasks.length)

  const dbMsgList: RuntimeMessage[] = injectRestoredTasks(sessionKey, dbPage.items.map(toRuntimeMsg), meta.tasks)
  const hasDbStreamingMsg = dbMsgList.some((m) => m.isStreaming)
  debugLog('[switchSession] 加载会话 sessionKey=' + sessionKey + ' dbMsgs=' + dbMsgList.length + ' hasDbStreamingMsg=' + hasDbStreamingMsg)

  /**
   * 合并逻辑放在 setState updater 内，确保基于写入时刻的最新内存状态做合并，
   * 消除 await 期间后台事件写入导致的竞态覆盖问题。
   */
  runtimeStore.setState((prev) => {
    const newSessions = new Map(prev.sessions)
    const latestMemSession = prev.sessions.get(sessionKey)
    const baseState = latestMemSession ?? getDefaultPerSessionState()

    let effectiveMessages: RuntimeMessage[] = dbMsgList
    let restoredIsStreaming = hasDbStreamingMsg
    let restoredActiveRunId: string | null = null
    let restoredCurrentTool: RuntimeToolCall | null = null

    if (latestMemSession && latestMemSession.messages.length > 0) {
      const dbMsgIds = new Set(dbMsgList.map((m) => m.id))
      const pendingMsgs = latestMemSession.messages.filter((m) => {
        if (dbMsgIds.has(m.id)) return false
        if (isIncomingPlaceholderDuplicateOfDb(m, dbMsgList)) return false
        return true
      })

      const mergedDbMsgs = dbMsgList.map((dbMsg) => {
        const memMsg = latestMemSession.messages.find((m) => m.id === dbMsg.id)
        if (!memMsg) return dbMsg
        // 流式中的内存 parts 比 DB 快照新，切换会话时必须保留时间线增量。
        if (memMsg.isStreaming && memMsg.parts.length > 0) {
          return {
            ...dbMsg,
            content: memMsg.content,
            parts: memMsg.parts,
            ...(memMsg.fileChanges ? { fileChanges: memMsg.fileChanges } : {}),
          }
        }
        const shouldOverlayToolCalls = (memMsg.toolCalls?.length ?? 0) > (dbMsg.toolCalls?.length ?? 0)
        if (!shouldOverlayToolCalls) return dbMsg
        return { ...dbMsg, toolCalls: memMsg.toolCalls }
      })

      if (pendingMsgs.length > 0) {
        effectiveMessages = injectRestoredTasks(sessionKey, [...mergedDbMsgs, ...pendingMsgs], meta.tasks)
        restoredActiveRunId = latestMemSession.activeRunId
        restoredIsStreaming = latestMemSession.isStreaming || hasDbStreamingMsg
        restoredCurrentTool = latestMemSession.currentTool
      } else {
        effectiveMessages = injectRestoredTasks(sessionKey, mergedDbMsgs, meta.tasks)
        restoredActiveRunId = hasDbStreamingMsg ? latestMemSession.activeRunId : null
        restoredIsStreaming = hasDbStreamingMsg
        restoredCurrentTool = hasDbStreamingMsg ? latestMemSession.currentTool : null
      }
      debugLog('[switchSession] 内存合并后 effectiveMsgs=' + effectiveMessages.length + ' restoredIsStreaming=' + restoredIsStreaming)
    }

    newSessions.set(sessionKey, {
      ...baseState,
      messages: effectiveMessages,
      historyPaging: {
        hasMore: dbPage.hasMore,
        isLoading: false,
        cursor: dbPage.nextCursor ?? null,
      },
      fileEvents: (() => {
        const memFileEvents = latestMemSession?.fileEvents ?? []
        const dbFileIds = new Set(dbFileEvents.map((f) => f.fileId))
        const onlyInMem = memFileEvents.filter((f) => !dbFileIds.has(f.fileId))
        return [...dbFileEvents, ...onlyInMem]
      })(),
      compactionEvents: [],
      activeAgents: [],
      error: null,
      activeRunId: restoredActiveRunId,
      isStreaming: restoredIsStreaming,
      currentTool: restoredCurrentTool,
      llmRouteStatus: 'healthy',
      llmRouteDetail: null,
      currentLlmModelId: null,
      ...(dbContextUsage ? {
        contextUsage: {
          usedTokens: dbContextUsage.usedTokens,
          contextWindow: dbContextUsage.contextWindow,
          triggerThreshold: dbContextUsage.triggerThreshold,
          isNearThreshold: dbContextUsage.contextWindow > 0
            ? dbContextUsage.usedTokens / dbContextUsage.contextWindow > 0.6
            : false,
          ...(dbContextUsage.breakdown ? { breakdown: dbContextUsage.breakdown } : {}),
        },
      } : {}),
    })
    return { ...prev, sessions: newSessions, currentSessionKey: sessionKey }
  })
}
