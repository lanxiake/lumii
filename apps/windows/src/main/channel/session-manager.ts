/**
 * SessionManager — 统一 prompt 入口
 *
 * 职责：
 * 1. 同一 sessionKey 下串行化并发 prompt（防止消息乱序）
 * 2. 编排 ContextStrategy.beforePrompt → bridge.prompt → ContextStrategy.afterPrompt
 * 3. 提供增强版 compactContext（LLM 摘要 + 内存同步）
 */

import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import type { ContextStrategy, IChannelAdapter, ChannelSession } from './types'

const log = {
  info: (...args: unknown[]) => console.log('[SessionManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[SessionManager]', ...args),
  error: (...args: unknown[]) => console.error('[SessionManager]', ...args),
  debug: (...args: unknown[]) => console.debug('[SessionManager]', ...args),
}

export interface PromptParams {
  instanceId: string
  sessionKey: string
  message: string
  strategy: ContextStrategy
  adapter: IChannelAdapter
  session: ChannelSession
  /**
   * 图片附件 workspace 绝对路径列表。
   * 透传给 bridge.prompt 用于构造多模态 UserMessage（仅模型支持视觉输入时由调用方传入）。
   */
  imageAttachmentPaths?: readonly string[]
  /**
   * 本轮用户消息在 DB 中的 id（若调用方在 prompt 前已持久化）。
   * 透传给 ContextStrategy.beforePrompt，恢复历史时排除它，避免消息重复。
   */
  pendingUserMsgId?: string
}

export interface CompactResult {
  summarizedCount: number
  keptCount: number
  hadSummary: boolean
}

export class SessionManager {
  /**
   * sessionKey → 当前正在执行的 prompt Promise（用于串行化）
   * 用 catch 包裹防止一次失败阻塞后续所有请求
   */
  private readonly promptLocks = new Map<string, Promise<void>>()

  constructor(private readonly bridge: AgentRuntimeBridge) {}

  /**
   * 统一 prompt 入口。
   * 同一 sessionKey 的并发调用会自动串行化。
   */
  async prompt(params: PromptParams): Promise<void> {
    const { sessionKey } = params
    const prev = this.promptLocks.get(sessionKey) ?? Promise.resolve()
    const next = prev.then(() => this._doPrompt(params))
    // catch 包裹：防止一次失败阻塞后续请求
    this.promptLocks.set(sessionKey, next.catch(() => {}))
    return next
  }

  /**
   * 清除指定 sessionKey 的锁（/clear、/new 命令切换会话时调用）
   */
  clearLock(sessionKey: string): void {
    this.promptLocks.delete(sessionKey)
    log.debug(`[clearLock] 已清除锁: sessionKey=${sessionKey}`)
  }

  /**
   * 增强版 compactContext（含 LLM 摘要）：
   * 委派给 bridge.compactContextAsync，由 bridge 统一处理摘要生成、DB 清理、内存同步。
   */
  async compactContext(
    instanceId: string,
    sessionKey: string,
    keepRecentTurns = 6,
  ): Promise<CompactResult> {
    log.info(`[compactContext] 开始压缩: sessionKey=${sessionKey} keepRecentTurns=${keepRecentTurns}`)

    const result = await this.bridge.compactContextAsync(instanceId, sessionKey, keepRecentTurns)
    const { previousMessageCount, newMessageCount, messagesRemoved, hadSummary } = result

    if (messagesRemoved === 0) {
      log.info(
        `[compactContext] 未删除消息: sessionKey=${sessionKey} count=${previousMessageCount} hadSummary=${hadSummary}`,
      )
      return { summarizedCount: 0, keptCount: newMessageCount, hadSummary }
    }

    log.info(`[compactContext] 压缩完成: 删除 ${messagesRemoved} 条，保留 ${newMessageCount} 条，hadSummary=${hadSummary}`)
    return {
      summarizedCount: messagesRemoved,
      keptCount: newMessageCount,
      hadSummary,
    }
  }

  // ── 内部实现 ──────────────────────────────────────────────────────────────

  private async _doPrompt(params: PromptParams): Promise<void> {
    const { instanceId, sessionKey, message, strategy, imageAttachmentPaths, pendingUserMsgId } = params

    log.info(
      `[_doPrompt] 开始: instanceId=${instanceId} sessionKey=${sessionKey} msgLen=${message.length} imageCount=${imageAttachmentPaths?.length ?? 0}`,
    )

    await strategy.beforePrompt(instanceId, sessionKey, pendingUserMsgId)
    try {
      await this.bridge.prompt(instanceId, message, imageAttachmentPaths)
    } finally {
      await strategy.afterPrompt(instanceId, sessionKey)
    }

    log.info(`[_doPrompt] 完成: instanceId=${instanceId} sessionKey=${sessionKey}`)
  }
}
