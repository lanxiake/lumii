/**
 * session-activity：多会话运行态的折叠规则
 *
 * 锁三件事：
 *   1. 只有"开场/等待/出错"才进表，心跳只刷新时间戳（不凭空造条目）
 *   2. `turn:end` / `agent:idle` 把条目**摘掉**，而不是留成 idle
 *   3. 主体自己被排除在"别人"之外——这条错了，控制坞会一直说"另有 1 个会话在跑"，
 *      而那个"别人"就是它自己
 */
import { describe, it, expect } from 'vitest'
import {
  EMPTY_SESSION_ACTIVITY,
  foreignAttention,
  normalizeSessionKey,
  otherSessions,
  reduceSessionActivity,
  shortSessionLabel,
  STALE_AFTER_MS,
  sweepStale,
  type SessionActivityState,
} from './session-activity'

const fold = (
  events: { type: string; sessionKey?: string; rootSessionKey?: string }[],
  start = 1000,
): SessionActivityState =>
  events.reduce((s, e, i) => reduceSessionActivity(s, e, start + i), EMPTY_SESSION_ACTIVITY)

describe('reduceSessionActivity', () => {
  it('turn:start 进场，turn:end 摘掉（不是留成 idle）', () => {
    const running = fold([{ type: 'agent:turn:start', sessionKey: 'chat:a' }])
    expect(Object.keys(running.runs)).toEqual(['chat:a'])
    const done = reduceSessionActivity(running, { type: 'agent:turn:end', sessionKey: 'chat:a' }, 2000)
    expect(done.runs).toEqual({})
  })

  it('agent:idle 与 turn:end 同义', () => {
    const done = fold([
      { type: 'agent:turn:start', sessionKey: 'chat:a' },
      { type: 'agent:idle', sessionKey: 'chat:a' },
    ])
    expect(done.runs).toEqual({})
  })

  it('等确认 → waiting；确认完回到 running（会话还在跑）', () => {
    const waiting = fold([
      { type: 'agent:turn:start', sessionKey: 'chat:a' },
      { type: 'agent:permission:request', sessionKey: 'chat:a' },
    ])
    expect(waiting.runs['chat:a']!.state).toBe('waiting')
    const resumed = reduceSessionActivity(
      waiting,
      { type: 'agent:permission:granted', sessionKey: 'chat:a' },
      2000,
    )
    expect(resumed.runs['chat:a']!.state).toBe('running')
  })

  it('出错进表，且是 error 态', () => {
    const s = fold([
      { type: 'agent:turn:start', sessionKey: 'chat:a' },
      { type: 'agent:error', sessionKey: 'chat:a' },
    ])
    expect(s.runs['chat:a']!.state).toBe('error')
  })

  it('心跳只刷新时间戳，状态不变', () => {
    const s = fold([
      { type: 'agent:turn:start', sessionKey: 'chat:a' },
      { type: 'agent:tool:start', sessionKey: 'chat:a' },
    ])
    expect(s.runs['chat:a']!.state).toBe('running')
    expect(s.runs['chat:a']!.updatedAt).toBe(1001)
  })

  it('没开过场的心跳不凭空造条目（重载后收到半截事件流也不会冒出幽灵会话）', () => {
    const s = fold([{ type: 'agent:tool:start', sessionKey: 'chat:x' }])
    expect(s.runs).toEqual({})
  })

  it('不认识的事件与缺 key 的事件都原样返回（引用不变）', () => {
    const s = fold([{ type: 'agent:turn:start', sessionKey: 'chat:a' }])
    expect(reduceSessionActivity(s, { type: 'agent:message:delta', sessionKey: 'chat:a' }, 9)).toBe(s)
    expect(reduceSessionActivity(s, { type: 'agent:turn:start' }, 9)).toBe(s)
  })

  it('子 Agent 归并到 root，不拆成"好几个会话"', () => {
    const s = fold([
      { type: 'agent:turn:start', sessionKey: 'sub-1', rootSessionKey: 'chat:a' },
      { type: 'agent:turn:start', sessionKey: 'sub-2', rootSessionKey: 'chat:a' },
    ])
    expect(Object.keys(s.runs)).toEqual(['chat:a'])
  })
})

describe('otherSessions / foreignAttention', () => {
  const two = fold([
    { type: 'agent:turn:start', sessionKey: 'chat:mine' },
    { type: 'agent:turn:start', sessionKey: 'cron:agent-self:1790026929462-owrcvos' },
  ])

  it('主体自己被排除在"别人"之外', () => {
    expect(otherSessions(two, 'chat:mine').map((r) => r.sessionKey)).toEqual([
      'cron:agent-self:1790026929462-owrcvos',
    ])
  })

  it('只有 waiting/error 才算"要你出手"，在跑的普通会话不算', () => {
    expect(foreignAttention(two, 'chat:mine')).toEqual([])
    const waiting = reduceSessionActivity(
      two,
      { type: 'agent:permission:request', sessionKey: 'cron:agent-self:1790026929462-owrcvos' },
      3000,
    )
    expect(foreignAttention(waiting, 'chat:mine').map((r) => r.state)).toEqual(['waiting'])
  })

  it('主体自己在等确认时，不把自己算成"别人在等"（否则头顶会说错人）', () => {
    const mineWaiting = reduceSessionActivity(
      two,
      { type: 'agent:permission:request', sessionKey: 'chat:mine' },
      3000,
    )
    expect(foreignAttention(mineWaiting, 'chat:mine')).toEqual([])
  })
})

describe('维护与展示', () => {
  it('超过阈值没心跳的条目被清掉（turn:end 丢了也不会永远挂着）', () => {
    const s = fold([{ type: 'agent:turn:start', sessionKey: 'chat:a' }], 0)
    // 阈值内留着、超了才清——先确认它不会把"还在跑"的会话误删
    expect(Object.keys(sweepStale(s, STALE_AFTER_MS - 1000).runs)).toEqual(['chat:a'])
    expect(sweepStale(s, STALE_AFTER_MS + 1).runs).toEqual({})
  })

  it('短的会话键原样保留', () => {
    expect(normalizeSessionKey({ sessionKey: 'local:desktop' })).toBe('local:desktop')
    expect(normalizeSessionKey({})).toBeNull()
  })

  it('短名把 id 段丢掉，只留有语义的部分', () => {
    expect(shortSessionLabel('cron:agent-self:1790026929462-owrcvos')).toBe('cron:agent-self')
    expect(shortSessionLabel('local:desktop')).toBe('local:desktop')
    expect(shortSessionLabel('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6')
  })
})
