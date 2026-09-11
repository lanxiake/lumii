/**
 * 跨渠道会话接续（§5.4，P2）
 *
 * 用户在客户端聊了一半，转到微信继续说「接着刚才的」——Agent 本来不知道「刚才」是哪个会话。
 * 本模块在渠道消息进入 Agent 之前插一步询问：
 *
 *   渠道消息到达（非斜杠命令、非挂起答复）
 *         │ 该 channelUserId 在别的渠道有近期活跃会话，且本会话没问过
 *         ▼
 *   回一条「检测到你在【客户端】有进行中的对话：<标题>，回 1 接续 / 0 不接续」
 *         ├─ 回 1  → 绑定到该会话，后续消息走它
 *         ├─ 回 0  → 留在当前会话
 *         └─ 30s 无回复 → 默认不接续
 *
 * 「只问一次」用内存 Map：重启后重问一次的成本可接受，不值得落库（设计 §5.4）。
 */

import type { ChannelSession, IChannelAdapter } from './types'

const log = {
  info: (...args: unknown[]) => console.log('[CrossChannelContinuity]', ...args),
  warn: (...args: unknown[]) => console.warn('[CrossChannelContinuity]', ...args),
}

/** 询问超时（设计 §5.4：30 秒内不回复默认不接续） */
export const CONTINUITY_TIMEOUT_MS = 30_000

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
}

// ── 纯函数：候选判定 ──────────────────────────────────────────────────────────

/** 已知渠道前缀 → 中文名。无前缀 = 客户端会话 */
const SESSION_PREFIX_LABELS: Record<string, string> = {
  weixin: '微信',
  feishu: '飞书',
  wecom: '企业微信',
  qbot: 'QQ',
}

/** 非用户会话的前缀（定时任务、工具进化等），不作为接续候选 */
const NON_USER_PREFIXES = new Set(['cron', 'evolution'])

/**
 * 从 sessionKey 反推渠道来源。
 * 约定：渠道会话形如 `weixin:{userId}`；客户端会话是裸 conversationId（无已知前缀）。
 */
export function channelOfSessionKey(sessionKey: string): {
  channelType: string
  label: string
} {
  const prefix = sessionKey.split(':')[0] ?? ''
  if (prefix in SESSION_PREFIX_LABELS) {
    return { channelType: prefix, label: SESSION_PREFIX_LABELS[prefix]! }
  }
  if (NON_USER_PREFIXES.has(prefix)) return { channelType: prefix, label: '' }
  return { channelType: 'ipc', label: '客户端' }
}

/**
 * 从最近会话列表里挑一个「其它渠道的活跃会话」作为接续候选。
 *
 * 排除：当前会话自己、同渠道的其它会话（同渠道用 /resume 即可，不需要接续询问）、
 * 定时任务等非用户会话、超出时间窗的旧会话。
 *
 * @param recent 按 updatedAt 降序的最近会话（bridge.listRecentConversations）
 * @param currentSessionKey 本轮消息所属会话
 * @param currentChannelType 本轮消息来源渠道
 * @param now 当前时间戳（注入便于测试）
 * @param windowMs 活跃时间窗（默认 3 天）
 */
export function pickContinuityCandidate(params: {
  recent: readonly RecentConversation[]
  currentSessionKey: string
  currentChannelType: string
  now?: number
  windowMs?: number
}): ContinuityCandidate | null {
  const {
    recent,
    currentSessionKey,
    currentChannelType,
    now = Date.now(),
    windowMs = 3 * 24 * 60 * 60 * 1000,
  } = params

  for (const conv of recent) {
    if (conv.id === currentSessionKey) continue

    const { channelType, label } = channelOfSessionKey(conv.id)
    // 同渠道 / 非用户会话不作候选
    if (channelType === currentChannelType || !label) continue

    const ts = Date.parse(conv.updatedAt)
    if (!Number.isFinite(ts) || now - ts > windowMs) continue

    return {
      conversationId: conv.id,
      title: conv.title,
      updatedAt: conv.updatedAt,
      channelLabel: label,
    }
  }
  return null
}

/** 询问文案（设计 §5.4） */
export function formatContinuityPrompt(candidate: ContinuityCandidate): string {
  return [
    `检测到你在【${candidate.channelLabel}】有进行中的对话：`,
    `「${candidate.title}」`,
    '',
    '是否接续该对话？回复 1 接续，0 不接续（30 秒内不回复默认不接续）。',
  ].join('\n')
}

/** 解析用户对询问的回复：1=接续，0=不接续，null=没看懂 */
export function parseContinuityReply(text: string): boolean | null {
  const t = text.trim().toLowerCase()
  if (t === '1' || t === 'y' || t === 'yes' || t === '是' || t === '接续') return true
  if (t === '0' || t === 'n' || t === 'no' || t === '否' || t === '不' || t === '不接续') return false
  return null
}

// ── 状态机 ────────────────────────────────────────────────────────────────────

interface PendingAsk {
  candidate: ContinuityCandidate
  adapter: IChannelAdapter
  session: ChannelSession
  timer: NodeJS.Timeout
  /**
   * 重放被扣住的那条消息 —— 即 adapter 再跑一次自己的 handleMessage。
   *
   * 不自己拼投递逻辑：重放时 adapter 会重新 buildSession()，
   * 接续已改过 activeSessionKey，路由自然落到目标会话（复用既有优先级链）。
   */
  replay: () => void
  /**
   * 持久化绑定（仅微信有 WeixinSessionBindingManager）。
   *
   * 必须随 pending 存：本类是跨渠道单例，bind 属于发起询问的那个 adapter，
   * 存进构造依赖会让先注册的渠道的 bind 被用到其它渠道的会话上。
   */
  bind?: (channelUserId: string, conversationId: string) => void
}

export interface ContinuityDeps {
  /** 最近会话列表（bridge.listRecentConversations）。bridge 是单例，可作全局依赖 */
  listRecent: (limit: number) => readonly RecentConversation[]
}

/**
 * 接续询问状态机。全局单例（与 ChannelInteractionHub 同理：各渠道共用一份问过记录）。
 */
export class CrossChannelContinuity {
  /** sessionKey → 挂起的询问 */
  private readonly pending = new Map<string, PendingAsk>()
  /** 已问过的 sessionKey（只问一次；进程内有效） */
  private readonly asked = new Set<string>()

  constructor(private readonly deps: ContinuityDeps) {}

  /** 该会话是否正在等接续答复 */
  hasPending(sessionKey: string): boolean {
    return this.pending.has(sessionKey)
  }

  /**
   * 尝试就本轮消息发起接续询问。
   *
   * @returns true 表示已发出询问并扣住这条消息，调用方不要再交给 Agent
   */
  maybeAsk(params: {
    adapter: IChannelAdapter
    session: ChannelSession
    replay: () => void
    /** 持久化绑定（仅微信有；其它渠道靠 setActiveSessionKey 的进程内路由） */
    bind?: (channelUserId: string, conversationId: string) => void
  }): boolean {
    const { adapter, session, replay, bind } = params
    const { sessionKey, channelType } = session

    if (this.asked.has(sessionKey) || this.pending.has(sessionKey)) return false

    let candidate: ContinuityCandidate | null = null
    try {
      candidate = pickContinuityCandidate({
        recent: this.deps.listRecent(10),
        currentSessionKey: sessionKey,
        currentChannelType: channelType,
      })
    } catch (err) {
      log.warn(`[maybeAsk] 候选查询失败，跳过询问: ${err instanceof Error ? err.message : err}`)
      return false
    }
    if (!candidate) {
      // 没有候选也算问过：避免每条消息都重查 DB
      this.asked.add(sessionKey)
      return false
    }

    const timer = setTimeout(() => {
      this.resolve(sessionKey, false, '超时')
    }, CONTINUITY_TIMEOUT_MS)
    // 询问是可选增强，不该让 Electron 进程为它多活 30 秒
    timer.unref?.()

    this.pending.set(sessionKey, { candidate, adapter, session, timer, replay, bind })
    this.asked.add(sessionKey)

    void adapter.sendTextReply(session, formatContinuityPrompt(candidate)).catch((err) => {
      log.warn(`[maybeAsk] 询问推送失败 sessionKey=${sessionKey}: ${err}`)
    })
    log.info(
      `[maybeAsk] 已询问接续 sessionKey=${sessionKey} → 候选=${candidate.conversationId}（${candidate.channelLabel}）`,
    )
    return true
  }

  /**
   * 拦截入站文字：若该会话正等接续答复，消费掉这条消息。
   *
   * @returns true 表示已作为答复消费，adapter 不应再当普通消息处理
   */
  tryConsumeReply(sessionKey: string, text: string): boolean {
    const entry = this.pending.get(sessionKey)
    if (!entry) return false

    const decision = parseContinuityReply(text)
    if (decision === null) {
      // 没看懂：不消费，当普通消息放行（用户可能压根不想理这个询问，直接换了话题）
      this.clearPending(sessionKey)
      log.info(`[tryConsumeReply] 未识别为接续答复，放行为普通消息 sessionKey=${sessionKey}`)
      return false
    }

    this.resolve(sessionKey, decision, '用户回复')
    return true
  }

  /** /clear、/new、中止时清掉挂起询问，避免陈旧询问吃掉下一条正常消息 */
  clear(sessionKey: string): void {
    this.clearPending(sessionKey)
    this.asked.delete(sessionKey)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private clearPending(sessionKey: string): void {
    const entry = this.pending.get(sessionKey)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(sessionKey)
  }

  /** 收敛一次询问：接续则先绑定再重放，不接续直接重放（两种都要把扣住的消息投出去） */
  private resolve(sessionKey: string, accepted: boolean, reason: string): void {
    const entry = this.pending.get(sessionKey)
    if (!entry) return
    this.clearPending(sessionKey)

    const { candidate, adapter, session, replay, bind } = entry
    log.info(`[resolve] sessionKey=${sessionKey} accepted=${accepted} reason=${reason}`)

    if (accepted) {
      try {
        bind?.(session.channelUserId, candidate.conversationId)
        adapter.setActiveSessionKey?.(session.channelUserId, candidate.conversationId)
        // 标记目标会话也已问过：否则重放时它成了「新会话」，会被再问一次
        this.asked.add(candidate.conversationId)
        void adapter
          .sendTextReply(
            { ...session, sessionKey: candidate.conversationId, instanceId: null },
            `✅ 已接续「${candidate.title}」，继续处理你刚才的消息…`,
          )
          .catch(() => {})
      } catch (err) {
        log.warn(`[resolve] 绑定失败，留在原会话: ${err instanceof Error ? err.message : err}`)
      }
    }

    // 重放：adapter 重新 buildSession()，接续后路由自然落到目标会话
    try {
      replay()
    } catch (err) {
      log.warn(`[resolve] 消息重放失败: ${err instanceof Error ? err.message : err}`)
    }
  }
}

/** 全局单例：各渠道共用一份「问过 / 挂起」记录 */
let instance: CrossChannelContinuity | null = null

export function getCrossChannelContinuity(
  deps: ContinuityDeps,
): CrossChannelContinuity {
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
  }
}): CrossChannelContinuity | undefined {
  if (!params.enabled) return undefined
  return getCrossChannelContinuity({
    listRecent: (limit) => params.bridge.listRecentConversations(limit),
  })
}
