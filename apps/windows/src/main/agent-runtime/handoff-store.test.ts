/**
 * 转交提案存储（F2）单测：一次性消费 + 上限淘汰。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { __clearHandoffsForTest, consumeHandoff, proposeHandoff } from './handoff-store'

describe('handoff-store（F2 转交提案）', () => {
  beforeEach(() => __clearHandoffsForTest())

  it('提案可被消费一次（确认动作一次性）', () => {
    const h = proposeHandoff({
      originSessionKey: 'sk-1',
      task: '把订单页分页修一下',
      summary: '订单页分页修复',
      sessionMode: 'recent',
    })
    expect(h.id).toBeTruthy()

    const got = consumeHandoff(h.id)
    expect(got?.task).toBe('把订单页分页修一下')
    expect(got?.sessionMode).toBe('recent')
    expect(got?.originSessionKey).toBe('sk-1')

    expect(consumeHandoff(h.id)).toBeUndefined()
  })

  it('提案携带 projectName（执行时写入开发会话的 dev-context）', () => {
    const h = proposeHandoff({
      originSessionKey: 'sk-p',
      task: '根据项目代码评审这份方案',
      summary: '评审新手指引方案',
      sessionMode: 'new',
      projectName: 'lumii',
    })
    expect(consumeHandoff(h.id)?.projectName).toBe('lumii')
  })

  it('未指定项目时 projectName 为 undefined（回落到活动项目 / Agent 绑定）', () => {
    const h = proposeHandoff({
      originSessionKey: 'sk-n',
      task: 't',
      summary: 's',
      sessionMode: 'new',
    })
    expect(consumeHandoff(h.id)?.projectName).toBeUndefined()
  })

  it('超过上限（50）淘汰最旧提案', () => {
    const ids: string[] = []
    for (let i = 0; i < 51; i++) {
      ids.push(
        proposeHandoff({
          originSessionKey: 'sk',
          task: `task-${i}`,
          summary: `summary-${i}`,
          sessionMode: 'new',
        }).id,
      )
    }
    expect(consumeHandoff(ids[0]!)).toBeUndefined()
    expect(consumeHandoff(ids[50]!)).toBeDefined()
  })
})
