/**
 * 渠道提问/审批的文字回复解析
 *
 * 渠道用户只能发纯文本，解析错就会把答案喂错给 Agent，或让运行永久卡住。
 */

import { describe, it, expect } from 'vitest'
import {
  parsePermissionReply,
  parseAskReply,
  formatAskPrompt,
} from './channel-interaction-store'

describe('parsePermissionReply', () => {
  it('识别序号与中英文关键词', () => {
    expect(parsePermissionReply('1')).toBe('allow-once')
    expect(parsePermissionReply(' 2 ')).toBe('allow-always')
    expect(parsePermissionReply('3')).toBe('deny')
    expect(parsePermissionReply('同意')).toBe('allow-once')
    expect(parsePermissionReply('拒绝')).toBe('deny')
    expect(parsePermissionReply('YES')).toBe('allow-once')
  })

  it('无法识别时返回 null（由调用方提示重发，不能猜）', () => {
    expect(parsePermissionReply('嗯……你觉得呢')).toBeNull()
    expect(parsePermissionReply('')).toBeNull()
  })
})

const singleQuestion = [
  {
    question: '用哪个数据库？',
    header: 'db',
    multiSelect: false,
    options: [{ label: 'SQLite' }, { label: 'Postgres' }],
  },
]

describe('parseAskReply', () => {
  it('序号映射成选项 label', () => {
    expect(parseAskReply(singleQuestion, '2')).toEqual({ db: 'Postgres' })
  })

  it('非序号原文作答（模型能读懂自由文本）', () => {
    expect(parseAskReply(singleQuestion, '都行，你定')).toEqual({ db: '都行，你定' })
  })

  it('多选按逗号拆并拼接 label', () => {
    const multi = [{ ...singleQuestion[0]!, multiSelect: true }]
    expect(parseAskReply(multi, '1,2')).toEqual({ db: 'SQLite, Postgres' })
  })

  it('多问题按换行分别作答', () => {
    const qs = [
      singleQuestion[0]!,
      { question: '要写测试吗？', header: 'test', multiSelect: false, options: [{ label: '要' }, { label: '不要' }] },
    ]
    expect(parseAskReply(qs, '1\n2')).toEqual({ db: 'SQLite', test: '不要' })
  })

  it('越界序号不当选项，退回原文，避免静默选错', () => {
    expect(parseAskReply(singleQuestion, '9')).toEqual({ db: '9' })
  })
})

describe('formatAskPrompt', () => {
  it('列出带序号的选项供渠道用户回复', () => {
    const text = formatAskPrompt(singleQuestion)
    expect(text).toContain('用哪个数据库？')
    expect(text).toContain('1. SQLite')
    expect(text).toContain('2. Postgres')
  })
})
