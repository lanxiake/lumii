import { describe, expect, it } from 'vitest'
import { buildResumeEntries, formatResumeList } from './resume'

const at = (iso: string) => new Date(iso).toISOString()

function conv(id: string, title: string, iso: string) {
  return { id, title, updatedAt: at(iso) }
}

describe('buildResumeEntries', () => {
  it('按来源渠道分组，组内按时间倒序，排除定时任务/进化会话', () => {
    const entries = buildResumeEntries({
      recent: [
        conv('cron:daily', '定时任务', '2026-09-14T10:00:00Z'),
        conv('evolution:main', '自主进化', '2026-09-14T10:00:00Z'),
        conv('weixin:u1', '微信对话', '2026-09-14T09:00:00Z'),
        conv('conv-a', '客户端旧会话', '2026-09-13T09:00:00Z'),
        conv('conv-b', '客户端新会话', '2026-09-14T08:00:00Z'),
        conv('feishu:ou_x', '飞书对话', '2026-09-14T07:00:00Z'),
      ],
      currentSessionKey: 'weixin:u1',
      weixinBoundIds: new Set(),
    })

    expect(entries.map((e) => e.id)).toEqual([
      'conv-b', // 客户端组，新的在前
      'conv-a',
      'weixin:u1', // 微信
      'feishu:ou_x', // 飞书
    ])
    expect(entries.find((e) => e.id === 'weixin:u1')?.isCurrent).toBe(true)
    expect(entries.find((e) => e.id === 'conv-b')?.channelLabel).toBe('客户端')
  })

  it('微信 /link 绑定过的会话补标「微信」（光看 id 认不出来）', () => {
    const entries = buildResumeEntries({
      recent: [conv('conv-bound-uuid', '重构登录模块', '2026-09-14T09:00:00Z')],
      currentSessionKey: 'weixin:u1',
      weixinBoundIds: new Set(['conv-bound-uuid']),
    })

    expect(entries[0]?.channelLabel).toBe('微信')
  })

  it('同一会话只出现一次', () => {
    const entries = buildResumeEntries({
      recent: [conv('weixin:u1', 'A', '2026-09-14T09:00:00Z'), conv('weixin:u1', 'A', '2026-09-14T09:00:00Z')],
      currentSessionKey: 'weixin:u1',
      weixinBoundIds: new Set(),
    })
    expect(entries).toHaveLength(1)
  })
})

describe('formatResumeList', () => {
  it('序号跨分组连续，且与 selectable 一一对应', () => {
    const entries = buildResumeEntries({
      recent: [
        conv('conv-a', '客户端会话', '2026-09-14T09:00:00Z'),
        conv('weixin:u1', '微信会话', '2026-09-14T08:00:00Z'),
      ],
      currentSessionKey: 'weixin:u1',
      weixinBoundIds: new Set(),
    })
    const { text, selectable } = formatResumeList(entries)

    expect(selectable.map((e) => e.id)).toEqual(['conv-a', 'weixin:u1'])
    expect(text).toContain('1. ')
    expect(text).toContain('2. ')
    expect(text).toContain('← 当前')
    expect(text).toContain('【客户端】')
    expect(text).toContain('【微信】')
    expect(text).toContain('/resume <序号>')
  })

  it('每组截断到上限，并提示还有多少未列出', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      conv(`conv-${i}`, `会话 ${i}`, `2026-09-14T${String(20 - i).padStart(2, '0')}:00:00Z`),
    )
    const entries = buildResumeEntries({
      recent: many,
      currentSessionKey: 'weixin:u1',
      weixinBoundIds: new Set(),
    })
    const { text, selectable } = formatResumeList(entries)

    expect(entries).toHaveLength(13)
    expect(selectable).toHaveLength(10)
    expect(text).toContain('另有 3 个较旧的会话未列出')
  })
})
