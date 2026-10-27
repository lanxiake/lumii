/**
 * 回合→快照索引：坏行跳过、合并近似、无变更取前一快照、缺索引按时间近似。
 */
import { describe, expect, it } from 'vitest'
import { parseTurnIndex, resolveTurnOid } from './turn-index'

const TEXT = [
  '{"messageId":"m1","conversationId":"c1","runId":"r1","oid":"aaa","at":100,"coalesced":0}',
  '{"messageId":"m2","conversationId":"c1","oid":null,"at":200}',
  'garbage',
  '{"messageId":"m3","conversationId":"c2","oid":"bbb","at":300,"coalesced":2}',
].join('\n')

describe('turn-index', () => {
  it('解析时跳过坏行', () => {
    const entries = parseTurnIndex(TEXT)
    expect(entries.map((entry) => entry.messageId)).toEqual(['m1', 'm2', 'm3'])
    expect(entries[1]?.oid).toBeNull()
  })

  it('自己的非空 oid 优先；coalesced 标近似', () => {
    const entries = parseTurnIndex(TEXT)
    expect(resolveTurnOid(entries, 'm1')).toMatchObject({ oid: 'aaa', approximate: false })
    expect(resolveTurnOid(entries, 'm3')).toMatchObject({ oid: 'bbb', approximate: true })
  })

  it('该回合无变更时取之前最近的快照，并视为精确', () => {
    const entries = parseTurnIndex(TEXT)
    expect(resolveTurnOid(entries, 'm2')).toMatchObject({
      oid: 'aaa',
      approximate: false,
      entry: { messageId: 'm1' },
    })
  })

  it('索引里没有该消息时按 timestamp 取之前的快照并标近似', () => {
    const entries = parseTurnIndex(TEXT)
    expect(resolveTurnOid(entries, 'missing', 250)).toMatchObject({
      oid: 'aaa',
      approximate: true,
    })
    expect(resolveTurnOid(entries, 'missing')).toBeNull()
  })
})
