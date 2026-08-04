/**
 * 事件转换器
 *
 * 将 AgentInstance 产生的旧格式 AgentRuntimeEvent 转换为新 IPC AgentRuntimeEvent 格式。
 *
 * 旧格式（packages/agent-runtime/src/types/events.ts）使用 instanceId 标识，
 * 新格式（apps/windows/src/shared/agent-runtime-events.ts）使用 runId/sessionKey/messageId。
 *
 * 设计依据: .qoder/design/client-agent-runtime/08-前端渲染与IPC通讯.md §6
 */

import { randomUUID } from 'node:crypto'
import type { AgentRuntimeEvent as OldEvent } from '@mtbot/agent-runtime'
import type { AgentRuntimeEvent as IpcEvent } from '../../shared/agent-runtime-events'

/**
 * 当前运行上下文
 *
 * 在 run 生命周期内保持一致的上下文信息。
 */
export interface RunContext {
  runId: string
  /** 本实例的 sessionKey（子 Agent 为 child-*，与 rootSessionKey 不同） */
  readonly sessionKey: string
  /** 所属对话聚合键（主实例与同一对话下的子实例共享） */
  readonly rootSessionKey: string
  /** 本运行上下文对应的 Agent 实例 ID */
  readonly instanceId: string
  /** 当前 Agent 解析后的模型 ID（用于 IPC agent:message:start） */
  resolvedModelId?: string
  /** 当前消息 ID，在 message:start 时生成 */
  currentMessageId: string
  /** 累积文本长度（当前轮次，已剥离 <think> 内容） */
  accumulatedLength: number
  /** 前几轮文本的累积总长度（含轮间 '\n\n' 分隔符），作为下一轮的初始偏移 */
  completedTurnsLength: number
  /** 当前轮次思考文本累积（message:end 时发出 thinking:end） */
  thinkingAccumulated: string
  /** 内联 <think> 标签状态机：idle = 正文模式，in_think = 标签内推理模式 */
  thinkTagState: 'idle' | 'in_think'
  /** 跨 delta 边界的标签前缀缓冲 */
  thinkTagBuf: string
  /** 当前 turn 开始时间 */
  turnStartMs: number
  /** 总工具使用次数 */
  totalToolUseCount: number
  /** 总 token 数 */
  totalTokens: number
  /** 最后一次 LLM 调用的 inputTokens（用于上下文使用量显示） */
  lastInputTokens: number
  /** 工具开始时间 Map: toolCallId → Date.now() */
  toolStartTimes: Map<string, number>
  /** Agent 显示名称（= AgentDefinition.name，用于分析埋点 agentId，与工具埋点口径一致） */
  agentName?: string
  /**
   * 子 Agent 专用：创建时刻父实例的 runId。
   * subagent_complete 须与 subagent_spawn 使用同一父 runId，才能在时间线/聚合中关联。
   */
  parentAnalyticsRunId?: string
}

/**
 * 创建新的运行上下文
 *
 * @param sessionKey - 本实例网关 session（子 Agent 唯一）
 * @param instanceId - Agent 实例 ID
 * @param rootSessionKey - 对话级聚合键（通常等于主会话的 sessionKey / conversationId）
 */
export function createRunContext(sessionKey: string, instanceId: string, rootSessionKey: string): RunContext {
  return {
    runId: randomUUID(),
    sessionKey,
    rootSessionKey,
    instanceId,
    currentMessageId: '',
    accumulatedLength: 0,
    completedTurnsLength: 0,
    thinkingAccumulated: '',
    thinkTagState: 'idle',
    thinkTagBuf: '',
    turnStartMs: Date.now(),
    totalToolUseCount: 0,
    totalTokens: 0,
    lastInputTokens: 0,
    toolStartTimes: new Map(),
  }
}

/** 为 IPC 事件附加 instance / 对话元数据 */
function ipcMeta(ctx: RunContext): { instanceId: string; rootSessionKey: string } {
  return { instanceId: ctx.instanceId, rootSessionKey: ctx.rootSessionKey }
}

/**
 * 将旧格式 AgentRuntimeEvent 转换为新 IPC AgentRuntimeEvent 数组
 *
 * @param oldEvent - 旧格式事件（来自 AgentInstance.subscribe）
 * @param ctx - 运行上下文（会被就地修改）
 * @returns 转换后的 IPC 事件数组
 */
export function convertOldEventToIpcEvents(
  oldEvent: OldEvent,
  ctx: RunContext,
): readonly IpcEvent[] {
  const now = Date.now()

  switch (oldEvent.type) {
    case 'agent:start': {
      ctx.runId = randomUUID()
      ctx.turnStartMs = now
      ctx.totalToolUseCount = 0
      ctx.totalTokens = 0
      ctx.thinkingAccumulated = ''
      return [{
        type: 'agent:turn:start',
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        turnIndex: 0,
        timestamp: now,
        ...ipcMeta(ctx),
      }]
    }

    case 'message:start': {
      // 若 bridge 已预设 DB 消息 ID（来自 agent:start 占位行），则复用，否则生成新 UUID
      // 确保渲染进程与 DB 使用同一 messageId，避免切换会话时产生重复消息
      if (!ctx.currentMessageId) {
        ctx.currentMessageId = randomUUID()
        ctx.completedTurnsLength = 0
      } else {
        // 续轮（tool_use 后的第二轮及以后）：UI 将在前一轮文本后追加 '\n\n' 再拼接本轮文本，
        // 所以本轮的字符偏移需从 上一轮结束位置 + 2（分隔符）开始，
        // 这样 tool:start 注入的 textPositionAtStart 才能正确对应拼接后的全文位置。
        ctx.completedTurnsLength = ctx.accumulatedLength + 2
      }
      ctx.accumulatedLength = ctx.completedTurnsLength
      ctx.thinkTagState = 'idle'
      ctx.thinkTagBuf = ''
      return [{
        type: 'agent:message:start',
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        messageId: ctx.currentMessageId,
        model: ctx.resolvedModelId ?? 'unknown',
        timestamp: now,
        ...ipcMeta(ctx),
      }]
    }

    case 'message:delta': {
      // 内联 <think>...</think> 标签状态机
      // deepseek-chat 等模型把推理内容混在 content 字段里（非 reasoning_content 字段），
      // pi-ai 不识别，直接作为 text_delta 发出。这里将其剥离：
      // - <think>...</think> 内的内容路由到 thinkingAccumulated，不出现在正文 delta 里
      // - </think> 标签本身不向前端发送
      const OPEN = '<think>'
      const CLOSE = '</think>'
      const ipcEvents: IpcEvent[] = []
      let remaining = ctx.thinkTagBuf + oldEvent.delta
      ctx.thinkTagBuf = ''

      while (remaining.length > 0) {
        if (ctx.thinkTagState === 'idle') {
          const openIdx = remaining.indexOf(OPEN)

          if (openIdx === -1) {
            // 检测末尾是否有 OPEN 的不完整前缀（跨 chunk 边界）
            let prefixLen = 0
            for (let k = Math.min(OPEN.length - 1, remaining.length); k > 0; k--) {
              if (OPEN.startsWith(remaining.slice(remaining.length - k))) { prefixLen = k; break }
            }
            const textPart = remaining.slice(0, remaining.length - prefixLen)
            if (textPart) {
              ctx.accumulatedLength += textPart.length
              ipcEvents.push({
                type: 'agent:message:delta',
                runId: ctx.runId,
                messageId: ctx.currentMessageId,
                sessionKey: ctx.sessionKey,
                delta: textPart,
                totalLength: ctx.accumulatedLength,
                ...ipcMeta(ctx),
              })
            }
            if (prefixLen > 0) ctx.thinkTagBuf = remaining.slice(remaining.length - prefixLen)
            remaining = ''
          } else {
            // 把 <think> 之前的文字正常输出
            if (openIdx > 0) {
              const textPart = remaining.slice(0, openIdx)
              ctx.accumulatedLength += textPart.length
              ipcEvents.push({
                type: 'agent:message:delta',
                runId: ctx.runId,
                messageId: ctx.currentMessageId,
                sessionKey: ctx.sessionKey,
                delta: textPart,
                totalLength: ctx.accumulatedLength,
                ...ipcMeta(ctx),
              })
            }
            ctx.thinkTagState = 'in_think'
            remaining = remaining.slice(openIdx + OPEN.length)
          }
        } else {
          // in_think：找 </think>
          const closeIdx = remaining.indexOf(CLOSE)
          if (closeIdx === -1) {
            let prefixLen = 0
            for (let k = Math.min(CLOSE.length - 1, remaining.length); k > 0; k--) {
              if (CLOSE.startsWith(remaining.slice(remaining.length - k))) { prefixLen = k; break }
            }
            const thinkPart = remaining.slice(0, remaining.length - prefixLen)
            if (thinkPart) {
              ctx.thinkingAccumulated += thinkPart
              ipcEvents.push({
                type: 'agent:thinking:delta',
                runId: ctx.runId,
                sessionKey: ctx.sessionKey,
                delta: thinkPart,
                ...ipcMeta(ctx),
              })
            }
            if (prefixLen > 0) ctx.thinkTagBuf = remaining.slice(remaining.length - prefixLen)
            remaining = ''
          } else {
            if (closeIdx > 0) {
              const thinkPart = remaining.slice(0, closeIdx)
              ctx.thinkingAccumulated += thinkPart
              ipcEvents.push({
                type: 'agent:thinking:delta',
                runId: ctx.runId,
                sessionKey: ctx.sessionKey,
                delta: thinkPart,
                ...ipcMeta(ctx),
              })
            }
            ctx.thinkTagState = 'idle'
            // 跳过 </think> 后的空白，使正文不以换行开头
            remaining = remaining.slice(closeIdx + CLOSE.length).replace(/^\n+/, '')
          }
        }
      }

      return ipcEvents
    }

    case 'message:thinking': {
      ctx.thinkingAccumulated += oldEvent.delta
      return [{
        type: 'agent:thinking:delta',
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        delta: oldEvent.delta,
        ...ipcMeta(ctx),
      }]
    }

    case 'message:end': {
      // 使用事件中的真实 token 数据（不再硬编码为 0）
      const usage = oldEvent.usage
        ? {
            inputTokens: oldEvent.usage.inputTokens,
            outputTokens: oldEvent.usage.outputTokens,
            cacheReadTokens: oldEvent.usage.cacheRead,
            cacheWriteTokens: oldEvent.usage.cacheWrite,
          }
        : { inputTokens: 0, outputTokens: 0 }
      ctx.totalTokens += (usage.inputTokens + usage.outputTokens)
      ctx.lastInputTokens = usage.inputTokens

      const pkgSr = oldEvent.stopReason
      const stopReason:
        | 'end_turn'
        | 'tool_use'
        | 'max_tokens'
        | 'stop_sequence'
        | 'error'
        | 'aborted' =
        pkgSr === 'tool_use' ? 'tool_use'
          : pkgSr === 'max_tokens' ? 'max_tokens'
            : pkgSr === 'error' ? 'error'
              : pkgSr === 'aborted' ? 'aborted'
                : 'end_turn'

      const { thinkingText: finalThinking, finalText } = parseThinkTagsFromRaw(oldEvent.fullText)
      // 优先用 fullText 解析结果（更完整），状态机结果作为备用
      const thinkingText = finalThinking || ctx.thinkingAccumulated
      ctx.thinkingAccumulated = ''

      const out: IpcEvent[] = []
      if (thinkingText.trim()) {
        out.push({
          type: 'agent:thinking:end',
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          thinkingText,
          ...ipcMeta(ctx),
        })
      }
      out.push({
        type: 'agent:message:end',
        runId: ctx.runId,
        messageId: ctx.currentMessageId,
        sessionKey: ctx.sessionKey,
        content: [{ type: 'text', text: finalText }],
        usage,
        stopReason,
        ...(thinkingText.trim() ? { thinkingText } : {}),
        ...(oldEvent.llmError ? { llmError: oldEvent.llmError } : {}),
        ...(oldEvent.injectedMemories && oldEvent.injectedMemories.length > 0
          ? { injectedMemories: oldEvent.injectedMemories }
          : {}),
        ...ipcMeta(ctx),
      })
      return out
    }

    case 'tool:start': {
      ctx.totalToolUseCount++
      ctx.toolStartTimes.set(oldEvent.toolCallId, now)
      // 调试日志：记录工具开始时间
      if (process.env.DEBUG_TOOL_DURATION) {
        console.log(`[event-converter] tool:start ${oldEvent.toolName} id=${oldEvent.toolCallId} startMs=${now}`)
      }
      return [{
        type: 'agent:tool:start',
        runId: ctx.runId,
        toolCallId: oldEvent.toolCallId,
        toolName: oldEvent.toolName,
        args: (oldEvent.args as Record<string, unknown>) ?? {},
        timestamp: now,
        // 携带当前已累积的正文字符数（已剥离 <think> 内容），
        // event-handler.ts 直接使用，无需在渲染侧重新估算
        textPositionAtStart: ctx.accumulatedLength,
        ...ipcMeta(ctx),
      }]
    }

    case 'tool:update': {
      return [{
        type: 'agent:tool:progress',
        runId: ctx.runId,
        toolCallId: oldEvent.toolCallId,
        toolName: oldEvent.toolName,
        partialResult: typeof oldEvent.partialResult === 'string'
          ? oldEvent.partialResult
          : undefined,
        ...ipcMeta(ctx),
      }]
    }

    case 'tool:end': {
      const startMs = ctx.toolStartTimes.get(oldEvent.toolCallId)
      ctx.toolStartTimes.delete(oldEvent.toolCallId)
      // 如果找不到开始时间，使用工具执行的实际开始时间（从事件中获取）或回退到当前时间
      const effectiveStartMs = startMs ?? (oldEvent as { startTime?: number }).startTime ?? now
      const durationMs = Math.max(0, now - effectiveStartMs)
      // 如果 durationMs 为 0 且是错误情况，记录警告日志以便调试
      if (durationMs === 0 && oldEvent.isError) {
        console.warn(`[event-converter] tool:end durationMs=0 for ${oldEvent.toolName}, startMs=${startMs}, effectiveStartMs=${effectiveStartMs}`)
      }
      // 调试：记录工具结果摘要
      const resultSummary = oldEvent.result == null
        ? 'null'
        : typeof oldEvent.result === 'object'
          ? JSON.stringify(oldEvent.result).slice(0, 200)
          : String(oldEvent.result).slice(0, 200)
      console.log(`[event-converter] tool:end toolName=${oldEvent.toolName} isError=${oldEvent.isError} durationMs=${durationMs} resultPreview=${resultSummary}`)
      return [{
        type: 'agent:tool:end',
        runId: ctx.runId,
        toolCallId: oldEvent.toolCallId,
        toolName: oldEvent.toolName,
        result: oldEvent.result,
        isError: oldEvent.isError,
        durationMs,
        ...ipcMeta(ctx),
      }]
    }

    case 'agent:end': {
      const durationMs = now - ctx.turnStartMs
      return [
        {
          type: 'agent:turn:end',
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          turnIndex: 0,
          totalToolUseCount: ctx.totalToolUseCount,
          totalTokens: ctx.totalTokens,
          durationMs,
          ...(oldEvent.loopInterrupted ? { loopInterrupted: true as const } : {}),
          ...ipcMeta(ctx),
        },
        {
          type: 'agent:idle',
          runId: ctx.runId,
          sessionKey: ctx.sessionKey,
          ...ipcMeta(ctx),
        },
      ]
    }

    case 'agent:error': {
      return [{
        type: 'agent:error',
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        errorCode: oldEvent.code ?? 'AGENT_ERROR',
        errorMessage: oldEvent.error,
        isRetryable: oldEvent.retryable ?? false,
        ...ipcMeta(ctx),
      }]
    }

    case 'agent:state-change': {
      // state-change 事件在新格式中没有直接对应
      return []
    }

    case 'context:compaction': {
      return [{
        type: 'agent:context:compacted',
        sessionKey: ctx.sessionKey,
        previousTokenCount: oldEvent.tokensBefore,
        newTokenCount: oldEvent.tokensAfter,
        messagesRemoved: oldEvent.messagesBefore - oldEvent.messagesAfter,
        messagesBefore: oldEvent.messagesBefore,
        messagesAfter: oldEvent.messagesAfter,
        timestamp: now,
      }]
    }

    default:
      return []
  }
}

/**
 * 从原始累积文本（可能含内联 <think> 标签）中分离推理内容和正文。
 *
 * 支持两种格式：
 * - 完整 <think>...</think> 块
 * - 孤立 </think>（DeepSeek 等模型直接推理后以 </think> 结束，无开头标签）
 *
 * @returns { thinkingText, finalText }
 */
export function parseThinkTagsFromRaw(raw: string): { thinkingText: string; finalText: string } {
  const thinkingParts: string[] = []
  const finalParts: string[] = []
  let lastIndex = 0

  // 提取完整的 <think>...</think> 块
  const pairedRegex = /<think>([\s\S]*?)<\/think>/gi
  let match: RegExpExecArray | null
  while ((match = pairedRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      finalParts.push(raw.slice(lastIndex, match.index))
    }
    thinkingParts.push(match[1] ?? '')
    lastIndex = pairedRegex.lastIndex
  }
  // 剩余部分（含孤立 </think>）直接作为正文输出
  if (lastIndex < raw.length) {
    finalParts.push(raw.slice(lastIndex))
  }

  if (thinkingParts.length > 0) {
    return {
      thinkingText: thinkingParts.join('\n\n').trim(),
      finalText: finalParts.join('').replace(/^\n+/, '').trimStart(),
    }
  }
  return {
    thinkingText: '',
    finalText: raw.replace(/^\n+/, '').trimStart(),
  }
}
