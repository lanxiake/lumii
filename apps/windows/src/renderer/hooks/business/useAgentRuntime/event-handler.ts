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
import type { RuntimeToolCall, RuntimeMessage, StreamMetrics, ContextUsage, PerSessionState, RuntimeFileEvent, RuntimeCompactionEvent } from './agent-runtime-store'
import { runtimeStore, updateSessionState, getDefaultPerSessionState } from './agent-runtime-store'
import {
  applyAssistantPartEvent,
  finalizeAssistantParts,
  type AssistantPart,
  type AssistantPartEvent,
} from '@mtbot/agent-runtime/browser'

/** 仅在开发环境输出详细日志，避免生产环境噪音 */
const debugLog = process.env.NODE_ENV === 'development'
  ? (...args: unknown[]) => console.log(...args)
  : () => undefined

let rendererPartIdSequence = 0

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
  err: { code: string; message: string } | undefined,
  contentText: string | undefined,
): AssistantPart[] {
  if (!err || contentText?.trim()) return [...parts]
  return applyRuntimeAssistantPartEvent(parts, {
    kind: 'text_delta',
    delta: `[${err.code}] ${err.message}`,
  })
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
  streamLlmStartByRunId.clear()
  subAgentStreamingMessageId.clear()
  runIdToSessionKey.clear()
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
 */
function finalizeStreamingAssistantMessages(
  messages: readonly RuntimeMessage[],
  closeMessages = false,
): readonly RuntimeMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const hasStreamingPart = message.parts.some(
      (part) => (part.type === 'thinking' || part.type === 'text') && part.status === 'streaming',
    )
    if (!hasStreamingPart && !(closeMessages && message.isStreaming)) return message
    changed = true
    return {
      ...message,
      parts: hasStreamingPart ? finalizeAssistantParts(message.parts) : message.parts,
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
        // 优先级：1) 同一 turn 已有主 Agent 消息 → 复用；2) 最后一条是 streaming 主 Agent 消息 → 复用；3) 创建新消息
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

        // 若没找到同一 turn 的消息，再检查最后一条是否是 streaming 主 Agent 消息（兜底）
        if (reuseIdx < 0) {
          const lastMsg = prev.messages.length > 0 ? prev.messages[prev.messages.length - 1] : null
          if (lastMsg?.role === 'assistant' && lastMsg.isStreaming && !lastMsg.sourceAgent) {
            reuseIdx = prev.messages.length - 1
          }
        }

        if (reuseIdx >= 0) {
          const existingText = prev.messages[reuseIdx]?.content[0]?.text ?? ''
          const separator = existingText ? '\n\n' : ''
          const nextText = existingText + separator
          const msgs = [...prev.messages]
          const existingMessage = msgs[reuseIdx]!
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
              turnId,
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
      // 0-token 空消息：仅在”无结构化错误”时跳过，避免吞掉余额不足等可见错误提示
      if (!event.llmError && !event.usage?.outputTokens && event.content?.[0]?.text === '') {
        break
      }

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
              ? ([{ type: 'text' as const, text: `[${err.code}] ${err.message}` }] as const)
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
          }
          return { ...prev, messages: msgs, isStreaming: keepStreaming }
        })
        break
      }

      // NO_REPLY 协议：Agent 返回 NO_REPLY 表示无需展示消息，移除占位消息
      const finalText = event.content?.[0]?.text?.trim()
      if (finalText === 'NO_REPLY') {
        updateSessionState(sessionKey, (prev) => {
          const msgs = [...prev.messages]
          const lastIdx = msgs.length - 1
          if (lastIdx >= 0 && msgs[lastIdx]?.role === 'assistant') {
            msgs.splice(lastIdx, 1)
          }
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
          // 始终使用流式累积的内容（state machine 已正确剥离 <think> 标签），
          // 不使用 event.content（来自截断的 fullText，可能含 think 内容）。
          // wasResumed 场景下 last.content 已包含前序轮次文本+当前轮流式文本，
          // 直接使用即可，无需追加。
          finalContent = last.content
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
            ? ([{ type: 'text' as const, text: `[${err.code}] ${err.message}` }] as const)
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
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        messages: finalizeStreamingAssistantMessages(prev.messages, true),
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

    case 'agent:ask-user:request': {
      const receivedAt = Date.now()
      updateSessionState(sessionKey, (prev) => ({
        ...prev,
        pendingAskUser: {
          requestId: event.requestId,
          instanceId: event.instanceId,
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
      // 这些事件由会话列表管理，不影响消息状态
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
      // （处理 agent:message:start 先于 snapshot 到达的竞态场景）
      updateSessionState(sessionKey, (prev) => {
        const idToName = new Map(event.agents.map((a) => [a.instanceId, a.name]))
        let messagesChanged = false
        const nextMessages = prev.messages.map((msg) => {
          if (!msg.sourceAgent) return msg
          const preferredName = idToName.get(msg.sourceAgent.instanceId)
          if (!preferredName) return msg
          if (msg.sourceAgent.label === preferredName) return msg
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

    case 'agent:context:usage': {
      const ratio = event.contextWindow > 0 ? event.usedTokens / event.contextWindow : 0
      const contextUsage: ContextUsage = {
        usedTokens: event.usedTokens,
        contextWindow: event.contextWindow,
        triggerThreshold: event.triggerThreshold,
        isNearThreshold: ratio > 0.6,
      }
      const isAutoCompacting = ratio >= event.triggerThreshold
      updateSessionState(sessionKey, (prev) => ({ ...prev, contextUsage, isAutoCompacting }))
      break
    }

    case 'agent:context:compacted': {
      updateSessionState(sessionKey, (prev) => {
        const ratio = prev.contextUsage && prev.contextUsage.contextWindow > 0
          ? event.newTokenCount / prev.contextUsage.contextWindow
          : 0
        const newCompactionEvent = {
          id: `compaction-${event.timestamp}`,
          timestamp: event.timestamp,
          tokensBefore: event.previousTokenCount,
          tokensAfter: event.newTokenCount,
          messagesRemoved: event.messagesRemoved,
          messagesBefore: event.messagesBefore ?? event.messagesRemoved,
          messagesAfter: event.messagesAfter ?? 0,
        }
        return {
          ...prev,
          isAutoCompacting: false,
          compactionEvents: [...prev.compactionEvents, newCompactionEvent],
          ...(prev.contextUsage ? {
            contextUsage: {
              ...prev.contextUsage,
              usedTokens: event.newTokenCount,
              isNearThreshold: ratio > 0.6,
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
      updateSessionState((event as unknown as { sessionKey: string }).sessionKey, (prev) => ({
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
