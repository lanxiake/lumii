/**
 * 附件挂起缓存：四渠道统一的纯附件消息挂起机制。
 * 用户连发多个文件后再发指令，所有文件一次性合并到 Agent prompt。
 */

export interface PendingAttachment {
  mediaPath: string
  fileName?: string
  at: number
}

export const ATTACHMENT_HELD_HINT = '📎 已收到附件，请发送文字说明你想如何处理。'

/** pendingKey → 附件列表（按到达时间排序） */
const store = new Map<string, PendingAttachment[]>()

export const pendingAttachments = {
  /**
   * 新增一批附件到挂起队列。
   * @returns true=这是该用户的第一批（需提醒），false=已有挂起（静默累加）
   */
  add(key: string, attachments: PendingAttachment[]): boolean {
    const existing = store.get(key)
    if (existing) {
      existing.push(...attachments)
      return false
    }
    store.set(key, [...attachments])
    return true
  },

  /** 取出并清空挂起的附件 */
  drain(key: string): PendingAttachment[] {
    const items = store.get(key) ?? []
    store.delete(key)
    return items
  },

  /** 清空某用户的挂起附件（切换会话时用） */
  clear(key: string): void {
    store.delete(key)
  },

  /** 当前挂起数量 */
  count(key: string): number {
    return store.get(key)?.length ?? 0
  },
}

export function makePendingKey(channelType: string, channelUserId: string): string {
  return `${channelType}:${channelUserId}`
}
