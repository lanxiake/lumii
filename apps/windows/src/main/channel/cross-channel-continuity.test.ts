/**
 * 跨渠道接续（§5.4）：候选判定 + 询问状态机 + 1 分钟超时。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CrossChannelContinuity,
  CONTINUITY_TIMEOUT_MS,
  channelOfSessionKey,
  parseContinuityReply,
  pickContinuityCandidate,
  type RecentConversation,
} from './cross-channel-continuity'
import type { ChannelSession, IChannelAdapter } from './types'

const NOW = Date.parse('2026-09-11T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

describe('channelOfSessionKey', () => {
  it('按前缀识别渠道会话', () => {
    expect(channelOfSessionKey('weixin:user-1')).toEqual({ channelType: 'weixin', label: '微信' })
    expect(channelOfSessionKey('qbot:user-1')).toEqual({ channelType: 'qbot', label: 'QQ' })
  })

  it('无已知前缀的裸 id 视为客户端会话', () => {
    expect(channelOfSessionKey('abc123def')).toEqual({ channelType: 'ipc', label: '客户端' })
  })

  it('定时任务等非用户会话不给标签（不作候选）', () => {
    expect(channelOfSessionKey('cron:daily-report').label).toBe('')
    expect(channelOfSessionKey('evolution:main').label).toBe('')
  })
})

describe('pickContinuityCandidate', () => {
  const base = { currentSessionKey: 'weixin:u1', currentChannelType: 'weixin', now: NOW }

  it('挑出其它渠道的近期会话', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-client', title: '重构登录模块', updatedAt: iso(2 * HOUR) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toMatchObject({
      conversationId: 'conv-client',
      channelLabel: '客户端',
    })
  })

  it('跳过同渠道会话（同渠道用 /resume 即可）', () => {
    const recent: RecentConversation[] = [
      { id: 'weixin:u1:169', title: '微信里的另一个会话', updatedAt: iso(HOUR) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toBeNull()
  })

  it('跳过当前会话自己', () => {
    const recent: RecentConversation[] = [
      { id: 'weixin:u1', title: '当前会话', updatedAt: iso(HOUR) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toBeNull()
  })

  it('跳过超出时间窗的旧会话', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-old', title: '上个月的对话', updatedAt: iso(30 * DAY) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toBeNull()
  })

  it('跳过定时任务会话', () => {
    const recent: RecentConversation[] = [
      { id: 'cron:daily', title: '每日汇报', updatedAt: iso(HOUR) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toBeNull()
  })

  it('时间戳损坏时跳过而不是崩', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-bad', title: '坏数据', updatedAt: 'not-a-date' },
    ]
    expect(pickContinuityCandidate({ ...base, recent })).toBeNull()
  })

  it('多个候选取最近的（列表已按时间降序）', () => {
    const recent: RecentConversation[] = [
      { id: 'feishu:u9', title: '飞书会话', updatedAt: iso(HOUR) },
      { id: 'conv-client', title: '客户端会话', updatedAt: iso(3 * HOUR) },
    ]
    expect(pickContinuityCandidate({ ...base, recent })?.conversationId).toBe('feishu:u9')
  })
})

describe('parseContinuityReply', () => {
  it('1 / 是 / y 表示接续', () => {
    for (const t of ['1', '是', 'y', 'yes', ' 接续 ']) {
      expect(parseContinuityReply(t)).toBe(true)
    }
  })

  it('0 / 否 / n 表示不接续', () => {
    for (const t of ['0', '否', 'n', 'no', '不接续']) {
      expect(parseContinuityReply(t)).toBe(false)
    }
  })

  it('其它文字无法识别', () => {
    expect(parseContinuityReply('帮我查下天气')).toBeNull()
  })
})

describe('CrossChannelContinuity 状态机', () => {
  const session: ChannelSession = {
    sessionKey: 'weixin:u1',
    channelType: 'weixin',
    channelUserId: 'u1',
    instanceId: null,
  }

  let sent: string[]
  let adapter: IChannelAdapter
  let setActive: ReturnType<typeof vi.fn>
  let bind: ReturnType<typeof vi.fn>
  let replay: ReturnType<typeof vi.fn>

  const recent: RecentConversation[] = [
    { id: 'conv-client', title: '重构登录模块', updatedAt: new Date().toISOString() },
  ]

  function make(recentList = recent): CrossChannelContinuity {
    return new CrossChannelContinuity({ listRecent: () => recentList })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    setActive = vi.fn()
    bind = vi.fn()
    replay = vi.fn()
    adapter = {
      channelType: 'weixin',
      sendTextReply: async (_s, text) => {
        sent.push(text)
      },
      notifyIncomingMessage: () => {},
      notifyNavigateToSession: () => {},
      getContextStrategy: () => ({ beforePrompt: async () => {}, afterPrompt: async () => {} }),
      setActiveSessionKey: setActive,
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('有候选时发出询问并扣住消息', () => {
    const c = make()
    expect(c.maybeAsk({ adapter, session, replay })).toBe(true)
    expect(c.hasPending('weixin:u1')).toBe(true)
    expect(sent[0]).toContain('重构登录模块')
    expect(sent[0]).toContain('客户端')
    // 扣住：还没投给 Agent
    expect(replay).not.toHaveBeenCalled()
  })

  it('回复 1 → 绑定目标会话并重放消息', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay, bind })
    expect(c.tryConsumeReply('weixin:u1', '1')).toBe(true)

    expect(bind).toHaveBeenCalledWith('u1', 'conv-client')
    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client')
    expect(replay).toHaveBeenCalledTimes(1)
    expect(c.hasPending('weixin:u1')).toBe(false)
  })

  it('回复 0 → 不绑定，仍重放消息到原会话', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay, bind })
    expect(c.tryConsumeReply('weixin:u1', '0')).toBe(true)

    expect(bind).not.toHaveBeenCalled()
    expect(setActive).not.toHaveBeenCalled()
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('1 分钟超时 → 默认接续，消息不丢', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay, bind })

    vi.advanceTimersByTime(CONTINUITY_TIMEOUT_MS)

    expect(bind).toHaveBeenCalledWith('u1', 'conv-client')
    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client')
    expect(replay).toHaveBeenCalledTimes(1)
    expect(c.hasPending('weixin:u1')).toBe(false)
  })

  it('答复无法识别 → 放行为普通消息，不吃掉它', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay })
    // 用户压根没理询问，直接换了话题
    expect(c.tryConsumeReply('weixin:u1', '帮我查下天气')).toBe(false)
    expect(c.hasPending('weixin:u1')).toBe(false)
  })

  it('同一会话只问一次', () => {
    const c = make()
    expect(c.maybeAsk({ adapter, session, replay })).toBe(true)
    c.tryConsumeReply('weixin:u1', '0')
    // 第二条消息不再询问
    expect(c.maybeAsk({ adapter, session, replay })).toBe(false)
  })

  it('无候选时不询问，且记为问过（避免每条消息重查）', () => {
    const c = make([])
    expect(c.maybeAsk({ adapter, session, replay })).toBe(false)
    expect(sent).toHaveLength(0)
    // 再次进来直接短路
    expect(c.maybeAsk({ adapter, session, replay })).toBe(false)
  })

  it('接续后目标会话不会被再问一次', () => {
    const c = make([
      { id: 'conv-client', title: '重构登录模块', updatedAt: new Date().toISOString() },
    ])
    c.maybeAsk({ adapter, session, replay })
    c.tryConsumeReply('weixin:u1', '1')

    // 重放后 adapter 会用新 sessionKey 再进一次
    const bound: ChannelSession = { ...session, sessionKey: 'conv-client' }
    expect(c.maybeAsk({ adapter, session: bound, replay })).toBe(false)
  })

  it('候选查询抛错时跳过询问，不阻断消息', () => {
    const c = new CrossChannelContinuity({
      listRecent: () => {
        throw new Error('db closed')
      },
    })
    expect(c.maybeAsk({ adapter, session, replay, bind })).toBe(false)
  })

  it('绑定失败时留在原会话，消息仍投出去', () => {
    bind.mockImplementation(() => {
      throw new Error('binding manager 不可用')
    })
    const c = make()
    c.maybeAsk({ adapter, session, replay, bind })
    c.tryConsumeReply('weixin:u1', '1')

    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('无 bind 的渠道（飞书/企微/QQ）靠 setActiveSessionKey 路由，不报错', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay })
    expect(c.tryConsumeReply('weixin:u1', '1')).toBe(true)

    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client')
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('clear 后可重新询问（/clear、/new 语义）', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay })
    c.clear('weixin:u1')
    expect(c.hasPending('weixin:u1')).toBe(false)
    expect(c.maybeAsk({ adapter, session, replay })).toBe(true)
  })
})
