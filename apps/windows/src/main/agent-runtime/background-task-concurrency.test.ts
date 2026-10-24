/**
 * 后台任务并发安全与内存回收。
 *
 * 管理器本身是同步状态机（无 await、无共享可变全局），并发风险不在「加锁」而在
 * 「跨任务串数据」与「终态后仍被写入」。这里锁死这两条，顺带证明回收不会误伤运行中任务。
 */
import { describe, expect, it } from 'vitest'
import type { AgentRuntimeEvent } from '../../shared/agent-runtime-events'
import { BackgroundTaskManager, type BackgroundTaskRecord } from './background-task-manager'

function makeManager(overrides?: { maxRetained?: number; now?: () => number }) {
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

/** 取某任务的增量日志消息（只认 logsDelta，全量快照在终态） */
function deltasFor(events: readonly AgentRuntimeEvent[], taskId: string): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type !== 'agent:background-task' || event.taskId !== taskId) continue
    for (const log of event.logsDelta ?? []) out.push(log.message)
  }
  return out
}

describe('后台任务并发隔离', () => {
  it('10 个任务交错各写 100 条日志，互不串台且顺序正确', () => {
    const { manager, events } = makeManager()
    const ids = Array.from({ length: 10 }, (_, i) =>
      manager.start({ toolName: `t${i}`, label: `L${i}` }),
    )

    for (let round = 0; round < 100; round++) {
      for (const [index, taskId] of ids.entries()) {
        manager.addLog(taskId, 'info', `t${index}-m${round}`)
      }
    }

    for (const [index, taskId] of ids.entries()) {
      const logs = manager.get(taskId)?.logs ?? []
      expect(logs).toHaveLength(100)
      expect(logs.every((log) => log.message.startsWith(`t${index}-`))).toBe(true)
      expect(logs[0]?.message).toBe(`t${index}-m0`)
      expect(logs[99]?.message).toBe(`t${index}-m99`)
      // 增量推送也必须只落在自己的任务上
      const deltas = deltasFor(events, taskId)
      expect(deltas).toHaveLength(100)
      expect(deltas.every((message) => message.startsWith(`t${index}-`))).toBe(true)
    }
  })

  it('取消一个任务不影响其它运行中任务', () => {
    const { manager } = makeManager()
    const a = manager.start({ toolName: 'a', label: 'A' })
    const b = manager.start({ toolName: 'b', label: 'B' })

    manager.cancel(a)
    manager.addLog(b, 'info', 'B 仍在跑')

    expect(manager.get(a)?.status).toBe('cancelled')
    expect(manager.get(b)?.status).toBe('running')
    expect(manager.get(b)?.logs).toHaveLength(1)
  })

  it('取消与完成同时到达：先到者胜，终态不再被改写', () => {
    const { manager, delivered } = makeManager()
    const a = manager.start({ toolName: 'a', label: 'A' })
    manager.cancel(a)
    manager.complete(a, '迟到的成功')

    expect(manager.get(a)?.status).toBe('cancelled')
    expect(manager.get(a)?.summary).toBeUndefined()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.status).toBe('cancelled')
  })

  it('终态之后的并发写入全部被丢弃', () => {
    const { manager, events } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.addLog(taskId, 'info', '结算前')
    manager.complete(taskId, 'ok')
    const afterSettle = events.length

    manager.addLog(taskId, 'error', '迟到日志')
    manager.updateProgress(taskId, 90, '迟到进度')
    manager.setMilestones(taskId, [{ step: 'x', status: 'pending' }])
    manager.updateMilestone(taskId, 'x', 'failed')

    expect(manager.get(taskId)?.logs?.map((log) => log.message)).toEqual(['结算前'])
    expect(events).toHaveLength(afterSettle)
  })
})

describe('后台任务暂停/恢复', () => {
  it('只对可暂停任务生效，暂停后可恢复且不终结', () => {
    const { manager, delivered } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.setMilestones(taskId, [{ step: '渲染', status: 'in-progress' }])
    manager.setPausable(taskId, true)

    manager.pause(taskId)
    expect(manager.get(taskId)?.status).toBe('paused')
    expect(manager.get(taskId)?.pausedAt).toBeTypeOf('number')
    // 暂停不是终态：不投递、不结束
    expect(delivered).toHaveLength(0)

    manager.resume(taskId)
    expect(manager.get(taskId)?.status).toBe('running')
    expect(manager.get(taskId)?.pausedAt).toBeUndefined()
  })

  it('暂停后进度与日志写入被忽略，恢复后继续可写', () => {
    const { manager } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.setPausable(taskId, true)
    manager.pause(taskId)

    manager.addLog(taskId, 'info', '暂停期间的日志')
    manager.updateProgress(taskId, 80, '暂停期间的进度')
    expect(manager.get(taskId)?.logs).toBeUndefined()
    expect(manager.get(taskId)?.progress).toBeUndefined()

    manager.resume(taskId)
    manager.addLog(taskId, 'info', '恢复后的日志')
    expect(manager.get(taskId)?.logs).toHaveLength(1)
  })

  it('不可暂停的任务 pause 是 no-op', () => {
    const { manager } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.pause(taskId)
    expect(manager.get(taskId)?.status).toBe('running')
  })

  it('暂停中取消仍生效', () => {
    const { manager, delivered } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    manager.setPausable(taskId, true)
    manager.pause(taskId)
    manager.cancel(taskId)
    expect(manager.get(taskId)?.status).toBe('cancelled')
    expect(delivered).toHaveLength(1)
  })
})

describe('后台任务内存回收', () => {
  it('超出保留上限只逐出最旧终态，运行中任务与日志不受影响', () => {
    const { manager } = makeManager({ maxRetained: 3, now: () => 1 })
    const running = manager.start({ toolName: 'run', label: 'R' })
    manager.addLog(running, 'info', '还在跑')

    const done = Array.from({ length: 5 }, (_, i) => {
      const id = manager.start({ toolName: `d${i}`, label: `D${i}` })
      manager.complete(id, 'ok')
      return id
    })

    const alive = manager.list()
    expect(alive.length).toBeLessThanOrEqual(3)
    expect(manager.get(running)?.status).toBe('running')
    expect(manager.get(running)?.logs).toHaveLength(1)
    // 逐出的是最早的终态任务
    expect(manager.get(done[0]!)).toBeUndefined()
    expect(manager.get(done[4]!)).toBeDefined()
  })

  it('日志缓冲有上限，长跑不会无限增长', () => {
    const { manager } = makeManager()
    const taskId = manager.start({ toolName: 't', label: 'L' })
    for (let i = 0; i < 5000; i++) manager.addLog(taskId, 'info', `m${i}`)
    const logs = manager.get(taskId)?.logs ?? []
    expect(logs).toHaveLength(1000)
    expect(logs[999]?.message).toBe('m4999')
  })
})
