/**
 * SessionManager — 统一 prompt 入口
 *
 * 职责：
 * 1. 同一 sessionKey 下串行化并发 prompt（防止消息乱序）
 * 2. 编排 ContextStrategy.beforePrompt → bridge.prompt → ContextStrategy.afterPrompt
 * 3. 提供增强版 compactContext（LLM 摘要 + 内存同步）
 */

import type { AgentRuntimeBridge } from '../agent-runtime/bridge'
import { channelLabelOf } from './types'
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

/** 会话锁排队超过此时长即告警：通常意味着前一轮 prompt 卡住了 */
const STALL_WARN_MS = 2 * 60_000

/**
 * 会话锁的硬界：超过它仍未结束就强制释放，避免单次卡死永久堵住该会话的后续消息。
 *
 * 为什么需要：`prompt()` 用 Promise 链串行化同一 sessionKey 的消息，链上任何一环
 * 永不 resolve，该会话就永久哑掉（2026-10-04「你好」被卡死的快照堵住即如此）。
 * 默认 30 分钟，远大于正常回合；可用 `LUMII_PROMPT_STALL_TIMEOUT_MS` 覆盖。
 */
const STALL_RELEASE_MS =
  Number(process.env.LUMII_PROMPT_STALL_TIMEOUT_MS) > 0
    ? Number(process.env.LUMII_PROMPT_STALL_TIMEOUT_MS)
    : 30 * 60_000

/**
 * 本轮消息的「回信地址」——channel_send 省略 `to` 时的默认收件人。
 *
 * 单聊 = channelUserId（与渠道内 peer id 一致）。
 * 群聊里二者不是一回事：QQ 群的 peer id 是 `group:{group_openid}`、企微群是群 chatId，
 * 都用该群 chatId 表达；而 `session.channelUserId` 是发言人。
 *
 * @returns 缺席 = 回不到当前会话（客户端 session、群聊没带 chatId），调用方须回退到显式 to
 */
export function resolveReplyTo(session: ChannelSession): string | undefined {
  if (session.channelType === 'ipc') return undefined
  const chatType = session.replyContext?.chatType
  if (chatType !== 'group') return session.channelUserId
  const chatId = session.replyContext?.chatId
  if (typeof chatId !== 'string' || !chatId) return undefined
  return session.channelType === 'qbot' ? `group:${chatId}` : chatId
}

export class SessionManager {
  /**
   * sessionKey → 当前正在执行的 prompt Promise（用于串行化）
   * 用 catch 包裹防止一次失败阻塞后续所有请求
   */
  private readonly promptLocks = new Map<string, Promise<void>>()

  /** sessionKey → 当前回合真正开始执行的时刻（用于卡死计时，区别于「入队时刻」） */
  private readonly lockStartedAt = new Map<string, number>()

  /** sessionKey → 卡死看门狗定时器（锁存活期间存在） */
  private readonly stallWatchdogs = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly bridge: AgentRuntimeBridge) {}

  /**
   * 统一 prompt 入口。
   * 同一 sessionKey 的并发调用会自动串行化。
   */
  async prompt(params: PromptParams): Promise<void> {
    const { sessionKey } = params
    const prev = this.promptLocks.get(sessionKey) ?? Promise.resolve()
    // 在真正轮到自己执行时才重置计时：若前一轮卡死，后续消息只是排队，
    // 计时必须继续从前一轮的起点算，否则卡死会因新消息入队而永远检测不到。
    const next = prev.then(() => {
      this.lockStartedAt.set(sessionKey, Date.now())
      return this._doPrompt(params)
    })
    // catch 包裹：防止一次失败阻塞后续请求
    const guarded = next.catch(() => {})
    this.promptLocks.set(sessionKey, guarded)

    // 锁正常落定即清理，避免陈旧条目与看门狗泄漏
    void guarded.finally(() => {
      if (this.promptLocks.get(sessionKey) === guarded) {
        this.promptLocks.delete(sessionKey)
        this.lockStartedAt.delete(sessionKey)
        const timer = this.stallWatchdogs.get(sessionKey)
        if (timer) {
          clearTimeout(timer)
          this.stallWatchdogs.delete(sessionKey)
        }
      }
    })

    this.armStallWatchdog(sessionKey)
    return next
  }

  /**
   * 给 sessionKey 的锁挂看门狗：超时未结束就告警；到达硬界则强制释放锁。
   * 强制释放是最后手段（正常工作不会触发），目的是不让一次卡死永久堵住该会话。
   */
  private armStallWatchdog(sessionKey: string): void {
    if (this.stallWatchdogs.has(sessionKey)) return

    const check = (): void => {
      this.stallWatchdogs.delete(sessionKey)
      const startedAt = this.lockStartedAt.get(sessionKey)
      // 锁已正常落定（无锁或未记录起点）→ 无需处理
      if (!this.promptLocks.has(sessionKey) || startedAt === undefined) return

      const elapsed = Date.now() - startedAt
      if (elapsed < STALL_RELEASE_MS) {
        log.warn(
          `[prompt] 会话锁已持续 ${Math.round(elapsed / 1000)}s 未结束，仍在等待: sessionKey=${sessionKey}`,
        )
        this.stallWatchdogs.set(sessionKey, setTimeout(check, STALL_WARN_MS))
        return
      }

      log.error(
        `[prompt] 会话锁疑似卡死 ${Math.round(elapsed / 1000)}s，强制释放以便后续消息继续: sessionKey=${sessionKey}`,
      )
      this.promptLocks.delete(sessionKey)
      this.lockStartedAt.delete(sessionKey)
    }

    this.stallWatchdogs.set(sessionKey, setTimeout(check, STALL_WARN_MS))
  }

  /**
   * 清除指定 sessionKey 的锁（/clear、/new 命令切换会话时调用）
   */
  clearLock(sessionKey: string): void {
    this.promptLocks.delete(sessionKey)
    this.lockStartedAt.delete(sessionKey)
    const timer = this.stallWatchdogs.get(sessionKey)
    if (timer) {
      clearTimeout(timer)
      this.stallWatchdogs.delete(sessionKey)
    }
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
    const { instanceId, sessionKey, message, strategy, imageAttachmentPaths, pendingUserMsgId, session } = params

    log.info(
      `[_doPrompt] 开始: instanceId=${instanceId} sessionKey=${sessionKey} msgLen=${message.length} imageCount=${imageAttachmentPaths?.length ?? 0}`,
    )

    const replyTo = resolveReplyTo(session)
    await strategy.beforePrompt(instanceId, sessionKey, pendingUserMsgId)
    try {
      // 统一写入本轮在场状态（P0：二元在场信号）。所有主 Agent 路径都经此入口，
      // 一处写点替代各 adapter 各自写，channelLabel 映射也收敛到 channelLabelOf。
      // channelType/channelUserId 是「消息来源」，供会话切换工具判断该改哪个渠道的路由；
      // replyTo 是「回给这里」，供 channel_send 省略 to 时默认回当前会话（群聊也成立）。
      this.bridge.setInstancePresence(instanceId, {
        userAtClient: session.channelType === 'ipc',
        channelLabel: channelLabelOf(session.channelType),
        channelType: session.channelType,
        channelUserId: session.channelUserId,
        ...(replyTo ? { replyTo } : {}),
      })
      // pendingUserMsgId 继续透传给 bridge.prompt：prompt() 内的自动压缩块会从 DB
      // 重载历史做剪枝/摘要，同样必须排除本条消息，否则它会被 replaceMessages
      // 注入实例内存、又被 instance.prompt() 追加一次，发送末尾出现重复 user。
      await this.bridge.prompt(instanceId, message, imageAttachmentPaths, pendingUserMsgId)
    } finally {
      await strategy.afterPrompt(instanceId, sessionKey)
    }

    log.info(`[_doPrompt] 完成: instanceId=${instanceId} sessionKey=${sessionKey}`)
  }
}
