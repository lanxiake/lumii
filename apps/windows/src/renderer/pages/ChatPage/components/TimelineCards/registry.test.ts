// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import {
  TimelineCardRegistryError,
  __resetTimelineCardsForTest,
  ensureTimelineCard,
  findTimelineCard,
  listTimelineCards,
  registerTimelineCard,
  type TimelineCardDefinition,
} from './registry'

type ToolPart = Extract<AssistantPart, { type: 'tool' }>

function part(name: string): ToolPart {
  return { type: 'tool', id: `t-${name}`, name, args: {}, status: 'done' }
}

const Noop = () => null

function def(overrides: Partial<TimelineCardDefinition> & { id: string }): TimelineCardDefinition {
  return { match: () => true, component: Noop, ...overrides }
}

describe('TimelineCards registry', () => {
  beforeEach(() => {
    __resetTimelineCardsForTest()
  })

  it('注册后能按 match 命中，注销后不再命中', () => {
    const off = registerTimelineCard(def({ id: 'a', match: (p) => p.name === 'foo' }))

    expect(findTimelineCard(part('foo'))?.id).toBe('a')
    expect(findTimelineCard(part('bar'))).toBeNull()

    off()
    expect(findTimelineCard(part('foo'))).toBeNull()
  })

  it('同 id 重复注册抛错（不是静默覆盖）', () => {
    registerTimelineCard(def({ id: 'dup' }))
    expect(() => registerTimelineCard(def({ id: 'dup' }))).toThrow(TimelineCardRegistryError)
  })

  it('order 小的优先；同 order 按注册顺序', () => {
    registerTimelineCard(def({ id: 'late', order: 100 }))
    registerTimelineCard(def({ id: 'builtin', order: 10 }))
    registerTimelineCard(def({ id: 'same', order: 10 }))

    // builtin 与 same 同为 10，builtin 先注册 → 胜出
    expect(findTimelineCard(part('x'))?.id).toBe('builtin')
  })

  it('默认 order 是 100，于是补缺口的插件顶不掉内置（10-30）', () => {
    registerTimelineCard(def({ id: 'builtin', order: 20 }))
    registerTimelineCard(def({ id: 'plugin' }))
    expect(findTimelineCard(part('x'))?.id).toBe('builtin')
    expect(listTimelineCards().map((c) => c.id)).toEqual(['builtin', 'plugin'])
  })

  it('ensureTimelineCard 幂等：HMR 重跑不抛也不重复登记', () => {
    ensureTimelineCard(def({ id: 'builtin', order: 10 }))
    expect(() => ensureTimelineCard(def({ id: 'builtin', order: 10 }))).not.toThrow()
    expect(listTimelineCards()).toHaveLength(1)
  })

  it('没有命中项时返回 null（调用方回落工具批次组）', () => {
    registerTimelineCard(def({ id: 'a', match: (p) => p.name === 'foo' }))
    expect(findTimelineCard(part('nope'))).toBeNull()
  })

  it('instanceId 提取器随卡片定义走', () => {
    registerTimelineCard(
      def({ id: 'spawn', instanceId: (p) => (p.result as { id?: string })?.id }),
    )
    const withResult: ToolPart = { ...part('spawn_agent'), result: { id: 'inst-1' } }
    expect(findTimelineCard(withResult)?.instanceId?.(withResult)).toBe('inst-1')
  })

  it('模块被重新执行（HMR）后仍读写同一张表', async () => {
    // 内置卡片在 ChatMessage 模块顶层注册，HMR 不会重跑插件工厂；
    // 表若退回模块作用域，热更新一次所有插件卡片就静默消失。
    ensureTimelineCard(def({ id: 'builtin', order: 10 }))
    vi.resetModules()

    const fresh = await import('./registry')
    expect(fresh.listTimelineCards().map((c) => c.id)).toEqual(['builtin'])
    // 新实例注册的项老实例也看得见（同一张表，不是两份）
    fresh.registerTimelineCard(def({ id: 'from-fresh' }))
    expect(listTimelineCards().map((c) => c.id)).toContain('from-fresh')
  })
})
