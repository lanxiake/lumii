// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'

import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import { __resetTimelineCardsForTest, findTimelineCard, listTimelineCards } from './registry'
import { registerBuiltinTimelineCards } from './builtin'

type ToolPart = Extract<AssistantPart, { type: 'tool' }>

function part(name: string, result?: unknown): ToolPart {
  return { type: 'tool', id: `t-${name}`, name, args: {}, status: 'done', result }
}

describe('内置时间线卡片', () => {
  beforeEach(() => {
    __resetTimelineCardsForTest()
    registerBuiltinTimelineCards()
  })

  it('三张卡片按 order 升序注册，且都 pinned', () => {
    const cards = listTimelineCards()
    expect(cards.map((c) => c.id)).toEqual(['builtin.handoff', 'builtin.spawn', 'builtin.task-complete'])
    expect(cards.every((c) => c.pinned === true)).toBe(true)
  })

  it('按工具名各命中各的', () => {
    expect(findTimelineCard(part('propose_dev_handoff'))?.id).toBe('builtin.handoff')
    expect(findTimelineCard(part('spawn_agent'))?.id).toBe('builtin.spawn')
    expect(findTimelineCard(part('task_complete'))?.id).toBe('builtin.task-complete')
  })

  it('普通工具不命中（回落工具批次组）', () => {
    expect(findTimelineCard(part('file_read'))).toBeNull()
    expect(findTimelineCard(part('bash'))).toBeNull()
  })

  it('重复调用是幂等的（HMR 重跑模块不抛）', () => {
    expect(() => registerBuiltinTimelineCards()).not.toThrow()
    expect(listTimelineCards()).toHaveLength(3)
  })

  it('spawn 卡片能读出子实例 id（子运行归属依赖它）', () => {
    const spawn = findTimelineCard(part('spawn_agent'))!
    const withResult = part('spawn_agent', {
      content: [{ type: 'text', text: JSON.stringify({ status: 'ok', instanceId: 'inst-1' }) }],
    })
    expect(spawn.instanceId?.(withResult)).toBe('inst-1')
    // 同步执行中结果尚未返回：读不到就返回 undefined，子运行走独立块兜底
    expect(spawn.instanceId?.(part('spawn_agent'))).toBeUndefined()
  })

  it('非委托卡片没有 instanceId 提取器', () => {
    expect(findTimelineCard(part('task_complete'))?.instanceId).toBeUndefined()
  })
})
