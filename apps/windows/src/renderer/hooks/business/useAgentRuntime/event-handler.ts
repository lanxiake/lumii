/**
 * 事件处理器 — 多会话并行架构
 *
 * 将 IPC 事件路由到对应会话的状态，不再过滤非当前会话的事件。
 * 每个事件根据 rootSessionKey / sessionKey 确定目标会话，
 * 并通过 updateSessionState 更新对应会话的独立状态。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §5
 */

import type { AgentRuntimeEvent, AgentRuntimeEventType } from '../../../../shared/agent-runtime-events'
import { patchBreakdownAfterConversationCompact } from '../../../../shared/context-usage-compact'
import type { RuntimeToolCall, RuntimeMessage, StreamMetrics, ContextUsage, PerSessionState, RuntimeFileEvent, RuntimeCompactionEvent } from './agent-runtime-store'
import { runtimeStore, updateSessionState, getDefaultPerSessionState } from './agent-runtime-store'
import {
  applyAssistantPartEvent,
  describeLlmError,
  finalizeAssistantParts,
  type AssistantPart,
  type AssistantPartEvent,
  type LlmErrorDetail,
} from '@mtbot/agent-runtime/browser'
import { notifyDesktop } from '../../../services/app-service'
import { resolveBackfilledAgentLabel } from './sub-agent-label'

/** 仅在开发环境输出详细日志，避免生产环境噪音 */
const debugLog = process.env.NODE_ENV === 'development'
  ? (...args: unknown[]) => console.log(...args)
  : () => undefined

let rendererPartIdSequence = 0

/**
 * ACP 后端标签映射
 */
const ACP_BACKEND_LABELS: Record<string, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
}

/**
 * 从 model 字段提取 ACP 后端信息（model 格式：acp:cursor / acp:claude 等）
 */
function extractAcpBackend(model?: string): { backendId: string; label: string } | null {
  if (!model || !model.startsWith('acp:')) return null
  const backendId = model.slice(4) // 移除 "acp:" 前缀
  const label = ACP_BACKEND_LABELS[backendId] ?? backendId
  return { backendId, label }
}

/**
 * 使用 renderer 命名空间生成 part id，避免与主进程持久化序号冲突。
 */
function applyRuntimeAssistantPartEvent(
  parts: readonly AssistantPart[],
  event: AssistantPartEvent,
): AssistantPart[] {
  return applyAssistantPartEvent(parts, event, {
    createId: () => {
      rendererPartIdSequence += 1
      return `renderer-part-${rendererPartIdSequence}`
    },
  })
}

/**
 * 每个会话内：同一 run 内每次 LLM 调用的首包时间（用于总耗时与 token/s）
 * sessionKey -> (runId -> timestamp)
 */
const streamLlmStartByRunId = new Map<string, Map<string, number>>()

/**
 * 每个会话内：子 Agent instanceId → 当前流式 assistant 消息 id
 * sessionKey -> (instanceId -> messageId)
 */
const subAgentStreamingMessageId = new Map<string, Map<string, string>>()

/**
 * 每个活跃 runId 对应的 sessionKey（用于无 sessionKey 的事件路由）
 * runId -> sessionKey
 */
const runIdToSessionKey = new Map<string, string>()

/**
 * 每条主 Agent 消息在本轮 LLM 调用开始时的正文字符数。
 * key: `${sessionKey}|${messageId}`；value: 本轮起点（含续轮分隔符）
 *
 * 用于 message:end 判断「本轮文本有没有进内存」：本轮增量全丢（IPC 丢失、
 * 渲染进程刚重启）时，用事件携带的最终文本兜底，否则这条回复在界面上是空白。
 */
const turnTextStartByMessage = new Map<string, number>()

/** 记录本轮正文起点；message:start 时调用 */
function markTurnTextStart(sessionKey: string, messageId: string, startLength: number): void {
  turnTextStartByMessage.set(`${sessionKey}|${messageId}`, startLength)
}

/** 取本轮正文起点（缺省 0 = 整条消息都是本轮） */
function getTurnTextStart(sessionKey: string, messageId: string): number {
  return turnTextStartByMessage.get(`${sessionKey}|${messageId}`) ?? 0
}

/** 清理某会话下已收尾消息的起点记录（避免长会话累积） */
function clearTurnTextStart(sessionKey: string, messageId?: string): void {
  if (messageId) {
    turnTextStartByMessage.delete(`${sessionKey}|${messageId}`)
    return
  }
  const prefix = `${sessionKey}|`
  for (const key of turnTextStartByMessage.keys()) {
    if (key.startsWith(prefix)) turnTextStartByMessage.delete(key)
  }
}

// ============================================================
// Delta 批处理 — 将高频 delta 事件合并为每帧一次 store 更新
// ============================================================

/** 待刷新的 delta 目标：主 Agent 文本、子 Agent 文本或 thinking */
type PendingDeltaTarget =
  | { kind: 'main_text'; sessionKey: string; messageId?: string }
  | { kind: 'sub_agent_text'; sessionKey: string; instanceId: string }
  | { kind: 'thinking'; sessionKey: string; instanceId?: string }

/** 按到达顺序排队的 delta 批次（同目标连续事件合并为同一批次） */
interface PendingDeltaBatch {
  target: PendingDeltaTarget
  text: string
}

const pendingDeltaQueue: PendingDeltaBatch[] = []

let deltaFlushScheduled = false

/**
 * 生成 delta 目标的唯一键，用于判断相邻批次是否可合并。
 */
function pendingDeltaTargetKey(target: PendingDeltaTarget): string {
  switch (target.kind) {
    case 'main_text':
      return `main_text::${target.sessionKey}`
    case 'sub_agent_text':
      return `sub_text::${target.sessionKey}::${target.instanceId}`
    case 'thinking':
      return `thinking::${target.sessionKey}::${target.instanceId ?? '__main__'}`
  }
}

/**
 * 将 delta 追加到有序队列；与上一批次同目标则合并文本，否则新建批次。
 */
function enqueuePendingDelta(target: PendingDeltaTarget, delta: string): void {
  const last = pendingDeltaQueue[pendingDeltaQueue.length - 1]
  if (last && pendingDeltaTargetKey(last.target) === pendingDeltaTargetKey(target)) {
    last.text += delta
    if (target.kind === 'main_text' && target.messageId) {
      last.target = { ...last.target, messageId: target.messageId } as PendingDeltaTarget
    }
    return
  }
  pendingDeltaQueue.push({ target, text: delta })
}

function scheduleDeltaFlush(): void {
  if (deltaFlushScheduled) return
  deltaFlushScheduled = true
  requestAnimationFrame(flushPendingDeltas)
}

/**
 * 将 thinking delta 应用到目标 assistant 消息。
 */
function applyThinkingDeltaBatch(
  sessionKey: string,
  instanceId: string | undefined,
  text: string,
): void {
  updateSessionState(sessionKey, (prev) => {
    const msgs = [...prev.messages]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const message = msgs[i]!
      if (message.role !== 'assistant' || !message.isStreaming) continue
      if (instanceId && message.sourceAgent?.instanceId !== instanceId) continue
      if (!instanceId && message.sourceAgent) continue
      msgs[i] = {
        ...message,
        parts: applyRuntimeAssistantPartEvent(message.parts, {
          kind: 'thinking_delta',
          delta: text,
        }),
      }
      break
    }
    return {
      ...prev,
      messages: msgs,
      ...(instanceId
        ? {}
        : {
            isThinking: true,
            currentThinkingText: prev.currentThinkingText + text,
          }),
    }
  })
}

/**
 * 将主 Agent text delta 应用到目标 assistant 消息。
 */
function applyMainTextDeltaBatch(
  sessionKey: string,
  messageId: string | undefined,
  text: string,
): void {
  updateSessionState(sessionKey, (prev) => {
    const msgs = [...prev.messages]
    let targetIdx = messageId ? msgs.findIndex((m) => m.id === messageId) : -1
    if (targetIdx < 0) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'assistant' && msgs[i]!.isStreaming && !msgs[i]!.sourceAgent) {
          targetIdx = i
          break
        }
      }
    }
    if (targetIdx < 0) return prev
    const last = msgs[targetIdx]!
    if (last.role !== 'assistant' || !last.isStreaming) return prev
    const currentText = last.content[0]?.text ?? ''
    msgs[targetIdx] = {
      ...last,
      content: [{ type: 'text' as const, text: currentText + text }],
      parts: applyRuntimeAssistantPartEvent(last.parts, { kind: 'text_delta', delta: text }),
    }
    return { ...prev, messages: msgs }
  })
}

/**
 * 将子 Agent text delta 应用到目标 assistant 消息。
 */
function applySubAgentTextDeltaBatch(
  sessionKey: string,
  instanceId: string,
  text: string,
): void {
  const mid = getSubAgentMsgId(sessionKey, instanceId)
  updateSessionState(sessionKey, (prev) => {
    const msgs = [...prev.messages]
    const idx = mid ? msgs.findIndex((m) => m.id === mid) : -1
    if (idx < 0) return prev
    const last = msgs[idx]!
    if (last.role !== 'assistant' || !last.isStreaming) return prev
    const currentText = last.content[0]?.text ?? ''
    msgs[idx] = {
      ...last,
      content: [{ type: 'text' as const, text: currentText + text }],
      parts: applyRuntimeAssistantPartEvent(last.parts, { kind: 'text_delta', delta: text }),
    }
    return { ...prev, messages: msgs }
  })
}

/**
 * 按到达顺序刷新所有待处理 delta，保持 text/thinking 交错顺序。
 */
function flushPendingDeltas(): void {
  deltaFlushScheduled = false

  for (const { target, text } of pendingDeltaQueue) {
    if (!text) continue
    switch (target.kind) {
      case 'thinking':
        applyThinkingDeltaBatch(target.sessionKey, target.instanceId, text)
        break
      case 'main_text':
        applyMainTextDeltaBatch(target.sessionKey, target.messageId, text)
        break
      case 'sub_agent_text':
        applySubAgentTextDeltaBatch(target.sessionKey, target.instanceId, text)
        break
    }
  }
  pendingDeltaQueue.length = 0
}

/**
 * 在 finalize 前将 LLM 错误文本注入 parts（content 为空时）。
 */
function partsWithLlmErrorIfNeeded(
  parts: readonly AssistantPart[],
  err: LlmErrorDetail | undefined,
  contentText: string | undefined,
): AssistantPart[] {
  if (!err || contentText?.trim()) return [...parts]
  return applyRuntimeAssistantPartEvent(parts, {
    kind: 'text_delta',
    delta: describeLlmError(err),
  })
}

/** 同一条错误在此窗口内只弹一次 toast，避免 message:end 与 agent:error 重复提示 */
const AGENT_ERROR_TOAST_DEDUPE_MS = 3000

let lastAgentErrorToast: { message: string; at: number } | null = null

/**
 * 通过全局事件把 Agent 错误抛给 GlobalModals 的 toast。
 *
 * 事件处理器是模块级单例（ChatPage 卸载后仍在跑），不能持有 React 上下文，
 * 因此走 window 事件而不是直接调用 useToast。
 */
function notifyAgentError(message: string): void {
  if (typeof window === 'undefined' || !message.trim()) return
  const now = Date.now()
  if (
    lastAgentErrorToast
    && lastAgentErrorToast.message === message
    && now - lastAgentErrorToast.at < AGENT_ERROR_TOAST_DEDUPE_MS
  ) {
    return
  }
  lastAgentErrorToast = { message, at: now }
  window.dispatchEvent(new CustomEvent('mtbot:agent-error', { detail: { message } }))
}

/**
 * LLM 错误 toast：用户主动中止不算故障，不打扰。
 */
function notifyLlmError(err: LlmErrorDetail): void {
  if (err.code === 'aborted') return
  notifyAgentError(describeLlmError(err))
}

/**
 * 单个会话的消息数量上限，超过后截断最早的消息，防止长时间运行的后台会话内存溢出
 */
const MAX_MESSAGES_PER_SESSION = 1000

/**
 * 仅测试用：清空模块级映射，避免用例间串状态。
 * 需与 `resetRuntimeStore()` 一起调用。
 */
export function resetAgentRuntimeEventHandlerForTests(): void {
  lastAgentErrorToast = null
  streamLlmStartByRunId.clear()
  subAgentStreamingMessageId.clear()
  runIdToSessionKey.clear()
  turnTextStartByMessage.clear()
  pendingDeltaQueue.length = 0
  deltaFlushScheduled = false
  rendererPartIdSequence = 0
}

// ============================================================
// 会话级辅助映射操作
// ============================================================

/** 获取会话内 LLM 调用首包时间 */
function getLlmStartTime(sessionKey: string, runId: string): number | undefined {
  return streamLlmStartByRunId.get(sessionKey)?.get(runId)
}

/** 注册 runId -> sessionKey 映射（在 turn:start 时即建立，确保收尾事件能正确路由） */
function registerRunSession(sessionKey: string, runId: string): void {
  runIdToSessionKey.set(runId, sessionKey)
}

/** 移除 runId -> sessionKey 映射 */
function unregisterRunSession(runId: string): void {
  runIdToSessionKey.delete(runId)
}

/** 设置会话内 LLM 调用首包时间 */
function setLlmStartTime(sessionKey: string, runId: string, ts: number): void {
  if (!streamLlmStartByRunId.has(sessionKey)) {
    streamLlmStartByRunId.set(sessionKey, new Map())
  }
  streamLlmStartByRunId.get(sessionKey)!.set(runId, ts)
}

/** 删除会话内 LLM 调用首包时间 */
function deleteLlmStartTime(sessionKey: string, runId: string): void {
  streamLlmStartByRunId.get(sessionKey)?.delete(runId)
}

/** 获取会话内子 Agent 流式消息 ID */
function getSubAgentMsgId(sessionKey: string, instanceId: string): string | undefined {
  return subAgentStreamingMessageId.get(sessionKey)?.get(instanceId)
}

/** 设置会话内子 Agent 流式消息 ID */
function setSubAgentMsgId(sessionKey: string, instanceId: string, messageId: string): void {
  if (!subAgentStreamingMessageId.has(sessionKey)) {
    subAgentStreamingMessageId.set(sessionKey, new Map())
  }
  subAgentStreamingMessageId.get(sessionKey)!.set(instanceId, messageId)
}

/**
 * 删除会话内子 Agent 流式消息 ID
 * 注意：此函数只能在 updateSessionState updater 外部调用，不得在纯函数 updater 内调用，
 * 以避免 updater 被重复调用时产生双重副作用。
 */
function deleteSubAgentMsgId(sessionKey: string, instanceId: string): void {
  subAgentStreamingMessageId.get(sessionKey)?.delete(instanceId)
}

/** 检查会话内是否存在子 Agent 流式消息 */
function hasSubAgentMsgId(sessionKey: string, instanceId: string): boolean {
  return subAgentStreamingMessageId.get(sessionKey)?.has(instanceId) ?? false
}

// ============================================================
// 消息数量限制
// ============================================================

/**
 * 截断超出上限的历史消息（保留最近的消息）
 * 确保单个会话的内存消耗有上界
 */
function trimMessages(messages: readonly RuntimeMessage[]): readonly RuntimeMessage[] {
  if (messages.length <= MAX_MESSAGES_PER_SESSION) return messages
  return messages.slice(messages.length - MAX_MESSAGES_PER_SESSION)
}

/**
 * 仅收尾仍含流式 part 的助手消息，避免 idle 时重建全部历史消息引用。
 *
 * @param interrupted 中止/错误路径传 true：把仍停在 `running` 的工具 part 一并收尾为
 *   `interrupted`，否则它们会永久显示「执行中」（见 08-委托可见性.md §5）
 */
function finalizeStreamingAssistantMessages(
  messages: readonly RuntimeMessage[],
  closeMessages = false,
  interrupted = false,
): readonly RuntimeMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const hasStreamingPart = message.parts.some(
      (part) => (part.type === 'thinking' || part.type === 'text') && part.status === 'streaming',
    )
    const hasRunningTool = interrupted && message.parts.some(
      (part) => part.type === 'tool' && part.status === 'running',
    )
    if (!hasStreamingPart && !hasRunningTool && !(closeMessages && message.isStreaming)) return message
    changed = true
    return {
      ...message,
      parts: hasStreamingPart || hasRunningTool
        ? finalizeAssistantParts(message.parts, { interrupted })
        : message.parts,
      ...(closeMessages ? { isStreaming: false } : {}),
    }
  })
  return changed ? next : messages
}

// ============================================================
// 事件路由
// ============================================================

/**
 * 从事件中提取目标会话 key
 *
 * 优先级：rootSessionKey > runId 反查 > sessionKey > currentSessionKey
 *
 * 引入 runId 反查解决以下问题：
 * agent:abort / agent:error 等事件可能没有 sessionKey，但有 runId。
 * 若直接回退到 currentSessionKey，会把后台会话的错误/中止状态错误地应用到当前会话。
 * 通过记录 runId -> sessionKey 映射，能正确路由到发出该 run 的会话。
 */
function resolveTargetSessionKey(event: AgentRuntimeEvent): string | null {
  if (event.type === 'agent:activity:snapshot') {
    return event.rootSessionKey ?? null
  }
  const rk = 'rootSessionKey' in event && event.rootSessionKey ? event.rootSessionKey : undefined
  if (rk) return rk

  // 通过 runId 反查 sessionKey，防止无 rootSessionKey 的事件路由到错误会话
  const runId = 'runId' in event ? (event as { runId?: string }).runId : undefined
  if (runId) {
    const mappedKey = runIdToSessionKey.get(runId)
    if (mappedKey) return mappedKey
  }

  const sk = 'sessionKey' in event ? (event as { sessionKey?: string }).sessionKey : undefined
  if (sk) return sk

  // 确实没有任何会话标识的事件（如 conversation:created）路由到当前会话
  return runtimeStore.getState().currentSessionKey
}

/**
 * 是否为子 Agent 的流（sessionKey 与对话根 session 不同）
 */
function isSubAgentStreamEvent(event: AgentRuntimeEvent): boolean {
  if (!('rootSessionKey' in event) || !event.rootSessionKey) return false
  if (!('sessionKey' in event)) return false
  const sk = (event as { sessionKey?: string }).sessionKey
  if (!sk) return false
  return sk !== event.rootSessionKey
}

/**
 * 根据子 Agent 实例 ID 定位当前 assistant 消息下标（会话隔离版本）
 */
function findMsgIndexByInstanceId(
  msgs: readonly RuntimeMessage[],
  sessionKey: string,
  instanceId: string,
): number {
  const mid = getSubAgentMsgId(sessionKey, instanceId)
  if (mid) {
    const i = msgs.findIndex((m) => m.id === mid)
    if (i >= 0) return i
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.role === 'assistant' && m.sourceAgent?.instanceId === instanceId) return i
  }
  return -1
}

/**
 * 由 usage 与耗时推算输出速度（token/s）
 */
function buildStreamMetrics(usage: { outputTokens: number }, durationMs: number): StreamMetrics {
  const sec = durationMs > 0 ? durationMs / 1000 : 1
  const tokensPerSecond = usage.outputTokens > 0 ? usage.outputTokens / sec : 0
  return { durationMs, tokensPerSecond }
}

// ============================================================
// 事件处理主入口
// ============================================================

/**
 * 处理 Agent Runtime IPC 事件（多会话并行版本）
 *
 * 每个事件被路由到其对应的会话状态，后台会话事件不再被丢弃。
 * 所有 Store 变更都是不可变的（创建新对象而非修改旧对象）。
 * 模块级 Map 的副作用（deleteSubAgentMsgId 等）始终在 updateSessionState 外部执行。
 */
export function handleRuntimeEvent(event: AgentRuntimeEvent): void {
  const sessionKey = resolveTargetSessionKey(event)
  if (!sessionKey) return

  if (event.type === 'agent:message:end') {
    debugLog('[AgentRuntime] message:end messageId:', event.messageId, 'runId:', event.runId, 'stopReason:', event.stopReason)
  } else if (!event.type.endsWith(':delta') && !event.type.includes('thinking')) {
    debugLog('[AgentRuntime] event:', event.type, 'sessionKey:', sessionKey)
  }

  // updateSessionState 内部已有"不存在时用默认状态"的兜底，无需额外的 ensureSessionExists 调用

  switch (event.type) {
    case 'agent:message:start': {
      // 记录 LLM 调用首包时间（路由映射已在 agent:turn:start 时建立，此处仅记录计时）
      setLlmStartTime(sessionKey, event.runId, Date.now())
      if (isSubAgentStreamEvent(event) && event.instanceId) {
        const subId = event.instanceId
        setSubAgentMsgId(sessionKey, subId, event.messageId)
        updateSessionState(sessionKey, (prev) => {
          // 优先用 activeAgents 中已知的 Agent 名称作为 label，避免显示笼统的「子 Agent」
          // 若 snapshot 尚未到达（竞态场景），回退到占位文案，后续 snapshot 会回填
          const matchedAgent = prev.activeAgents.find((a) => a.instanceId === subId)
          const label = matchedAgent?.name ?? '子 Agent'

          // 同 messageId 已存在则复用，避免子 Agent 续轮把同一气泡推成两条
          const existingIdx = prev.messages.findIndex(
            (m) => m.id === event.messageId && m.role === 'assistant',
          )
          if (existingIdx >= 0) {
            const msgs = [...prev.messages]
            const existing = msgs[existingIdx]!
            msgs[existingIdx] = {
              ...existing,
              isStreaming: true,
              sourceAgent: {
                instanceId: subId,
                label: existing.sourceAgent?.label && existing.sourceAgent.label !== '子 Agent'
                  ? existing.sourceAgent.label
                  : label,
              },
            }
            return {
              ...prev,
              activeRunId: event.runId,
              isStreaming: true,
              error: null,
              currentLlmModelId: event.model,
              messages: msgs,
            }
          }

          return {
            ...prev,
            activeRunId: event.runId,
            isStreaming: true,
            error: null,
            currentLlmModelId: event.model,
            messages: trimMessages([
              ...prev.messages,
              {
                id: event.messageId,
                role: 'assistant' as const,
                content: [{ type: 'text' as const, text: '' }],
                parts: [],
                timestamp: event.timestamp,
                isStreaming: true,
                toolCalls: [],
                sourceAgent: {
                  instanceId: subId,
                  label,
                },
              },
            ]),
          }
        })
        break
      }
      updateSessionState(sessionKey, (prev) => {
        // 同一 turn 内多次 LLM 调用复用同一条主 Agent 消息气泡（通过 turnId 识别）
        // 优先级：
        // 1) 同一 turn 已有主 Agent 消息 → 复用
        // 2) 已有同 messageId 的主 Agent 消息 → 复用（防 duplicate key / 双「执行过程」）
        // 3) 向后找最近一条 streaming 主 Agent 消息 → 复用（子消息插队时末条兜底会失效）
        // 4) 创建新消息
        const turnId = event.runId

        // 优先查找同一 turn 的主 Agent 消息（向后查找最近一条）
        let reuseIdx = -1
        for (let i = prev.messages.length - 1; i >= 0; i--) {
          const m = prev.messages[i]!
          if (m.role === 'assistant' && !m.sourceAgent && m.turnId === turnId) {
            reuseIdx = i
            break
          }
        }

        // 同 messageId 已存在：绝不能再 push，否则 ChatContainer 出现 duplicate key `m:<id>`
        if (reuseIdx < 0) {
          for (let i = prev.messages.length - 1; i >= 0; i--) {
            const m = prev.messages[i]!
            if (m.role === 'assistant' && !m.sourceAgent && m.id === event.messageId) {
              reuseIdx = i
              break
            }
          }
        }

        // 向后找最近一条仍在流式的主 Agent 消息（不要求它是列表末条）
        if (reuseIdx < 0) {
          for (let i = prev.messages.length - 1; i >= 0; i--) {
            const m = prev.messages[i]!
            if (m.role === 'assistant' && m.isStreaming && !m.sourceAgent) {
              reuseIdx = i
              break
            }
          }
        }

        if (reuseIdx >= 0) {
          const existingText = prev.messages[reuseIdx]?.content[0]?.text ?? ''
          const separator = existingText ? '\n\n' : ''
          const nextText = existingText + separator
          const msgs = [...prev.messages]
          const existingMessage = msgs[reuseIdx]!
          const acpBackend = extractAcpBackend(event.model)
          // 续轮：本轮的正文从分隔符之后开始
          markTurnTextStart(sessionKey, event.messageId, nextText.length)
          msgs[reuseIdx] = {
            ...existingMessage,
            id: event.messageId,
            isStreaming: true,
            turnId,
            content: [{ type: 'text' as const, text: nextText }],
            parts: separator
              ? applyRuntimeAssistantPartEvent(existingMessage.parts, {
                  kind: 'text_delta',
                  delta: separator,
                })
              : existingMessage.parts,
            acpBackendLabel: acpBackend?.label ?? existingMessage.acpBackendLabel,
          }
          return {
            ...prev,
            activeRunId: event.runId,
            isStreaming: true,
            error: null,
            currentLlmModelId: event.model,
            messages: msgs,
          }
        }

        const acpBackend = extractAcpBackend(event.model)
        // 新建消息：整条都是本轮
        markTurnTextStart(sessionKey, event.messageId, 0)
        return {
          ...prev,
          activeRunId: event.runId,
          isStreaming: true,
          error: null,
          currentLlmModelId: event.model,
          messages: trimMessages([
            ...prev.messages,
            {
              id: event.messageId,
              role: 'assistant' as const,
              content: [{ type: 'text' as const, text: '' }],
              parts: [],
              timestamp: event.timestamp,
              isStreaming: true,
              toolCalls: [],
              turnId,
              acpBackendLabel: acpBackend?.label,
            },
          ]),
        }
      })
      break
    }

    case 'agent:message:delta': {
      if (isSubAgentStreamEvent(event) && event.instanceId) {
        enqueuePendingDelta(
          { kind: 'sub_agent_text', sessionKey, instanceId: event.instanceId },
          event.delta,
        )
      } else {
        enqueuePendingDelta(
          { kind: 'main_text', sessionKey, messageId: event.messageId },
          event.delta,
        )
      }
      scheduleDeltaFlush()
      break
    }

    case 'agent:message:end': {
      flushPendingDeltas()
      // 0-token 空消息：仅在"确实没出错"时跳过，避免吞掉密钥无效、余额不足等错误提示。
      // 中止（aborted）同理不能跳过：被中止的那轮正文就是空的（模型还没来得及输出），
      // 若在此 break，isAborted 永远写不到消息上——气泡徽标与子运行块都会退回「已完成」
      // （2026-09-20 冒烟实测：卡片对了、运行块仍显示已完成，根因就在这条守卫）。
      if (
        !event.llmError
        && event.stopReason !== 'error'
        && event.stopReason !== 'aborted'
        && !event.usage?.outputTokens
        && event.content?.[0]?.text === ''
      ) {
        break
      }

      if (event.llmError) notifyLlmError(event.llmError)

      if (isSubAgentStreamEvent(event) && event.instanceId) {
        const instanceId = event.instanceId
        const mid = getSubAgentMsgId(sessionKey, instanceId)
        const finalTextSub = event.content?.[0]?.text?.trim()

        if (finalTextSub === 'NO_REPLY') {
          // 副作用在 updater 外部执行，避免 updater 被多次调用时重复操作 Map
          deleteSubAgentMsgId(sessionKey, instanceId)
          updateSessionState(sessionKey, (prev) => {
            const msgs = [...prev.messages]
            const idx = mid ? msgs.findIndex((m) => m.id === mid) : -1
            if (idx >= 0) msgs.splice(idx, 1)
            return { ...prev, messages: msgs, isStreaming: false }
          })
          break
        }

        const keepStreaming = event.stopReason === 'tool_use'
        const t0 = getLlmStartTime(sessionKey, event.runId) ?? Date.now()
        const durationMs = Date.now() - t0
        // 副作用在 updater 外部执行
        if (!keepStreaming) {
          deleteLlmStartTime(sessionKey, event.runId)
          deleteSubAgentMsgId(sessionKey, instanceId)
        } else {
          setLlmStartTime(sessionKey, event.runId, Date.now())
        }

        updateSessionState(sessionKey, (prev) => {
          const msgs = [...prev.messages]
          const idx = mid ? msgs.findIndex((m) => m.id === mid) : -1
          if (idx < 0) return prev
          const last = msgs[idx]!
          const finalContent = keepStreaming ? last.content : event.content
          const err = event.llmError
          const failed = Boolean(err) || event.stopReason === 'error' || event.stopReason === 'aborted'
          let streamMetrics: StreamMetrics | undefined
          if (!failed && !keepStreaming && event.usage) {
            streamMetrics = buildStreamMetrics({ outputTokens: event.usage.outputTokens }, durationMs)
          }
          const llmErrorBlock = err
            ? { code: err.code, message: err.message, retryable: err.retryable }
            : undefined
          const mergedContent =
            err && (!finalContent[0]?.text?.trim())
              ? ([{ type: 'text' as const, text: describeLlmError(err) }] as const)
              : finalContent
          msgs[idx] = {
            ...last,
            content: mergedContent,
            parts: finalizeAssistantParts(
              partsWithLlmErrorIfNeeded(last.parts, err, finalContent[0]?.text),
            ),
            isStreaming: keepStreaming,
            usage: event.usage,
            ...(streamMetrics ? { streamMetrics } : {}),
            ...(llmErrorBlock ? { llmError: llmErrorBlock } : {}),
            // 中止标记：子运行块据此显示「已中断」而不是「已完成」
            ...(event.stopReason === 'aborted' ? { isAborted: true } : {}),
          }
          return { ...prev, messages: msgs, isStreaming: keepStreaming }
        })
        break
      }

      // NO_REPLY 协议：Agent 返回 NO_REPLY 表示无需展示消息，移除占位消息
      const finalText = event.content?.[0]?.text?.trim()
      if (finalText === 'NO_REPLY') {
        clearTurnTextStart(sessionKey, event.messageId)
        updateSessionState(sessionKey, (prev) => {
          const msgs = [...prev.messages]
          // 优先按 messageId 定位本轮占位：定时任务等场景下消息列表末尾可能是
          // 刚推送进来的其它消息，按「最后一条」删会误伤不是本轮的消息
          let targetIdx = event.messageId ? msgs.findIndex((m) => m.id === event.messageId) : -1
          if (targetIdx < 0) {
            const lastIdx = msgs.length - 1
            targetIdx = lastIdx >= 0 && msgs[lastIdx]?.role === 'assistant' ? lastIdx : -1
          }
          if (targetIdx >= 0) msgs.splice(targetIdx, 1)
          return { ...prev, messages: msgs, isStreaming: false }
        })
        break
      }

      // 副作用在 updater 外部执行
      const keepStreamingMain = event.stopReason === 'tool_use'
      const t0Main = getLlmStartTime(sessionKey, event.runId) ?? Date.now()
      const durationMsMain = Date.now() - t0Main
      if (!keepStreamingMain) {
        deleteLlmStartTime(sessionKey, event.runId)
      } else {
        setLlmStartTime(sessionKey, event.runId, Date.now())
      }

      updateSessionState(sessionKey, (prev) => {
        const msgs = [...prev.messages]
        // 优先用 messageId 精确定位；找不到时回退到最后一条 streaming assistant 消息
        let targetIdx = event.messageId
          ? msgs.findIndex((m) => m.id === event.messageId)
          : -1
        if (targetIdx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.role === 'assistant' && msgs[i]!.isStreaming && !msgs[i]!.sourceAgent) {
              targetIdx = i
              break
            }
          }
        }
        if (targetIdx < 0) return prev
        const last = msgs[targetIdx]!

        // tool_use：当前 LLM 调用结束是为了调用工具，之后还会有新的 LLM 调用
        // 保持 isStreaming: true，等 agent:turn:end 统一关闭流式
        let finalContent: typeof last.content
        if (keepStreamingMain) {
          finalContent = last.content
        } else {
          // 优先使用流式累积的内容（state machine 已正确剥离 <think> 标签）；
          // wasResumed 场景下 last.content 已包含前序轮次文本+当前轮流式文本。
          //
          // 但本轮增量可能一个都没到（IPC 丢失、渲染进程刚重启、窗口刚打开）——
          // 此时内存正文停在本轮起点上，必须用事件携带的本轮最终文本补上，
          // 否则这条回复是空白，会被空消息守卫隐藏成「Agent 没有回复」。
          const accumulatedText = last.content.map((c) => c.text).join('')
          const turnText = accumulatedText.slice(getTurnTextStart(sessionKey, event.messageId))
          const eventText = event.content?.map((c) => c.text).join('') ?? ''
          finalContent =
            !turnText.trim() && eventText.trim()
              ? [{ type: 'text' as const, text: accumulatedText + eventText }]
              : last.content
        }

        const err = event.llmError
        const failed = Boolean(err) || event.stopReason === 'error' || event.stopReason === 'aborted'
        let streamMetrics: StreamMetrics | undefined
        if (!failed && !keepStreamingMain && event.usage) {
          streamMetrics = buildStreamMetrics(
            { outputTokens: event.usage.outputTokens },
            durationMsMain,
          )
        }

        const llmErrorBlock = err
          ? { code: err.code, message: err.message, retryable: err.retryable }
          : undefined

        const mergedContent =
          err && (!finalContent[0]?.text?.trim())
            ? ([{ type: 'text' as const, text: describeLlmError(err) }] as const)
            : finalContent

        const injected =
          event.injectedMemories && event.injectedMemories.length > 0
            ? event.injectedMemories
            : undefined

        msgs[targetIdx] = {
          ...last,
          content: mergedContent,
          parts: finalizeAssistantParts(
            partsWithLlmErrorIfNeeded(last.parts, err, finalContent[0]?.text),
          ),
          isStreaming: keepStreamingMain,
          usage: event.usage,
          ...(streamMetrics ? { streamMetrics } : {}),
          ...(llmErrorBlock ? { llmError: llmErrorBlock } : {}),
          ...(injected ? { injectedMemories: injected } : {}),
          // 中止标记：气泡显示「回复已中断」徽标（此前该字段没有人写入）
          ...(event.stopReason === 'aborted' ? { isAborted: true } : {}),
        }
        debugLog('[AgentRuntime] message:end updated:', {
          id: msgs[targetIdx]!.id,
          contentPreview: msgs[targetIdx]!.content[0]?.text?.slice(0, 50),
          isStreaming: msgs[targetIdx]!.isStreaming,
        })

        const routeAfterMessage: { llmRouteStatus: PerSessionState['llmRouteStatus']; llmRouteDetail: string | null } =
          failed
            ? {
                llmRouteStatus: 'error',
                llmRouteDetail: err ? `${err.code}: ${err.message}` : (event.stopReason ?? 'error'),
              }
            : prev.llmRouteStatus === 'degraded'
              ? { llmRouteStatus: 'degraded', llmRouteDetail: prev.llmRouteDetail }
              : { llmRouteStatus: 'healthy', llmRouteDetail: null }

        return {
          ...prev,
          messages: msgs,
          isStreaming: keepStreamingMain,
          ...routeAfterMessage,
        }
      })
      break
    }

    case 'agent:thinking:delta': {
      const instanceId =
        isSubAgentStreamEvent(event) && event.instanceId ? event.instanceId : undefined
      enqueuePendingDelta(
        {
          kind: 'thinking',
          sessionKey,
          ...(instanceId ? { instanceId } : {}),
        },
        event.delta,
      )
      scheduleDeltaFlush()
      break
    }

    case 'agent:thinking:end': {
      flushPendingDeltas()
      const isSubAgentThinking = isSubAgentStreamEvent(event) && Boolean(event.instanceId)
      updateSessionState(sessionKey, (prev) => {
        const msgs = [...prev.messages]
        for (let i = msgs.length - 1; i >= 0; i--) {
          const message = msgs[i]!
          if (message.role !== 'assistant') continue
          if (isSubAgentThinking && message.sourceAgent?.instanceId !== event.instanceId) continue
          if (!isSubAgentThinking && message.sourceAgent) continue
          msgs[i] = {
            ...message,
            parts: applyRuntimeAssistantPartEvent(message.parts, { kind: 'thinking_end' }),
          }
          break
        }
        return {
          ...prev,
          messages: msgs,
          ...(isSubAgentThinking
            ? {}
            : {
                isThinking: false,
                currentThinkingText: '',
              }),
        }
      })
      break
    }

    case 'agent:tool:start': {
      // 工具事件是时间线边界，先提交前序 delta，避免批处理改变 part 顺序。
      flushPendingDeltas()
      if ('instanceId' in event && event.instanceId && hasSubAgentMsgId(sessionKey, event.instanceId)) {
        updateSessionState(sessionKey, (prev) => {
          const msgs = [...prev.messages]
          const idx = findMsgIndexByInstanceId(msgs, sessionKey, event.instanceId!)
          if (idx < 0) return prev
          const msg = msgs[idx]!
          // 防重复：同一 toolCallId 已存在则跳过
          if (msg.parts.some((part) => part.type === 'tool' && part.id === event.toolCallId)) {
            return prev
          }
          // 优先使用事件携带的权威位置（主进程注入，已剥离 thinking 内容）；
          // 仅在未提供时回退到当前消息文本长度估算
          const textLen = event.textPositionAtStart ?? msg.content[0]?.text?.length ?? 0
          const newTool: RuntimeToolCall = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
            status: 'running',
            isError: false,
            startMs: event.timestamp ?? Date.now(),
            textPositionAtStart: textLen,
          }
          msgs[idx] = {
            ...msg,
            parts: applyRuntimeAssistantPartEvent(msg.parts, {
              kind: 'tool_start',
              id: event.toolCallId,
              name: event.toolName,
              args: event.args,
              ...(msg.sourceAgent ? { meta: { sourceAgent: msg.sourceAgent } } : {}),
            }),
          }
          return { ...prev, messages: msgs, currentTool: newTool }
        })
        break
      }
      updateSessionState(sessionKey, (prev) => {
        const msgs = [...prev.messages]
        // 主 Agent 的工具调用：找最后一条不属于子 Agent 的 assistant 消息
        // 避免 sub-agent 消息穿插后，工具卡片被错误附加到子 Agent 消息上
        let targetIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!
          if (m.role === 'assistant' && !m.sourceAgent) {
            targetIdx = i
            break
          }
        }
        const targetMsg = targetIdx >= 0 ? msgs[targetIdx] : null
        // 防重复：同一 toolCallId 已存在则只更新 currentTool
        if (targetMsg?.parts.some((part) => part.type === 'tool' && part.id === event.toolCallId)) {
          return prev
        }
        // 优先使用事件携带的权威位置（主进程注入，已剥离 thinking 内容）；
        // 仅在未提供时回退到当前消息文本长度估算
        const textLen = event.textPositionAtStart ?? (targetMsg?.content[0]?.text?.length ?? 0)
        const newTool: RuntimeToolCall = {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          status: 'running',
          isError: false,
          startMs: event.timestamp ?? Date.now(),
          textPositionAtStart: textLen,
        }
        if (targetMsg) {
          msgs[targetIdx] = {
            ...targetMsg,
            parts: applyRuntimeAssistantPartEvent(targetMsg.parts, {
              kind: 'tool_start',
              id: event.toolCallId,
              name: event.toolName,
              args: event.args,
            }),
          }
          return { ...prev, messages: msgs, currentTool: newTool }
        }
        // 未找到合适的 assistant 消息时（极少数边缘情况），
        // 仍然更新 currentTool，确保 agent:tool:end 能正确获取 args
        return { ...prev, currentTool: newTool }
      })
      break
    }

    case 'agent:tool:progress': {
      updateSessionState(sessionKey, (prev) => {
        if (!prev.currentTool || prev.currentTool.id !== event.toolCallId) return prev
        return {
          ...prev,
          currentTool: { ...prev.currentTool, progressText: event.progressText },
        }
      })
      break
    }

    case 'agent:tool:end': {
      // 工具完成同样是时间线边界，先提交前序文字增量。
      flushPendingDeltas()
      // 调试：记录工具结果
      const resultPreview = event.result == null
        ? 'null'
        : typeof event.result === 'object'
          ? JSON.stringify(event.result).slice(0, 300)
          : String(event.result).slice(0, 300)
      debugLog(`[AgentRuntime] tool:end toolName=${event.toolName} isError=${event.isError} resultPreview=${resultPreview}`)

      const isSubAgentTool =
        'instanceId' in event &&
        Boolean(event.instanceId) &&
        hasSubAgentMsgId(sessionKey, event.instanceId!)
      updateSessionState(sessionKey, (prev) => {
        const msgs = [...prev.messages]
        let targetIdx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          const message = msgs[i]!
          if (message.role !== 'assistant') continue
          if (isSubAgentTool && message.sourceAgent?.instanceId !== event.instanceId) continue
          if (!isSubAgentTool && message.sourceAgent) continue
          if (message.parts.some((part) => part.type === 'tool' && part.id === event.toolCallId)) {
            targetIdx = i
            break
          }
        }
        if (targetIdx >= 0) {
          const message = msgs[targetIdx]!
          msgs[targetIdx] = {
            ...message,
            parts: applyRuntimeAssistantPartEvent(message.parts, {
              kind: 'tool_end',
              id: event.toolCallId,
              name: event.toolName,
              result: event.result,
              isError: event.isError,
            }),
          }
        }
        return { ...prev, messages: msgs, currentTool: null }
      })
      // 检测 task_complete 工具调用，设置任务完成状态
      if (event.toolName === 'task_complete' && !event.isError) {
        let summary = ''
        try {
          const result = event.result as Record<string, unknown> | undefined
          const content = result?.content as Array<{ type: string; text?: string }> | undefined
          const textContent = content?.find((c) => c.type === 'text')?.text
          if (textContent) {
            const parsed = JSON.parse(textContent) as { summary?: string }
            summary = parsed.summary ?? ''
          }
        } catch {
          // ignore parse errors
        }
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          lastTaskCompletion: { summary, timestamp: Date.now() },
        }))
      }
      break
    }

    case 'agent:turn:start': {
      // 子 Agent 新回合不重置主 Agent 的统计数据
      if (isSubAgentStreamEvent(event)) break
      // 提前建立 runId -> sessionKey 映射，确保 turn:end / error / idle 等收尾事件
      // 即使在 message:start 之前到达也能正确路由，不会 fallback 到 currentSessionKey
      registerRunSession(sessionKey, event.runId)
      updateSessionState(sessionKey, (prev) => {
        // 自愈重试时，移除上一轮留下的空 streaming 占位消息，避免 UI 出现重复消息
        const messages = prev.messages.filter(
          (msg) => !(msg.role === 'assistant' && msg.isStreaming && !msg.sourceAgent && (msg.content[0]?.text ?? '') === '')
        )
        return {
          ...prev,
          messages,
          isStreaming: true,
          isThinking: false,
          error: null,
          activeRunId: event.runId,
          turnStats: { toolUseCount: 0, totalTokens: 0, durationMs: 0 },
          llmRouteStatus: 'healthy',
          llmRouteDetail: null,
        }
      })
      break
    }

    case 'agent:turn:end': {
      flushPendingDeltas()
      if (isSubAgentStreamEvent(event)) {
        // 子 Agent 回合结束：只关闭属于该子 Agent 的流式消息，不影响主 Agent 全局状态
        const subInstanceId = 'instanceId' in event ? event.instanceId : undefined
        if (subInstanceId) {
          updateSessionState(sessionKey, (prev) => {
            const hasStreaming = prev.messages.some(
              (msg) => msg.isStreaming && msg.sourceAgent?.instanceId === subInstanceId
            )
            if (!hasStreaming) return prev
            return {
              ...prev,
              messages: prev.messages.map((msg): RuntimeMessage =>
                msg.isStreaming && msg.sourceAgent?.instanceId === subInstanceId
                  ? { ...msg, isStreaming: false }
                  : msg
              ),
            }
          })
        }
        break
      }
      // turn 正常结束，清理映射（下一 turn 的 turn:start 会重新注册）
      unregisterRunSession(event.runId)
      clearTurnTextStart(sessionKey)
      updateSessionState(sessionKey, (prev) => {
        // 仅在确实有 streaming 消息时才创建新数组，避免无谓的引用变化触发下游重渲染
        const hasStreaming = prev.messages.some((msg) => msg.isStreaming)
        let messages: readonly RuntimeMessage[] = hasStreaming
          ? prev.messages.map((msg): RuntimeMessage =>
              msg.isStreaming ? { ...msg, isStreaming: false } : msg
            )
          : prev.messages
        if (event.loopInterrupted) {
          messages = [
            ...messages,
            {
              id: `loop-interrupt-${Date.now()}`,
              role: 'system',
              content: [{ type: 'text', text: '⚠️ 检测到工具调用循环，已自动中止。请重新描述你的需求，或提供更多信息。' }],
              parts: [],
              timestamp: Date.now(),
              isStreaming: false,
              toolCalls: [],
            },
          ]
        }
        return {
          ...prev,
          messages,
          turnStats: {
            toolUseCount: event.totalToolUseCount,
            totalTokens: event.totalTokens,
            durationMs: event.durationMs,
          },
          isStreaming: false,
          // 本轮正常结束的时间戳：供 UI 监听以自动发送等待队列（中止/错误路径不更新）
          lastTurnEndAt: Date.now(),
          // 本轮结束：清除「降级」提示，下轮 agent:turn:start 已置 healthy；保留全局 error 由用户下一条处理
          llmRouteStatus: prev.llmRouteStatus === 'error' ? 'error' : 'healthy',
          llmRouteDetail: prev.llmRouteStatus === 'error' ? prev.llmRouteDetail : null,
        }
      })
      break
    }

    case 'agent:turn:file-changes': {
      if (event.fileChanges.length === 0) break
      updateSessionState(sessionKey, (prev) => {
        let targetIdx = prev.messages.findIndex(
          (message) => message.id === event.messageId && message.role === 'assistant',
        )
        if (targetIdx < 0) {
          for (let i = prev.messages.length - 1; i >= 0; i--) {
            const message = prev.messages[i]!
            if (message.role === 'assistant' && !message.sourceAgent && message.turnId === event.runId) {
              targetIdx = i
              break
            }
          }
        }
        if (targetIdx < 0) {
          debugLog('[AgentRuntime] file-changes 未找到目标消息:', event.messageId)
          return prev
        }
        const messages = [...prev.messages]
        messages[targetIdx] = {
          ...messages[targetIdx]!,
          fileChanges: [...event.fileChanges],
        }
        return { ...prev, messages }
      })
      break
    }

    case 'agent:idle': {
      flushPendingDeltas()
      // 子 Agent 空闲不重置主 Agent 全局状态
      if (isSubAgentStreamEvent(event)) break
      // idle 是 turn:end 之后的收尾事件，此时映射已由 turn:end 清理，无需重复清理
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        messages: finalizeStreamingAssistantMessages(prev.messages, true),
        activeRunId: null,
        isStreaming: false,
        isThinking: false,
        currentTool: null,
      }))
      break
    }

    case 'agent:error': {
      flushPendingDeltas()
      // 错误路径：turn:end 不会到来，需在此清理映射
      unregisterRunSession(event.runId)
      notifyLlmError({
        code: event.errorCode,
        message: event.errorMessage,
        retryable: event.isRetryable,
      })
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        messages: finalizeStreamingAssistantMessages(prev.messages, true, true),
        error: {
          code: event.errorCode,
          message: event.errorMessage,
          retryable: event.isRetryable,
        },
        isStreaming: false,
        isThinking: false,
        currentTool: null,
        llmRouteStatus: 'error',
        llmRouteDetail: `${event.errorCode}: ${event.errorMessage}`,
      }))
      break
    }

    case 'agent:llm:diagnostic': {
      if (event.kind === 'fallback') {
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          llmRouteStatus: 'degraded',
          llmRouteDetail: `降级: ${event.fromModelId} → ${event.toModelId}（${event.reason}）`,
        }))
      } else if (event.kind === 'http_error') {
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          llmRouteDetail: `HTTP ${event.status} ${event.code}${event.retryable ? '（可重试）' : ''}`,
        }))
      }
      break
    }

    case 'agent:abort': {
      flushPendingDeltas()
      // 中止路径：turn:end 不会到来，需在此清理映射
      unregisterRunSession(event.runId)
      // 子 Agent 被中止不重置**会话级**流式态（与 turn:start / turn:end / idle 同一判据）：
      // 级联中止时子事件会把父会话的 isStreaming/isThinking/activeRunId 一起清掉，
      // 父气泡随即表现为「凭空结束」。这里只收尾该子 Agent 自己的消息 ——
      // 它的工具不会再有 tool_end，不收尾会永久显示「执行中」。
      if (isSubAgentStreamEvent(event)) {
        const abortedInstanceId = event.instanceId
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          messages: prev.messages.map((msg) => {
            // 只动子 Agent 消息；缺 instanceId 时退化为「收尾全部子消息」，父气泡仍不受影响
            if (msg.role !== 'assistant' || !msg.sourceAgent) return msg
            if (abortedInstanceId && msg.sourceAgent.instanceId !== abortedInstanceId) return msg
            return {
              ...msg,
              parts: finalizeAssistantParts(msg.parts, { interrupted: true }),
              isStreaming: false,
            }
          }),
        }))
        break
      }
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        messages: finalizeStreamingAssistantMessages(prev.messages, true, true),
        activeRunId: null,
        isStreaming: false,
        isThinking: false,
        currentTool: null,
      }))
      break
    }

    case 'agent:permission:request': {
      const receivedAt = Date.now()
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        pendingPermission: {
          requestId: event.requestId,
          toolName: event.toolName,
          toolArgs: event.toolArgs,
          riskLevel: event.riskLevel,
          description: event.description,
          timeoutMs: event.timeoutMs,
          receivedAt,
        },
      }))
      // 超时自动清除权限弹窗
      if (event.timeoutMs > 0) {
        const reqId = event.requestId
        setTimeout(() => {
          updateSessionState(sessionKey, (prev) => {
            if (prev.pendingPermission?.requestId !== reqId) return prev
            return { ...prev, pendingPermission: null }
          })
        }, event.timeoutMs)
      }
      break
    }

    /**
     * 审批被解决（用户响应 / 超时 / 放行）→ 收起审批卡。
     *
     * 自动放行时主进程把 request 与 granted 连着发，这里按 requestId 清掉，
     * 免得 ChatPage 的兜底自动审批再发一次多余的 `allow-once`（日志里
     * "already resolved or timed out" 的噪音就是这么来的）。
     */
    case 'agent:permission:granted':
    case 'agent:permission:denied':
    case 'agent:permission:timeout': {
      const reqId = event.requestId
      updateSessionState(sessionKey, (prev) => {
        if (prev.pendingPermission?.requestId !== reqId) return prev
        return { ...prev, pendingPermission: null }
      })
      break
    }

    case 'agent:ask-user:request': {
      const receivedAt = Date.now()
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        pendingAskUser: {
          requestId: event.requestId,
          instanceId: event.instanceId,
          context: event.context,
          questions: event.questions,
          timeoutMs: event.timeoutMs,
          receivedAt,
        },
      }))
      if (event.timeoutMs > 0) {
        const reqId = event.requestId
        setTimeout(() => {
          updateSessionState(sessionKey, (prev) => {
            if (prev.pendingAskUser?.requestId !== reqId) return prev
            return { ...prev, pendingAskUser: null }
          })
        }, event.timeoutMs)
      }
      break
    }

    case 'agent:ask-user:cancelled': {
      const reqId = event.requestId
      updateSessionState(sessionKey, (prev) => {
        if (prev.pendingAskUser?.requestId !== reqId) return prev
        return { ...prev, pendingAskUser: null }
      })
      break
    }

    case 'conversation:message:new': {
      debugLog('[AgentRuntime] conversation:message:new sessionKey:', sessionKey, 'msgId:', event.message.id, 'role:', event.message.role)
      updateSessionState(sessionKey, (prev) => {
        // 主窗口 sendMessage 已乐观写入同 id 时跳过，避免重复气泡
        if (prev.messages.some((m) => m.id === event.message.id)) {
          return prev
        }
        return {
          ...prev,
          messages: trimMessages([
            ...prev.messages,
            {
              id: event.message.id,
              role: event.message.role,
              content: event.message.content,
              parts: [],
              timestamp: event.message.timestamp,
              isStreaming: false,
              ...(event.message.isVoice ? { isVoice: true } : {}),
              ...(event.message.audioWavBase64 ? { audioWavBase64: event.message.audioWavBase64 } : {}),
              toolCalls: (event.message.toolCalls ?? []).map((tc) => ({
                ...tc,
                status: (tc.isError ? 'error' : 'completed') as 'error' | 'completed',
                isError: tc.isError ?? false,
              })),
            },
          ]),
        }
      })
      break
    }

    case 'runtime:ready':
      // bridge.initialize() 完成后推送，触发渲染侧历史会话加载
      runtimeStore.setState((prev) => ({ ...prev, isReady: true }))
      break

    case 'conversation:created':
    case 'conversation:updated':
      // 不影响消息状态，只递增列表版本号，让 ChatPage 重拉侧栏
      runtimeStore.setState((prev) => ({
        ...prev,
        sessionListRevision: prev.sessionListRevision + 1,
      }))
      break

    case 'conversation:navigate': {
      // 外部通道（微信 /new 命令等）触发会话切换：初始化目标会话状态并切换当前会话
      const navKey = event.sessionKey
      runtimeStore.setState((prev) => {
        const newSessions = new Map(prev.sessions)
        if (!newSessions.has(navKey)) {
          newSessions.set(navKey, getDefaultPerSessionState())
        }
        return { ...prev, sessions: newSessions, currentSessionKey: navKey }
      })
      // 通道入站只通过 conversation:message:new 注入最新一条占位消息，不会拉 DB 历史。
      // 若不触发 switchSession，UI 只会显示最新一条，表现为「聊天记录消失」。
      window.dispatchEvent(new CustomEvent('mtbot:session-switch-request', { detail: { sessionKey: navKey } }))
      break
    }

    case 'agent:file:created': {
      // 将文件事件追加到对应会话的 fileEvents 中
      const fileEvent: RuntimeFileEvent = {
        fileId: event.fileId,
        fileName: event.fileName,
        localPath: event.localPath,
        mimeType: event.mimeType,
        fileSize: event.fileSize,
        conversationId: event.conversationId,
        messageId: event.messageId,
        agentId: event.agentId,
        channel: event.channel,
        category: event.category,
      }
      // 文件事件按 conversationId 路由（无 sessionKey，用 conversationId 作为 sessionKey）
      const fileSessionKey = event.conversationId ?? sessionKey
      updateSessionState(fileSessionKey, (prev) => ({
        ...prev,
        fileEvents: [...prev.fileEvents, fileEvent],
      }))
      break
    }

    case 'agent:activity:snapshot': {
      // snapshot 到达时同步更新 activeAgents，并回填子 Agent 消息中可能遗留的占位 label
      // （处理 agent:message:start 先于 snapshot 到达的竞态场景）。
      // 只回填占位值，绝不覆盖定义侧的真实名——快照名可能退化成 user-… 编码 id，
      // 见 sub-agent-label.ts 文件头。
      updateSessionState(sessionKey, (prev) => {
        const idToName = new Map(event.agents.map((a) => [a.instanceId, a.name]))
        let messagesChanged = false
        const nextMessages = prev.messages.map((msg) => {
          if (!msg.sourceAgent) return msg
          const preferredName = resolveBackfilledAgentLabel(
            msg.sourceAgent.label,
            msg.sourceAgent.instanceId,
            idToName.get(msg.sourceAgent.instanceId),
          )
          if (!preferredName) return msg
          messagesChanged = true
          return {
            ...msg,
            sourceAgent: { ...msg.sourceAgent, label: preferredName },
          }
        })
        return {
          ...prev,
          activeAgents: event.agents,
          ...(messagesChanged ? { messages: nextMessages } : {}),
        }
      })
      break
    }

    case 'agent:subagent:completed': {
      // 异步子 Agent 完成：结果已投回父会话（父 Agent 接着产出回复）。
      // 用户不在父会话（或窗口不在前台）时弹桌面通知，点击直达父会话。
      if (event.status === 'cancelled') break
      const focusedOnParent =
        typeof document !== 'undefined'
        && document.hasFocus()
        && runtimeStore.getState().currentSessionKey === sessionKey
      if (focusedOnParent) break
      const statusText = event.status === 'succeeded' ? '已完成' : event.status === 'stale' ? '已超时' : '执行失败'
      const preview = event.summaryPreview.trim()
      // 哨兵值不是内容：整条摘要就是 NO_REPLY 时按「无摘要」走兜底文案
      const hasSummary = preview.length > 0 && !/^no_reply$/i.test(preview)
      const body = hasSummary
        ? preview.length > 120
          ? `${preview.slice(0, 120)}…`
          : preview
        : '结果已汇入会话，点击查看'
      notifyDesktop(`Lumii · ${event.name} ${statusText}`, body, sessionKey)
      break
    }

    case 'agent:context:usage': {
      const ratio = event.contextWindow > 0 ? event.usedTokens / event.contextWindow : 0
      // 占用率只影响 contextUsage 派生字段；isAutoCompacting 由压缩生命周期事件驱动，
      // 否则占用停在高位时每次 usage 推送都会把它重置为 true，spinner 永久转
      updateSessionState(sessionKey, (prev) => {
        const cur = prev.contextUsage
        // 每次 LLM 往返都会推一次，值没变就别换引用：useSyncExternalStore 没配
        // equality 函数，换引用会让 ChatPage / ChatInput（memo 被 prop 击穿）白重渲染。
        if (
          cur
          && cur.usedTokens === event.usedTokens
          && cur.contextWindow === event.contextWindow
          && cur.triggerThreshold === event.triggerThreshold
          && event.breakdown === undefined
          && event.budget === undefined
        ) {
          return prev
        }
        return {
          ...prev,
          contextUsage: {
            usedTokens: event.usedTokens,
            contextWindow: event.contextWindow,
            triggerThreshold: event.triggerThreshold,
            isNearThreshold: ratio > 0.6,
            ...(event.breakdown
              ? { breakdown: event.breakdown }
              : cur?.breakdown
                ? { breakdown: cur.breakdown }
                : {}),
            // 触发线快照只在完整推送里带，轻量推送沿用上一次
            ...(event.budget
              ? { budget: event.budget }
              : cur?.budget
                ? { budget: cur.budget }
                : {}),
          },
        }
      })
      break
    }

    case 'agent:context:compacted': {
      updateSessionState(sessionKey, (prev) => {
        const ratio = prev.contextUsage && prev.contextUsage.contextWindow > 0
          ? event.newTokenCount / prev.contextUsage.contextWindow
          : 0
        const convBefore = event.conversationTokensBefore
        const convAfter = event.conversationTokensAfter
        const breakdown = event.breakdown
          ?? (prev.contextUsage?.breakdown && convBefore != null && convAfter != null
            ? patchBreakdownAfterConversationCompact(prev.contextUsage.breakdown, convBefore, convAfter)
            : prev.contextUsage?.breakdown)
        // 同一 run 内的连续压缩（压缩链）合并为一张卡片：保留首次 tokensBefore、
        // 累计移出消息数、更新时间戳与最新摘要，避免一次请求刷出一排卡片。
        const last = prev.compactionEvents[prev.compactionEvents.length - 1]
        const mergeable = event.runId != null && last?.runId === event.runId
        const newCompactionEvent: RuntimeCompactionEvent = {
          id: mergeable && last ? last.id : `compaction-${event.timestamp}`,
          timestamp: event.timestamp,
          tokensBefore: mergeable && last ? last.tokensBefore : event.previousTokenCount,
          tokensAfter: event.newTokenCount,
          messagesRemoved: mergeable && last ? last.messagesRemoved + event.messagesRemoved : event.messagesRemoved,
          messagesBefore: mergeable && last ? last.messagesBefore : (event.messagesBefore ?? event.messagesRemoved),
          messagesAfter: event.messagesAfter ?? (mergeable && last ? last.messagesAfter : 0),
          ...(event.runId
            ? { runId: event.runId }
            : mergeable && last?.runId
              ? { runId: last.runId }
              : {}),
          ...(event.summaryText
            ? { summaryText: event.summaryText }
            : mergeable && last?.summaryText
              ? { summaryText: last.summaryText }
              : {}),
        }
        return {
          ...prev,
          isAutoCompacting: false,
          compactionEvents: mergeable && last
            ? [...prev.compactionEvents.slice(0, -1), newCompactionEvent]
            : [...prev.compactionEvents, newCompactionEvent],
          ...(prev.contextUsage ? {
            contextUsage: {
              ...prev.contextUsage,
              usedTokens: event.newTokenCount,
              isNearThreshold: ratio > 0.6,
              ...(breakdown ? { breakdown } : {}),
            },
          } : {}),
        }
      })
      break
    }

    // ── 客户端命令工具事件 ──

    case 'session:create-request' as AgentRuntimeEventType: {
      window.dispatchEvent(new CustomEvent('mtbot:session-create-request'))
      break
    }

    case 'session:cleared' as AgentRuntimeEventType: {
      const clearedKey = (event as unknown as { sessionKey: string }).sessionKey
      clearTurnTextStart(clearedKey)
      updateSessionState(clearedKey, (prev) => ({
        ...prev,
        messages: [],
      }))
      break
    }

    case 'session:compact-request' as AgentRuntimeEventType: {
      const { sessionKey: targetKey, keepRecentTurns } = event as unknown as { sessionKey: string; keepRecentTurns: number }
      window.dispatchEvent(new CustomEvent('mtbot:compact-request', { detail: { sessionKey: targetKey, keepRecentTurns } }))
      break
    }

    case 'session:switch-request' as AgentRuntimeEventType: {
      const { sessionKey: targetKey } = event as unknown as { sessionKey: string }
      window.dispatchEvent(new CustomEvent('mtbot:session-switch-request', { detail: { sessionKey: targetKey } }))
      break
    }

    case 'settings:think-level' as AgentRuntimeEventType: {
      const { level } = event as unknown as { level: string }
      try { localStorage.setItem('mtbot:think-level', level) } catch {}
      window.dispatchEvent(new CustomEvent('mtbot:think-level-changed', { detail: { level } }))
      break
    }

    case 'settings:backend-changed' as AgentRuntimeEventType: {
      const { backendId } = event as unknown as { backendId: string }
      try { localStorage.setItem('mtbot:acp-backend', backendId) } catch {}
      window.dispatchEvent(new CustomEvent('mtbot:backend-changed', { detail: { backendId } }))
      break
    }

    case 'agent:team:generated' as AgentRuntimeEventType:
    case 'agent:team:optimized' as AgentRuntimeEventType:
    case 'agent:removed' as AgentRuntimeEventType: {
      // 通知渲染进程刷新 Agent 列表
      window.dispatchEvent(new CustomEvent('mtbot:agents-changed'))
      break
    }
  }
}
