/**
 * 跨渠道接续（§5.4）：候选判定 + 询问状态机 + 1 分钟超时。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CrossChannelContinuity,
  CONTINUITY_TIMEOUT_MS,
  parseContinuityReply,
  pickContinuityCandidate,
  type RecentConversation,
} from './cross-channel-continuity'
import type { ChannelSession, IChannelAdapter } from './types'

const NOW = Date.parse('2026-09-11T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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

  // ── 归属落库值（10-S2） ──────────────────────────────────────────────────
  it('当前会话归属读落库值：qbot 键被微信适配器服务时仍按 QQ 判定（不问）', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-client', title: '客户端里的会话', updatedAt: iso(HOUR) },
    ]
    // 真实场景（10 号计划 §2.1 日志实证）：用户在微信里说，但路由在 qbot: 会话上
    expect(
      pickContinuityCandidate({
        ...base,
        currentSessionKey: 'qbot:964A',
        currentSessionOwnership: 'qbot',
        currentChannelType: 'weixin',
        recent,
      }),
    ).toBeNull()
    // 同一会话若归属确为微信，则应正常询问
    expect(
      pickContinuityCandidate({
        ...base,
        currentSessionKey: 'qbot:964A',
        currentSessionOwnership: 'weixin',
        currentChannelType: 'weixin',
        recent,
      }),
    ).toMatchObject({ conversationId: 'conv-client' })
  })

  it('候选归属读落库值：系统会话（onboarding）即使无已知前缀也不作候选', () => {
    const recent: RecentConversation[] = [
      { id: 'guide-1', title: '新手导览', updatedAt: iso(HOUR), channelType: 'onboarding' },
      { id: 'conv-client', title: '客户端会话', updatedAt: iso(2 * HOUR) },
    ]
    // guide-1 被跳过（系统会话），落在下一条候选上
    expect(pickContinuityCandidate({ ...base, recent })).toMatchObject({
      conversationId: 'conv-client',
    })
  })

  it('候选归属落库值优先于前缀（脏前缀不再误判渠道）', () => {
    const recent: RecentConversation[] = [
      { id: 'weixin:u9', title: '实际是客户端的会话', updatedAt: iso(HOUR), channelType: 'ipc' },
    ]
    // 落库标为客户端 → 对微信用户而言是合法候选（与「同渠道跳过」相反）
    expect(pickContinuityCandidate({ ...base, recent })).toMatchObject({
      channelLabel: '客户端',
    })
  })

  // 守卫：当前会话已经不属于本渠道（/link 绑定、或上次接续的结果）时不能再问。
  // 否则回 0 会把用户从他明确选定的会话里踢出去。
  it('当前会话不属于本渠道时直接不问', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-client', title: '客户端里的另一个会话', updatedAt: iso(HOUR) },
    ]
    // 微信用户已 /link 到某个客户端会话
    expect(
      pickContinuityCandidate({ ...base, currentSessionKey: 'conv-bound', recent }),
    ).toBeNull()
    // 飞书用户上次接续进了微信会话
    expect(
      pickContinuityCandidate({
        ...base,
        currentSessionKey: 'weixin:u9',
        currentChannelType: 'feishu',
        recent,
      }),
    ).toBeNull()
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

  // 底层列表是「置顶优先」序：置顶的旧会话会排在真正最近的会话前面
  it('列表乱序（置顶优先）时仍取时间上最近的那个', () => {
    const recent: RecentConversation[] = [
      { id: 'conv-pinned-old', title: '两天前置顶的闲聊', updatedAt: iso(48 * HOUR) },
      { id: 'feishu:u9', title: '五分钟前的会话', updatedAt: iso(5 * MINUTE) },
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
    return new CrossChannelContinuity({
      listRecent: () => recentList,
      // 归属落库值：本组用例不涉及「当前会话归属」的差异，统一返回 null（回退前缀）
      lookupOwnership: () => null,
    })
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
    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client', 'continuity')
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

  it('回复 0 → 路由显式改回本渠道会话，且新 key 不再被追问', () => {
    const reset = vi.fn(() => 'weixin:u1:169')
    const c = make()
    c.maybeAsk({ adapter: { ...adapter, resetToChannelSession: reset }, session, replay })
    expect(c.tryConsumeReply('weixin:u1', '0')).toBe(true)

    expect(reset).toHaveBeenCalledWith('u1')
    expect(replay).toHaveBeenCalledTimes(1)
    // 重放后 buildSession 拿到的是 own（新 key），不标记就会被当作新会话再问一次
    const afterReset: ChannelSession = { ...session, sessionKey: 'weixin:u1:169' }
    expect(
      c.maybeAsk({ adapter: { ...adapter, resetToChannelSession: reset }, session: afterReset, replay }),
    ).toBe(false)
  })

  it('回到本渠道会话失败时不阻断重放', () => {
    const reset = vi.fn(() => {
      throw new Error('store 不可用')
    })
    const c = make()
    c.maybeAsk({ adapter: { ...adapter, resetToChannelSession: reset }, session, replay })
    expect(() => c.tryConsumeReply('weixin:u1', '0')).not.toThrow()

    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('1 分钟超时 → 默认接续，消息不丢', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay, bind })

    vi.advanceTimersByTime(CONTINUITY_TIMEOUT_MS)

    expect(bind).toHaveBeenCalledWith('u1', 'conv-client')
    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client', 'continuity')
    expect(replay).toHaveBeenCalledTimes(1)
    expect(c.hasPending('weixin:u1')).toBe(false)
  })

  it('答复无法识别 → 放行为普通消息，且被扣住的那条补投出去', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay })
    // 用户压根没理询问，直接换了话题
    expect(c.tryConsumeReply('weixin:u1', '帮我查下天气')).toBe(false)
    expect(c.hasPending('weixin:u1')).toBe(false)
    // 被扣的消息从没进过 Agent，必须补投，否则用户发了消息永远等不到回音
    expect(replay).toHaveBeenCalledTimes(1)
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
      lookupOwnership: () => null,
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

    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client', 'continuity')
    expect(replay).toHaveBeenCalledTimes(1)
  })

  it('clear 后可重新询问，且不补投被扣消息（/clear、/new 语义）', () => {
    const c = make()
    c.maybeAsk({ adapter, session, replay })
    c.clear('weixin:u1')
    expect(c.hasPending('weixin:u1')).toBe(false)
    // 用户已明确作废该会话，被扣的旧消息不投递
    expect(replay).not.toHaveBeenCalled()
    expect(c.maybeAsk({ adapter, session, replay })).toBe(true)
  })
})
