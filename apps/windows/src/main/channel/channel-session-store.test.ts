import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStateRepo } from '@mtbot/agent-runtime'
import { ChannelSessionStore, isOwnChannelSessionKey } from './channel-session-store'

/** 最小 RuntimeStateRepo 替身：只实现 store 用到的方法 */
function makeRepo(rows: Record<string, string> = {}) {
  const data = new Map(Object.entries(rows))
  return {
    data,
    repo: {
      setJson: (key: string, value: unknown) => {
        data.set(key, JSON.stringify(value))
      },
      delete: (key: string) => data.delete(key),
      listByPrefix: (prefix: string) =>
        [...data.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
    } as unknown as RuntimeStateRepo,
  }
}

const WEIXIN = 'weixin'
const UID = 'o9cq801'

describe('isOwnChannelSessionKey', () => {
  it('认渠道默认会话与 /new 建的时间戳会话', () => {
    expect(isOwnChannelSessionKey(WEIXIN, UID, `weixin:${UID}`)).toBe(true)
    expect(isOwnChannelSessionKey(WEIXIN, UID, `weixin:${UID}:1726000000000`)).toBe(true)
  })

  it('不把别的渠道、别的用户、以及前缀相近的用户认成自己', () => {
    expect(isOwnChannelSessionKey(WEIXIN, UID, 'feishu:o9cq801')).toBe(false)
    expect(isOwnChannelSessionKey(WEIXIN, UID, 'weixin:other-user')).toBe(false)
    // 前缀串号：uid 是另一个 uid 的前缀
    expect(isOwnChannelSessionKey(WEIXIN, 'u1', 'weixin:u1x:1726000000000')).toBe(false)
    expect(isOwnChannelSessionKey(WEIXIN, UID, 'conv-client-uuid')).toBe(false)
  })
})

describe('ChannelSessionStore', () => {
  it('记录 active；本渠道会话同时更新 own', () => {
    const { repo, data } = makeRepo()
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })

    store.setActive(UID, `weixin:${UID}:1726000000000`)

    expect(store.getActive(UID)).toBe(`weixin:${UID}:1726000000000`)
    expect(store.getOwn(UID)).toBe(`weixin:${UID}:1726000000000`)
    // 写穿透：落库
    expect(data.has(`channel:active:weixin:${UID}`)).toBe(true)
  })

  it('跨渠道接续不污染 own —— 回到本渠道时仍能找回自己的会话', () => {
    const { repo } = makeRepo()
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })

    store.setActive(UID, `weixin:${UID}`) // 本渠道的会话
    store.setActive(UID, 'conv-client-a') // 接续到客户端会话
    expect(store.getActive(UID)).toBe('conv-client-a')
    expect(store.getOwn(UID)).toBe(`weixin:${UID}`)
  })

  it('重启后从库中恢复（构造时载入）', () => {
    const { repo } = makeRepo({
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-client-a',
        own: `weixin:${UID}`,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })

    expect(store.getActive(UID)).toBe('conv-client-a')
    expect(store.getOwn(UID)).toBe(`weixin:${UID}`)
  })

  it('只载入本渠道的记录（不串到其它渠道）', () => {
    const { repo } = makeRepo({
      'channel:active:feishu:ou_x': JSON.stringify({
        channelType: 'feishu',
        channelUserId: 'ou_x',
        active: 'feishu:ou_x',
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })
    expect(store.getActive('ou_x')).toBeNull()
  })

  it('own 缺失时兜底扫最近会话，并按时间取最近（不受置顶顺序影响）', () => {
    const { repo } = makeRepo()
    const old = new Date('2026-09-01T00:00:00Z').toISOString()
    const recent = new Date('2026-09-14T00:00:00Z').toISOString()
    const listRecent = vi.fn(() => [
      { id: 'pinned-old-conv', updatedAt: old }, // 底层按置顶优先返回，排在前面但不是最近的
      { id: `weixin:${UID}`, updatedAt: old },
      { id: `weixin:${UID}:1726000000000`, updatedAt: recent },
      { id: 'feishu:other', updatedAt: recent },
    ])
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN, listRecent })

    expect(store.getOwn(UID)).toBe(`weixin:${UID}:1726000000000`)
  })

  it('兜底查无结果也记忆化，不每条消息重扫', () => {
    const { repo } = makeRepo()
    const listRecent = vi.fn(() => [{ id: 'conv-other', updatedAt: new Date().toISOString() }])
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN, listRecent })

    expect(store.getOwn(UID)).toBeNull()
    expect(store.getOwn(UID)).toBeNull()
    expect(listRecent).toHaveBeenCalledTimes(1)
  })

  it('clear 后路由与 own 一并交回（/unlink 语义）', () => {
    const { repo, data } = makeRepo()
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })
    store.setActive(UID, 'conv-client-a')

    store.clear(UID)

    expect(store.getActive(UID)).toBeNull()
    expect(store.getOwn(UID)).toBeNull()
    expect(data.has(`channel:active:weixin:${UID}`)).toBe(false)
  })

  it('DB 抛错时降级为纯内存，不影响消息路由', () => {
    const repo = {
      setJson: () => {
        throw new Error('db locked')
      },
      delete: () => {
        throw new Error('db locked')
      },
      listByPrefix: () => {
        throw new Error('db locked')
      },
    } as unknown as RuntimeStateRepo
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })

    expect(() => store.setActive(UID, `weixin:${UID}`)).not.toThrow()
    expect(store.getActive(UID)).toBe(`weixin:${UID}`)
    expect(() => store.clear(UID)).not.toThrow()
  })

  it('损坏的库记录被忽略，不阻塞载入', () => {
    const { repo } = makeRepo({
      'channel:active:weixin:bad': '{not json',
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: `weixin:${UID}`,
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo, channelType: WEIXIN })
    expect(store.getActive(UID)).toBe(`weixin:${UID}`)
  })

  // 自愈：指向已删会话的 key 留着，下一条消息会让 ensureConversationExists 把它重建成空会话
  it('载入时清掉指向已删会话的 active，保留仍有效的 own', () => {
    const { repo } = makeRepo({
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-deleted',
        own: `weixin:${UID}`,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      channelType: WEIXIN,
      conversationExists: (id) => id !== 'conv-deleted',
    })

    expect(store.getActive(UID)).toBeNull()
    expect(store.getOwn(UID)).toBe(`weixin:${UID}`)
  })

  it('active 与 own 都失效时整条丢弃', () => {
    const { repo, data } = makeRepo({
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-deleted',
        own: 'conv-deleted-too',
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      channelType: WEIXIN,
      conversationExists: () => false,
    })

    expect(store.getActive(UID)).toBeNull()
    expect(store.getOwn(UID)).toBeNull()
    expect(data.has(`channel:active:weixin:${UID}`)).toBe(false)
  })

  it('会话校验抛错时不丢路由（宁可按存在处理）', () => {
    const { repo } = makeRepo({
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: `weixin:${UID}`,
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      channelType: WEIXIN,
      conversationExists: () => {
        throw new Error('db busy')
      },
    })
    expect(store.getActive(UID)).toBe(`weixin:${UID}`)
  })
})
