/**
 * 单个 Agent 实例的运行时事件管道：日志、SQLite 持久化、权限 IPC、旧/新格式转发。
 * 从 AgentRuntimeBridge.createInstance 拆出以降低主类体积并保持职责单一。
 */

import type {
  AgentRuntimeEvent,
  AssistantPart,
  AssistantPartsContent,
  ConversationRepo,
  FileChangeEntry,
  FileRepo,
} from '@mtbot/agent-runtime'
import {
  applyAssistantPartEvent,
  diffTurnSnapshots,
  finalizeAssistantParts,
  providerPromptTokens,
} from '@mtbot/agent-runtime'
import { convertOldEventToIpcEvents, parseThinkTagsFromRaw, type RunContext } from './event-converter'
import { resetAppUiToolTurnQuotas } from './bridge-app-ui-tools'
import { forwardPermissionRuntimeToIpc } from './bridge-permission-ipc-forward'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { FileMemoryHandler } from './file-memory-handler'
import type {
  AgentRuntimeEvent as RendererIpcEvent,
  ContextUsageBreakdownEntry,
} from '../../shared/agent-runtime-events'
import type { InstanceStateStore } from './bridge-instance-state'
import { agentRuntimeLog as log, parseJsonToolResultPayload } from './bridge-utils'
import { recordUsage } from '../usage-store'
import { markRunStart, markFirstToken, clearRun } from '../provider-latency'
import { captureWorkspaceTurnSnapshot } from '../workspace-vcs/workspace-turn-snapshot'
import { applyConversationCompactToUsage } from '../../shared/context-usage-compact'

/** 单实例运行时累计指标（主进程内部，与 DetailPanel「运行状态」对应） */
export interface InstanceRuntimeMetrics {
  definitionId: string
  runningStartedAt: number | null
  completedTurns: number
  inputTokens: number
  outputTokens: number
}

type AssistantPartsMetadata = Pick<AssistantPartsContent, 'usage' | 'sourceAgent' | 'fileChanges'>

/**
 * 将 parts 收尾为数据库内容，并兼容仅通过原始 <think> 标签提供思考内容的模型。
 */
export function createAssistantPartsContent(
  parts: readonly AssistantPart[],
  metadata: AssistantPartsMetadata = {},
): AssistantPartsContent {
  let finalizedParts = finalizeAssistantParts(parts)
  const hasThinkingPart = finalizedParts.some((part) => part.type === 'thinking')
  const fallbackThinkingTexts: string[] = []
  const normalizedParts: AssistantPart[] = []

  for (const part of finalizedParts) {
    if (part.type !== 'text') {
      normalizedParts.push(part)
      continue
    }
    const { thinkingText, finalText } = parseThinkTagsFromRaw(part.text)
    if (!thinkingText) {
      normalizedParts.push(part)
      continue
    }
    fallbackThinkingTexts.push(thinkingText)
    if (finalText) normalizedParts.push({ ...part, text: finalText, status: 'done' })
  }
  finalizedParts = normalizedParts

  if (!hasThinkingPart && fallbackThinkingTexts.length > 0) {
    const fallbackThinking = finalizeAssistantParts(
      applyAssistantPartEvent([], {
        kind: 'thinking_delta',
        delta: fallbackThinkingTexts.join('\n\n'),
      }),
    )[0]
    if (fallbackThinking) {
      finalizedParts.unshift(fallbackThinking)
    }
  }

  return {
    type: 'assistant_parts',
    parts: finalizedParts,
    ...(metadata.usage ? { usage: metadata.usage } : {}),
    ...(metadata.sourceAgent ? { sourceAgent: metadata.sourceAgent } : {}),
    ...(metadata.fileChanges ? { fileChanges: metadata.fileChanges } : {}),
  }
}

/**
 * 提取 parts 中的最终正文，供记忆与技能进化回调复用。
 */
function assistantTextFromParts(parts: readonly AssistantPart[]): string {
  return parts
    .filter((part): part is Extract<AssistantPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

/**
 * 构造流式写入内容，保持 pendingParts 中的实时状态不被提前收尾。
 */
function createStreamingAssistantPartsContent(
  parts: readonly AssistantPart[],
  metadata: AssistantPartsMetadata = {},
): AssistantPartsContent {
  return {
    type: 'assistant_parts',
    parts: [...parts],
    ...(metadata.usage ? { usage: metadata.usage } : {}),
    ...(metadata.sourceAgent ? { sourceAgent: metadata.sourceAgent } : {}),
  }
}

/**
 * 将流式中的 assistant 消息落库为已完成状态，保留已有文本与工具调用记录。
 * 用于 agent:error / 自愈重试等场景，避免删除导致「继续」时历史丢失。
 */
function finalizeStreamingAssistantMessage(params: {
  conversationRepo: ConversationRepo
  messageId: string
  conversationId: string
  parts: readonly AssistantPart[]
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  sourceAgent?: { instanceId: string; label: string }
  logTag: string
}): boolean {
  const { conversationRepo, messageId, conversationId, parts, usage, sourceAgent, logTag } = params
  const contentJson = createAssistantPartsContent(parts, { usage, sourceAgent })
  const hasContent = contentJson.parts.some(
    (part) => part.type === 'tool' || part.text.trim().length > 0,
  )
  if (!hasContent) return false
  try {
    conversationRepo.updateMessageContent({
      messageId,
      conversationId,
      contentJson,
      isStreaming: false,
    })
    log.info(
      `[event] ${logTag} 已保留中断消息 messageId=${messageId}, parts=${contentJson.parts.length}`,
    )
    return true
  } catch (err) {
    log.error(`[event] ${logTag} 保留中断消息失败:`, err)
    return false
  }
}

/**
 * createAgentInstanceRuntimeEventHandler 所需的依赖（均为 bridge 上的引用，零拷贝传递）
 */
export interface BridgeAgentInstanceEventDeps {
  instanceId: string
  ctx: RunContext
  ipcChannel: BridgeRendererIpcChannel
  conversationRepo: ConversationRepo | null
  fileRepo: FileRepo | null
  fileMemoryHandler: FileMemoryHandler
  /** Per-instance 聚合状态存储（替代分散 Map） */
  instanceStates: InstanceStateStore
  instanceToConversation: Map<string, string>
  toolCallInstanceMap: Map<string, string>
  toolStartTimeMap: Map<string, number>
  nodeStreamCallbacks: Map<string, (event: AgentRuntimeEvent) => void>
  getCompactionForRootSession: (rootSessionKey: string) => {
    contextWindow: number
    outputReserveTokens: number
    summaryReserveTokens: number
  }
  /** 按消息估算的上下文用量（优先提供商 inputTokens） */
  getSessionContextUsage: (sessionKey: string) => {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly ContextUsageBreakdownEntry[]
  }
  /** 记录提供商返回的 inputTokens，供上下文用量条使用 */
  setSessionProviderInputTokens: (sessionKey: string, inputTokens: number) => void
  /** 压缩后清除提供商 token 缓存 */
  clearSessionProviderInputTokens: (sessionKey: string) => void
  /** 与 bridge.currentToolExecutorInstanceId 同步（tool:start / tool:end） */
  setCurrentToolExecutorInstanceId: (id: string | undefined) => void
  /** Agent 显示名称（用于子 Agent 消息持久化 sourceAgent.label） */
  agentName?: string
  /** 是否为子 Agent（子 Agent 消息需持久化 sourceAgent 信息） */
  isSubAgent?: boolean
  /** 对话结束后回调（客户端侧记忆记录，fire-and-forget） */
  onConversationEnd?: (convId: string, assistantText: string) => void
  /** 获取当前工作区目录，用于回合结束快照。 */
  getCwd: () => string
  /** 每条 assistant 消息持久化完成后回调（用于自动快照等工作） */
  onAssistantMessagePersisted?: (params: { conversationId: string; runId: string }) => void
  /** 技能进化：轮次结束后回调（fire-and-forget） */
  onTurnComplete?: (instanceId: string, messages: import('../skill-evolution/types').ConversationMessage[]) => void
}

const CONTEXT_USAGE_TRIGGER_THRESHOLD = 0.8

/**
 * 构造 Agent 实例的 subscribe 回调：处理一轮内的持久化、IPC 与 Gateway 节点流回调。
 */
export function createAgentInstanceRuntimeEventHandler(
  deps: BridgeAgentInstanceEventDeps,
): (event: AgentRuntimeEvent) => void {
  const {
    instanceId,
    ctx,
    ipcChannel,
    conversationRepo,
    fileRepo,
    fileMemoryHandler,
    instanceStates,
    instanceToConversation,
    toolCallInstanceMap,
    toolStartTimeMap,
    nodeStreamCallbacks,
    getCompactionForRootSession,
    getSessionContextUsage,
    setSessionProviderInputTokens,
    setCurrentToolExecutorInstanceId,
    agentName,
    isSubAgent,
    onConversationEnd,
    getCwd,
    onTurnComplete,
    onAssistantMessagePersisted,
  } = deps
  const sourceAgentInfo = isSubAgent && agentName ? { instanceId, label: agentName } : undefined
  const streamingPersistIntervalMs = 100
  let streamingPersistTimer: ReturnType<typeof setTimeout> | undefined
  let lastStreamingPersistAt = 0

  /**
   * 立即将当前 pendingParts 同步到流式占位行。
   */
  function writeCurrentStreamingParts(logTag: string): void {
    const state = instanceStates.get(instanceId)
    const messageId = state?.streamingAssistantMsgId
    const conversationId = instanceToConversation.get(instanceId)
    if (
      !state ||
      !messageId ||
      messageId === '__PLACEHOLDER_FAILED__' ||
      !conversationId ||
      !conversationRepo
    ) {
      return
    }

    try {
      lastStreamingPersistAt = Date.now()
      conversationRepo.updateMessageContent({
        messageId,
        conversationId,
        contentJson: createStreamingAssistantPartsContent(state.pendingParts, {
          usage: state.lastAssistantUsage,
          sourceAgent: sourceAgentInfo,
        }),
        isStreaming: true,
      })
    } catch (err) {
      log.error(`[event] ${logTag} 持久化失败:`, err)
    }
  }

  /**
   * 合并高频 token 写入；工具边界可强制立即落库。
   */
  function persistCurrentStreamingParts(logTag: string, force = false): void {
    if (force) {
      cancelPendingStreamingPersist()
      writeCurrentStreamingParts(logTag)
      return
    }

    const delay = streamingPersistIntervalMs - (Date.now() - lastStreamingPersistAt)
    if (delay <= 0 && !streamingPersistTimer) {
      writeCurrentStreamingParts(logTag)
      return
    }
    if (streamingPersistTimer) return

    streamingPersistTimer = setTimeout(() => {
      streamingPersistTimer = undefined
      writeCurrentStreamingParts(logTag)
    }, Math.max(0, delay))
  }

  /**
   * 取消尚未执行的流式写，避免覆盖 message:end / agent:end 的终态。
   */
  function cancelPendingStreamingPersist(): void {
    if (!streamingPersistTimer) return
    clearTimeout(streamingPersistTimer)
    streamingPersistTimer = undefined
  }

  /**
   * 执行单个运行时事件；仅 agent:end 的工作区结束快照会异步让出。
   */
  // 高频流式事件（逐 chunk 触发），不逐条落日志，避免刷屏
  const SILENT_EVENT_TYPES = new Set(['message:delta', 'message:thinking', 'tool:update'])

  async function handleRuntimeEvent(event: AgentRuntimeEvent): Promise<void> {
    if (event.type === 'message:delta') {
      // 首个 delta 即首字节，配对 agent:start 得到 TTFB；后续 delta 无副作用
      markFirstToken(instanceId, ctx.resolvedModelId ?? 'unknown')
    } else if (event.type === 'message:end') {
      const llmErr = (event as {
        llmError?: { httpStatus?: number; code?: string; message?: string; retryable?: boolean }
      }).llmError
      if (llmErr) {
        log.error(
          `[event] message:end (LLM ERROR) httpStatus=${llmErr.httpStatus ?? 'N/A'} code=${llmErr.code ?? 'N/A'} message="${llmErr.message ?? 'N/A'}" retryable=${llmErr.retryable ?? 'N/A'}, usage=${JSON.stringify(event.usage)}`,
        )
      } else {
        log.info(
          `[event] message:end fullText="${event.fullText?.slice(0, 80)}", usage=${JSON.stringify(event.usage)}`,
        )
      }
    } else if (event.type === 'agent:error') {
      log.error(
        `[event] agent:error error="${event.error}" errorCode="${(event as { errorCode?: string }).errorCode ?? 'N/A'}"`,
      )
    } else if (!SILENT_EVENT_TYPES.has(event.type)) {
      log.info(`[event] type=${event.type}`)
    }

    if (event.type === 'agent:start') {
      cancelPendingStreamingPersist()
      markRunStart(instanceId)
      const state = instanceStates.get(instanceId)
      // 自愈重试时，删除上一轮的空占位行；有内容的行应 finalize 保留，供「继续」恢复历史
      const prevMsgId = state?.streamingAssistantMsgId
      const prevParts = state?.pendingParts ?? []
      const prevHasContent = prevParts.some(
        (part) => part.type === 'tool' || part.text.trim().length > 0,
      )
      if (prevMsgId && prevMsgId !== '__PLACEHOLDER_FAILED__' && conversationRepo) {
        const convId = instanceToConversation.get(instanceId)
        if (convId) {
          try {
            if (prevHasContent) {
              finalizeStreamingAssistantMessage({
                conversationRepo,
                messageId: prevMsgId,
                conversationId: convId,
                parts: prevParts,
                usage: state?.lastAssistantUsage,
                sourceAgent: sourceAgentInfo,
                logTag: 'agent:start',
              })
            } else {
              conversationRepo.deleteMessage(prevMsgId, convId)
              log.info(`[event] agent:start 删除上轮空占位行 messageId=${prevMsgId}`)
            }
          } catch (err) {
            log.warn(`[event] agent:start 处理上轮占位行异常: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      if (state) {
        state.streamingAssistantMsgId = undefined
        state.pendingParts = []
        state.toolCallArgs = new Map()
        state.lastAssistantUsage = undefined
      }
      // 自愈重试时重置文本累积偏移，避免 message:start 误判为"续轮"导致前端文本重复
      ctx.accumulatedLength = 0
      ctx.completedTurnsLength = 0
      ctx.currentMessageId = ''
      ctx.thinkTagState = 'idle'
      ctx.thinkTagBuf = ''
      const convId = instanceToConversation.get(instanceId)
      if (convId && conversationRepo) {
        const convExists = conversationRepo.getConversation(convId)
        if (!convExists) {
          log.info(`[event] agent:start 跳过占位行：对话已不存在 conversationId=${convId}`)
        } else {
          try {
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson: {
                type: 'assistant_parts',
                parts: [],
                ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
              },
              isStreaming: true,
            })
            if (state) state.streamingAssistantMsgId = row.id
            ctx.currentMessageId = row.id
            log.info(`[event] agent:start 创建流式占位行: msgId=${row.id}, conversationId=${convId}, is_streaming=${row.is_streaming}`)
          } catch (err) {
            log.error(`[event] 流式助手占位行失败:`, err)
            if (state) state.streamingAssistantMsgId = '__PLACEHOLDER_FAILED__'
          }
        }
      }
    }

    {
      const m = instanceStates.get(instanceId)?.metrics
      if (m) {
        if (event.type === 'agent:state-change') {
          if (event.state === 'running') {
            m.runningStartedAt = Date.now()
          } else {
            m.runningStartedAt = null
          }
        }
        if (event.type === 'agent:end') {
          m.completedTurns++
        }
        if (event.type === 'message:end' && event.usage) {
          m.inputTokens += event.usage.inputTokens ?? 0
          m.outputTokens += event.usage.outputTokens ?? 0
        }
      }
    }

    forwardPermissionRuntimeToIpc(ipcChannel, instanceId, event)

    if (event.type === 'tool:start') {
      setCurrentToolExecutorInstanceId(instanceId)
      toolCallInstanceMap.set(event.toolCallId, instanceId)
      const state = instanceStates.get(instanceId)
      if (state) {
        const args = (event.args ?? {}) as Record<string, unknown>
        state.toolCallArgs.set(event.toolCallId, args)
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, {
          kind: 'tool_start',
          id: event.toolCallId,
          name: event.toolName,
          args,
          ...(sourceAgentInfo ? { meta: { sourceAgent: sourceAgentInfo } } : {}),
        })
      }
      toolStartTimeMap.set(`${instanceId}:${event.toolCallId}`, Date.now())
      persistCurrentStreamingParts('tool:start', true)

      if (
        state && !state.memoryGuideInjected &&
        (event.toolName === 'memory_search' ||
          event.toolName === 'memory_read' ||
          event.toolName === 'profile_memory' ||
          event.toolName === 'memory_manage')
      ) {
        state.memoryGuideInjected = true
        log.info(`[event] 记忆工具首次调用，标记注入完整记忆指南 instanceId=${instanceId} tool=${event.toolName}`)
      }
    }
    if (event.type === 'tool:end') {
      setCurrentToolExecutorInstanceId(undefined)
      toolCallInstanceMap.delete(event.toolCallId)
      const state = instanceStates.get(instanceId)
      const argMap = state?.toolCallArgs
      const args = argMap?.get(event.toolCallId) ?? {}
      argMap?.delete(event.toolCallId)
      const toolStartMs = toolStartTimeMap.get(`${instanceId}:${event.toolCallId}`)
      toolStartTimeMap.delete(`${instanceId}:${event.toolCallId}`)
      if (state) {
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, {
          kind: 'tool_end',
          id: event.toolCallId,
          name: event.toolName,
          result: event.result,
          isError: event.isError,
        })
      }
      persistCurrentStreamingParts('tool:end', true)

      // 兼容新旧两套工具名：
      // - file_write（覆盖写）、file_edit（按字符串替换写回）使用 params.filePath
      // - writeLocalFile 为旧命名保留兼容
      const isWriteTool =
        event.toolName === 'file_write' ||
        event.toolName === 'file_edit' ||
        event.toolName === 'writeLocalFile'
      if (isWriteTool && !event.isError && fileRepo) {
        void fileMemoryHandler.handleFileWritten(instanceId, args).catch((err: unknown) => {
          log.error(`[file:created] 注册文件元数据失败 instanceId=${instanceId}:`, err)
        })
      }

      // bash/exec 工具：脚本写出的文件（Python/shell）不走 file_write，扫描 outputs/ 补齐注册
      if (event.toolName === 'bash' && !event.isError && fileRepo) {
        void fileMemoryHandler.scanAndRegisterOutputs(instanceId, toolStartMs).catch((err: unknown) => {
          log.error(`[file:created] 扫描 outputs 注册失败 instanceId=${instanceId}:`, err)
        })
      }
    }
    if (event.type === 'message:delta') {
      const state = instanceStates.get(instanceId)
      if (state && event.delta) {
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, { kind: 'thinking_end' })
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, {
          kind: 'text_delta',
          delta: event.delta,
        })
        persistCurrentStreamingParts('message:delta')
      }
    }

    if (event.type === 'message:thinking') {
      const state = instanceStates.get(instanceId)
      if (state && event.delta) {
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, {
          kind: 'thinking_delta',
          delta: event.delta,
        })
        persistCurrentStreamingParts('message:thinking')
      }
    }

    if (event.type === 'message:end') {
      cancelPendingStreamingPersist()
      const state = instanceStates.get(instanceId)
      if (event.usage && state) {
        state.lastAssistantUsage = event.usage
      }
      if (state) {
        state.pendingParts = applyAssistantPartEvent(state.pendingParts, { kind: 'thinking_end' })
        state.pendingParts = createAssistantPartsContent(state.pendingParts).parts
      }
      if (event.usage && ctx.sessionKey === ctx.rootSessionKey) {
        const promptTokens = providerPromptTokens(event.usage)
        if (promptTokens > 0) {
          setSessionProviderInputTokens(ctx.rootSessionKey, promptTokens)
        }
      }
      // 落盘用量：只在服务商真给了 usage 时记，估算值不入库（否则花费统计会失真）
      if (event.usage && ctx.resolvedModelId) {
        void recordUsage({
          model: ctx.resolvedModelId,
          promptTokens: event.usage.inputTokens ?? 0,
          completionTokens: event.usage.outputTokens ?? 0,
          sessionKey: ctx.rootSessionKey,
        })
      }
      const msgId = state?.streamingAssistantMsgId
      const convId = instanceToConversation.get(instanceId)
      const contentJson = createAssistantPartsContent(state?.pendingParts ?? [], {
        usage: event.usage,
        sourceAgent: sourceAgentInfo,
      })
      if (msgId && convId && conversationRepo) {
        try {
          if (msgId === '__PLACEHOLDER_FAILED__') {
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson,
              isStreaming: true,
            })
            if (state) state.streamingAssistantMsgId = row.id
            log.info(`[event] message:end 占位降级 saveMessage 成功, newMsgId=${row.id}`)
          } else {
            conversationRepo.updateMessageContent({
              messageId: msgId,
              conversationId: convId,
              contentJson,
              isStreaming: true,
            })
            log.info(`[event] message:end 更新流式消息内容: msgId=${msgId}, conversationId=${convId}, is_streaming=1, contentLength=${JSON.stringify(contentJson).length}`)
          }
        } catch (err) {
          log.error(`[event] message:end 持久化失败，尝试 saveMessage 降级:`, err)
          try {
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson,
              isStreaming: true,
            })
            if (state) state.streamingAssistantMsgId = row.id
            log.info(`[event] message:end saveMessage 降级成功, newMsgId=${row.id}`)
          } catch (err2) {
            log.error(`[event] message:end 降级也失败，消息可能丢失:`, err2)
            log.error(`[event] message:end 丢失消息上下文: msgId=${msgId}, convId=${convId}, contentLength=${JSON.stringify(contentJson).length}`)
          }
        }
        // 持久化完成 → 触发快照等后处理（fire-and-forget）
        if (onAssistantMessagePersisted && ctx) {
          try {
            onAssistantMessagePersisted({ conversationId: convId, runId: ctx.runId })
          } catch {
            /* 静默吞掉，不阻断事件循环 */
          }
        }
      }
    }

    if (event.type === 'agent:error') {
      cancelPendingStreamingPersist()
      // 请求失败不该留下未配对的起点污染下一轮延迟
      clearRun(instanceId)
      const state = instanceStates.get(instanceId)
      const msgId = state?.streamingAssistantMsgId
      const convId = instanceToConversation.get(instanceId)

      if (msgId && convId && conversationRepo) {
        const preserved = finalizeStreamingAssistantMessage({
          conversationRepo,
          messageId: msgId,
          conversationId: convId,
          parts: state?.pendingParts ?? [],
          usage: state?.lastAssistantUsage,
          sourceAgent: sourceAgentInfo,
          logTag: 'agent:error',
        })
        if (!preserved) {
          try {
            conversationRepo.deleteMessage(msgId, convId)
            log.info(`[event] agent:error 已删除空占位行 messageId=${msgId}`)
          } catch (err) {
            log.error(`[event] agent:error 删除流式行失败:`, err)
          }
        } else if (state) {
          state.pendingParts = []
        }
      }
      if (state) {
        state.streamingAssistantMsgId = undefined
        state.lastAssistantUsage = undefined
      }

    }

    if (event.type === 'agent:end') {
      cancelPendingStreamingPersist()
      // 一轮没产出任何 delta（纯工具轮 / 中断）时清掉起点，否则会被下一轮误配成超长延迟
      clearRun(instanceId)
      const state = instanceStates.get(instanceId)
      const convId = instanceToConversation.get(instanceId)
      const msgId = state?.streamingAssistantMsgId
      let persistedMessageId = msgId
      const usage = state?.lastAssistantUsage
      let fileChanges: FileChangeEntry[] | undefined
      const turnSnapshotStart = state?.turnSnapshotStart
      if (state) state.turnSnapshotStart = undefined
      if (turnSnapshotStart) {
        try {
          const turnSnapshotEnd = await captureWorkspaceTurnSnapshot(getCwd())
          fileChanges = diffTurnSnapshots(turnSnapshotStart, turnSnapshotEnd)
        } catch (err) {
          log.warn(`[turn-snapshot] end failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const contentJson = createAssistantPartsContent(state?.pendingParts ?? [], {
        usage,
        sourceAgent: sourceAgentInfo,
        fileChanges,
      })
      const text = assistantTextFromParts(contentJson.parts)
      const toolParts = contentJson.parts.filter(
        (part): part is Extract<AssistantPart, { type: 'tool' }> => part.type === 'tool',
      )
      const thinkingLength = contentJson.parts
        .filter((part) => part.type === 'thinking')
        .reduce((length, part) => length + part.text.length, 0)

      let persistSuccess = false
      if (convId && msgId && conversationRepo) {
        try {
          if (msgId === '__PLACEHOLDER_FAILED__') {
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson,
              isStreaming: false,
            })
            if (state) state.streamingAssistantMsgId = row.id
            persistedMessageId = row.id
          } else {
            conversationRepo.updateMessageContent({
              messageId: msgId,
              conversationId: convId,
              contentJson,
              isStreaming: false,
            })
            log.info(`[event] agent:end 最终确认消息: msgId=${msgId}, conversationId=${convId}, is_streaming=0, contentLength=${JSON.stringify(contentJson).length}`)
          }
          log.info(`[event] 持久化 AI 回复（收尾） conversationId=${convId}, len=${text.length}, tools=${toolParts.length}, thinkingLen=${thinkingLength}`)
          persistSuccess = true
        } catch (err) {
          log.error(`[event] 持久化 AI 回复失败，保留内存数据以备恢复:`, err)
        }
      } else if (convId && (text.trim() || toolParts.length > 0)) {
        const convExists = conversationRepo?.getConversation(convId)
        if (!convExists) {
          log.info(`[event] agent:end 跳过持久化：对话已不存在 conversationId=${convId}`)
        } else {
          try {
            const row = conversationRepo?.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson,
            })
            persistedMessageId = row?.id
            log.info(
              `[event] 持久化 AI 回复（无流式占位） conversationId=${convId}, msgId=${row?.id}, is_streaming=0, len=${text.length}, tools=${toolParts.length}, thinkingLen=${thinkingLength}`,
            )
            persistSuccess = true
          } catch (err) {
            log.error(`[event] 持久化 AI 回复失败:`, err)
          }
        }
      }

      if (persistSuccess || !convId) {
        // 在清空之前保存本轮工具调用记录，供技能进化使用
        const toolsBeforeClear = toolParts.filter((part) => part.status !== 'running')
        if (state) {
          state.pendingParts = []
          state.streamingAssistantMsgId = undefined
          state.lastAssistantUsage = undefined
        }

        // 客户端侧记忆记录（fire-and-forget，不阻塞事件处理）
        if (persistSuccess && convId && text.trim() && onConversationEnd && !isSubAgent) {
          try {
            onConversationEnd(convId, text)
          } catch (err) {
            log.warn(`[event] onConversationEnd 回调异常: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // 技能进化：轮次结束后分析对话（fire-and-forget，不阻塞）
        if (onTurnComplete && !isSubAgent && convId) {
          const convMessages = conversationRepo?.loadMessagesAsPiFormat(convId, { limit: 50 })
          if (convMessages && convMessages.length > 0) {
            // 补充本轮工具调用记录（loadMessagesAsPiFormat 只含 user/assistant）
            const toolMsgs = toolsBeforeClear.map(t => ({
              role: 'tool' as const,
              content: typeof t.result === 'string' ? t.result : JSON.stringify(t.result),
              toolName: t.name,
            }))
            log.info(`[SkillEvolution] 传入 observer: user/assistant=${convMessages.length}, toolMsgs=${toolMsgs.length}, uniqueTools=${[...new Set(toolMsgs.map(t => t.toolName))].join(',')}`)
            const mapped = [
              ...convMessages.map(m => ({
                role: m.role as 'user' | 'assistant',
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
              })),
              ...toolMsgs,
            ]
            void Promise.resolve(onTurnComplete(instanceId, mapped)).catch((err: unknown) => {
              log.warn(`[event] onTurnComplete 回调异常: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
        }
      } else {
        log.warn(`[event] agent:end 持久化未成功，保留内存数据 instanceId=${instanceId}`)
      }

      if (persistSuccess && fileChanges && persistedMessageId) {
        ipcChannel.forwardIpcEvent({
          type: 'agent:turn:file-changes',
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          messageId: persistedMessageId,
          fileChanges,
          instanceId: ctx.instanceId,
          rootSessionKey: ctx.rootSessionKey,
        })
      }

    }

    // 自动压缩只扣对话历史：用压缩前整窗占用减对话差值，并写入种子，避免 MCP 定义被等比缩放
    let compactionOverlay: {
      previousTokenCount: number
      newTokenCount: number
      conversationTokensBefore: number
      conversationTokensAfter: number
      contextWindow: number
      triggerThreshold: number
    } | null = null
    if (event.type === 'context:compaction' && ctx.sessionKey === ctx.rootSessionKey) {
      const usageBefore = getSessionContextUsage(ctx.rootSessionKey)
      const previousTokenCount =
        usageBefore.usedTokens > 0 ? usageBefore.usedTokens : event.tokensBefore
      const newTokenCount = applyConversationCompactToUsage(
        previousTokenCount,
        event.tokensBefore,
        event.tokensAfter,
      )
      setSessionProviderInputTokens(ctx.rootSessionKey, newTokenCount)
      compactionOverlay = {
        previousTokenCount,
        newTokenCount,
        conversationTokensBefore: event.tokensBefore,
        conversationTokensAfter: event.tokensAfter,
        contextWindow: usageBefore.contextWindow,
        triggerThreshold: usageBefore.triggerThreshold,
      }
    }

    ipcChannel.forwardToRenderer(event)

    const nodeStreamCb = nodeStreamCallbacks.get(instanceId)
    if (nodeStreamCb) {
      try {
        nodeStreamCb(event)
      } catch (err) {
        log.error(
          `[nodeStream] 回调异常: instanceId=${instanceId} error=${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const ipcEvents = convertOldEventToIpcEvents(event, ctx)
    for (const ipcEvent of ipcEvents) {
      if (ipcEvent.type === 'agent:turn:end') {
        resetAppUiToolTurnQuotas()
      }
      if (ipcEvent.type === 'agent:context:compacted' && compactionOverlay) {
        ipcChannel.forwardIpcEvent({
          ...ipcEvent,
          previousTokenCount: compactionOverlay.previousTokenCount,
          newTokenCount: compactionOverlay.newTokenCount,
          conversationTokensBefore: compactionOverlay.conversationTokensBefore,
          conversationTokensAfter: compactionOverlay.conversationTokensAfter,
        })
        ipcChannel.forwardIpcEvent({
          type: 'agent:context:usage',
          sessionKey: ctx.rootSessionKey,
          usedTokens: compactionOverlay.newTokenCount,
          contextWindow: compactionOverlay.contextWindow,
          triggerThreshold: compactionOverlay.triggerThreshold,
        } as unknown as RendererIpcEvent)
      } else {
        ipcChannel.forwardIpcEvent(ipcEvent)
      }
    }

    if (event.type === 'agent:end' && ctx.sessionKey === ctx.rootSessionKey) {
      const usage = getSessionContextUsage(ctx.rootSessionKey)
      ipcChannel.forwardIpcEvent({
        type: 'agent:context:usage',
        sessionKey: ctx.rootSessionKey,
        usedTokens: usage.usedTokens,
        contextWindow: usage.contextWindow,
        triggerThreshold: CONTEXT_USAGE_TRIGGER_THRESHOLD,
        ...(usage.breakdown ? { breakdown: usage.breakdown } : {}),
      } as unknown as RendererIpcEvent)
      const breakdownText = usage.breakdown?.length
        ? ` breakdown=${usage.breakdown.map((e) => `${e.category}:${e.tokens}`).join(',')}`
        : ''
      log.info(
        `[event] 推送 contextUsage: used=${usage.usedTokens}/${usage.contextWindow} (${usage.contextWindow > 0 ? ((usage.usedTokens / usage.contextWindow) * 100).toFixed(1) : '0'}%)${breakdownText}`,
      )
    }
  }

  /**
   * 保持 EventSink 的同步 void 契约，并显式兜住内部异步处理失败。
   */
  return (event: AgentRuntimeEvent): void => {
    void handleRuntimeEvent(event).catch((err: unknown) => {
      log.error(
        `[event] 异步事件处理失败 type=${event.type}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }
}
