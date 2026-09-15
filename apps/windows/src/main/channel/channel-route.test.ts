/**
 * ChannelRouteService（10-S3）：四个渠道共用的路由决策。
 *
 * 收口前的问题：`/back` 在微信会解绑 /link、在其它渠道不会；`/unlink`、接续被拒、`/back`
 * 三条路径对绑定各写各的。这里把「去哪」与「离开时释放什么」都定成一条规则，渠道差异
 * 只剩「有没有绑定层」这一个可选依赖。
 */

import { describe, expect, it, vi } from 'vitest'
import type { RuntimeStateRepo } from '@mtbot/agent-runtime'
import { ChannelSessionStore } from './channel-session-store'
import { ChannelRouteService, type ChannelBindingPort } from './channel-route'

function makeRepo() {
  const data = new Map<string, string>()
  return {
    data,
    repo: {
      setJson: (key: string, value: unknown) => void data.set(key, JSON.stringify(value)),
      delete: (key: string) => void data.delete(key),
      listByPrefix: (prefix: string) =>
        [...data.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    } as unknown as RuntimeStateRepo,
  }
}

function makeStore() {
  return new ChannelSessionStore({ repo: makeRepo().repo })
}

/** 绑定层替身：记录 bind/unbind 调用 */
function makeBinding(initial?: string) {
  let bound: string | null = initial ?? null
  return {
    bindings: { bound: () => bound },
    port: {
      getBoundConversationId: () => bound,
      bind: vi.fn((_uid: string, conversationId: string) => {
        bound = conversationId
      }),
      unbind: vi.fn(() => {
        bound = null
      }),
    } satisfies ChannelBindingPort,
  }
}

const UID = 'u1'

describe('ChannelRouteService · 路由优先级', () => {
  it('无记录时回落到渠道默认会话，来源 default（默认键只在此处构造）', () => {
    const route = new ChannelRouteService({ channelType: 'qbot', store: makeStore() })
    expect(route.activeKey(UID)).toBe('qbot:u1')
    expect(route.activeSource(UID)).toBe('default')
  })

  it('有 /link 绑定时优先于默认会话', () => {
    const { port } = makeBinding('conv-linked')
    const route = new ChannelRouteService({ channelType: 'weixin', store: makeStore(), binding: port })
    expect(route.activeKey(UID)).toBe('conv-linked')
    expect(route.activeSource(UID)).toBe('link')
  })

  it('路由表优先于 /link 绑定（/resume、接续是更新的决定）', () => {
    const { port } = makeBinding('conv-linked')
    const store = makeStore()
    const route = new ChannelRouteService({ channelType: 'weixin', store, binding: port })

    route.setActive(UID, 'conv-chosen', 'resume')

    expect(route.activeKey(UID)).toBe('conv-chosen')
    expect(route.activeSource(UID)).toBe('resume')
  })
})

describe('ChannelRouteService · /back（resetToOwn）四渠道同语义', () => {
  it('当前路由恰是 /link 绑定时释放绑定并回到自己', () => {
    const { port, bindings } = makeBinding('conv-linked')
    const route = new ChannelRouteService({ channelType: 'weixin', store: makeStore(), binding: port })

    // 初始路由就来自绑定（无路由记录 → 回落 /link）
    expect(route.activeKey(UID)).toBe('conv-linked')

    expect(route.resetToOwn(UID)).toBe('weixin:u1')
    expect(bindings.bound()).toBeNull() // 绑定被释放
    expect(port.unbind).toHaveBeenCalledTimes(1)
    expect(route.activeSource(UID)).toBe('own')
  })

  it('当前路由不是那条绑定时**不解绑**（不误伤用户显式建立的绑定）', () => {
    const { port, bindings } = makeBinding('conv-linked')
    const route = new ChannelRouteService({ channelType: 'weixin', store: makeStore(), binding: port })
    route.setActive(UID, 'conv-continuity', 'continuity')

    expect(route.resetToOwn(UID)).toBe('weixin:u1')
    expect(bindings.bound()).toBe('conv-linked') // 绑定保留
    expect(port.unbind).not.toHaveBeenCalled()
  })

  it('没有绑定层的渠道（飞书/企微/QQ）走同一段代码：只改路由', () => {
    const store = makeStore()
    const route = new ChannelRouteService({ channelType: 'feishu', store })
    store.setActive('feishu', UID, 'feishu:u1:169', 'own')
    route.setActive(UID, 'conv-borrowed', 'continuity')

    expect(route.resetToOwn(UID)).toBe('feishu:u1:169')
    expect(route.activeKey(UID)).toBe('feishu:u1:169')
  })

  it('没有自己的会话时回落到渠道默认键', () => {
    const route = new ChannelRouteService({ channelType: 'wecom', store: makeStore() })
    route.setActive(UID, 'conv-borrowed', 'continuity')

    expect(route.resetToOwn(UID)).toBe('wecom:u1')
  })
})

describe('ChannelRouteService · /link 与 /unlink', () => {
  it('link 建绑定并把路由指过去（来源 link）', () => {
    const { port, bindings } = makeBinding()
    const route = new ChannelRouteService({ channelType: 'weixin', store: makeStore(), binding: port })

    route.link(UID, 'conv-desktop')

    expect(bindings.bound()).toBe('conv-desktop')
    expect(route.activeKey(UID)).toBe('conv-desktop')
    expect(route.activeSource(UID)).toBe('link')
  })

  it('unlink 断开绑定并把路由交回自己', () => {
    const { port, bindings } = makeBinding()
    const route = new ChannelRouteService({ channelType: 'weixin', store: makeStore(), binding: port })
    route.link(UID, 'conv-desktop')

    expect(route.unlink(UID)).toBe('weixin:u1')
    expect(bindings.bound()).toBeNull()
    expect(route.activeKey(UID)).toBe('weixin:u1')
  })

  it('无绑定层的渠道调用 link/unlink 不报错（能力缺口显式可见）', () => {
    const route = new ChannelRouteService({ channelType: 'qbot', store: makeStore() })
    expect(() => route.link(UID, 'conv-x')).not.toThrow()
    expect(route.activeKey(UID)).toBe('conv-x')
    expect(route.unlink(UID)).toBe('qbot:u1')
  })
})

describe('ChannelRouteService · 失效目标', () => {
  it('目标会话已删除时切换被拒（路由不变），由调用方决定怎么告知用户', () => {
    const store = new ChannelSessionStore({
      repo: makeRepo().repo,
      conversationExists: (id) => id !== 'conv-deleted',
    })
    const route = new ChannelRouteService({ channelType: 'qbot', store })
    route.setActive(UID, 'qbot:u1', 'own')

    expect(route.setActive(UID, 'conv-deleted', 'resume')).toBe(false)
    expect(route.activeKey(UID)).toBe('qbot:u1')
  })
})
