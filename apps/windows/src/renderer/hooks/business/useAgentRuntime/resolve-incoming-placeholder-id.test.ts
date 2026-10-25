import { describe, expect, it } from 'vitest'
import { resolveIncomingPlaceholderId } from './resolve-incoming-placeholder-id'

describe('resolveIncomingPlaceholderId', () => {
  const db = [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '早' }] },
    { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '早啊' }] },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: '帮我看看' }] },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '好的' }] },
  ]

  it('非占位 id 原样返回', () => {
    expect(resolveIncomingPlaceholderId('u2', '帮我看看', db)).toBe('u2')
  })

  it('incoming-* 按正文对齐到库里最近一条同文案用户消息', () => {
    expect(resolveIncomingPlaceholderId('incoming-1-abc', '帮我看看', db)).toBe('u2')
  })

  it('同文案多条时取最近一条', () => {
    const withDup = [
      ...db,
      { id: 'u3', role: 'user', content: [{ type: 'text', text: '帮我看看' }] },
    ]
    expect(resolveIncomingPlaceholderId('incoming-2-xyz', '帮我看看', withDup)).toBe('u3')
  })

  it('占位且库里无同文案 → null（调用方应拒绝重发）', () => {
    expect(resolveIncomingPlaceholderId('incoming-3-nope', '不存在的话', db)).toBeNull()
  })
})
