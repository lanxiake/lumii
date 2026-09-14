/**
 * ChannelSessionStore — 渠道活跃会话路由的持久化
 *
 * 背景：各 adapter 的 `activeSession` 是纯内存 Map，进程重启即丢；微信另有 `/link`
 * 绑定层（`weixin-session-binding.ts`）持久化，其它渠道一点都没有。结果是
 * 「不接续时回哪个会话」完全靠运气：残留的覆盖、或一个从没用过的 `{渠道}:{uid}`，
 * 后者会被 `ensureConversationExists` 就地新建成一个空会话。
 *
 * 本 store 把两件事落库：
 *   - active：该用户当前路由到哪个会话（可能是跨渠道接续借来的）
 *   - own   ：该渠道**本人自己的**最近会话，用于「回到本渠道」时找回落点
 *
 * key：`channel:active:{channelType}:{channelUserId}`
 * value：{ channelType, channelUserId, active, own, updatedAt }
 *
 * 读走内存（`getActiveSessionKey` 是每条入站消息的热路径，绝不能碰 DB），写穿透落库；
 * DB 异常一律降级为纯内存，不能让一次磁盘抖动变成「所有渠道消息路由崩」。
 *
 * 注意：`RuntimeStateRepo.listByPrefix` 是 LIKE 前缀匹配，channelUserId 可能含
 * `_` / `%`。因此用户标识以 JSON value 为准（载入时按 value 建索引），不解析 key。
 */

import type { RuntimeStateRepo } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[ChannelSessionStore]', ...args),
  warn: (...args: unknown[]) => console.warn('[ChannelSessionStore]', ...args),
}

const KEY_PREFIX = 'channel:active:'

/** 兜底查「本渠道最近会话」时扫描的条数（底层是置顶优先序，要足够多才能兜住自己的会话） */
const OWN_LOOKUP_LIMIT = 200

export interface ChannelActiveSession {
  channelType: string
  channelUserId: string
  /** 当前生效路由（可能是跨渠道接续来的会话） */
  active: string
  /** 该渠道自己的最近会话；active 属于本渠道本人时同步更新 */
  own: string | null
  updatedAt: string
}

/** 最近会话列表的形状（bridge.listRecentConversations） */
export type RecentConversationLookup = (
  limit: number,
) => readonly { id: string; updatedAt: string }[]

/**
 * sessionKey 是否属于「该渠道的这位用户」自己的会话。
 *
 * 形如 `weixin:{uid}`（渠道默认会话）或 `weixin:{uid}:{timestamp}`（/new 新建的）。
 * 不能用裸 `startsWith('weixin:u1')` —— `weixin:u1` 是 `weixin:u1x:` 的前缀，会串到别人的会话。
 */
export function isOwnChannelSessionKey(
  channelType: string,
  channelUserId: string,
  sessionKey: string,
): boolean {
  const base = `${channelType}:${channelUserId}`
  return sessionKey === base || sessionKey.startsWith(`${base}:`)
}

export interface ChannelSessionStoreDeps {
  repo: RuntimeStateRepo
  channelType: string
  /** 最近会话列表；用于 store 无记录时的兜底查找（升级前的存量用户） */
  listRecent?: RecentConversationLookup
  /**
   * 会话是否仍存在。
   *
   * 载入时用它剔除已失效的路由：指向已删会话的 key 会让 `ensureConversationExists`
   * 把它重建成一个空会话——正是用户看到的「莫名其妙多了个空会话」。
   * 只在构造时调一次，不进热路径。
   */
  conversationExists?: (conversationId: string) => boolean
}

export class ChannelSessionStore {
  private readonly repo: RuntimeStateRepo
  private readonly channelType: string
  private readonly listRecent?: RecentConversationLookup
  private readonly conversationExists?: (conversationId: string) => boolean

  /** channelUserId → 记录（按 value 索引，避开 key 的 LIKE 通配符问题） */
  private readonly cache = new Map<string, ChannelActiveSession>()
  /** 兜底查找结果记忆化：含「查无结果」（null），否则陌生用户每条消息都要扫一遍 */
  private readonly ownLookupCache = new Map<string, string | null>()

  constructor(deps: ChannelSessionStoreDeps) {
    this.repo = deps.repo
    this.channelType = deps.channelType
    if (deps.listRecent) this.listRecent = deps.listRecent
    if (deps.conversationExists) this.conversationExists = deps.conversationExists
    this.load()
  }

  /** 当前生效路由；无记录返回 null（调用方继续走 /link 绑定或渠道默认会话） */
  getActive(channelUserId: string): string | null {
    return this.cache.get(channelUserId)?.active || null
  }

  /**
   * 本渠道自己的最近会话：先看记录，再兜底扫一次最近会话列表。
   * 找不到就返回 null，由调用方回落到 `{渠道}:{uid}`。
   */
  getOwn(channelUserId: string): string | null {
    const recorded = this.cache.get(channelUserId)?.own
    if (recorded && isOwnChannelSessionKey(this.channelType, channelUserId, recorded)) {
      return recorded
    }
    if (this.ownLookupCache.has(channelUserId)) return this.ownLookupCache.get(channelUserId) ?? null
    const found = this.lookupOwn(channelUserId)
    this.ownLookupCache.set(channelUserId, found)
    return found
  }

  /** 记一次路由变更：更新 active；sessionKey 属于本渠道本人时同步更新 own */
  setActive(channelUserId: string, sessionKey: string): void {
    const prev = this.cache.get(channelUserId)
    const own = isOwnChannelSessionKey(this.channelType, channelUserId, sessionKey)
      ? sessionKey
      : (prev?.own ?? null)
    const row: ChannelActiveSession = {
      channelType: this.channelType,
      channelUserId,
      active: sessionKey,
      own,
      updatedAt: new Date().toISOString(),
    }
    this.cache.set(channelUserId, row)
    this.ownLookupCache.delete(channelUserId)
    this.persist(row)
  }

  /** 删除记录（/unlink 解绑时调用，路由完全交回 /link 绑定或渠道默认会话） */
  clear(channelUserId: string): void {
    this.drop(channelUserId)
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private keyOf(channelUserId: string): string {
    return `${KEY_PREFIX}${this.channelType}:${channelUserId}`
  }

  private drop(channelUserId: string): void {
    this.cache.delete(channelUserId)
    this.ownLookupCache.delete(channelUserId)
    try {
      this.repo.delete(this.keyOf(channelUserId))
    } catch (err) {
      log.warn(`[drop] 删除失败 channelUserId=${channelUserId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  /** 目标会话是否还在（未注入校验时一律按存在处理） */
  private stillExists(conversationId: string): boolean {
    if (!this.conversationExists) return true
    try {
      return this.conversationExists(conversationId)
    } catch {
      // 查不动就当它还在：不要因为一次 DB 抖动丢掉用户的路由
      return true
    }
  }

  /** 载入本渠道的全部记录（键前缀已限定渠道，value 里的 channelUserId 才是真标识） */
  private load(): void {
    try {
      const rows = this.repo.listByPrefix(`${KEY_PREFIX}${this.channelType}:`)
      let dropped = 0
      for (const { value } of rows) {
        try {
          const row = JSON.parse(value) as ChannelActiveSession
          if (!row?.channelUserId || !row.active || row.channelType !== this.channelType) continue

          const activeAlive = this.stillExists(row.active)
          const ownAlive = row.own ? this.stillExists(row.own) : false
          if (!activeAlive && !ownAlive) {
            // 指向的会话都被删了：整条丢掉，路由交回 /link 绑定或渠道默认会话
            this.drop(row.channelUserId)
            dropped += 1
            continue
          }
          // 失效的那一半清掉，避免 ensureConversationExists 把已删会话重建成空会话
          if (!activeAlive) row.active = ''
          row.own = ownAlive ? row.own : null
          this.cache.set(row.channelUserId, row)
          if (!activeAlive) dropped += 1
        } catch {
          // 忽略损坏的记录
        }
      }
      log.info(
        `[load] 渠道 ${this.channelType} 载入 ${this.cache.size} 条活跃会话记录（失效 ${dropped} 条）`,
      )
    } catch (err) {
      // bridge 未初始化等：降级为纯内存，不影响消息处理
      log.warn(`[load] 载入失败，降级为纯内存: ${err instanceof Error ? err.message : err}`)
    }
  }

  private persist(row: ChannelActiveSession): void {
    try {
      this.repo.setJson(this.keyOf(row.channelUserId), row)
    } catch (err) {
      log.warn(`[persist] 写入失败 channelUserId=${row.channelUserId}: ${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * 兜底找「本渠道本人的最近会话」。
   *
   * 不能直接取 `listRecent(1)`：底层 SQL 是 `is_pinned DESC, last_msg_at DESC`，
   * 置顶的旧会话会压过五分钟前的真实会话。这里取一批后自己按时间排序。
   */
  private lookupOwn(channelUserId: string): string | null {
    if (!this.listRecent) return null
    try {
      const mine = this.listRecent(OWN_LOOKUP_LIMIT).filter((c) =>
        isOwnChannelSessionKey(this.channelType, channelUserId, c.id),
      )
      if (mine.length === 0) return null
      return mine.reduce((latest, c) =>
        Date.parse(c.updatedAt) > Date.parse(latest.updatedAt) ? c : latest,
      ).id
    } catch (err) {
      log.warn(`[lookupOwn] 查询失败 channelUserId=${channelUserId}: ${err instanceof Error ? err.message : err}`)
      return null
    }
  }
}
