/**
 * ChannelSessionStore — 渠道会话路由的持久化与内存缓存（**进程单例**）
 *
 * 背景：各 adapter 原本各自持有一份 `activeSession` 内存 Map + 一份 store 实例，
 * 同一份「这个用户该路由到哪个会话」被存了三次（内存 Map / store cache / 微信的
 * `/link` 绑定），且四份实现各写各的。本 store 收口为**一份数据、一处读写**：
 *
 *   - active：该用户当前路由到哪个会话（可能是跨渠道接续借来的）
 *   - own   ：该渠道**本人自己的**最近会话，用于「回到本渠道」时找回落点
 *   - source：active 是怎么来的（own / link / continuity / resume）——
 *     `/back` 据此决定要不要释放 `/link` 绑定，也让「借来的路由」在数据上可见
 *
 * key：`channel:active:{channelType}:{channelUserId}`
 * value：{ channelType, channelUserId, active, own, source, updatedAt }
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

/**
 * 当前路由的来源。
 *
 * - `own`：本渠道本人的会话（默认、`/new`）
 * - `link`：`/link` 绑定借来的（仅微信有绑定层）
 * - `continuity`：跨渠道接续借来的
 * - `resume`：用户用 `/resume` 或 Agent 的 `session_resume` 显式选的
 */
export type RouteSource = 'own' | 'link' | 'continuity' | 'resume'

export interface ChannelActiveSession {
  channelType: string
  channelUserId: string
  /** 当前生效路由（可能是跨渠道接续来的会话） */
  active: string
  /** 该渠道自己的最近会话；active 属于本渠道本人时同步更新 */
  own: string | null
  /** active 的来源；老记录（S3 之前）没有这个字段，读作 undefined = 未知 */
  source?: RouteSource
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
  /** 最近会话列表；用于 store 无记录时的兜底查找（升级前的存量用户） */
  listRecent?: RecentConversationLookup
  /**
   * 会话是否仍存在。
   *
   * 载入时用它剔除已失效的路由：指向已删会话的 key 会让 `ensureConversationExists`
   * 把它重建成一个空会话——正是用户看到的「莫名其妙多了个空会话」。
   * 写入时也用它兜一道（B6）：切到一个已被删掉的会话不该静默生效。
   */
  conversationExists?: (conversationId: string) => boolean
}

export class ChannelSessionStore {
  private readonly repo: RuntimeStateRepo
  private readonly listRecent?: RecentConversationLookup
  private readonly conversationExists?: (conversationId: string) => boolean

  /** `${channelType}:${channelUserId}` → 记录（按 value 索引，避开 key 的 LIKE 通配符问题） */
  private readonly cache = new Map<string, ChannelActiveSession>()
  /** 兜底查找结果记忆化：含「查无结果」（null），否则陌生用户每条消息都要扫一遍 */
  private readonly ownLookupCache = new Map<string, string | null>()

  constructor(deps: ChannelSessionStoreDeps) {
    this.repo = deps.repo
    if (deps.listRecent) this.listRecent = deps.listRecent
    if (deps.conversationExists) this.conversationExists = deps.conversationExists
    this.load()
  }

  /** 当前生效路由；无记录返回 null（调用方继续走 /link 绑定或渠道默认会话） */
  getActive(channelType: string, channelUserId: string): string | null {
    return this.cache.get(cacheKey(channelType, channelUserId))?.active || null
  }

  /** 当前路由的来源；无记录返回 null，老记录返回 undefined（未知） */
  getSource(channelType: string, channelUserId: string): RouteSource | undefined | null {
    const row = this.cache.get(cacheKey(channelType, channelUserId))
    return row ? row.source : null
  }

  /**
   * 本渠道自己的最近会话：先看记录，再兜底扫一次最近会话列表。
   * 找不到就返回 null，由调用方回落到 `{渠道}:{uid}`。
   */
  getOwn(channelType: string, channelUserId: string): string | null {
    const recorded = this.cache.get(cacheKey(channelType, channelUserId))?.own
    if (recorded && isOwnChannelSessionKey(channelType, channelUserId, recorded)) {
      return recorded
    }
    const memoKey = cacheKey(channelType, channelUserId)
    if (this.ownLookupCache.has(memoKey)) return this.ownLookupCache.get(memoKey) ?? null
    const found = this.lookupOwn(channelType, channelUserId)
    this.ownLookupCache.set(memoKey, found)
    return found
  }

  /**
   * 记一次路由变更：更新 active 与 source；sessionKey 属于本渠道本人时同步更新 own。
   *
   * @returns false = 目标会话已不存在（或查不动），**路由保持不变**——
   *   让 `ensureConversationExists` 把已删会话重建成空会话，比留在原地更糟。
   */
  setActive(
    channelType: string,
    channelUserId: string,
    sessionKey: string,
    source: RouteSource,
  ): boolean {
    if (!this.stillExists(sessionKey)) {
      log.warn(
        `[setActive] 目标会话不存在，路由不变 channelType=${channelType} uid=${channelUserId} target=${sessionKey}`,
      )
      return false
    }
    const key = cacheKey(channelType, channelUserId)
    const prev = this.cache.get(key)
    const own = isOwnChannelSessionKey(channelType, channelUserId, sessionKey)
      ? sessionKey
      : (prev?.own ?? null)
    const row: ChannelActiveSession = {
      channelType,
      channelUserId,
      active: sessionKey,
      own,
      source,
      updatedAt: new Date().toISOString(),
    }
    this.cache.set(key, row)
    this.ownLookupCache.delete(key)
    this.persist(row)
    return true
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private keyOf(channelType: string, channelUserId: string): string {
    return `${KEY_PREFIX}${channelType}:${channelUserId}`
  }

  private drop(channelType: string, channelUserId: string): void {
    this.cache.delete(cacheKey(channelType, channelUserId))
    this.ownLookupCache.delete(cacheKey(channelType, channelUserId))
    try {
      this.repo.delete(this.keyOf(channelType, channelUserId))
    } catch (err) {
      log.warn(
        `[drop] 删除失败 channelType=${channelType} channelUserId=${channelUserId}: ${err instanceof Error ? err.message : err}`,
      )
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

  /** 载入全部渠道的记录（value 里的 channelType/channelUserId 才是真标识） */
  private load(): void {
    try {
      const rows = this.repo.listByPrefix(KEY_PREFIX)
      let dropped = 0
      for (const { value } of rows) {
        try {
          const row = JSON.parse(value) as ChannelActiveSession
          if (!row?.channelType || !row.channelUserId || !row.active) continue

          const activeAlive = this.stillExists(row.active)
          const ownAlive = row.own ? this.stillExists(row.own) : false
          if (!activeAlive && !ownAlive) {
            // 指向的会话都被删了：整条丢掉，路由交回 /link 绑定或渠道默认会话
            this.drop(row.channelType, row.channelUserId)
            dropped += 1
            continue
          }
          // 失效的那一半清掉，避免 ensureConversationExists 把已删会话重建成空会话
          if (!activeAlive) row.active = ''
          row.own = ownAlive ? row.own : null
          this.cache.set(cacheKey(row.channelType, row.channelUserId), row)
          if (!activeAlive) dropped += 1
        } catch {
          // 忽略损坏的记录
        }
      }
      log.info(`[load] 载入 ${this.cache.size} 条活跃会话记录（失效 ${dropped} 条）`)
    } catch (err) {
      // bridge 未初始化等：降级为纯内存，不影响消息处理
      log.warn(`[load] 载入失败，降级为纯内存: ${err instanceof Error ? err.message : err}`)
    }
  }

  private persist(row: ChannelActiveSession): void {
    try {
      this.repo.setJson(this.keyOf(row.channelType, row.channelUserId), row)
    } catch (err) {
      log.warn(
        `[persist] 写入失败 channelUserId=${row.channelUserId}: ${err instanceof Error ? err.message : err}`,
      )
    }
  }

  /**
   * 兜底找「本渠道本人的最近会话」。
   *
   * 不能直接取 `listRecent(1)`：底层 SQL 是 `is_pinned DESC, last_msg_at DESC`，
   * 置顶的旧会话会压过五分钟前的真实会话。这里取一批后自己按时间排序。
   */
  private lookupOwn(channelType: string, channelUserId: string): string | null {
    if (!this.listRecent) return null
    try {
      const mine = this.listRecent(OWN_LOOKUP_LIMIT).filter((c) =>
        isOwnChannelSessionKey(channelType, channelUserId, c.id),
      )
      if (mine.length === 0) return null
      return mine.reduce((latest, c) =>
        Date.parse(c.updatedAt) > Date.parse(latest.updatedAt) ? c : latest,
      ).id
    } catch (err) {
      log.warn(
        `[lookupOwn] 查询失败 channelUserId=${channelUserId}: ${err instanceof Error ? err.message : err}`,
      )
      return null
    }
  }
}

function cacheKey(channelType: string, channelUserId: string): string {
  return `${channelType}:${channelUserId}`
}

/**
 * 进程单例：路由表只有一份，四个 adapter 共用。
 *
 * 与 `getChannelInteractionHub` 同理——多份实例意味着「一处的切换另一处看不到」。
 */
let instance: ChannelSessionStore | null = null

export function getChannelSessionStore(deps: ChannelSessionStoreDeps): ChannelSessionStore {
  if (!instance) instance = new ChannelSessionStore(deps)
  return instance
}

/** 测试用：重置单例 */
export function __resetChannelSessionStore(): void {
  instance = null
}
