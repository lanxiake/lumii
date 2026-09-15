/**
 * 跨渠道接续（§5.4 / 10-S4 方案 A）：候选判定 + 提示状态机（不扣消息、无定时器）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  CrossChannelContinuity,
  CONTINUITY_OFFER_TTL_MS,
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

describe('CrossChannelContinuity 提示状态机（10-S4 方案 A）', () => {
  const session: ChannelSession = {
    sessionKey: 'weixin:u1',
    channelType: 'weixin',
    channelUserId: 'u1',
    instanceId: null,
  }

  let sent: string[]
  let adapter: IChannelAdapter
  let setActive: ReturnType<typeof vi.fn>
  /** 可控时钟：状态机内部没有任何 timer，过期靠惰性判定 */
  let clock: number

  const recent: RecentConversation[] = [
    { id: 'conv-client', title: '重构登录模块', updatedAt: new Date().toISOString() },
  ]

  function make(recentList = recent): CrossChannelContinuity {
    return new CrossChannelContinuity({
      listRecent: () => recentList,
      // 归属落库值：本组用例不涉及「当前会话归属」的差异，统一返回 null（回退前缀）
      lookupOwnership: () => null,
      now: () => clock,
    })
  }

  beforeEach(() => {
    clock = Date.parse('2026-09-15T10:00:00.000Z')
    sent = []
    setActive = vi.fn()
    adapter = {
      channelType: 'weixin',
      sendTextReply: async (_s, text) => {
        sent.push(text)
      },
      notifyIncomingMessage: () => {},
      notifyNavigateToSession: () => {},
      getContextStrategy: () => ({ beforePrompt: async () => {}, afterPrompt: async () => {} }),
      // 路由写入后回读：默认读回被写入的目标（模拟写入成功）
      setActiveSessionKey: setActive,
      getActiveSessionKey: () => 'conv-client',
    }
  })

  // ── 提示 ────────────────────────────────────────────────────────────────────
  it('有候选时发出提示（消息不扣留：调用方照常处理本条）', () => {
    const c = make()
    expect(c.maybeNotice({ adapter, session })).toBe(true)
    expect(sent[0]).toContain('重构登录模块')
    expect(sent[0]).toContain('客户端')
    // 提示里如实说明两条路各会发生什么，且**不再要求回复裸数字**（10-S5 消歧）：
    // 渠道里另一套「回 1/2/3」是审批/提问选项，两套都问「1」时用户没法表达在答哪个
    expect(sent[0]).toContain('回复「接续」')
    expect(sent[0]).toContain('不接续')
    expect(sent[0]).not.toContain('回复 1')
    expect(sent[0]).not.toContain('默认接续')
  })

  it('同一路由只提示一次；用户换了会话（/new、/back）后可以再提示', () => {
    const c = make()
    expect(c.maybeNotice({ adapter, session })).toBe(true)
    expect(c.maybeNotice({ adapter, session })).toBe(false)
    expect(sent).toHaveLength(1)

    const afterNew: ChannelSession = { ...session, sessionKey: 'weixin:u1:169' }
    expect(c.maybeNotice({ adapter, session: afterNew })).toBe(true)
  })

  it('无候选时不提示，也记为看过（避免每条消息重查 DB）', () => {
    const c = make([])
    expect(c.maybeNotice({ adapter, session })).toBe(false)
    expect(sent).toHaveLength(0)
    expect(c.maybeNotice({ adapter, session })).toBe(false)
  })

  it('该会话正等审批/提问答复时不发提示（10-S5 消歧：两套「回复…」不抢同一条消息）', () => {
    const c = make()
    expect(c.maybeNotice({ adapter, session, hasPendingInteraction: true })).toBe(false)
    expect(sent).toHaveLength(0)
    // 也不记为「看过」：那套流程结束后仍应正常提示
    expect(c.maybeNotice({ adapter, session })).toBe(true)
  })

  it('候选查询抛错时跳过提示，不阻断消息', () => {
    const c = new CrossChannelContinuity({
      listRecent: () => {
        throw new Error('db closed')
      },
      lookupOwnership: () => null,
    })
    expect(c.maybeNotice({ adapter, session })).toBe(false)
  })

  // ── 答复 ────────────────────────────────────────────────────────────────────
  it('回复 1 → 后续消息路由到目标会话，并回执提示 /back', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    expect(c.tryConsumeReply(adapter, session, '1')).toBe(true)
    expect(setActive).toHaveBeenCalledWith('u1', 'conv-client', 'continuity')
    expect(sent.at(-1)).toContain('已接续')
    expect(sent.at(-1)).toContain('/back')
  })

  it('回复 1 但目标会话已不可用（写入被拒）→ 如实告知，不改路由', () => {
    const c = make()
    c.maybeNotice({ adapter, session })
    const stale = { ...adapter, getActiveSessionKey: () => 'weixin:u1' }

    expect(c.tryConsumeReply(stale, session, '1')).toBe(true)
    expect(sent.at(-1)).toContain('已不可用')
  })

  it('回复 0 → 什么都不变（方案 A 的默认就是保持现状）', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    expect(c.tryConsumeReply(adapter, session, '0')).toBe(true)
    expect(setActive).not.toHaveBeenCalled()
    expect(sent.at(-1)).toContain('留在当前会话')
  })

  it('答复无法识别 → 不消费，当普通消息放行', () => {
    const c = make()
    c.maybeNotice({ adapter, session })
    expect(c.tryConsumeReply(adapter, session, '帮我查下天气')).toBe(false)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('没有提示时不消费（不会顺手吃掉无关的「1」）', () => {
    const c = make()
    expect(c.tryConsumeReply(adapter, session, '1')).toBe(false)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('超过有效期后提示失效：回 1 不再切会话（旧版是「1 分钟不回就默认接续」）', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    clock += CONTINUITY_OFFER_TTL_MS + 1

    expect(c.tryConsumeReply(adapter, session, '1')).toBe(false)
    expect(setActive).not.toHaveBeenCalled()
  })

  it('有效期边界内仍可兑现', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    clock += CONTINUITY_OFFER_TTL_MS - 1

    expect(c.tryConsumeReply(adapter, session, '1')).toBe(true)
  })

  it('兑现一次即作废（不会连续切两次）', () => {
    const c = make()
    c.maybeNotice({ adapter, session })
    expect(c.tryConsumeReply(adapter, session, '1')).toBe(true)
    expect(c.tryConsumeReply(adapter, session, '1')).toBe(false)
  })

  it('clear 作废未兑现的提示（斜杠命令、/stop 时调用）', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    c.clear('weixin', 'u1')

    expect(c.tryConsumeReply(adapter, session, '1')).toBe(false)
    // 但「已提示过这条路由」的记录保留：用户发条命令不该又被问一遍
    expect(c.maybeNotice({ adapter, session })).toBe(false)
  })

  it('resetNotice 完全重新武装（/clear 语义：清空即重新开始）', () => {
    const c = make()
    c.maybeNotice({ adapter, session })

    c.resetNotice('weixin', 'u1')

    expect(c.tryConsumeReply(adapter, session, '1')).toBe(false)
    // 与 clear 不同：可以就同一条路由再提示一次
    expect(c.maybeNotice({ adapter, session })).toBe(true)
  })
})
