/**
 * 跨渠道会话接续（§5.4，P2；2026-09-15 按 10-S4 方案 A 重做）
 *
 * 用户在客户端聊了一半，转到微信继续说「接着刚才的」——Agent 本来不知道「刚才」是哪个会话。
 * 本模块在渠道消息进入 Agent 之前**提示**一句，把选择权交给用户：
 *
 *   渠道消息到达（非斜杠命令、非挂起答复）
 *         │ 该 channelUserId 在别的渠道有近期活跃会话，且**当前路由**还没提示过
 *         ▼
 *   回一条「检测到你在【客户端】有进行中的对话：<标题>；回 1 继续那条，回 0 忽略」
 *         ├─ 回 1  → **后续消息**路由到该会话（本条消息仍在当前会话里回答）
 *         ├─ 回 0  → 什么都不变
 *         └─ 不回  → 什么都不变（提示 10 分钟后失效）
 *
 * 与旧实现（S4 之前）的区别，正是「混乱」的来源，逐条记在这里：
 *   - **不扣消息**：旧版把当前消息扣在 pending 里，等答复后靠 `replay()` 让 adapter 重跑
 *     一遍 `handleMessage`。重放不走 `userQueues`，与紧随的 `/clear` 竞态（清空后旧消息又冒出来），
 *     且每条作废路径都要想清楚要不要补投。现在消息照常处理，没有「被扣住的消息」这回事。
 *   - **无定时器**：旧版 1 分钟无回复就默认接续——用户没看见提示也会被换会话。现在默认什么都不变，
 *     提示只在有效期内（10 分钟）可被「1」兑现，过期即作废（惰性判定，不挂 timer）。
 *   - **按用户记，不按会话记**：旧版 `asked: Set<sessionKey>` 只增不减，且键是「路由」而非「用户」，
 *     接续后路由变成借来的键，还得手工补两处标记。现在记「该用户已就**哪条**路由提示过」，
 *     用户换会话（/new、/resume、/back）后自然可以再提示一次。
 */

import type { ChannelSession, IChannelAdapter } from './types'
import { resolveChannelIdentity } from './channel-identity'
import { RECENT_SCAN_LIMIT, sortByUpdatedAtDesc } from './recent-conversations'

const log = {
  info: (...args: unknown[]) => console.log('[CrossChannelContinuity]', ...args),
  warn: (...args: unknown[]) => console.warn('[CrossChannelContinuity]', ...args),
}

/** 提示的有效期：用户在这段时间内回 1 才兑现；过期什么都不发生 */
export const CONTINUITY_OFFER_TTL_MS = 10 * 60 * 1000

/** 候选会话：来自其它渠道的近期活跃会话 */
export interface ContinuityCandidate {
  conversationId: string
  title: string
  updatedAt: string
  /** 该会话所属渠道的中文名（客户端 / 微信 / 飞书…） */
  channelLabel: string
}

/** 会话列表项（bridge.listRecentConversations 的形状） */
export interface RecentConversation {
  id: string
  title: string
  updatedAt: string
  /** 归属落库值（conversations.channel_type）；缺失时按前缀回退 */
  channelType?: string | null
}

// ── 纯函数：候选判定 ──────────────────────────────────────────────────────────

/**
 * 从最近会话列表里挑一个「其它渠道的活跃会话」作为接续候选。
 *
 * 排除：当前会话自己、同渠道的其它会话（同渠道用 /resume 即可，不需要接续提示）、
 * 定时任务等非用户会话、超出时间窗的旧会话。
 *
 * 归属判定一律走 `resolveChannelIdentity`（落库值优先，缺了才回退前缀）——
 * 前缀只说明会话从哪来，不说明此刻谁在说话（10 号计划 §2.1 的日志实证）。
 *
 * @param recent 按 updatedAt 降序的最近会话（bridge.listRecentConversations）
 * @param currentSessionKey 本轮消息所属会话
 * @param currentSessionOwnership 当前会话的归属落库值（缺省回退前缀）
 * @param currentChannelType 本轮消息来源渠道（**当前在说话的那个渠道**）
 * @param now 当前时间戳（注入便于测试）
 * @param windowMs 活跃时间窗（默认 3 天）
 */
export function pickContinuityCandidate(params: {
  recent: readonly RecentConversation[]
  currentSessionKey: string
  currentSessionOwnership?: string | null
  currentChannelType: string
  now?: number
  windowMs?: number
}): ContinuityCandidate | null {
  const {
    recent,
    currentSessionKey,
    currentSessionOwnership,
    currentChannelType,
    now = Date.now(),
    windowMs = 3 * 24 * 60 * 60 * 1000,
  } = params

  // 当前会话并不属于本渠道 —— 用户已经在别的会话里了（/link 绑定，或上次接续的结果）。
  // 此时再问「是否接续」既没有语义，又危险：回 0 会把他从自己选定的会话里踢出去。
  if (resolveChannelIdentity(currentSessionKey, currentSessionOwnership).ownership !== currentChannelType) {
    return null
  }

  // 底层列表是「置顶优先」序而非时间序（conversation-repo.listActiveConversations），
  // 置顶的旧会话会压过真正最近的会话。先按时间排一遍，否则会挑到两天前的闲聊。
  const ordered = sortByUpdatedAtDesc(recent)

  for (const conv of ordered) {
    if (conv.id === currentSessionKey) continue

    const { ownership, label } = resolveChannelIdentity(conv.id, conv.channelType)
    // 同渠道 / 非用户会话不作候选
    if (ownership === currentChannelType || !label) continue

    if (now - Date.parse(conv.updatedAt) > windowMs) continue

    return {
      conversationId: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      channelLabel: label,
    }
  }
  return null
}

/**
 * 提示文案（10-S5 消歧）：**不再要求用户回裸数字**。
 *
 * 渠道里另有一套「回 1/2/3」的协议（审批与提问选项，见 `channel-interaction-store.ts`），
 * 两套都问「1」时用户无法表达自己在回答哪一个。审批那一套是位阶选择，天然用数字；
 * 所以这里改用词，让两种提示在词面上就分得开（`parseContinuityReply` 仍容忍 1/0/是/否 等旧写法）。
 */
export function formatContinuityPrompt(candidate: ContinuityCandidate): string {
  return [
    `检测到你在【${candidate.channelLabel}】有进行中的对话：`,
    `「${candidate.title}」`,
    '',
    '回复「接续」继续那条对话（本条消息仍在这里回答），回复「不接续」忽略。',
  ].join('\n')
}

/** 解析用户对提示的回复：1=接续，0=不接续，null=没看懂 */
export function parseContinuityReply(text: string): boolean | null {
  const t = text.trim().toLowerCase()
  if (t === '1' || t === 'y' || t === 'yes' || t === '是' || t === '接续') return true
  if (t === '0' || t === 'n' || t === 'no' || t === '否' || t === '不' || t === '不接续') return false
  return null
}

// ── 状态机 ────────────────────────────────────────────────────────────────────

interface ContinuityOffer {
  candidate: ContinuityCandidate
  expiresAt: number
}

export interface ContinuityDeps {
  /** 最近会话列表（bridge.listRecentConversations）。bridge 是单例，可作全局依赖 */
  listRecent: (limit: number) => readonly RecentConversation[]
  /**
   * 查会话归属落库值（`conversations.channel_type`）。
   * 归属是「会话从哪来」，与「此刻谁在说话」不同——守卫要用它判断「当前会话是否属于本渠道」。
   * 查不到返回 null，交由 `resolveChannelIdentity` 回退前缀。
   */
  lookupOwnership: (conversationId: string) => string | null
  /** 时钟（测试注入） */
  now?: () => number
}

/** 用户键：接续是**用户级**事实，与当前路由无关 */
function userKeyOf(channelType: string, channelUserId: string): string {
  return `${channelType}:${channelUserId}`
}

/**
 * 接续提示状态机。全局单例（与 ChannelInteractionHub 同理：各渠道共用一份记录）。
 *
 * 只存两样东西：有效期内可兑现的提示、以及「该用户已就哪条路由提示过」。
 * 没有 pending、没有定时器、没有重放。
 */
export class CrossChannelContinuity {
  /** 用户键 → 未过期的提示 */
  private readonly offers = new Map<string, ContinuityOffer>()
  /** 用户键 → 已提示过的路由（换会话后可再提示一次） */
  private readonly noticedRoute = new Map<string, string>()

  constructor(private readonly deps: ContinuityDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /**
   * 就本轮消息给出接续提示（若该用户确有别的渠道的活跃会话）。
   *
   * **不拦截消息**：返回值只表示「是否发了提示」，调用方照常处理这条消息——
   * 用户选择接续是下一次发言才生效的事。
   *
   * @param hasPendingInteraction 该会话是否正等用户答复审批/提问。是则**不发提示**：
   *   用户下一条消息会被那套协议吃掉，此时再给一个「回复…」只会让两条提示抢同一条消息。
   */
  maybeNotice(params: {
    adapter: IChannelAdapter
    session: ChannelSession
    hasPendingInteraction?: boolean
  }): boolean {
    const { adapter, session, hasPendingInteraction } = params
    const { sessionKey, channelType, channelUserId } = session
    const userKey = userKeyOf(channelType, channelUserId)

    // 同一路由只提示一次。用户换会话（/new、/resume、/back）后路由变了，可以再提示。
    if (this.noticedRoute.get(userKey) === sessionKey) return false
    // 有挂起的审批/提问时不提示（也不记为看过：等那套流程结束再评估）
    if (hasPendingInteraction) return false

    let candidate: ContinuityCandidate | null = null
    try {
      candidate = pickContinuityCandidate({
        recent: this.deps.listRecent(RECENT_SCAN_LIMIT),
        currentSessionKey: sessionKey,
        currentSessionOwnership: this.deps.lookupOwnership(sessionKey),
        currentChannelType: channelType,
      })
    } catch (err) {
      log.warn(`[maybeNotice] 候选查询失败，跳过提示: ${err instanceof Error ? err.message : err}`)
      return false
    }
    // 没有候选也记一笔：避免每条消息都重查一次 DB（与旧实现一致）
    this.noticedRoute.set(userKey, sessionKey)
    if (!candidate) return false

    this.offers.set(userKey, {
      candidate,
      expiresAt: this.now() + CONTINUITY_OFFER_TTL_MS,
    })
    void adapter.sendTextReply(session, formatContinuityPrompt(candidate)).catch((err) => {
      log.warn(`[maybeNotice] 提示推送失败 ${userKey}: ${err}`)
    })
    log.info(`[maybeNotice] 已提示接续 ${userKey} → 候选=${candidate.conversationId}（${candidate.channelLabel}）`)
    return true
  }

  /**
   * 拦截入站文字：若该用户有未过期的提示，且这条是有效答复，则消费掉。
   *
   * @returns true 表示已作为答复消费，调用方不要再交给 Agent
   */
  tryConsumeReply(adapter: IChannelAdapter, session: ChannelSession, text: string): boolean {
    const { channelType, channelUserId } = session
    const userKey = userKeyOf(channelType, channelUserId)
    const offer = this.liveOffer(userKey)
    if (!offer) return false

    const decision = parseContinuityReply(text)
    // 没看懂：本条当普通消息放行（用户可能压根不想理这个提示，直接换了话题）
    if (decision === null) return false

    this.offers.delete(userKey)
    if (!decision) {
      void adapter.sendTextReply(session, '好的，留在当前会话。').catch(() => {})
      log.info(`[tryConsumeReply] 用户选择不接续 ${userKey}`)
      return true
    }

    // 接续：只改路由，后续消息走目标会话。本条消息已在当前会话里回答过/正在回答，不带过去。
    adapter.setActiveSessionKey?.(channelUserId, offer.candidate.conversationId, 'continuity')
    // 回读确认：目标会话可能已被删除（store 会拒绝这种写入）
    const applied = adapter.getActiveSessionKey?.(channelUserId) === offer.candidate.conversationId
    void adapter
      .sendTextReply(
        session,
        applied
          ? `✅ 已接续「${offer.candidate.title}」，后续消息会发到那条会话。\n（发送 /back 可回到本渠道会话）`
          : '⚠️ 那条会话已不可用（可能已被删除），留在当前会话。',
      )
      .catch(() => {})
    log.info(
      `[tryConsumeReply] ${applied ? '已接续' : '接续失败'} ${userKey} → ${offer.candidate.conversationId}`,
    )
    return true
  }

  /**
   * 作废该用户的挂起提示（`/stop`、斜杠命令时调用）。
   *
   * 不清 `noticedRoute`：用户已就这条路由做过决定，不该因为发了条命令又被问一次。
   */
  clear(channelType: string, channelUserId: string): void {
    this.offers.delete(userKeyOf(channelType, channelUserId))
  }

  /**
   * 完全重新武装（`/clear` 调用）：作废提示，并允许就当前路由再提示一次。
   *
   * 其它换会话的命令（`/new`、`/resume`、`/back`）不需要它——路由一变，
   * `noticedRoute` 自然对不上，下次消息就会重新评估。
   */
  resetNotice(channelType: string, channelUserId: string): void {
    const userKey = userKeyOf(channelType, channelUserId)
    this.offers.delete(userKey)
    this.noticedRoute.delete(userKey)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 取未过期的提示（惰性过期：不挂 timer，读到过期即删） */
  private liveOffer(userKey: string): ContinuityOffer | null {
    const offer = this.offers.get(userKey)
    if (!offer) return null
    if (this.now() > offer.expiresAt) {
      this.offers.delete(userKey)
      return null
    }
    return offer
  }
}

/** 全局单例：各渠道共用一份「提示过 / 待兑现」记录 */
let instance: CrossChannelContinuity | null = null

export function getCrossChannelContinuity(deps: ContinuityDeps): CrossChannelContinuity {
  if (!instance) instance = new CrossChannelContinuity(deps)
  return instance
}

/** 测试用：重置单例 */
export function __resetCrossChannelContinuity(): void {
  instance = null
}

// ── adapter 侧接线 ────────────────────────────────────────────────────────────

/**
 * 渠道 adapter 统一入口：功能开时返回状态机，关时返回 undefined。
 *
 * 开关每次读（同步、走内存缓存），用户在设置页关掉后立即生效，不需重启。
 */
export function resolveContinuityForChannel(params: {
  enabled: boolean
  bridge: {
    listRecentConversations: (limit: number) => readonly RecentConversation[]
    /** 读会话归属落库值（`conversations.channel_type`） */
    getConversationOwnership?: (conversationId: string) => string | null
  }
}): CrossChannelContinuity | undefined {
  if (!params.enabled) return undefined
  return getCrossChannelContinuity({
    listRecent: (limit) => params.bridge.listRecentConversations(limit),
    // 桥未提供查归属（测试桩/裁剪宿主）时返回 null → 回退前缀推断
    lookupOwnership: (conversationId) =>
      params.bridge.getConversationOwnership?.(conversationId) ?? null,
  })
}
