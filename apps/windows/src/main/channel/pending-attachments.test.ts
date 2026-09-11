/**
 * pendingAttachments 单测：挂起 / 取出 / 首批判定。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { pendingAttachments, makePendingKey, type PendingAttachment } from './pending-attachments'

describe('pendingAttachments', () => {
  beforeEach(() => {
    // 每个测试前清空全局 store
    const key1 = makePendingKey('qbot', 'user-a')
    const key2 = makePendingKey('feishu', 'user-b')
    const key3 = makePendingKey('wecom', 'user-c')
    pendingAttachments.clear(key1)
    pendingAttachments.clear(key2)
    pendingAttachments.clear(key3)
  })

  it('add 第一批返回 true，后续返回 false', () => {
    const key = makePendingKey('qbot', 'user-a')
    const first = pendingAttachments.add(key, [{ mediaPath: 'a.png', at: Date.now() }])
    expect(first).toBe(true)
    const second = pendingAttachments.add(key, [{ mediaPath: 'b.jpg', at: Date.now() }])
    expect(second).toBe(false)
  })

  it('drain 取出全部并清空', () => {
    const key = makePendingKey('feishu', 'user-b')
    pendingAttachments.add(key, [
      { mediaPath: '1.png', at: 1000 },
      { mediaPath: '2.jpg', at: 2000 },
    ])
    pendingAttachments.add(key, [{ mediaPath: '3.pdf', fileName: 'doc.pdf', at: 3000 }])
    const drained = pendingAttachments.drain(key)
    expect(drained).toHaveLength(3)
    expect(drained[0].mediaPath).toBe('1.png')
    expect(drained[2].fileName).toBe('doc.pdf')
    expect(pendingAttachments.count(key)).toBe(0)
    expect(pendingAttachments.drain(key)).toEqual([])
  })

  it('不同 key 互不干扰', () => {
    const k1 = makePendingKey('wechat', 'alice')
    const k2 = makePendingKey('wecom', 'alice')
    pendingAttachments.add(k1, [{ mediaPath: 'wx-a.png', at: Date.now() }])
    pendingAttachments.add(k2, [{ mediaPath: 'wecom-b.jpg', at: Date.now() }])
    expect(pendingAttachments.count(k1)).toBe(1)
    expect(pendingAttachments.count(k2)).toBe(1)
    const d1 = pendingAttachments.drain(k1)
    expect(d1[0].mediaPath).toBe('wx-a.png')
    expect(pendingAttachments.count(k2)).toBe(1)
  })

  it('add 空数组不改变计数但仍标记为已有批次', () => {
    const key = makePendingKey('qbot', 'user-c')
    const result = pendingAttachments.add(key, [])
    expect(result).toBe(true) // 首批，即使为空
    expect(pendingAttachments.count(key)).toBe(0)
    const second = pendingAttachments.add(key, [{ mediaPath: 'a.png', at: Date.now() }])
    expect(second).toBe(false) // 已有批次
  })

  it('drain 后再 add 视为新一批，返回 true', () => {
    const key = makePendingKey('feishu', 'user-d')
    pendingAttachments.add(key, [{ mediaPath: 'first.png', at: 1 }])
    pendingAttachments.drain(key)
    const again = pendingAttachments.add(key, [{ mediaPath: 'second.jpg', at: 2 }])
    expect(again).toBe(true)
  })

  it('clear 清空该 key', () => {
    const key = makePendingKey('wecom', 'user-e')
    pendingAttachments.add(key, [{ mediaPath: 'a.png', at: Date.now() }])
    expect(pendingAttachments.count(key)).toBe(1)
    pendingAttachments.clear(key)
    expect(pendingAttachments.count(key)).toBe(0)
  })

  it('makePendingKey 避免同 id 跨渠道撞车', () => {
    const k1 = makePendingKey('wechat', '123')
    const k2 = makePendingKey('qbot', '123')
    expect(k1).not.toBe(k2)
    expect(k1).toBe('wechat:123')
    expect(k2).toBe('qbot:123')
  })
})
