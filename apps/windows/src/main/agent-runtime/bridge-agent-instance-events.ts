/**
 * 单个 Agent 实例的运行时事件管道：日志、SQLite 持久化、权限 IPC、旧/新格式转发。
 * 从 AgentRuntimeBridge.createInstance 拆出以降低主类体积并保持职责单一。
 */

import type { AgentRuntimeEvent } from '@mtbot/agent-runtime'
import { providerPromptTokens } from '@mtbot/agent-runtime'
import type { ConversationRepo, FileRepo } from '@mtbot/agent-runtime'
import { convertOldEventToIpcEvents, parseThinkTagsFromRaw, type RunContext } from './event-converter'
import { forwardPermissionRuntimeToIpc } from './bridge-permission-ipc-forward'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import type { FileMemoryHandler } from './file-memory-handler'
import type { AgentRuntimeEvent as RendererIpcEvent } from '../../shared/agent-runtime-events'
import type { InstanceStateStore } from './bridge-instance-state'
import { agentRuntimeLog as log, parseJsonToolResultPayload } from './bridge-utils'
import { recordUsage } from '../usage-store'
import { markRunStart, markFirstToken, clearRun } from '../provider-latency'

/** 单实例运行时累计指标（主进程内部，与 DetailPanel「运行状态」对应） */
export interface InstanceRuntimeMetrics {
  definitionId: string
  runningStartedAt: number | null
  completedTurns: number
  inputTokens: number
  outputTokens: number
}

/** 助手轮次内待合并落库的 tool 调用记录 */
export type AssistantTurnToolRecord = {
  id: string
  name: string
  args: Record<string, unknown>
  result: unknown
  isError: boolean
  textPositionAtStart?: number
  durationMs?: number
}

/**
 * 将流式中的 assistant 消息落库为已完成状态，保留已有文本与工具调用记录。
 * 用于 agent:error / 自愈重试等场景，避免删除导致「继续」时历史丢失。
 */
function finalizeStreamingAssistantMessage(params: {
  conversationRepo: ConversationRepo
  messageId: string
  conversationId: string
  text: string
  thinkingText?: string
  tools: readonly AssistantTurnToolRecord[]
  usage?: { inputTokens: number; outputTokens: number; cacheRead?: number; cacheWrite?: number }
  sourceAgent?: { instanceId: string; label: string }
  logTag: string
}): boolean {
  const { conversationRepo, messageId, conversationId, text, thinkingText, tools, usage, sourceAgent, logTag } =
    params
  const hasContent = text.trim().length > 0 || tools.length > 0
  if (!hasContent) return false
  try {
    conversationRepo.updateMessageContent({
      messageId,
      conversationId,
      contentJson: {
        type: 'text',
        text,
        ...(thinkingText ? { thinkingText } : {}),
        ...(tools.length > 0 ? { toolCalls: tools } : {}),
        ...(usage ? { usage } : {}),
        ...(sourceAgent ? { sourceAgent } : {}),
      },
      isStreaming: false,
    })
    log.info(
      `[event] ${logTag} 已保留中断消息 messageId=${messageId}, len=${text.length}, tools=${tools.length}`,
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
  toolTextPositionMap: Map<string, number>
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
    toolTextPositionMap,
    toolStartTimeMap,
    nodeStreamCallbacks,
    getCompactionForRootSession,
    getSessionContextUsage,
    setSessionProviderInputTokens,
    clearSessionProviderInputTokens,
    setCurrentToolExecutorInstanceId,
    agentName,
    isSubAgent,
    onConversationEnd,
    onTurnComplete,
    onAssistantMessagePersisted,
  } = deps

  return (event: AgentRuntimeEvent) => {
    if (event.type === 'message:delta') {
      // 首个 delta 即首字节，配对 agent:start 得到 TTFB；后续 delta 无副作用
      markFirstToken(instanceId, ctx.resolvedModelId ?? 'unknown')
      log.info(`[event] message:delta delta="${event.delta?.slice(0, 80)}"`)
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
          `[event] message:end fullText="${event.fullText?.slice(0, 200)}", usage=${JSON.stringify(event.usage)}`,
        )
      }
    } else if (event.type === 'agent:error') {
      log.error(
        `[event] agent:error error="${event.error}" errorCode="${(event as { errorCode?: string }).errorCode ?? 'N/A'}"`,
      )
    } else {
      log.info(`[event] type=${event.type}`)
    }

    if (event.type === 'agent:start') {
      markRunStart(instanceId)
      const state = instanceStates.get(instanceId)
      // 自愈重试时，删除上一轮的空占位行；有内容的行应 finalize 保留，供「继续」恢复历史
      const prevMsgId = state?.streamingAssistantMsgId
      const prevRawText = state?.accumulatedText ?? ''
      const prevTools = state?.pendingTools ?? []
      const prevHasContent = prevRawText.trim().length > 0 || prevTools.length > 0
      if (prevMsgId && prevMsgId !== '__PLACEHOLDER_FAILED__' && conversationRepo) {
        const convId = instanceToConversation.get(instanceId)
        if (convId) {
          try {
            if (prevHasContent) {
              const { thinkingText: tagThinking, finalText } = parseThinkTagsFromRaw(prevRawText)
              const prevThinking = (state?.accumulatedThinking ?? '').trim().length > 0
                ? state!.accumulatedThinking
                : tagThinking
              const sourceAgentInfo = isSubAgent && agentName ? { instanceId, label: agentName } : undefined
              finalizeStreamingAssistantMessage({
                conversationRepo,
                messageId: prevMsgId,
                conversationId: convId,
                text: finalText,
                thinkingText: prevThinking || undefined,
                tools: prevTools,
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
        state.accumulatedText = ''
        state.accumulatedThinking = ''
        state.pendingTools = []
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
            const sourceAgentInfo = isSubAgent && agentName
              ? { instanceId, label: agentName }
              : undefined
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson: {
                type: 'text',
                text: '',
                ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
              },
              isStreaming: true,
            })
            if (state) state.streamingAssistantMsgId = row.id
            ctx.currentMessageId = row.id
            log.info(`[event] 流式助手占位行 conversationId=${convId}, messageId=${row.id}`)
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
      log.info(
        `[DEBUG tool:start] toolCallId=${event.toolCallId}, instanceId=${instanceId}, toolName=${event.toolName}, mapSize=${toolCallInstanceMap.size}`,
      )
      const state = instanceStates.get(instanceId)
      if (state) {
        state.toolCallArgs.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>)
      }
      const rawTextAtStart = state?.accumulatedText ?? ''
      // textPositionAtStart 必须基于剥离 <think> 后的正文长度，与 UI 渲染位置对齐
      const { finalText: cleanTextAtStart } = parseThinkTagsFromRaw(rawTextAtStart)
      toolTextPositionMap.set(`${instanceId}:${event.toolCallId}`, cleanTextAtStart.length)
      toolStartTimeMap.set(`${instanceId}:${event.toolCallId}`, Date.now())

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
      const textPositionAtStart = toolTextPositionMap.get(`${instanceId}:${event.toolCallId}`)
      toolTextPositionMap.delete(`${instanceId}:${event.toolCallId}`)
      const toolStartMs = toolStartTimeMap.get(`${instanceId}:${event.toolCallId}`)
      toolStartTimeMap.delete(`${instanceId}:${event.toolCallId}`)
      const durationMs = toolStartMs ? Math.max(0, Date.now() - toolStartMs) : undefined
      if (state) {
        state.pendingTools.push({
          id: event.toolCallId,
          name: event.toolName,
          args,
          result: event.result,
          isError: event.isError,
          textPositionAtStart,
          durationMs,
        })
      }

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

      // bash/exec 工具：脚本写出的文件（Python/shell）不走 file_write，扫描 workspace/outputs 补齐注册
      if (event.toolName === 'bash' && !event.isError && fileRepo) {
        void fileMemoryHandler.scanAndRegisterOutputs(instanceId, toolStartMs).catch((err: unknown) => {
          log.error(`[file:created] 扫描 outputs 注册失败 instanceId=${instanceId}:`, err)
        })
      }
    }
    if (event.type === 'message:delta' && event.fullText !== undefined) {
      const state = instanceStates.get(instanceId)
      const msgId = state?.streamingAssistantMsgId
      const convId = instanceToConversation.get(instanceId)
      if (msgId && convId && conversationRepo) {
        /** 前序已结束的助手段（message:end 累加）；fullText 为当前段内累积全文 */
        const base = state?.accumulatedText ?? ''
        const text = base + event.fullText
        try {
          conversationRepo.updateMessageContent({
            messageId: msgId,
            conversationId: convId,
            contentJson: { type: 'text', text },
            isStreaming: true,
          })
        } catch (err) {
          log.error(`[event] message:delta 持久化失败:`, err)
        }
      }
    }

    if (event.type === 'message:thinking') {
      const state = instanceStates.get(instanceId)
      if (state) state.accumulatedThinking = state.accumulatedThinking + event.delta
    }

    if (event.type === 'message:end' && event.fullText !== undefined) {
      const state = instanceStates.get(instanceId)
      if (state) state.accumulatedText = state.accumulatedText + event.fullText
    }

    if (event.type === 'message:end') {
      const state = instanceStates.get(instanceId)
      if (event.usage && state) {
        state.lastAssistantUsage = event.usage
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
      const accumulated = state?.accumulatedText ?? ''
      const pendingTools = state?.pendingTools ?? []
      const sourceAgentInfo = isSubAgent && agentName ? { instanceId, label: agentName } : undefined
      if (msgId && convId && conversationRepo) {
        try {
          const contentJson: {
            type: 'text'
            text: string
            toolCalls?: typeof pendingTools
            usage?: NonNullable<(typeof event)['usage']>
            sourceAgent?: { instanceId: string; label: string }
          } = {
            type: 'text',
            text: accumulated,
          }
          if (pendingTools.length > 0) {
            contentJson.toolCalls = pendingTools
          }
          if (event.usage) {
            contentJson.usage = event.usage
          }
          if (sourceAgentInfo) {
            contentJson.sourceAgent = sourceAgentInfo
          }
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
          }
        } catch (err) {
          log.error(`[event] message:end 持久化失败，尝试 saveMessage 降级:`, err)
          try {
            const fallbackContent = {
              type: 'text' as const,
              text: accumulated,
              ...(pendingTools.length > 0 ? { toolCalls: pendingTools } : {}),
              ...(event.usage ? { usage: event.usage } : {}),
              ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
            }
            const row = conversationRepo.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson: fallbackContent,
              isStreaming: true,
            })
            if (state) state.streamingAssistantMsgId = row.id
            log.info(`[event] message:end saveMessage 降级成功, newMsgId=${row.id}`)
          } catch (err2) {
            log.error(`[event] message:end 降级也失败，消息可能丢失:`, err2)
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
      // 请求失败不该留下未配对的起点污染下一轮延迟
      clearRun(instanceId)
      const state = instanceStates.get(instanceId)
      const msgId = state?.streamingAssistantMsgId
      const convId = instanceToConversation.get(instanceId)
      const rawText = state?.accumulatedText ?? ''
      const tools = state?.pendingTools ?? []
      const sourceAgentInfo = isSubAgent && agentName ? { instanceId, label: agentName } : undefined
      const accumulatedThinking = state?.accumulatedThinking ?? ''
      const { thinkingText: tagThinkingText, finalText: text } = parseThinkTagsFromRaw(rawText)
      const thinkingText = accumulatedThinking.trim().length > 0 ? accumulatedThinking : tagThinkingText

      if (msgId && convId && conversationRepo) {
        const preserved = finalizeStreamingAssistantMessage({
          conversationRepo,
          messageId: msgId,
          conversationId: convId,
          text,
          thinkingText: thinkingText || undefined,
          tools,
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
        }
      }
      if (state) {
        state.streamingAssistantMsgId = undefined
        state.lastAssistantUsage = undefined
      }

    }

    if (event.type === 'agent:end') {
      // 一轮没产出任何 delta（纯工具轮 / 中断）时清掉起点，否则会被下一轮误配成超长延迟
      clearRun(instanceId)
      const state = instanceStates.get(instanceId)
      const convId = instanceToConversation.get(instanceId)
      const msgId = state?.streamingAssistantMsgId
      const tools = state?.pendingTools ?? []
      const rawText = state?.accumulatedText ?? ''
      const usage = state?.lastAssistantUsage
      const sourceAgentInfo = isSubAgent && agentName ? { instanceId, label: agentName } : undefined

      // 优先使用 message:thinking 事件累积的 thinking 内容（DeepSeek reasoning_content 等）
      // 若无，则回退到解析 <think> 标签（兼容旧格式）
      const accumulatedThinking = state?.accumulatedThinking ?? ''
      const { thinkingText: tagThinkingText, finalText: text } = parseThinkTagsFromRaw(rawText)
      const thinkingText = accumulatedThinking.trim().length > 0 ? accumulatedThinking : tagThinkingText

      let persistSuccess = false
      if (convId && msgId && conversationRepo) {
        try {
          conversationRepo.updateMessageContent({
            messageId: msgId,
            conversationId: convId,
            contentJson: {
              type: 'text',
              text,
              ...(thinkingText ? { thinkingText } : {}),
              ...(tools.length > 0 ? { toolCalls: tools } : {}),
              ...(usage ? { usage } : {}),
              ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
            },
            isStreaming: false,
          })
          log.info(`[event] 持久化 AI 回复（收尾） conversationId=${convId}, len=${text.length}, tools=${tools.length}, thinkingLen=${thinkingText?.length ?? 0}`)
          persistSuccess = true
        } catch (err) {
          log.error(`[event] 持久化 AI 回复失败，保留内存数据以备恢复:`, err)
        }
      } else if (convId && (text.trim() || tools.length > 0)) {
        const convExists = conversationRepo?.getConversation(convId)
        if (!convExists) {
          log.info(`[event] agent:end 跳过持久化：对话已不存在 conversationId=${convId}`)
        } else {
          try {
            conversationRepo?.saveMessage({
              conversationId: convId,
              role: 'assistant',
              contentJson: {
                type: 'text',
                text,
                ...(thinkingText ? { thinkingText } : {}),
                ...(tools.length > 0 ? { toolCalls: tools } : {}),
                ...(usage ? { usage } : {}),
                ...(sourceAgentInfo ? { sourceAgent: sourceAgentInfo } : {}),
              },
            })
            log.info(
              `[event] 持久化 AI 回复（无流式占位） conversationId=${convId}, len=${text.length}, tools=${tools.length}, thinkingLen=${thinkingText?.length ?? 0}`,
            )
            persistSuccess = true
          } catch (err) {
            log.error(`[event] 持久化 AI 回复失败:`, err)
          }
        }
      }

      if (persistSuccess || !convId) {
        // 在清空之前保存本轮工具调用记录，供技能进化使用
        const toolsBeforeClear = state?.pendingTools ?? []
        if (state) {
          state.pendingTools = []
          state.accumulatedText = ''
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

    }

    // 压缩后清掉提供商 token 缓存，让上下文读数回落到估算直至下次 LLM 响应
    if (event.type === 'context:compaction' && ctx.sessionKey === ctx.rootSessionKey) {
      clearSessionProviderInputTokens(ctx.rootSessionKey)
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
      ipcChannel.forwardIpcEvent(ipcEvent)
    }

    if (event.type === 'agent:end' && ctx.sessionKey === ctx.rootSessionKey) {
      const usage = getSessionContextUsage(ctx.rootSessionKey)
      ipcChannel.forwardIpcEvent({
        type: 'agent:context:usage',
        sessionKey: ctx.rootSessionKey,
        usedTokens: usage.usedTokens,
        contextWindow: usage.contextWindow,
        triggerThreshold: CONTEXT_USAGE_TRIGGER_THRESHOLD,
      } as unknown as RendererIpcEvent)
      log.info(
        `[event] 推送 contextUsage: used=${usage.usedTokens}/${usage.contextWindow} (${usage.contextWindow > 0 ? ((usage.usedTokens / usage.contextWindow) * 100).toFixed(1) : '0'}%)`,
      )
    }
  }
}
