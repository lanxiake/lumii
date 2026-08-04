/**
 * WeixinSessionBindingManager — 微信会话绑定管理器
 *
 * 允许微信用户通过 /link 命令将自己的消息路由到指定的 Windows 会话（conversationId），
 * 实现跨通道上下文共享。绑定关系持久化到 RuntimeStateRepo，重启后不丢失。
 *
 * key 格式：weixin:binding:{channelUserId}
 */

import type { RuntimeStateRepo } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[WeixinSessionBindingManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[WeixinSessionBindingManager]', ...args),
  error: (...args: unknown[]) => console.error('[WeixinSessionBindingManager]', ...args),
}

const KEY_PREFIX = 'weixin:binding:'

export interface WeixinSessionBinding {
  channelUserId: string
  conversationId: string
  boundAt: string
}

export class WeixinSessionBindingManager {
  /** 内存缓存：channelUserId → binding */
  private readonly cache = new Map<string, WeixinSessionBinding>()

  constructor(private readonly runtimeStateRepo: RuntimeStateRepo) {}

  /**
   * 从 RuntimeStateRepo 加载所有已有绑定到内存缓存。
   * 在 WeixinChannelAdapter 构造后调用一次。
   */
  initialize(): void {
    const rows = this.runtimeStateRepo.listByPrefix(KEY_PREFIX)
    for (const { value } of rows) {
      try {
        const binding = JSON.parse(value) as WeixinSessionBinding
        if (binding.channelUserId && binding.conversationId) {
          this.cache.set(binding.channelUserId, binding)
        }
      } catch {
        // 忽略损坏的记录
      }
    }
    log.info(`[initialize] 加载了 ${this.cache.size} 条绑定关系`)
  }

  /**
   * 绑定微信用户到指定会话。
   */
  bind(channelUserId: string, conversationId: string): void {
    const binding: WeixinSessionBinding = {
      channelUserId,
      conversationId,
      boundAt: new Date().toISOString(),
    }
    this.runtimeStateRepo.setJson(`${KEY_PREFIX}${channelUserId}`, binding)
    this.cache.set(channelUserId, binding)
    log.info(`[bind] ${channelUserId} → ${conversationId}`)
  }

  /**
   * 解除绑定。
   */
  unbind(channelUserId: string): void {
    this.runtimeStateRepo.delete(`${KEY_PREFIX}${channelUserId}`)
    this.cache.delete(channelUserId)
    log.info(`[unbind] ${channelUserId} 已解绑`)
  }

  /**
   * 获取绑定的会话 ID（未绑定返回 null）。同步，直接读缓存。
   */
  getBoundConversationId(channelUserId: string): string | null {
    return this.cache.get(channelUserId)?.conversationId ?? null
  }

  /**
   * 列出所有绑定关系。
   */
  listBindings(): WeixinSessionBinding[] {
    return [...this.cache.values()]
  }
}
