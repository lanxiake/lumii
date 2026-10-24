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

  it('deliver 抛错不影响任务终结', () => {    const events: AgentRuntimeEvent[] = []
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

  it('终态回调拿到含耗时的记录；回调抛错不影响终结', () => {
    const settled: BackgroundTaskRecord[] = []
    const events: AgentRuntimeEvent[] = []
    const manager = new BackgroundTaskManager({
      emit: (e) => events.push(e),
      deliver: () => {},
      now: () => 5_000,
      onSettled: (record) => {
        settled.push(record)
        throw new Error('埋点炸了')
      },
    })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    expect(() => manager.complete(taskId, 'ok')).not.toThrow()
    expect(settled).toHaveLength(1)
    expect(settled[0]).toMatchObject({ taskId, status: 'succeeded', endedAt: 5_000 })
  })

  it('摘要截断不影响完整结果：result 保留全文，唤醒投递拿到的是全文', () => {
    const { manager, delivered } = makeManager({ summaryMaxLength: 5 })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.complete(taskId, '0123456789', {
      outputs: [{ name: 'a.mp4', path: 'video/a.mp4', kind: 'video', url: 'https://x/view?filename=a.mp4' }],
    })
    expect(manager.get(taskId)).toMatchObject({ summary: '01234…', result: '0123456789' })
    expect(delivered[0]?.result).toBe('0123456789')
    expect(delivered[0]?.outputs).toEqual([
      { name: 'a.mp4', path: 'video/a.mp4', kind: 'video', url: 'https://x/view?filename=a.mp4' },
    ])
  })

  it('update 只在运行中推进度事件，终态清掉进度说明', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.update(taskId, 'ComfyUI 排队中')
    manager.update(taskId, 'ComfyUI 排队中') // 未变化不重复推
    manager.update(taskId, 'ComfyUI 渲染中')
    expect(events).toHaveLength(3)
    expect(events[2]).toMatchObject({ status: 'running', note: 'ComfyUI 渲染中' })

    manager.complete(taskId, 'ok')
    expect(manager.get(taskId)?.note).toBeUndefined()
    manager.update(taskId, '终态后不该再推')
    expect(events).toHaveLength(4)
  })

  it('自动 taskId 唯一', () => {
    const { manager } = makeManager()
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) ids.add(manager.start({ toolName: 't', label: 'L' }))
    expect(ids.size).toBe(50)
  })
})

describe('BackgroundTaskManager 进度 / 日志 / 里程碑', () => {
  it('updateProgress 钳制到 0–100 并推事件，重复值不推', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.updateProgress(taskId, 40, '渲染')
    manager.updateProgress(taskId, 40, '渲染')
    manager.updateProgress(taskId, 150)
    manager.updateProgress(taskId, -10)
    expect(manager.get(taskId)?.progress).toBe(0)
    expect(manager.get(taskId)?.currentStep).toBe('渲染')
    expect(events).toHaveLength(4)
  })

  it('addLog 追加并在超过 1000 条时丢掉最早的', () => {
    const { manager, events } = makeManager({ now: () => 10 })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    for (let i = 0; i < 1001; i++) manager.addLog(taskId, 'info', `m-${i}`)
    const logs = manager.get(taskId)?.logs ?? []
    expect(logs).toHaveLength(1000)
    expect(logs[0]?.message).toBe('m-1')
    expect(logs[999]?.message).toBe('m-1000')
    // 运行中只推增量：长任务每次刷新都全量重传会拖死渲染层
    expect(events.at(-1)).toMatchObject({
      type: 'agent:background-task',
      logsDelta: [{ level: 'info', message: 'm-1000', timestamp: 10 }],
    })
    expect(events.at(-1)).not.toHaveProperty('logs')
  })

  it('addLog 增量推动，终态补齐全量快照', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.addLog(taskId, 'info', 'a')
    manager.addLog(taskId, 'info', 'b')
    const deltas = events
      .filter((e) => e.type === 'agent:background-task' && 'logsDelta' in e)
      .map((e) => (e as { logsDelta: readonly { message: string }[] }).logsDelta.map((l) => l.message))
    expect(deltas).toEqual([['a'], ['b']])

    manager.complete(taskId, 'ok')
    const last = events.at(-1)
    expect(last?.type === 'agent:background-task' && last.logs?.map((l) => l.message)).toEqual(['a', 'b'])
  })

  it('setMilestones / updateMilestone 按步骤更新，未知步骤不推事件', () => {
    const { manager, events } = makeManager({ now: () => 5_000 })
    const taskId = manager.start({ toolName: 't', label: 'L' })
    const before = events.length
    manager.setMilestones(taskId, [
      { step: '准备', status: 'pending' },
      { step: '渲染', status: 'pending' },
    ])
    manager.updateMilestone(taskId, '准备', 'in-progress')
    manager.updateMilestone(taskId, '准备', 'completed', 1200)
    manager.updateMilestone(taskId, '不存在', 'failed')
    expect(manager.get(taskId)?.milestones).toEqual([
      { step: '准备', status: 'completed', startTime: 5_000, duration: 1200 },
      { step: '渲染', status: 'pending' },
    ])
    expect(events.length).toBe(before + 3)
  })

  it('终态之后进度和日志更新被忽略，已有日志仍保留', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.addLog(taskId, 'info', '开始')
    manager.complete(taskId, 'ok')
    const after = events.length
    manager.updateProgress(taskId, 80, '太晚了')
    manager.addLog(taskId, 'error', '不该写入')
    expect(manager.get(taskId)?.logs?.map((log) => log.message)).toEqual(['开始'])
    expect(manager.get(taskId)?.progress).toBeUndefined()
    expect(events).toHaveLength(after)
  })

  it('未知 taskId 的进度更新是 no-op', () => {
    const { manager, events } = makeManager()
    expect(() => manager.updateProgress('missing', 10)).not.toThrow()
    expect(() => manager.addLog('missing', 'info', 'x')).not.toThrow()
    expect(() => manager.setMilestones('missing', [])).not.toThrow()
    expect(events).toHaveLength(0)
  })
})
