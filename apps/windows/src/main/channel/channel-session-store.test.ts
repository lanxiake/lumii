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
  it('记录 active 与来源；本渠道会话同时更新 own', () => {
    const { repo, data } = makeRepo()
    const store = new ChannelSessionStore({ repo })

    store.setActive(WEIXIN, UID, `weixin:${UID}:1726000000000`, 'own')

    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}:1726000000000`)
    expect(store.getOwn(WEIXIN, UID)).toBe(`weixin:${UID}:1726000000000`)
    expect(store.getSource(WEIXIN, UID)).toBe('own')
    // 写穿透：落库
    expect(data.has(`channel:active:weixin:${UID}`)).toBe(true)
  })

  it('跨渠道接续不污染 own —— 回到本渠道时仍能找回自己的会话，来源可查', () => {
    const { repo } = makeRepo()
    const store = new ChannelSessionStore({ repo })

    store.setActive(WEIXIN, UID, `weixin:${UID}`, 'own')
    store.setActive(WEIXIN, UID, 'conv-client-a', 'continuity')

    expect(store.getActive(WEIXIN, UID)).toBe('conv-client-a')
    expect(store.getOwn(WEIXIN, UID)).toBe(`weixin:${UID}`)
    expect(store.getSource(WEIXIN, UID)).toBe('continuity')
  })

  it('重启后从库中恢复（构造时载入），来源一并带回', () => {
    const { repo } = makeRepo({
      [`channel:active:weixin:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-client-a',
        own: `weixin:${UID}`,
        source: 'continuity',
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo })

    expect(store.getActive(WEIXIN, UID)).toBe('conv-client-a')
    expect(store.getOwn(WEIXIN, UID)).toBe(`weixin:${UID}`)
    expect(store.getSource(WEIXIN, UID)).toBe('continuity')
  })

  it('单实例载入全部渠道，各渠道互不串（S3：一份路由表）', () => {
    const { repo } = makeRepo({
      'channel:active:feishu:ou_x': JSON.stringify({
        channelType: 'feishu',
        channelUserId: 'ou_x',
        active: 'feishu:ou_x',
        own: null,
        updatedAt: new Date().toISOString(),
      }),
      [`channel:active:${WEIXIN}:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: `weixin:${UID}`,
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo })

    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}`)
    expect(store.getActive('feishu', 'ou_x')).toBe('feishu:ou_x')
    // 同名 uid 在不同渠道下是两条独立记录
    expect(store.getActive(WEIXIN, 'ou_x')).toBeNull()
    expect(store.getActive('feishu', UID)).toBeNull()
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
    const store = new ChannelSessionStore({ repo, listRecent })

    expect(store.getOwn(WEIXIN, UID)).toBe(`weixin:${UID}:1726000000000`)
  })

  it('兜底查无结果也记忆化，不每条消息重扫', () => {
    const { repo } = makeRepo()
    const listRecent = vi.fn(() => [{ id: 'conv-other', updatedAt: new Date().toISOString() }])
    const store = new ChannelSessionStore({ repo, listRecent })

    expect(store.getOwn(WEIXIN, UID)).toBeNull()
    expect(store.getOwn(WEIXIN, UID)).toBeNull()
    expect(listRecent).toHaveBeenCalledTimes(1)
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
    const store = new ChannelSessionStore({ repo })

    expect(() => store.setActive(WEIXIN, UID, `weixin:${UID}`, 'own')).not.toThrow()
    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}`)
  })

  it('损坏的库记录被忽略，不阻塞载入', () => {
    const { repo } = makeRepo({
      'channel:active:weixin:bad': '{not json',
      [`channel:active:${WEIXIN}:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: `weixin:${UID}`,
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({ repo })
    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}`)
  })

  // 自愈：指向已删会话的 key 留着，下一条消息会让 ensureConversationExists 把它重建成空会话
  it('载入时清掉指向已删会话的 active，保留仍有效的 own', () => {
    const { repo } = makeRepo({
      [`channel:active:${WEIXIN}:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-deleted',
        own: `weixin:${UID}`,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      conversationExists: (id) => id !== 'conv-deleted',
    })

    expect(store.getActive(WEIXIN, UID)).toBeNull()
    expect(store.getOwn(WEIXIN, UID)).toBe(`weixin:${UID}`)
  })

  it('active 与 own 都失效时整条丢弃', () => {
    const { repo, data } = makeRepo({
      [`channel:active:${WEIXIN}:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: 'conv-deleted',
        own: 'conv-deleted-too',
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      conversationExists: () => false,
    })

    expect(store.getActive(WEIXIN, UID)).toBeNull()
    expect(store.getOwn(WEIXIN, UID)).toBeNull()
    expect(data.has(`channel:active:weixin:${UID}`)).toBe(false)
  })

  it('会话校验抛错时不丢路由（宁可按存在处理）', () => {
    const { repo } = makeRepo({
      [`channel:active:${WEIXIN}:${UID}`]: JSON.stringify({
        channelType: WEIXIN,
        channelUserId: UID,
        active: `weixin:${UID}`,
        own: null,
        updatedAt: new Date().toISOString(),
      }),
    })
    const store = new ChannelSessionStore({
      repo,
      conversationExists: () => {
        throw new Error('db busy')
      },
    })
    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}`)
  })

  // B6：运行期也要校验，否则会静默把用户切到一个已被删掉的会话上，
  // 下一条消息再由 ensureConversationExists 把它重建成空会话
  it('写入时目标会话已不存在 → 拒绝写入，路由保持不变', () => {
    const { repo } = makeRepo()
    const store = new ChannelSessionStore({
      repo,
      conversationExists: (id) => id !== 'conv-deleted',
    })
    store.setActive(WEIXIN, UID, `weixin:${UID}`, 'own')

    expect(store.setActive(WEIXIN, UID, 'conv-deleted', 'resume')).toBe(false)
    expect(store.getActive(WEIXIN, UID)).toBe(`weixin:${UID}`)
  })
})
