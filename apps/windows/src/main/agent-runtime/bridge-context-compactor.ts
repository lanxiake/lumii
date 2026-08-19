/**
 * AgentRuntimeBridge 上下文压缩 / 单次 LLM 调用服务
 *
 * 拆自 bridge.ts，封装 callLLM / compactContext / compactContextAsync 三个跨实例方法。
 * 不持有 per-instance Map，仅通过 deps 注入仓库引用与 stream getter。
 */

import {
  type ConversationRepo,
  type SummaryGeneratorFn,
  type DatabaseAdapter,
  estimateTokenCount,
  createGatewayStreamFn,
  resolveManualCompactKeepCount,
  buildCompactSummaryPrompt,
  formatCompactSummary,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
  ProgressFence,
} from '@mtbot/agent-runtime'
import type { ContextUsageBreakdownEntry } from '../../shared/agent-runtime-events'
import {
  applyConversationCompactToUsage,
  patchBreakdownAfterConversationCompact,
} from './context-usage-breakdown'
import type { AgentMessage } from '@mariozechner/pi-agent-core'
import type { BridgeRendererIpcChannel } from './bridge-renderer-ipc'
import { agentRuntimeLog as log } from './bridge-utils'
import {
  buildPersistedCompactSummary,
  resolveCompactSummaryTimestamp,
} from './compact-persist'

type ModelRef = import('@mariozechner/pi-ai').Model<any>
type InnerStreamRef = ReturnType<typeof createGatewayStreamFn>

export interface BridgeContextCompactorDeps {
  getConversationRepo: () => ConversationRepo | null
  /** 根据 instanceId 查询 (innerStream, model) — 用于优先选择该实例的 stream */
  getInstanceStream: (
    instanceId: string,
  ) => { innerStream: InnerStreamRef; model: ModelRef } | undefined
  /** 主 Agent 实例的 innerStream（降级用） */
  getMainInnerStream: () => InnerStreamRef | null
  /** 主 Agent 实例的 model（降级用） */
  getMainModel: () => ModelRef | null
  /** 任一可用实例的 (innerStream, model)（二次降级用，供后台总结等无指定实例的调用） */
  getAnyInstanceStream?: () => { innerStream: InnerStreamRef; model: ModelRef } | undefined
  /**
   * 无任何 Agent 实例时的兜底 stream（三次降级）。
   * 供 cron / companion workflow 等不创建实例的后台 LLM 调用（如资讯综述）。
   */
  getFallbackStream?: () => { innerStream: InnerStreamRef; model: ModelRef } | undefined
  /** 数据库连接（用于直接 prepare DELETE 等操作） */
  getDb: () => DatabaseAdapter
  ipcChannel: BridgeRendererIpcChannel
  /**
   * 同步 Agent 内存（在 LLM 摘要写入 DB 后调用，重新拉取最新消息注入实例）。
   */
  restoreHistoryForInstance: (instanceId: string, conversationId: string, limit: number) => void
  /**
   * 构造 LLM 摘要生成器：把 AgentMessage[] 拼接 prompt 后流式收集摘要文本。
   */
  createSummaryGenerator: (innerStream: InnerStreamRef, model: ModelRef) => SummaryGeneratorFn
  /** 压缩/清空后使提供商 token 缓存失效 */
  onSessionContextInvalidated?: (sessionKey: string) => void
  /** 压缩后写入整窗占用（只扣对话差值），避免下一次读数把 MCP 一并缩放 */
  onSessionContextTokensUpdated?: (sessionKey: string, usedTokens: number) => void
  /** 读取压缩前的整窗占用（与占用卡片同一口径） */
  getSessionContextUsage?: (sessionKey: string) => {
    usedTokens: number
    contextWindow: number
    triggerThreshold: number
    breakdown?: readonly ContextUsageBreakdownEntry[]
  }
}

export class BridgeContextCompactor {
  constructor(private readonly deps: BridgeContextCompactorDeps) {}

  /**
   * 单次 LLM 调用，复用现有 Agent 实例的 innerStream（继承用户配置的模型和认证）。
   * @param purpose 业务用途标签，写入 LLM 调用日志 metadata.purpose
   */
  async callLLM(prompt: string, instanceId?: string, purpose = 'chat'): Promise<string> {
    const entry = instanceId ? this.deps.getInstanceStream(instanceId) : undefined
    let innerStream = entry?.innerStream ?? this.deps.getMainInnerStream()
    let model = entry?.model ?? this.deps.getMainModel()

    // 二次降级：主 stream 仅在 agent id==='main' 时设置，普通 agent（如 assistant）为空。
    // 后台总结等无指定实例的调用，兜底用任一可用实例的 stream。
    if (!innerStream || !model) {
      const any = this.deps.getAnyInstanceStream?.()
      if (any) {
        innerStream = any.innerStream
        model = any.model
      }
    }

    // 三次降级：cron / companion 故意不建实例，用独立 direct stream（不依赖会话是否打开）。
    if (!innerStream || !model) {
      const fallback = this.deps.getFallbackStream?.()
      if (fallback) {
        innerStream = fallback.innerStream
        model = fallback.model
      }
    }

    if (!innerStream || !model) {
      throw new Error(
        'callLLM: 没有可用的 Agent 实例 stream，请确保至少有一个 Agent 实例已初始化',
      )
    }
    const context: import('@mariozechner/pi-ai').Context = {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }
    const streamResult = await innerStream(model, context, { purpose } as Parameters<InnerStreamRef>[2])
    let text = ''
    for await (const event of streamResult) {
      if (event.type === 'text_delta') {
        text += event.delta
      }
    }
    return text.trim()
  }

  /**
   * 同步裁剪指定会话上下文（无 LLM 摘要，至少保留 1 条）。
   * 短对话也会按一半历史压缩，不再因「不足 12 条」直接跳过。
   *
   * 旧段只做标记（compacted_at），消息仍留在 DB 供用户回看，仅不再进入 LLM 请求。
   */
  compactContext(
    sessionKey: string,
    keepRecentTurns = 6,
  ): { success: boolean; previousMessageCount: number; newMessageCount: number; messagesRemoved: number } {
    const repo = this.deps.getConversationRepo()
    if (!repo) {
      throw new Error('ConversationRepo not initialized')
    }
    const allMessages = this.loadActiveMessages(sessionKey)

    const previousMessageCount = allMessages.length
    // 同步路径无 LLM 摘要，至少保留 1 条，避免把上下文清空
    const keepCount = Math.max(1, resolveManualCompactKeepCount(allMessages.length, keepRecentTurns))
    if (allMessages.length === 0 || keepCount >= allMessages.length) {
      log.info(
        `[compactContext] sessionKey=${sessionKey} 消息数(${allMessages.length}) 无法在无摘要时压缩，跳过`,
      )
      return { success: true, previousMessageCount, newMessageCount: allMessages.length, messagesRemoved: 0 }
    }

    const ids = allMessages.slice(0, allMessages.length - keepCount).map((m) => m.id)

    // 标记前快照整窗占用与对话估算，压缩只扣对话差值
    const usageBefore = this.deps.getSessionContextUsage?.(sessionKey)
    const allPiMessages = repo.loadMessagesAsPiFormat(sessionKey, { limit: allMessages.length }) as AgentMessage[]
    const conversationBefore = estimateTokenCount(allPiMessages)
    const conversationAfter = estimateTokenCount(allPiMessages.slice(ids.length))

    repo.markMessagesCompacted(sessionKey, ids)

    const newMessageCount = allMessages.length - ids.length
    log.info(
      `[compactContext] sessionKey=${sessionKey} 压缩完成: 移出上下文${ids.length}条(仍保留在历史), 保留${newMessageCount}条`,
    )

    this.emitCompacted({
      sessionKey,
      conversationBefore,
      conversationAfter,
      messagesRemoved: ids.length,
      messagesBefore: allMessages.length,
      messagesAfter: newMessageCount,
      usageBefore,
    })

    return {
      success: true,
      previousMessageCount,
      newMessageCount,
      messagesRemoved: ids.length,
    }
  }

  /**
   * 读取仍参与上下文的消息（排除流式行与此前已压缩标记的行）。
   */
  private loadActiveMessages(sessionKey: string): { id: string; timestamp: string }[] {
    const db = this.deps.getDb()
    return db
      .prepare<{ id: string; timestamp: string }>(
        `SELECT id, timestamp FROM messages
         WHERE conversation_id = ? AND is_streaming = 0 AND compacted_at IS NULL
         ORDER BY timestamp ASC`,
      )
      .all(sessionKey) as { id: string; timestamp: string }[]
  }

  /**
   * 异步压缩上下文（含 LLM 摘要生成）。
   *
   * 手动压缩不看 token 阈值、也不因「不足 12 条」跳过：只要有消息就发出摘要请求。
   * 流程：
   * 1. 从 DB 加载仍在上下文中的消息
   * 2. 调用 LLM 生成结构化摘要（失败时降级为纯标记，且绝不清空上下文）
   * 3. 标记旧段为已压缩（不删除，用户仍可回看），保留最近一半或请求轮数
   * 4. 将摘要写入 DB（作为 assistant 消息）
   * 5. 同步 Agent 内存（restoreHistoryForInstance）
   * 6. 推送 agent:context:compacted 事件
   */
  async compactContextAsync(
    instanceId: string,
    sessionKey: string,
    keepRecentTurns = 6,
    signal?: AbortSignal,
  ): Promise<{
    success: boolean
    previousMessageCount: number
    newMessageCount: number
    messagesRemoved: number
    hadSummary: boolean
    /** 压缩前对话 token 估算（不含 MCP/工具定义） */
    conversationTokensBefore: number
    /** 压缩后对话 token 估算；未压缩时与 before 相同 */
    conversationTokensAfter: number
  }> {
    const repo = this.deps.getConversationRepo()
    if (!repo) throw new Error('ConversationRepo not initialized')

    const allMessages = this.loadActiveMessages(sessionKey)

    const previousMessageCount = allMessages.length
    if (previousMessageCount === 0) {
      log.info(`[compactContextAsync] 无消息可压缩: sessionKey=${sessionKey}`)
      return {
        success: true,
        previousMessageCount: 0,
        newMessageCount: 0,
        messagesRemoved: 0,
        hadSummary: false,
        conversationTokensBefore: 0,
        conversationTokensAfter: 0,
      }
    }

    let keepCount = resolveManualCompactKeepCount(previousMessageCount, keepRecentTurns)

    // 删除前快照整窗占用（含 MCP/工具定义），避免事后清缓存把定义一并缩放
    const usageBefore = this.deps.getSessionContextUsage?.(sessionKey)

    // 尝试 LLM 摘要：手动压缩无论消息多少都发出摘要请求
    let summaryText: string | null = null
    const piMessages = repo.loadMessagesAsPiFormat(sessionKey, { limit: allMessages.length }) as AgentMessage[]
    const conversationBefore = estimateTokenCount(piMessages)
    // 优先用当前实例的 stream，降级到主 Agent stream
    const instanceStreamEntry = this.deps.getInstanceStream(instanceId)
    const activeInnerStream = instanceStreamEntry?.innerStream ?? this.deps.getMainInnerStream()
    const activeModel = instanceStreamEntry?.model ?? this.deps.getMainModel()
    if (activeInnerStream && activeModel) {
      try {
        const summaryPrompt =
          NO_TOOLS_PREAMBLE +
          buildCompactSummaryPrompt({ domainHint: 'general' }) +
          NO_TOOLS_TRAILER
        const generator = this.deps.createSummaryGenerator(activeInnerStream, activeModel)
        const rawSummary = await generator(piMessages, summaryPrompt, signal)
        summaryText = rawSummary ? formatCompactSummary(rawSummary) : null
        if (summaryText) {
          log.info(
            `[compactContextAsync] LLM 摘要生成成功（已看完整 ${piMessages.length} 条消息）: ${summaryText.length} 字符`,
          )
        } else {
          log.warn(`[compactContextAsync] LLM 摘要返回空文本，降级为纯标记`)
        }
      } catch (err) {
        log.warn(
          `[compactContextAsync] LLM 摘要生成失败，降级为纯标记: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      log.warn(`[compactContextAsync] mainInnerStream/mainModel 未初始化，跳过 LLM 摘要`)
    }

    // 无摘要时绝不清空上下文：至少保留 1 条
    if (!summaryText) {
      keepCount = Math.max(keepCount, 1)
    }
    if (keepCount >= previousMessageCount) {
      log.info(
        `[compactContextAsync] 无法压缩（无摘要且仅 ${previousMessageCount} 条）: sessionKey=${sessionKey}`,
      )
      return {
        success: true,
        previousMessageCount,
        newMessageCount: previousMessageCount,
        messagesRemoved: 0,
        hadSummary: false,
        conversationTokensBefore: conversationBefore,
        conversationTokensAfter: conversationBefore,
      }
    }

    const ids = allMessages.slice(0, allMessages.length - keepCount).map((m) => m.id)

    // ⭐ 原子提交期：移出旧消息与写入摘要必须同生共死。
    // 两次独立写入之间崩溃会留下「旧消息已移出但摘要未写」→ 上下文凭空丢失。
    const failedResult = {
      success: false as const,
      previousMessageCount,
      newMessageCount: previousMessageCount,
      messagesRemoved: 0,
      hadSummary: false,
      conversationTokensBefore: conversationBefore,
      conversationTokensAfter: conversationBefore,
    }
    const fence = new ProgressFence()
    if (!fence.beginCommit()) {
      log.warn(`[compactContextAsync] 提交入场权已被撤销，跳过写入: sessionKey=${sessionKey}`)
      return failedResult
    }
    const db = this.deps.getDb()
    try {
      // BEGIN IMMEDIATE 立刻拿写锁，避免读-写竞争下的 SQLITE_BUSY
      db.exec('BEGIN IMMEDIATE')
      try {
        repo.markMessagesCompacted(sessionKey, ids)
        if (summaryText) {
          const firstKept = allMessages[allMessages.length - keepCount]
          repo.saveMessage({
            conversationId: sessionKey,
            role: 'assistant',
            contentJson: buildPersistedCompactSummary(summaryText),
            timestamp: resolveCompactSummaryTimestamp(firstKept?.timestamp),
          })
        }
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      log.info(
        `[compactContextAsync] 压缩事务提交成功: 移出 ${ids.length} 条(仍保留在历史), 摘要=${!!summaryText}, sessionKey=${sessionKey}`,
      )
    } catch (err) {
      log.error(
        `[compactContextAsync] 压缩事务失败已回滚，上下文保持原状: ${err instanceof Error ? err.message : String(err)}`,
      )
      return failedResult
    } finally {
      fence.finishCommit()
    }

    const newMessageCount = allMessages.length - ids.length + (summaryText ? 1 : 0)

    // 同步 Agent 内存
    try {
      this.deps.restoreHistoryForInstance(instanceId, sessionKey, newMessageCount + 10)
      log.info(`[compactContextAsync] 内存同步完成: instanceId=${instanceId}`)
    } catch (err) {
      log.warn(
        `[compactContextAsync] 内存同步失败（非致命）: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const newPiMessages = repo.loadMessagesAsPiFormat(sessionKey, {
      limit: newMessageCount + 10,
    }) as AgentMessage[]
    const conversationAfter = estimateTokenCount(newPiMessages)

    this.emitCompacted({
      sessionKey,
      conversationBefore,
      conversationAfter,
      messagesRemoved: ids.length,
      messagesBefore: previousMessageCount,
      messagesAfter: newMessageCount,
      summaryText,
      usageBefore,
    })

    return {
      success: true,
      previousMessageCount,
      newMessageCount,
      messagesRemoved: ids.length,
      hadSummary: !!summaryText,
      conversationTokensBefore: conversationBefore,
      conversationTokensAfter: conversationAfter,
    }
  }

  /**
   * 推送压缩完成事件：token 用整窗口径，只扣对话差值；MCP/工具定义保持压缩前的展示值。
   */
  private emitCompacted(params: {
    sessionKey: string
    conversationBefore: number
    conversationAfter: number
    messagesRemoved: number
    messagesBefore: number
    messagesAfter: number
    summaryText?: string | null
    usageBefore?: {
      usedTokens: number
      contextWindow: number
      triggerThreshold: number
      breakdown?: readonly ContextUsageBreakdownEntry[]
    }
  }): void {
    const { sessionKey, conversationBefore, conversationAfter, usageBefore } = params
    const previousTokenCount =
      usageBefore && usageBefore.usedTokens > 0 ? usageBefore.usedTokens : conversationBefore
    const newTokenCount = applyConversationCompactToUsage(
      previousTokenCount,
      conversationBefore,
      conversationAfter,
    )
    const breakdown = usageBefore?.breakdown
      ? patchBreakdownAfterConversationCompact(
          usageBefore.breakdown,
          conversationBefore,
          conversationAfter,
        )
      : undefined

    if (this.deps.onSessionContextTokensUpdated) {
      this.deps.onSessionContextTokensUpdated(sessionKey, newTokenCount)
    } else {
      this.deps.onSessionContextInvalidated?.(sessionKey)
    }

    this.deps.ipcChannel.forwardIpcEvent({
      type: 'agent:context:compacted',
      sessionKey,
      previousTokenCount,
      newTokenCount,
      messagesRemoved: params.messagesRemoved,
      messagesBefore: params.messagesBefore,
      messagesAfter: params.messagesAfter,
      timestamp: Date.now(),
      conversationTokensBefore: conversationBefore,
      conversationTokensAfter: conversationAfter,
      ...(params.summaryText ? { summaryText: params.summaryText } : {}),
      ...(breakdown ? { breakdown } : {}),
    })

    if (usageBefore) {
      this.deps.ipcChannel.forwardIpcEvent({
        type: 'agent:context:usage',
        sessionKey,
        usedTokens: newTokenCount,
        contextWindow: usageBefore.contextWindow,
        triggerThreshold: usageBefore.triggerThreshold,
        ...(breakdown ? { breakdown } : {}),
      })
    }
  }
}

/**
 * 构建 LLM 摘要生成器（用于上下文压缩）
 *
 * 使用当前 Agent 实例的 streamFn 调用 LLM 生成结构化摘要。
 * 将 AgentMessage[] 转换为 user-only 历史，拼接摘要提示词作为最后一条 user 消息，
 * 然后流式收集文本输出。
 */
export function createLlmSummaryGenerator(
  innerStream: ReturnType<typeof createGatewayStreamFn>,
  model: import('@mariozechner/pi-ai').Model<any>,
): SummaryGeneratorFn {
  return async (
    messages: AgentMessage[],
    summaryPrompt: string,
    signal?: AbortSignal,
  ): Promise<string | null> => {
    // 将 AgentMessage[] 转换为 LLM 兼容的 Message[]（只保留 user/assistant/toolResult）
    const llmMessages: import('@mariozechner/pi-ai').Message[] = messages.flatMap((m) => {
      if (typeof m !== 'object' || m === null || !('role' in m)) return []
      const role = (m as { role: string }).role
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return []
      return [m as import('@mariozechner/pi-ai').Message]
    })

    // 附加摘要指令作为最后一条 user 消息
    const messagesWithPrompt: import('@mariozechner/pi-ai').Message[] = [
      ...llmMessages,
      { role: 'user', content: summaryPrompt, timestamp: Date.now() },
    ]

    const context: import('@mariozechner/pi-ai').Context = {
      messages: messagesWithPrompt,
    }

    // 流式调用并收集文本
    const streamResult = await innerStream(model, context, {
      purpose: 'session_summary',
    } as Parameters<typeof innerStream>[2])
    let summaryText = ''

    for await (const event of streamResult) {
      if (signal?.aborted) return null
      if (event.type === 'text_delta') {
        summaryText += event.delta
      }
    }

    return summaryText.trim() || null
  }
}
