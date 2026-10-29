/**
 * 渠道入站 → Agent 绑定的三条硬约束：
 *   1. 没配 agentId 时行为与改造前逐字一致（`main`）；
 *   2. 配了就按配的建实例；
 *   3. **换绑当场生效**——缓存里的实例定义对不上就作废重建，不等重启。
 */
import { describe, it, expect, vi } from 'vitest'
import { getOrCreateChannelInstance, type ChannelInstanceBridge } from './channel-agent-binding'

// helper 每建一次实例就打一行日志，测试里没意义
vi.spyOn(console, 'log').mockImplementation(() => {})
vi.spyOn(console, 'warn').mockImplementation(() => {})

function fakeBridge(live: Array<{ id: string; definitionId: string }> = []) {
  const created: Array<{ agentId: string; sessionKey: string }> = []
  const invalidated: string[] = []
  let seq = 0
  const bridge: ChannelInstanceBridge = {
    getInstances: () => live.map((i) => ({ ...i, state: 'idle' })),
    createInstanceById: async (agentId, sessionKey) => {
      const id = `inst-${++seq}`
      created.push({ agentId, sessionKey: sessionKey ?? '' })
      // 与真实定义库一致：'main' 解析成 assistant
      live.push({ id, definitionId: agentId === 'main' ? 'assistant' : agentId })
      return id
    },
    invalidateInstance: (id) => {
      invalidated.push(id)
      return 'destroyed'
    },
  }
  return { bridge, created, invalidated, live }
}

describe('getOrCreateChannelInstance', () => {
  it('没配绑定 → 建 main（改造前行为不变）', async () => {
    const { bridge, created } = fakeBridge()
    const id = await getOrCreateChannelInstance(bridge, new Map(), 'qbot', 'qbot:u1', () => undefined)
    expect(id).toBe('inst-1')
    expect(created).toEqual([{ agentId: 'main', sessionKey: 'qbot:u1' }])
  })

  it('配了绑定 → 用配置的 Agent 定义', async () => {
    const { bridge, created } = fakeBridge()
    await getOrCreateChannelInstance(bridge, new Map(), 'qbot', 'qbot:u1', () => 'chronicler')
    expect(created[0]!.agentId).toBe('chronicler')
  })

  it('缓存命中且定义一致 → 复用，不重建', async () => {
    const { bridge, created, live } = fakeBridge()
    const cache = new Map<string, string>()
    const first = await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => 'chronicler')
    const second = await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => 'chronicler')
    expect(second).toBe(first)
    expect(created).toHaveLength(1)
    expect(live).toHaveLength(1)
  })

  it('换绑当场生效：旧实例作废，新建一个按新定义', async () => {
    const { bridge, created, invalidated } = fakeBridge()
    const cache = new Map<string, string>()
    const first = await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => 'chronicler')
    const second = await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => 'assistant')
    expect(second).not.toBe(first)
    expect(invalidated).toEqual([first])
    expect(created.map((c) => c.agentId)).toEqual(['chronicler', 'assistant'])
    expect(cache.get('s')).toBe(second)
  })

  it('实例已被销毁 → 重建（与换绑走同一条路）', async () => {
    const { bridge, created, live } = fakeBridge()
    const cache = new Map([['s', 'inst-gone']])
    const id = await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => undefined)
    expect(id).toBe('inst-1')
    expect(created).toHaveLength(1)
    expect(live).toHaveLength(1)
  })

  it('没配绑定时不比较定义 id（main 解析成 assistant，比了会每次重建）', async () => {
    const { bridge, created } = fakeBridge()
    const cache = new Map<string, string>()
    await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => undefined)
    await getOrCreateChannelInstance(bridge, cache, 'qbot', 's', () => undefined)
    expect(created).toHaveLength(1)
  })
})
