/**
 * 转交提案存储（F2）单测：一次性消费 + 上限淘汰。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  __clearHandoffsForTest,
  consumeHandoff,
  findLatestHandoffFor,
  isChannelSession,
  isHandoffConfirmText,
  proposeHandoff,
} from './handoff-store'

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

  it('findLatestHandoffFor：按会话找最新提案；时间窗外/已消费/他会话均找不到', () => {
    const h1 = proposeHandoff({ originSessionKey: 'sk-a', task: 't1', summary: 's1', sessionMode: 'new' })
    const h2 = proposeHandoff({ originSessionKey: 'sk-a', task: 't2', summary: 's2', sessionMode: 'new' })
    const hb = proposeHandoff({ originSessionKey: 'sk-b', task: 't3', summary: 's3', sessionMode: 'new' })

    expect(findLatestHandoffFor('sk-a', 60000)?.id).toBe(h2.id)
    expect(findLatestHandoffFor('sk-b', 60000)?.id).toBe(hb.id)
    expect(findLatestHandoffFor('sk-none', 60000)).toBeUndefined()
    // 时间窗（withinMs 为负 → 全部过期）
    expect(findLatestHandoffFor('sk-a', -1)).toBeUndefined()
    // 最新一条被消费后回退到更早一条
    consumeHandoff(h2.id)
    expect(findLatestHandoffFor('sk-a', 60000)?.id).toBe(h1.id)
  })

  it('isHandoffConfirmText：仅保守确认词命中，避免误伤正常聊天', () => {
    for (const t of ['1', ' 1 ', '确认', 'OK', 'y', 'yes']) {
      expect(isHandoffConfirmText(t)).toBe(true)
    }
    for (const t of ['2', '好的', '是', '帮我改一下', '取消', '']) {
      expect(isHandoffConfirmText(t)).toBe(false)
    }
  })

  it('isChannelSession：渠道前缀命中，桌面 uuid/系统会话不命中', () => {
    for (const sk of ['qbot:2C77AAC2', 'feishu:ou_xxx', 'weixin:wxid_1', 'wecom:user-1']) {
      expect(isChannelSession(sk)).toBe(true)
    }
    for (const sk of ['9d1f28762c99c39eb6dbfe6ba22bc450', 'evolution:main', 'cron:seed-daily-report']) {
      expect(isChannelSession(sk)).toBe(false)
    }
  })
})
