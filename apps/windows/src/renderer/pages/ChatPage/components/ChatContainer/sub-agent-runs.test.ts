/**
 * groupSubAgentRuns 单元测试
 *
 * 覆盖 docs/plans/专项Agent/08-委托可见性.md §4.4 的验收点：
 * 子消息不再并入父 parts、独立成组、无父时不丢内容、同一实例多消息合并。
 */
import { describe, it, expect } from 'vitest'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import { groupSubAgentRuns, type GroupableMessage } from './sub-agent-runs'

function msg(overrides: Partial<GroupableMessage> & { id: string; timestamp: Date }): GroupableMessage {
  return { role: 'assistant', ...overrides }
}

const t = (s: number) => new Date(Date.UTC(2026, 8, 14, 1, 0, s))

const thinking = (id: string, text: string): AssistantPart => ({
  type: 'thinking',
  id,
  text,
  status: 'done',
})

const tool = (id: string, name: string): AssistantPart => ({
  type: 'tool',
  id,
  name,
  args: {},
  status: 'done',
})

describe('groupSubAgentRuns', () => {
  it('子消息归到前一条主 Agent 消息下，不修改父的 parts', () => {
    const parentParts = [thinking('th-1', 'father')]
    const parent = msg({ id: 'p1', timestamp: t(0), parts: parentParts })
    const child = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: '灵栖维护' },
      parts: [thinking('th-2', 'child'), tool('t-2', 'Write')],
    })

    const { runsByParent, attachedMessageIds } = groupSubAgentRuns([parent, child])

    // 父的 parts 引用与内容均未被改写
    expect(parent.parts).toBe(parentParts)
    expect(parent.parts).toHaveLength(1)
    // 子消息被归组，不再独立渲染
    expect(attachedMessageIds.has('c1')).toBe(true)

    const runs = runsByParent.get('p1')
    expect(runs).toHaveLength(1)
    expect(runs![0]!.label).toBe('灵栖维护')
    expect(runs![0]!.parts.map((p) => p.id)).toEqual(['th-2', 't-2'])
  })

  it('同一实例的多条消息合并为一段轨迹，流式状态取或', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const c1 = msg({
      id: 'c1',
      timestamp: t(1),
      isStreaming: true,
      sourceAgent: { instanceId: 'inst-a', label: '系统默认' },
      parts: [tool('t-1', 'Read')],
    })
    const c2 = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-a', label: '系统默认' },
      parts: [tool('t-2', 'Write')],
    })

    const { runsByParent } = groupSubAgentRuns([parent, c1, c2])
    const runs = runsByParent.get('p1')!

    expect(runs).toHaveLength(1)
    expect(runs[0]!.parts.map((p) => p.id)).toEqual(['t-1', 't-2'])
    // 后续消息不带 isStreaming，但此前已经流过 → 保持 true
    expect(runs[0]!.isStreaming).toBe(true)
  })

  it('两个不同实例各自成组（并发委派不串台）', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const a = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: '灵栖维护' },
      parts: [tool('a-1', 'Read')],
    })
    const b = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-b', label: '灵栖情报' },
      parts: [tool('b-1', 'Grep')],
    })

    const { runsByParent } = groupSubAgentRuns([parent, a, b])
    const runs = runsByParent.get('p1')!

    expect(runs.map((r) => r.instanceId)).toEqual(['inst-a', 'inst-b'])
    expect(runs.map((r) => r.label)).toEqual(['灵栖维护', '灵栖情报'])
  })

  it('找不到父的子消息不被吞掉（旧实现会整条丢弃）', () => {
    const orphan = msg({
      id: 'c1',
      timestamp: t(0),
      sourceAgent: { instanceId: 'inst-a', label: '系统默认' },
      parts: [tool('t-1', 'Read')],
    })

    const { runsByParent, attachedMessageIds } = groupSubAgentRuns([orphan])

    expect(runsByParent.size).toBe(0)
    expect(attachedMessageIds.has('c1')).toBe(false)
  })

  it('子消息不能成为父：多个子 Agent 都归到同一条主 Agent 消息', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const c1 = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
    })
    const c2 = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-b', label: 'B' },
      parts: [],
    })

    const { runsByParent } = groupSubAgentRuns([parent, c1, c2])

    expect([...runsByParent.keys()]).toEqual(['p1'])
    expect(runsByParent.get('p1')).toHaveLength(2)
  })

  it('user 消息中断父子关系：其后没有新的主 Agent 消息时子消息成为孤儿', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const user = msg({ id: 'u1', role: 'user', timestamp: t(1), parts: [] })
    const child = msg({
      id: 'c1',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
    })

    const { runsByParent } = groupSubAgentRuns([parent, user, child])

    // user 消息不重置父（旧实现是「向前找最近一条无 sourceAgent 的 assistant」，
    // 跨过 user 消息同样能命中 p1）——保持与旧行为一致
    expect(runsByParent.get('p1')).toHaveLength(1)
  })

  it('输入乱序时按时间排序后再归组', () => {
    const parent = msg({ id: 'p1', timestamp: t(5), parts: [] })
    const child = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
    })

    // child 在 parent 之前 → 无父可挂
    const { runsByParent } = groupSubAgentRuns([parent, child])
    expect(runsByParent.size).toBe(0)
  })

  it('子运行的文件变更按 path 去重合并', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const c1 = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      fileChanges: [{ path: 'a.ts', status: 'added' }],
    })
    const c2 = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      fileChanges: [{ path: 'a.ts', status: 'modified' }, { path: 'b.ts', status: 'added' }],
    })

    const { runsByParent } = groupSubAgentRuns([parent, c1, c2])
    const run = runsByParent.get('p1')![0]!

    expect(run.fileChanges).toEqual([
      { path: 'a.ts', status: 'modified' },
      { path: 'b.ts', status: 'added' },
    ])
  })
})
