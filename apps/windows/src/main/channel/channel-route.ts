/**
 * ChannelRouteService —— 渠道会话路由的**唯一决策点**（10-S3）
 *
 * 此前「这条渠道消息该进哪个会话」由四份几乎逐字的 adapter 拷贝回答，且答案来自三层
 * 互不知晓的状态：各自的内存 Map、`ChannelSessionStore`、微信独有的 `/link` 绑定。
 * 直接后果：
 *   - `/back` 在微信会解绑绑定、在其它三个渠道不会（同一命令不同副作用）；
 *   - `/unlink`、`/back`、接续被拒三条路径对绑定各写各的；
 *   - 「接续不写绑定」这条约束只写在注释里，没有类型或测试保证。
 *
 * 本服务把决策收成一条链、四个渠道共用：
 *
 *   active = 路由表（可能借自别处）  >  /link 绑定  >  `{渠道}:{uid}` 默认会话
 *
 * 并且**只在一个地方**决定了「回到自己」（`resetToOwn`）：当前路由恰是 /link 绑定时释放它。
 * 没有绑定层的渠道（飞书/企微/QQ）传 `binding: undefined`，走的是同一段代码，语义自然一致。
 *
 * 分工边界：本服务只回答「去哪」；**归属**（这条会话从哪来）由 `channel-identity.ts` 回答；
 * 两者的差别正是 10 号计划 §2.1 的日志实证。
 */

import type { ChannelSessionStore, RouteSource } from './channel-session-store'

/** `/link` 绑定层的接口（由 `WeixinSessionBindingManager` 满足） */
export interface ChannelBindingPort {
  /** 未绑定时返回 null / undefined（两种写法都接受） */
  getBoundConversationId(channelUserId: string): string | null | undefined
  bind(channelUserId: string, conversationId: string): void
  unbind(channelUserId: string): void
}

export interface ChannelRouteDeps {
  channelType: string
  /** 进程单例的路由表（getChannelSessionStore） */
  store: ChannelSessionStore
  /** /link 绑定层；仅微信注入，其它渠道为 undefined（同一段代码，无需分支） */
  binding?: ChannelBindingPort
}

export class ChannelRouteService {
  constructor(private readonly deps: ChannelRouteDeps) {}

  /**
   * 当前生效会话键（热路径：每条入站消息都会问，只读内存）。
   *
   * 无路由记录时回落 `/link` 绑定，再回落渠道默认会话 `{渠道}:{uid}`——
   * 默认键的构造只此一处（此前散在四个 adapter 的 8 个地方）。
   */
  activeKey(channelUserId: string): string {
    return this.resolve(channelUserId).sessionKey
  }

  /**
   * 当前路由的来源。
   *
   * `'default'` = 没有路由记录（用的是 /link 绑定或渠道默认会话）；
   * 老记录（S3 之前落库、无 source 字段）无从判断，按 `'own'` 读。
   */
  activeSource(channelUserId: string): RouteSource | 'default' {
    return this.resolve(channelUserId).source
  }

  /**
   * 切换路由。调用方负责给出**来源**：
   * `/new` → own、`/resume` 与 Agent 的 session_resume → resume、
   * 跨渠道接续 → continuity、`/link` → link（走 `link()` 更省事）。
   *
   * @returns false = 目标会话已不存在，路由保持不变
   */
  setActive(channelUserId: string, sessionKey: string, source: RouteSource): boolean {
    return this.deps.store.setActive(this.deps.channelType, channelUserId, sessionKey, source)
  }

  /** `/link`：建持久绑定并把路由指过去 */
  link(channelUserId: string, conversationId: string): boolean {
    this.deps.binding?.bind(channelUserId, conversationId)
    return this.setActive(channelUserId, conversationId, 'link')
  }

  /** `/unlink`：显式断开绑定，再把路由交回自己 */
  unlink(channelUserId: string): string {
    this.deps.binding?.unbind(channelUserId)
    return this.resetToOwn(channelUserId)
  }

  /**
   * 回到本渠道自己的会话（`/back`、接续被拒、`/unlink` 收尾）。
   *
   * 统一语义：**当前路由恰是那条 /link 绑定时才释放绑定**——不误伤用户显式建立、
   * 但此刻没在用的绑定。没有绑定层的渠道走同一段代码（`binding` 为 undefined）。
   *
   * @returns 回落后的会话键
   */
  resetToOwn(channelUserId: string): string {
    const previous = this.activeKey(channelUserId)
    const bound = this.deps.binding?.getBoundConversationId(channelUserId)
    if (bound && bound === previous) {
      this.deps.binding?.unbind(channelUserId)
    }
    const own =
      this.deps.store.getOwn(this.deps.channelType, channelUserId) ??
      this.defaultKey(channelUserId)
    this.setActive(channelUserId, own, 'own')
    return own
  }

  /** 该渠道默认会话键：`{channelType}:{channelUserId}`（全仓唯一构造点） */
  defaultKey(channelUserId: string): string {
    return `${this.deps.channelType}:${channelUserId}`
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private resolve(channelUserId: string): { sessionKey: string; source: RouteSource | 'default' } {
    const stored = this.deps.store.getActive(this.deps.channelType, channelUserId)
    if (stored) {
      return {
        sessionKey: stored,
        source: this.deps.store.getSource(this.deps.channelType, channelUserId) ?? 'own',
      }
    }
    const bound = this.deps.binding?.getBoundConversationId(channelUserId)
    if (bound) return { sessionKey: bound, source: 'link' }
    return { sessionKey: this.defaultKey(channelUserId), source: 'default' }
  }
}
