/**
 * useAgentRuntime — React Hook for Agent Runtime 多会话状态管理
 *
 * 使用 useSyncExternalStore + 外部 Store 模式替代旧版 useState。
 * 支持切片订阅，避免不必要的 re-render。
 * 每个会话独立维护状态，会话切换只需更新 currentSessionKey，
 * 后台会话事件持续路由到对应会话，不再丢失。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §5
 */

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { PerSessionState, MultiSessionRuntimeState, RuntimeMessage } from './agent-runtime-store'
import {
  runtimeStore,
  getDefaultPerSessionState,
  updateSessionState,
  findAnyPendingPermission,
  getPendingPermissionSnapshot,
  type PendingPermissionSnapshot,
} from './agent-runtime-store'
import type {
  ContextUsageBreakdownEntry,
} from '../../../../shared/agent-runtime-events'
import { isCommandError } from '../../../../shared/agent-runtime-commands'
import { debugLog, ensureIpcEventListener, sleep, LIST_NOT_READY_RETRY_MS, LIST_NOT_READY_MAX_ATTEMPTS } from './bridge-init'
import { switchSession as switchSessionImpl } from './switch-session'
import { HISTORY_PAGE_SIZE, type DbMessagePage } from './useAgentRuntime.types'
import { toRuntimeMsg } from './bridge-init'

// ============================================================
// 状态 Hook
// ============================================================

/**
 * 订阅当前会话的 Agent Runtime 状态切片
 *
 * 参考 Claude Code useAppState(selector) 模式:
 * - 使用 useSyncExternalStore 避免 tearing
 * - selector 通过 ref 稳定引用，避免内联 selector 每次渲染重建 get 函数
 * - 自动从当前 currentSessionKey 对应的会话读取状态
 *
 * @example
 * ```tsx
 * const messages = useAgentRuntimeState(s => s.messages)
 * const isThinking = useAgentRuntimeState(s => s.isThinking)
 * ```
 */
export function useAgentRuntimeState<T>(
  selector: (state: PerSessionState) => T,
): T {
  // 用 ref 持有最新 selector，避免内联箭头函数每次渲染产生新引用导致 get 频繁重建
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  // get 函数引用稳定（不依赖 selector），useSyncExternalStore 不会因 selector 变化重新订阅
  const get = useCallback(() => {
    const globalState = runtimeStore.getState()
    const sessionKey = globalState.currentSessionKey
    const sessionState = sessionKey ? globalState.sessions.get(sessionKey) : null
    return selectorRef.current(sessionState ?? getDefaultPerSessionState())
  }, [])

  return useSyncExternalStore(runtimeStore.subscribe, get, get)
}

/**
 * 订阅任意会话中的待处理权限请求（含后台频道会话）。
 * 解决「当前 UI 会话与 Agent 运行会话不一致时权限弹窗不显示」的问题。
 */
export function useAnyPendingPermission(): PendingPermissionSnapshot {
  const get = useCallback(() => getPendingPermissionSnapshot(), [])
  return useSyncExternalStore(runtimeStore.subscribe, get, get)
}

/**
 * 订阅全局 Agent Runtime 状态切片（非会话级）
 *
 * 用于读取 currentSessionKey、sessions Map 等全局属性。
 *
 * @example
 * ```tsx
 * const currentSessionKey = useAgentRuntimeGlobalState(s => s.currentSessionKey)
 * ```
 */
export function useAgentRuntimeGlobalState<T>(
  selector: (state: MultiSessionRuntimeState) => T,
): T {
  const selectorRef = useRef(selector)
  selectorRef.current = selector

  const get = useCallback(() => selectorRef.current(runtimeStore.getState()), [])
  return useSyncExternalStore(runtimeStore.subscribe, get, get)
}

// ============================================================
// 操作 Hook
// ============================================================

/**
 * 获取 Agent Runtime 操作方法
 *
 * 返回稳定引用，不会触发 re-render。
 * IPC 事件由模块级单例订阅（ensureIpcEventListener），生命周期独立于组件。
 * 多会话架构下，所有事件都被路由到对应会话，无需手动维护会话缓存。
 */
export function useAgentRuntimeActions() {
  // 确保全局 IPC 监听器已建立（幂等）
  ensureIpcEventListener()

  const sendMessage = useCallback(
    async (
      content: string,
      options?: {
        sessionKey?: string
        agentId?: string
        modelId?: string
        /**
         * 图片附件 workspace 绝对路径列表。
         * 仅当 selectedModel 支持多模态视觉输入时传入，主进程会读盘转 base64 注入 LLM。
         */
        imageAttachmentPaths?: readonly string[]
      },
    ) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) {
        throw new Error('Agent Runtime new protocol not available')
      }

      const sessionKey = options?.sessionKey ?? runtimeStore.getState().currentSessionKey
      if (!sessionKey) {
        throw new Error('No active session. Create a session first.')
      }

      // 生成稳定消息 ID，确保落库后 ID 与本地一致，切换会话不重复
      const msgId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // 先将用户消息追加到对应会话的 Store
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        messages: [
          ...prev.messages,
          {
            id: msgId,
            role: 'user' as const,
            content: [{ type: 'text' as const, text: content }],
            parts: [],
            timestamp: Date.now(),
            isStreaming: false,
            toolCalls: [],
          },
        ],
      }))

      const result = await api.sendCommand({
        type: 'user:send',
        sessionKey,
        content,
        agentId: options?.agentId,
        modelId: options?.modelId,
        msgId,
        imageAttachmentPaths: options?.imageAttachmentPaths,
      }) as { runId: string }

      return result.runId
    },
    [],
  )

  const steer = useCallback(async (steerText: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    const globalState = runtimeStore.getState()
    const sessionKey = globalState.currentSessionKey
    if (!sessionKey) return
    const sessionState = globalState.sessions.get(sessionKey)
    const activeRunId = sessionState?.activeRunId ?? null
    if (!activeRunId) return
    // 确保 isStreaming 保持 true，防止 steer 条因短暂 false 而收起
    updateSessionState(sessionKey, (prev) => ({ ...prev, isStreaming: true }))
    await api.sendCommand({ type: 'user:steer', runId: activeRunId, steerText })
  }, [])

  const abort = useCallback(async () => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return

    const globalState = runtimeStore.getState()
    const sessionKey = globalState.currentSessionKey
    if (!sessionKey) return
    const sessionState = globalState.sessions.get(sessionKey)
    const runId = sessionState?.activeRunId ?? null

    // 先本地收敛 UI，避免等待 IPC 事件期间仍显示“流式中”
    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      isStreaming: false,
      isThinking: false,
      currentTool: null,
      activeRunId: null,
      messages: prev.messages.map((msg) =>
        msg.isStreaming ? { ...msg, isStreaming: false } : msg
      ),
    }))

    await api.sendCommand({ type: 'user:abort', ...(runId ? { runId } : {}), sessionKey })
  }, [])

  const respondPermission = useCallback(
    async (decision: 'allow-once' | 'allow-always' | 'deny') => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return

      const found = findAnyPendingPermission(runtimeStore.getState())
      if (!found) return
      const { sessionKey, pending } = found
      await api.sendCommand({
        type: 'user:permission:respond',
        requestId: pending.requestId,
        decision,
      })
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        pendingPermission: null,
      }))
    },
    [],
  )

  /**
   * 提交 ask_user_question Modal 的用户答案
   *
   * @param payload - `answers` 必填，可选 `annotations` / `declined`
   *                  `answers` key = 问题文本；value = 答案字符串（多选逗号拼接；"Other" 时为自定义文本）
   */
  const respondAskUser = useCallback(
    async (payload: {
      answers: Record<string, string>
      annotations?: Record<string, { preview?: string; notes?: string }>
      declined?: boolean
    }) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return

      const globalState = runtimeStore.getState()
      const sessionKey = globalState.currentSessionKey
      if (!sessionKey) return
      const sessionState = globalState.sessions.get(sessionKey)
      const pending = sessionState?.pendingAskUser ?? null
      if (!pending) return

      await api.sendCommand({
        type: 'user:ask-user:respond',
        requestId: pending.requestId,
        answers: payload.answers,
        annotations: payload.annotations,
        declined: payload.declined,
      })
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        pendingAskUser: null,
      }))
    },
    [],
  )

  const createSession = useCallback(
    async (title?: string, agentId?: string, selectedModelId?: string) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) {
        throw new Error('Agent Runtime new protocol not available')
      }

      const result = await api.sendCommand({
        type: 'conversation:create',
        title,
        agentId,
        selectedModelId,
      })

      if (isCommandError(result) || !(result as { sessionKey?: string }).sessionKey) {
        const errMsg = isCommandError(result) ? result.error : 'sessionKey 缺失'
        throw new Error(`创建会话失败: ${errMsg}`)
      }

      const newSessionKey = (result as { sessionKey: string }).sessionKey

      // 初始化新会话状态，并切换当前会话
      runtimeStore.setState((prev) => {
        const newSessions = new Map(prev.sessions)
        newSessions.set(newSessionKey, getDefaultPerSessionState())
        return {
          ...prev,
          sessions: newSessions,
          currentSessionKey: newSessionKey,
        }
      })

      return newSessionKey
    },
    [],
  )

  /**
   * 拉取侧栏会话列表：数据**仅来自客户端本地 SQLite**（`conversation:list` → 主进程 `listConversations`），
   * 不经由网关或远程同步；若主进程尚未挂接 Bridge，IPC 会返回 `NOT_READY`，此处对 `NOT_READY` 做有限次重试。
   */
  const listSessions = useCallback(async (): Promise<readonly { sessionKey: string; title: string; updatedAt: string; agentId?: string; lastMessagePreview?: string; hasRunning?: boolean; isPinned?: boolean; wasInterrupted?: boolean }[]> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return []

    for (let attempt = 0; attempt < LIST_NOT_READY_MAX_ATTEMPTS; attempt++) {
      try {
        const result = await api.sendCommand({ type: 'conversation:list' })

        if (isCommandError(result)) {
          const code = typeof result.error === 'string' ? result.error : ''
          if (code === 'NOT_READY' && attempt < LIST_NOT_READY_MAX_ATTEMPTS - 1) {
            debugLog('[useAgentRuntime] conversation:list NOT_READY，等待主进程挂接 Bridge，重试', attempt + 1)
            await sleep(LIST_NOT_READY_RETRY_MS)
            continue
          }
          console.warn('[useAgentRuntime] conversation:list 返回错误', result)
          return []
        }

        if (!Array.isArray(result)) {
          console.warn('[useAgentRuntime] conversation:list 返回非数组，已忽略', typeof result, result)
          return []
        }

        const rows = (result as readonly { id: string; sessionKey: string; title: string; updatedAt: string; agentId?: string; lastMessagePreview?: string; hasRunning?: boolean; isPinned?: boolean; wasInterrupted?: boolean }[]).filter(
          (s) => s.sessionKey,
        )
        debugLog('[useAgentRuntime] conversation:list 条数=', rows.length)
        return rows
      } catch (err) {
        if (attempt < LIST_NOT_READY_MAX_ATTEMPTS - 1) {
          debugLog('[useAgentRuntime] conversation:list 异常，重试', attempt + 1, err)
          await sleep(LIST_NOT_READY_RETRY_MS)
          continue
        }
        console.warn('[useAgentRuntime] conversation:list 调用异常', err)
        return []
      }
    }
    return []
  }, [])

  /**
   * 切换会话
   *
   * 多会话架构下，切换只需：
   * 1. 目标会话内存中已有消息（含后台路由的消息）→ 直接切换，但仍刷新 files/tasks
   * 2. 否则从 DB 加载历史，在 setState updater 内与最新内存状态合并（避免竞态）
   * 后台会话的事件已被持续路由到对应会话，无需缓存恢复。
   */
  const switchSession = useCallback(switchSessionImpl, [])

  /**
   * 上滑懒加载更早的历史消息，把结果前插到会话消息列表。
   *
   * 上下文压缩不再删除消息，历史可以很长；首屏只加载最新一页，
   * 用户往上翻时按游标继续取。并发调用与「已到顶」都会被短路。
   */
  const loadOlderMessages = useCallback(async (sessionKey: string): Promise<void> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return

    const paging = runtimeStore.getState().sessions.get(sessionKey)?.historyPaging
    if (!paging || !paging.hasMore || paging.isLoading || !paging.cursor) return

    const cursor = paging.cursor
    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      historyPaging: { ...prev.historyPaging, isLoading: true },
    }))

    try {
      const page = (await api.sendCommand({
        type: 'conversation:messages',
        sessionKey,
        limit: HISTORY_PAGE_SIZE,
        before: cursor,
      })) as DbMessagePage

      updateSessionState(sessionKey, (prev) => {
        const knownIds = new Set(prev.messages.map((m) => m.id))
        // 并发写入（流式新消息、事件回填）可能已插入同 id 消息，前插时去重
        const older = page.items
          .filter((msg) => !knownIds.has(msg.id))
          .map(toRuntimeMsg)
        return {
          ...prev,
          messages: older.length > 0 ? [...older, ...prev.messages] : prev.messages,
          historyPaging: {
            hasMore: page.hasMore,
            isLoading: false,
            cursor: page.nextCursor ?? prev.historyPaging.cursor,
          },
        }
      })
      debugLog(
        '[loadOlderMessages] sessionKey=' + sessionKey + ' loaded=' + page.items.length + ' hasMore=' + page.hasMore,
      )
    } catch (err) {
      debugLog('[loadOlderMessages] 加载更早历史失败 sessionKey=' + sessionKey, err)
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        historyPaging: { ...prev.historyPaging, isLoading: false },
      }))
    }
  }, [])

  /**
   * 删除当前会话中的一条消息（本地 SQLite + 内存状态）。
   * 若未传 sessionKey，默认使用 currentSessionKey。
   */
  const deleteMessage = useCallback(async (messageId: string, options?: { sessionKey?: string }) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) {
      throw new Error('Agent Runtime new protocol not available')
    }
    const sessionKey = options?.sessionKey ?? runtimeStore.getState().currentSessionKey
    if (!sessionKey) {
      throw new Error('No active session. Cannot delete message.')
    }

    await api.sendCommand({
      type: 'message:delete',
      messageId,
      sessionKey,
    })

    // 本地立即同步 UI，避免等待会话重载
    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      messages: prev.messages.filter((m) => m.id !== messageId),
    }))
  }, [])

  const editMessage = useCallback(async (messageId: string, newContent: string, options?: { sessionKey?: string }) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) throw new Error('Agent Runtime new protocol not available')
    const sessionKey = options?.sessionKey ?? runtimeStore.getState().currentSessionKey
    if (!sessionKey) throw new Error('No active session.')

    await api.sendCommand({ type: 'message:edit', messageId, sessionKey, newContent })

    updateSessionState(sessionKey, (prev) => ({
      ...prev,
      messages: prev.messages.map((m) =>
        m.id === messageId
          ? { ...m, content: [{ type: 'text' as const, text: newContent }] }
          : m,
      ),
    }))
  }, [])

  /**
   * 基于当前历史创建新对话分支（「编辑并新建对话」选项）。
   * 复制 sourceSessionKey 中 uptoMessageId 之前的历史，追加编辑后内容，返回新 sessionKey。
   */
  const forkConversation = useCallback(async (
    sourceSessionKey: string,
    uptoMessageId: string,
    newContent: string,
  ): Promise<string> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) throw new Error('Agent Runtime not available')
    const result = await api.sendCommand({
      type: 'conversation:fork',
      sourceSessionKey,
      uptoMessageId,
      newContent,
    }) as { success: boolean; sessionKey?: string; error?: string }
    if (!result.success || !result.sessionKey) {
      throw new Error(result.error ?? 'fork failed')
    }
    return result.sessionKey
  }, [])

  /**
   * 编辑用户消息并重新触发回答（「删后续重答」选项）。
   * 删除该消息之后的所有消息，更新内容，重发给 Agent。
   */
  const editAndResend = useCallback(async (
    messageId: string,
    newContent: string,
    options?: { sessionKey?: string },
  ): Promise<void> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) throw new Error('Agent Runtime not available')
    const sessionKey = options?.sessionKey ?? runtimeStore.getState().currentSessionKey
    if (!sessionKey) throw new Error('No active session.')

    // 本地 store 先行清理：只保留该消息及其之前的内容，其余清除（Agent 回复会重新 push）。
    // 必须在 sendCommand 之前执行——主进程 message:edit-and-resend 会 await bridge.prompt(...)，
    // 即命令要等整轮新回复生成完才 resolve；若把清理放在 await 之后，流式新回复会先填入气泡，
    // 随后的 slice 又把刚生成的新回复一并删掉（问题3 误删根因）。
    updateSessionState(sessionKey, (prev) => {
      const idx = prev.messages.findIndex((m) => m.id === messageId)
      if (idx === -1) return prev
      const kept = prev.messages.slice(0, idx + 1).map((m) =>
        m.id === messageId
          ? { ...m, content: [{ type: 'text' as const, text: newContent }] }
          : m,
      )
      return { ...prev, messages: kept }
    })

    await api.sendCommand({ type: 'message:edit-and-resend', sessionKey, messageId, newContent })
  }, [])

  /**
   * 删除指定会话（本地 SQLite + 内存状态）。
   */
  /**
   * 同步 GET /api/config/models 拉平后的能力到主进程（上下文压缩、用量条）
   */
  const syncModelCatalog = useCallback(
    async (entries: readonly { id: string; contextWindow?: number; maxTokens?: number }[]) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand || entries.length === 0) return
      await api.sendCommand({ type: 'runtime:modelCatalog:set', entries })
    },
    [],
  )

  /**
   * 将主进程返回的上下文用量写入会话 store
   */
  const applyContextUsage = useCallback(
    (
      sessionKey: string,
      raw: {
        usedTokens: number
        contextWindow: number
        triggerThreshold: number
        breakdown?: readonly ContextUsageBreakdownEntry[]
      },
    ) => {
      const ratio = raw.contextWindow > 0 ? raw.usedTokens / raw.contextWindow : 0
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        contextUsage: {
          usedTokens: raw.usedTokens,
          contextWindow: raw.contextWindow,
          triggerThreshold: raw.triggerThreshold,
          isNearThreshold: ratio > 0.6,
          ...(raw.breakdown ? { breakdown: raw.breakdown } : {}),
        },
        isAutoCompacting: ratio >= raw.triggerThreshold,
      }))
    },
    [],
  )

  /**
   * 拉取并刷新指定会话的上下文用量（模型切换 / 目录同步后调用）
   */
  const refreshContextUsage = useCallback(
    async (sessionKey: string) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand || !sessionKey) return
      try {
        const usage = await api.sendCommand({
          type: 'conversation:context-usage',
          sessionKey,
        }) as {
          usedTokens: number
          contextWindow: number
          triggerThreshold: number
          breakdown?: readonly ContextUsageBreakdownEntry[]
        }
        applyContextUsage(sessionKey, usage)
      } catch (err) {
        debugLog(`[refreshContextUsage] 失败 sessionKey=${sessionKey}`, err)
      }
    },
    [applyContextUsage],
  )

  /**
   * 更新当前会话的模型偏好（下拉切换时，无需等待发送）
   */
  const setSessionPreferredModel = useCallback(async (sessionKey: string, modelId: string | undefined) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    const usage = await api.sendCommand({
      type: 'session:preferredModel:set',
      sessionKey,
      modelId,
    }) as { usedTokens: number; contextWindow: number; triggerThreshold: number }
    applyContextUsage(sessionKey, usage)
  }, [applyContextUsage])

  /**
   * 更新当前会话的思考模式与推理强度
   */
  const setSessionThinkingPrefs = useCallback(
    async (
      sessionKey: string,
      patch: { thinkingEnabled?: boolean; reasoningEffort?: 'high' | 'max' },
    ) => {
      const api = window.electronAPI?.agentRuntime
      if (!api?.sendCommand) return
      await api.sendCommand({
        type: 'session:thinkingPrefs:set',
        sessionKey,
        ...patch,
      })
    },
    [],
  )

  const deleteSession = useCallback(async (sessionKey: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) {
      throw new Error('Agent Runtime new protocol not available')
    }

    // 调用主进程删除会话
    await api.sendCommand({
      type: 'conversation:delete',
      sessionKey,
    })

    // 本地立即从内存中移除该会话
    const globalState = runtimeStore.getState()
    const newSessions = new Map(globalState.sessions)
    newSessions.delete(sessionKey)
    
    runtimeStore.setState((prev) => ({
      ...prev,
      sessions: newSessions,
      // 如果删除的是当前会话，清空当前会话状态
      currentSessionKey: prev.currentSessionKey === sessionKey ? null : prev.currentSessionKey,
    }))
  }, [])

  const renameSession = useCallback(async (sessionKey: string, newTitle: string): Promise<void> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    await api.sendCommand({ type: 'conversation:rename', sessionKey, newTitle })
  }, [])

  const pinSession = useCallback(async (sessionKey: string): Promise<boolean> => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return false
    const result = await api.sendCommand({ type: 'conversation:pin-toggle', sessionKey })
    return (result as { isPinned: boolean }).isPinned
  }, [])

  // 所有方法均为稳定 useCallback；用 useMemo 包裹返回对象，保证 identity 稳定，
  // 避免消费方（如 PetModeShell mount 副作用）因每次渲染拿到新对象而反复执行。
  return useMemo(
    () => ({
      sendMessage,
      steer,
      abort,
      respondPermission,
      respondAskUser,
      createSession,
      syncModelCatalog,
      setSessionPreferredModel,
      setSessionThinkingPrefs,
      refreshContextUsage,
      switchSession,
      loadOlderMessages,
      listSessions,
      deleteMessage,
      editMessage,
      forkConversation,
      editAndResend,
      deleteSession,
      renameSession,
      pinSession,
    }),
    [
      sendMessage,
      steer,
      abort,
      respondPermission,
      respondAskUser,
      createSession,
      syncModelCatalog,
      setSessionPreferredModel,
      setSessionThinkingPrefs,
      refreshContextUsage,
      switchSession,
      loadOlderMessages,
      listSessions,
      deleteMessage,
      editMessage,
      forkConversation,
      editAndResend,
      deleteSession,
      renameSession,
      pinSession,
    ],
  )
}

// ============================================================
// 一体化 Hook
// ============================================================

/**
 * 一体化 Hook — 同时获取当前会话状态和操作
 *
 * 适用于需要同时读写的组件。
 * 注意：每个 useAgentRuntimeState 调用都是独立的订阅，
 * 消息列表变化不会导致 isThinking 的消费组件 re-render。
 */
export function useAgentRuntime() {
  const messages = useAgentRuntimeState((s) => s.messages)
  const isThinking = useAgentRuntimeState((s) => s.isThinking)
  const currentTool = useAgentRuntimeState((s) => s.currentTool)
  const { pending: pendingPermission } = useAnyPendingPermission()
  const isStreaming = useAgentRuntimeState((s) => s.isStreaming)
  const error = useAgentRuntimeState((s) => s.error)
  const actions = useAgentRuntimeActions()

  return {
    messages,
    isThinking,
    currentTool,
    pendingPermission,
    isStreaming,
    error,
    ...actions,
  }
}
