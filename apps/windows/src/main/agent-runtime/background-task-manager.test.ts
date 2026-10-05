import { describe, expect, it } from 'vitest'
import type { AgentRuntimeEvent } from '../../shared/agent-runtime-events'
import { BackgroundTaskManager, type BackgroundTaskRecord } from './background-task-manager'

function makeManager(overrides?: {
  now?: () => number
  maxRetained?: number
  summaryMaxLength?: number
}): {
  manager: BackgroundTaskManager
  events: AgentRuntimeEvent[]
  delivered: BackgroundTaskRecord[]
} {
  const events: AgentRuntimeEvent[] = []
  const delivered: BackgroundTaskRecord[] = []
  const manager = new BackgroundTaskManager({
    emit: (e) => events.push(e),
    deliver: (t) => {
      delivered.push(t)
    },
    ...overrides,
  })
  return { manager, events, delivered }
}

describe('BackgroundTaskManager', () => {
  it('start 登记并推 running 事件', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({
      instanceId: 'inst-1',
      sessionKey: 'sess-1',
      toolName: 'mcp__comfyui-remote__enqueue_workflow',
      label: 'ComfyUI: enqueue_workflow',
    })

    expect(taskId).toBeTruthy()
    expect(manager.get(taskId)?.status).toBe('running')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'agent:background-task',
      taskId,
      status: 'running',
      sessionKey: 'sess-1',
      instanceId: 'inst-1',
      toolName: 'mcp__comfyui-remote__enqueue_workflow',
    })
  })

  it('complete 推 succeeded 并投递一次；重复终结被忽略', () => {
    const { manager, events, delivered } = makeManager({ now: () => 1000 })
    const taskId = manager.start({ instanceId: 'i', sessionKey: 's', toolName: 't', label: 'L' })

    manager.complete(taskId, '产出一个视频')
    manager.complete(taskId, '重复调用') // 应被忽略
    manager.fail(taskId, '也不该覆盖')

    const terminal = events.filter((e) => e.type === 'agent:background-task' && e.status !== 'running')
    expect(terminal).toHaveLength(1)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ status: 'succeeded', summary: '产出一个视频', endedAt: 1000 })
  })

  it('fail 携带错误并投递', () => {
    const { manager, delivered } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.fail(taskId, '网络断开')
    expect(manager.get(taskId)).toMatchObject({ status: 'failed', error: '网络断开' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].status).toBe('failed')
  })

  it('未知 taskId 的终结是 no-op，不抛错、不投递', () => {
    const { manager, delivered } = makeManager()
    expect(() => manager.complete('nope')).not.toThrow()
    expect(() => manager.fail('nope', 'x')).not.toThrow()
    expect(delivered).toHaveLength(0)
  })

  it('摘要超长被截断', () => {
    const { manager } = makeManager({ summaryMaxLength: 5 })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.complete(taskId, '0123456789')
    expect(manager.get(taskId)?.summary).toBe('01234…')
  })

  it('超过保留上限时逐出最旧的终态任务（不逐出 running）', () => {
    const { manager } = makeManager({ maxRetained: 2, now: () => 1 })
    const a = manager.start({ toolName: 'a', label: 'A' })
    const b = manager.start({ toolName: 'b', label: 'B' })
    const running = manager.start({ toolName: 'c', label: 'C' })
    manager.complete(a)
    manager.complete(b)

    expect(manager.get(a)).toBeUndefined() // 最旧终态被逐出
    expect(manager.get(b)?.status).toBe('succeeded')
    expect(manager.get(running)?.status).toBe('running')
  })

  it('deliver 抛错不影响任务终结', () => {
    const events: AgentRuntimeEvent[] = []
    const manager = new BackgroundTaskManager({
      emit: (e) => events.push(e),
      deliver: () => {
        throw new Error('投递失败')
      },
    })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    expect(() => manager.complete(taskId, 'ok')).not.toThrow()
    expect(manager.get(taskId)?.status).toBe('succeeded')
  })

  it('listBySession 按会话过滤', () => {
    const { manager } = makeManager()
    manager.start({ sessionKey: 's1', toolName: 't', label: 'L' })
    manager.start({ sessionKey: 's2', toolName: 't', label: 'L' })
    manager.start({ sessionKey: 's1', toolName: 't', label: 'L' })
    expect(manager.listBySession('s1')).toHaveLength(2)
    expect(manager.listBySession('s2')).toHaveLength(1)
  })

  it('自动 taskId 唯一', () => {
    const { manager } = makeManager()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(manager.start({ toolName: 't', label: 'L' }))
    expect(ids.size).toBe(50)
  })
})
