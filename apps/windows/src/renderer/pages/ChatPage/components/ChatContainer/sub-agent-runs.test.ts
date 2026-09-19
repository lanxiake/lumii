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

  it('失败原因是终态：最后一条消息的结局说了算（中间失败、最后成功 → 不报失败）', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const failedFirst = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      llmError: { code: 'rate_limited', message: '请求过于频繁被限流', retryable: true },
    })
    const recovered = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [tool('t-1', 'file_write')],
    })

    // 自愈重试后成功 → 运行是「已完成」，不因中间那次失败而报红（失败尝试仍在轨迹里）
    const run = groupSubAgentRuns([parent, failedFirst, recovered]).runsByParent.get('p1')![0]!
    expect(run.error).toBeUndefined()
  })

  it('最后一条消息带 llmError → 失败原因取该条', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const c1 = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      llmError: { code: 'rate_limited', message: '请求过于频繁被限流', retryable: true },
    })
    const c2 = msg({
      id: 'c2',
      timestamp: t(2),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      llmError: { code: 'insufficient_credits', message: '账户余额不足', retryable: false },
    })

    const run = groupSubAgentRuns([parent, c1, c2]).runsByParent.get('p1')![0]!
    expect(run.error).toBe('账户余额不足')
  })

  it('没有 llmError 时回退到消息 error 字段', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const child = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [],
      error: '子 Agent 异常退出',
    })

    const run = groupSubAgentRuns([parent, child]).runsByParent.get('p1')![0]!
    expect(run.error).toBe('子 Agent 异常退出')
    expect(run.interrupted).toBeUndefined()
  })

  it('中止标记：实时 isAborted 与历史回放的 interrupted 工具态都能识别', () => {
    // 实时：级联中止 / 实例销毁时事件带 isAborted
    const liveRun = groupSubAgentRuns([
      msg({ id: 'p1', timestamp: t(0), parts: [] }),
      msg({
        id: 'c1',
        timestamp: t(1),
        sourceAgent: { instanceId: 'inst-a', label: 'A' },
        parts: [],
        isAborted: true,
      }),
    ]).runsByParent.get('p1')![0]!
    expect(liveRun.interrupted).toBe(true)

    // 历史回放：isAborted 不落库，靠 finalizeAssistantParts 收尾的 interrupted 工具态
    const historyRun = groupSubAgentRuns([
      msg({ id: 'p2', timestamp: t(0), parts: [] }),
      msg({
        id: 'c2',
        timestamp: t(1),
        sourceAgent: { instanceId: 'inst-b', label: 'B' },
        parts: [{ type: 'tool', id: 't-1', name: 'bash', args: {}, status: 'interrupted' }],
      }),
    ]).runsByParent.get('p2')![0]!
    expect(historyRun.interrupted).toBe(true)
  })

  it('正常收场的运行不带失败/中断标记（不误报）', () => {
    const parent = msg({ id: 'p1', timestamp: t(0), parts: [] })
    const child = msg({
      id: 'c1',
      timestamp: t(1),
      sourceAgent: { instanceId: 'inst-a', label: 'A' },
      parts: [tool('t-1', 'file_write')],
    })

    const run = groupSubAgentRuns([parent, child]).runsByParent.get('p1')![0]!
    expect(run.error).toBeUndefined()
    expect(run.interrupted).toBeUndefined()
  })
})
