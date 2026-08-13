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
import type { PerSessionState, MultiSessionRuntimeState, RuntimeMessage, RuntimeToolCall, RuntimeFileEvent } from './agent-runtime-store'
import {
  runtimeStore,
  getDefaultPerSessionState,
  updateSessionState,
  findAnyPendingPermission,
  getPendingPermissionSnapshot,
  type PendingPermissionSnapshot,
} from './agent-runtime-store'
import { handleRuntimeEvent } from './event-handler'
import type {
  AgentRuntimeEvent,
  ContextUsageBreakdownEntry,
} from '../../../../shared/agent-runtime-events'
import { isCommandError } from '../../../../shared/agent-runtime-commands'
import {
  parseMessageContentJson,
  type AssistantPart,
  type FileChangeEntry,
} from '@mtbot/agent-runtime/browser'

/** 仅在开发环境输出详细日志，避免生产环境噪音 */
const debugLog = process.env.NODE_ENV === 'development'
  ? (...args: unknown[]) => console.log(...args)
  : () => undefined

// ============================================================
// 模块级 IPC 事件订阅（独立于 React 组件生命周期）
//
// 将 onEvent 订阅提升至模块级单例，确保即使 ChatPage 卸载
// （用户切换菜单），事件处理仍持续运行，不会丢失
// agent:turn:end / agent:error 等终止事件，避免 isStreaming 永久为 true。
// ============================================================

let _ipcEventUnsubscribe: (() => void) | null = null

/**
 * 全局单例键：防止 HMR / 多模块实例导致 onEvent 重复注册，
 * 出现同一事件被消费多次（文本重复拼接）。
 */
const GLOBAL_ON_EVENT_UNSUB_KEY = '__mtbot_agent_runtime_on_event_unsub__'

/** 补偿 runtime:ping 的定时器重试句柄（主进程 bridge 晚于首次 ping 挂接时需持续探测） */
let _pingRetryTimer: ReturnType<typeof setTimeout> | null = null

/** 每次 ping 间隔（ms）；与主进程 initAgentRuntime 可能耗时数秒相匹配 */
const PING_RETRY_MS = 2000

/** 最多重试次数（约 30s），避免永久轮询 */
const PING_MAX_ATTEMPTS = 15

/** `conversation:list` 在主进程尚未 `setAgentRuntimeBridgeForIpc` 时返回 NOT_READY，与 ping 使用相同间隔重试 */
const LIST_NOT_READY_RETRY_MS = 2000

/** 会话列表拉取最多等待约 30s（与 PING_MAX_ATTEMPTS 量级一致） */
const LIST_NOT_READY_MAX_ATTEMPTS = 15

/**
 * Promise 延迟（用于 NOT_READY 重试间隔）
 *
 * @param ms - 毫秒
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 停止 runtime:ping 补偿轮询（HMR 或已成功就绪时调用）
 */
function clearPingRetryTimer(): void {
  if (_pingRetryTimer != null) {
    clearTimeout(_pingRetryTimer)
    _pingRetryTimer = null
  }
}

/**
 * 在 bridge 已挂接且能响应 IPC 时，用合成 runtime:ready 对齐状态。
 * 用于：主进程在渲染进程注册 onEvent 之前已发出 runtime:ready（事件被丢弃）、或首次 ping 返回 NOT_READY。
 */
function applySyntheticRuntimeReadyIfPingOk(result: unknown): boolean {
  if (result && typeof result === 'object' && 'ok' in result && (result as { ok: boolean }).ok) {
    handleRuntimeEvent({ type: 'runtime:ready', timestamp: Date.now() })
    return true
  }
  return false
}

/**
 * 带重试的 bridge 就绪探测：直到 ping 成功、store 已从事件变为 isReady、或超出次数。
 *
 * @param api - preload 暴露的 agentRuntime API
 * @param attempt - 当前尝试序号（从 0 起）
 */
function tryPingBridgeUntilReady(
  api: NonNullable<typeof window.electronAPI>['agentRuntime'],
  attempt: number,
): void {
  if (runtimeStore.getState().isReady) {
    clearPingRetryTimer()
    return
  }
  if (!api.sendCommand) {
    clearPingRetryTimer()
    return
  }
  if (attempt >= PING_MAX_ATTEMPTS) {
    clearPingRetryTimer()
    debugLog('[useAgentRuntime] runtime:ping 已达最大重试次数，仍依赖后续 runtime:ready 事件')
    return
  }

  void api
    .sendCommand({ type: 'runtime:ping' })
    .then((result) => {
      if (runtimeStore.getState().isReady) {
        clearPingRetryTimer()
        return
      }
      if (applySyntheticRuntimeReadyIfPingOk(result)) {
        clearPingRetryTimer()
        return
      }
      _pingRetryTimer = setTimeout(() => {
        _pingRetryTimer = null
        tryPingBridgeUntilReady(api, attempt + 1)
      }, PING_RETRY_MS)
    })
    .catch(() => {
      if (runtimeStore.getState().isReady) {
        clearPingRetryTimer()
        return
      }
      _pingRetryTimer = setTimeout(() => {
        _pingRetryTimer = null
        tryPingBridgeUntilReady(api, attempt + 1)
      }, PING_RETRY_MS)
    })
}

/**
 * 初始化全局 IPC 事件监听器（幂等，多次调用安全）。
 * 由 useAgentRuntimeActions 在首次调用时触发。
 */
function ensureIpcEventListener(): void {
  const globalObj = globalThis as typeof globalThis & {
    [GLOBAL_ON_EVENT_UNSUB_KEY]?: (() => void) | null
  }

  // 进程级单例：若已注册则直接复用，避免重复监听
  if (globalObj[GLOBAL_ON_EVENT_UNSUB_KEY]) {
    _ipcEventUnsubscribe = globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] ?? null
    return
  }

  if (_ipcEventUnsubscribe) {
    return
  }
  console.log('[useAgentRuntime] ensureIpcEventListener: 首次注册')
  const api = window.electronAPI?.agentRuntime
  if (!api?.onEvent) return

  _ipcEventUnsubscribe = api.onEvent((rawEvent: unknown) => {
    if (
      rawEvent &&
      typeof rawEvent === 'object' &&
      'type' in rawEvent
    ) {
      const evtType = (rawEvent as { type?: string }).type
      if (evtType && !evtType.endsWith(':delta') && !evtType.includes('thinking')) {
        debugLog('[useAgentRuntime] onEvent received type:', evtType)
      }
      handleRuntimeEvent(rawEvent as AgentRuntimeEvent)
    }
  })
  globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] = _ipcEventUnsubscribe

  // 监听器刚建立时，bridge 可能已经就绪（runtime:ready 在监听前发出）。
  // 单次 ping 若遇 ipcBridgeRef 尚未挂接会返回 NOT_READY 且无重试，会导致 isReady 恒为 false、侧边栏历史永不加载。
  // 此处对 ping 做有限次重试，与 ChatPage 中「新建对话」会无条件 refreshLocalSessions 的现象一致（用户操作触发了可工作的 IPC 时序）。
  tryPingBridgeUntilReady(api, 0)
}

/**
 * Vite HMR 热更新时自动清理旧监听器，防止重复注册。
 * 模块级变量 _ipcEventUnsubscribe 在 HMR 后会被重置为 null，
 * 但 ipcRenderer.on 注册的旧监听器仍然存活——需要主动注销。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    const globalObj = globalThis as typeof globalThis & {
      [GLOBAL_ON_EVENT_UNSUB_KEY]?: (() => void) | null
    }
    clearPingRetryTimer()
    if (_ipcEventUnsubscribe) {
      _ipcEventUnsubscribe()
      _ipcEventUnsubscribe = null
    }
    globalObj[GLOBAL_ON_EVENT_UNSUB_KEY] = null
  })
}

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
  const switchSession = useCallback(async (sessionKey: string, preferredModelId?: string) => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return

    // 切换前先 prime 模型偏好，确保 context-usage 返回正确的 contextWindow（而非 128K 默认值）
    if (preferredModelId) {
      await api.sendCommand({ type: 'session:preferredModel:set', sessionKey, modelId: preferredModelId }).catch(() => undefined)
    }

    type DbFileRow = {
      id: string; fileName: string; localPath: string; mimeType: string | null
      fileSize: number | null; conversationId: string | null; messageId: string | null
      agentId: string | null; channel: string; category: 'upload' | 'output'
    }
    type DbTaskRow = {
      id: string; subject: string; description: string | null; status: string; owner: string | null
    }

    /** 将 FileRepo 行转为 RuntimeFileEvent */
    const toFileEvents = (files: readonly DbFileRow[]): RuntimeFileEvent[] =>
      files.map((f) => ({
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

    /**
     * 用 TaskRepo 权威任务列表注入一条合成 todo_write，供 TodoPanel 在重启后展示。
     * 追加到最后一条 assistant 消息，aggregateTasks 会以最后一个 tasks[] 为基线。
     */
    const injectRestoredTasks = (
      messages: RuntimeMessage[],
      tasks: readonly DbTaskRow[],
    ): RuntimeMessage[] => {
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
    if (existingSession && existingSession.messages.length > 0) {
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
            messages: injectRestoredTasks(prev.messages as RuntimeMessage[], meta.tasks),
            fileEvents: [...meta.fileEvents, ...onlyInMem],
            contextUsage: {
              usedTokens: contextUsage.usedTokens,
              contextWindow: contextUsage.contextWindow,
              triggerThreshold: contextUsage.triggerThreshold,
              isNearThreshold: ratio > 0.6,
              ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
            },
            isAutoCompacting: ratio >= contextUsage.triggerThreshold,
          }
        })
      } catch (err) {
        debugLog('[switchSession] 刷新缓存会话元数据失败（已忽略） sessionKey=' + sessionKey, err)
      }
      debugLog('[switchSession] 切换到已缓存会话 sessionKey=' + sessionKey + ' msgs=' + existingSession.messages.length)
      return
    }

    // 从 DB 加载目标会话历史
    type DbMessage = {
      id: string
      role: 'user' | 'assistant'
      content: readonly { type: 'text'; text: string }[]
      timestamp: number
      isStreaming?: boolean
      isVoice?: boolean
      audioWavBase64?: string
      contentJson?: string
      toolCalls?: readonly {
        id: string
        name: string
        args: Record<string, unknown>
        result?: unknown
        isError?: boolean
        textPositionAtStart?: number
      }[]
      sourceAgent?: { instanceId: string; label: string }
    }

    const [dbMessages, meta, dbContextUsage] = await Promise.all([
      api.sendCommand({
        type: 'conversation:messages',
        sessionKey,
      }) as Promise<readonly DbMessage[]>,
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

    /**
     * 将主进程返回的 DB 消息映射为 renderer 消息，并恢复 assistant_parts。
     */
    const toRuntimeMsg = (msg: DbMessage): RuntimeMessage => {
      const parsed = msg.contentJson ? parseMessageContentJson(msg.contentJson) : undefined
      const assistantContent = parsed?.type === 'assistant_parts' ? parsed : undefined
      const parts: readonly AssistantPart[] = assistantContent?.parts ?? []
      const fileChanges: readonly FileChangeEntry[] | undefined = assistantContent?.fileChanges
      const content = assistantContent
        ? [{
            type: 'text' as const,
            text: parts
              .filter((part): part is Extract<AssistantPart, { type: 'text' }> => part.type === 'text')
              .map((part) => part.text)
              .join(''),
          }]
        : msg.content

      return {
        id: msg.id,
        role: msg.role,
        content,
        parts,
        timestamp: msg.timestamp,
        isStreaming: msg.isStreaming ?? false,
        toolCalls: (msg.toolCalls ?? []).map((tc) => ({
          ...tc,
          status: (tc.isError ? 'error' : 'completed') as 'error' | 'completed',
          isError: tc.isError ?? false,
          textPositionAtStart: tc.textPositionAtStart,
        })),
        ...(assistantContent?.sourceAgent
          ? { sourceAgent: assistantContent.sourceAgent }
          : msg.sourceAgent
            ? { sourceAgent: msg.sourceAgent }
            : {}),
        ...(fileChanges ? { fileChanges } : {}),
        ...(msg.isVoice ? { isVoice: true } : {}),
        ...(msg.audioWavBase64 ? { audioWavBase64: msg.audioWavBase64 } : {}),
      }
    }

    const dbMsgList: RuntimeMessage[] = injectRestoredTasks(dbMessages.map(toRuntimeMsg), meta.tasks)
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
        const pendingMsgs = latestMemSession.messages.filter((m) => !dbMsgIds.has(m.id))

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
          effectiveMessages = injectRestoredTasks([...mergedDbMsgs, ...pendingMsgs], meta.tasks)
          restoredActiveRunId = latestMemSession.activeRunId
          restoredIsStreaming = latestMemSession.isStreaming || hasDbStreamingMsg
          restoredCurrentTool = latestMemSession.currentTool
        } else {
          effectiveMessages = injectRestoredTasks(mergedDbMsgs, meta.tasks)
          restoredActiveRunId = hasDbStreamingMsg ? latestMemSession.activeRunId : null
          restoredIsStreaming = hasDbStreamingMsg
          restoredCurrentTool = hasDbStreamingMsg ? latestMemSession.currentTool : null
        }
        debugLog('[switchSession] 内存合并后 effectiveMsgs=' + effectiveMessages.length + ' restoredIsStreaming=' + restoredIsStreaming)
      }

      newSessions.set(sessionKey, {
        ...baseState,
        messages: effectiveMessages,
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
          isAutoCompacting: dbContextUsage.contextWindow > 0
            ? dbContextUsage.usedTokens / dbContextUsage.contextWindow >= dbContextUsage.triggerThreshold
            : false,
        } : {}),
      })
      return { ...prev, sessions: newSessions, currentSessionKey: sessionKey }
    })
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
