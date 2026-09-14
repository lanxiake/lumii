import { describe, expect, it } from 'vitest'
import {
  buildSessionListRows,
  DEFAULT_SESSION_LIST_LIMIT,
  MAX_SESSION_LIST_LIMIT,
} from './session-list-rows'

const at = (iso: string) => new Date(iso).toISOString()

function row(id: string, title: string | null, iso: string | null) {
  return { id, title, last_msg_at: iso, created_at: at('2026-09-01T00:00:00Z') }
}

describe('buildSessionListRows', () => {
  it('按时间倒序，不受底层「置顶优先」顺序影响', () => {
    const rows = [
      row('conv-pinned-old', '两天前置顶的会话', at('2026-09-12T00:00:00Z')),
      row('conv-recent', '五分钟前的会话', at('2026-09-14T09:55:00Z')),
      row('conv-mid', '昨天', at('2026-09-13T00:00:00Z')),
    ]
    expect(buildSessionListRows(rows).map((s) => s.id)).toEqual([
      'conv-recent',
      'conv-mid',
      'conv-pinned-old',
    ])
  })

  it('标注来源渠道，无前缀的算客户端，定时任务算系统', () => {
    const rows = [
      row('weixin:u1', '微信对话', at('2026-09-14T09:00:00Z')),
      row('feishu:ou_x', '飞书对话', at('2026-09-14T08:00:00Z')),
      row('qbot:u9', 'QQ 对话', at('2026-09-14T07:00:00Z')),
      row('conv-uuid', '客户端会话', at('2026-09-14T06:00:00Z')),
      row('cron:daily', '定时任务', at('2026-09-14T05:00:00Z')),
    ]
    expect(buildSessionListRows(rows).map((s) => [s.id, s.channel])).toEqual([
      ['weixin:u1', '微信'],
      ['feishu:ou_x', '飞书'],
      ['qbot:u9', 'QQ'],
      ['conv-uuid', '客户端'],
      ['cron:daily', '系统'],
    ])
  })

  it('标出当前会话', () => {
    const rows = [
      row('conv-a', 'A', at('2026-09-14T09:00:00Z')),
      row('conv-b', 'B', at('2026-09-14T08:00:00Z')),
    ]
    const out = buildSessionListRows(rows, { currentSessionKey: 'conv-b' })
    expect(out.find((s) => s.id === 'conv-a')?.isCurrent).toBe(false)
    expect(out.find((s) => s.id === 'conv-b')?.isCurrent).toBe(true)
  })

  it('关键词按标题过滤，大小写不敏感', () => {
    const rows = [
      row('conv-a', '二十四史学习规划', at('2026-09-14T09:00:00Z')),
      row('conv-b', 'Lumii 重构', at('2026-09-14T08:00:00Z')),
    ]
    expect(buildSessionListRows(rows, { keyword: '二十四史' }).map((s) => s.id)).toEqual(['conv-a'])
    expect(buildSessionListRows(rows, { keyword: 'lumii' }).map((s) => s.id)).toEqual(['conv-b'])
    expect(buildSessionListRows(rows, { keyword: '  ' })).toHaveLength(2)
  })

  it('默认返回 DEFAULT 条，显式 limit 被夹到 [1, MAX]', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`conv-${i}`, `会话 ${i}`, at('2026-09-14T09:00:00Z')),
    )
    expect(buildSessionListRows(rows)).toHaveLength(DEFAULT_SESSION_LIST_LIMIT)
    expect(buildSessionListRows(rows, { limit: 5 })).toHaveLength(5)
    expect(buildSessionListRows(rows, { limit: 999 })).toHaveLength(MAX_SESSION_LIST_LIMIT)
    expect(buildSessionListRows(rows, { limit: 0 })).toHaveLength(1)
  })

  it('标题为空时回落「新对话」，坏时间戳的行直接丢掉', () => {
    const rows = [
      row('conv-a', null, at('2026-09-14T09:00:00Z')),
      { id: 'conv-bad', title: '坏数据', last_msg_at: 'not-a-date', created_at: 'also-bad' },
    ]
    const out = buildSessionListRows(rows)
    expect(out).toHaveLength(1)
    expect(out[0]?.title).toBe('新对话')
  })

  it('last_msg_at 为空时用 created_at 排序', () => {
    const rows = [
      { id: 'conv-new', title: '新建未聊', last_msg_at: null, created_at: at('2026-09-14T09:00:00Z') },
      { id: 'conv-old', title: '聊过', last_msg_at: at('2026-09-13T00:00:00Z'), created_at: at('2026-09-01T00:00:00Z') },
    ]
    expect(buildSessionListRows(rows).map((s) => s.id)).toEqual(['conv-new', 'conv-old'])
  })
})
