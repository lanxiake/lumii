/**
 * 对话内搜索的纯逻辑（Ctrl+F）。
 *
 * 与侧栏搜索分工：侧栏搜所有会话（要查库）；这里只搜当前会话的消息列表，
 * 逐字响应。所以这里的判据是「命中哪个、跳几格」，不是「查得多快」。
 */
import { describe, expect, it } from 'vitest'
import { findChatSearchHits, stepHitIndex } from './chat-search'

const messages = [
  { id: 'm1', text: '帮我看看宠物精灵图的抠底算法' },
  { id: 'm2', text: '今天的天气不错' },
  { id: 'm3', text: '精灵图还是有问题，精灵图旁边也有' },
]

describe('findChatSearchHits', () => {
  it('按会话顺序返回命中的消息，同一条消息记多次命中', () => {
    const hits = findChatSearchHits(messages, '精灵图')
    expect(hits.map((h) => h.messageId)).toEqual(['m1', 'm3'])
    expect(hits[1]!.count).toBe(2)
  })

  it('大小写不敏感（与侧栏 SQL LIKE 一致）', () => {
    expect(findChatSearchHits([{ id: 'a', text: 'LiteShell 的 asar' }], 'liteshell')).toEqual([
      { messageId: 'a', count: 1 },
    ])
  })

  it('空关键词返回空集，不当成「匹配一切」', () => {
    expect(findChatSearchHits(messages, '   ')).toEqual([])
    expect(findChatSearchHits(messages, '')).toEqual([])
  })

  it('不存在的词返回空集', () => {
    expect(findChatSearchHits(messages, 'xzqw')).toEqual([])
  })

  it('中文单字也能搜（FTS5 trigram 做不到，这是选内存检索的原因之一）', () => {
    expect(findChatSearchHits(messages, '图').map((h) => h.messageId)).toEqual(['m1', 'm3'])
  })
})

describe('stepHitIndex', () => {
  it('前进/后退循环', () => {
    expect(stepHitIndex(0, 3, 1)).toBe(1)
    expect(stepHitIndex(2, 3, 1)).toBe(0)
    expect(stepHitIndex(0, 3, -1)).toBe(2)
  })

  it('从 -1（还没开始）也能走到第一条/最后一条', () => {
    expect(stepHitIndex(-1, 3, 1)).toBe(0)
    expect(stepHitIndex(-1, 3, -1)).toBe(2)
  })

  it('没有命中时返回 -1，不产生越界下标', () => {
    expect(stepHitIndex(0, 0, 1)).toBe(-1)
  })
})
