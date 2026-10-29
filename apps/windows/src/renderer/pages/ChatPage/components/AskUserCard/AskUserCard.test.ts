/**
 * AskUserCard args 回退解析单测
 */

import { describe, expect, it } from 'vitest'
import { __askUserCardTest } from './AskUserCard'

const { parseAskArgs } = __askUserCardTest

describe('parseAskArgs', () => {
  it('解析合法 questions/context', () => {
    const parsed = parseAskArgs({
      context: '需要你选一个方案',
      questions: [
        {
          question: '用哪个库？',
          header: '库',
          options: [
            { label: 'dayjs', description: '轻量', recommended: true, recommendReason: '体积小' },
            { label: 'moment', description: '旧版' },
          ],
        },
      ],
    })
    expect(parsed?.context).toBe('需要你选一个方案')
    expect(parsed?.questions).toHaveLength(1)
    expect(parsed?.questions[0]?.options[0]).toMatchObject({
      label: 'dayjs',
      recommended: true,
      recommendReason: '体积小',
    })
  })

  it('非法或空 args 返回 null', () => {
    expect(parseAskArgs(null)).toBeNull()
    expect(parseAskArgs({})).toBeNull()
    expect(parseAskArgs({ questions: [{ question: 'x?', header: 'h', options: [] }] })).toBeNull()
  })
})
