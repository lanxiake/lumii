import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { handleCronRun, handleCronRuns, handleCronUpdate } from './cron-commands'

const job = {
  id: 'seed-focus-check',
  name: '专注提醒',
  task_text: '提醒我专注',
  agent_id: null,
}

describe('cron bridge contract', () => {
  it('runs a loaded job through the scheduler bridge', async () => {
    const runCronJobManually = vi.fn().mockResolvedValue(undefined)
    const bridge = {
      getLocalCronJobRecordById: vi.fn().mockReturnValue(job),
      runCronJobManually,
    } as unknown as AgentRuntimeBridge

    await expect(handleCronRun(bridge, job.id)).resolves.toEqual({ status: 'ok', id: job.id })
    expect(runCronJobManually).toHaveBeenCalledWith(job)
  })

  it('maps scheduler run rows to the IPC history contract', () => {
    const bridge = {
      listLocalCronRuns: vi.fn().mockReturnValue([{
        id: 'run-1',
        status: 'error',
        started_at: 10,
        finished_at: 25,
        duration_ms: 15,
        summary: 'task',
        error: 'failed',
      }]),
    } as unknown as AgentRuntimeBridge

    expect(handleCronRuns(bridge, job.id, 10)).toEqual({
      status: 'ok',
      entries: [{
        id: 'run-1',
        status: 'error',
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
        summary: 'task',
        error: 'failed',
      }],
    })
  })
})

/**
 * 管道任务（task_text 是 companion 魔法指令）的身份字段不该被任务页的编辑弹窗改掉：
 * 弹窗保存必然写非空 agentId（CreateJobModal 的 canSubmit 要求），一写就让 magic 拦截失效
 * （cron-scheduler 只在 `!job.agent_id` 时走 companion 通道），管道会变成拿魔法指令
 * 当普通文本跑的普通任务。**但启停走同一个 cron:update，必须放行**。
 */
describe('handleCronUpdate · 管道任务护栏', () => {
  const pipelineJob = {
    id: 'wechat-watch',
    name: '微信消息盯梢',
    task_text: '__wechat_watch__',
    agent_id: null,
    schedule_type: 'every',
    schedule_expr: '',
    next_run_at: 1,
    interval_ms: 15_000,
    enabled: 1,
    created_at: 1,
    active_days: null,
    active_hour_start: null,
    active_hour_end: null,
    notify_targets: null,
  }

  function makeBridge(row: Record<string, unknown>) {
    const updateLocalCronJobRecord = vi.fn()
    const bridge = {
      getLocalCronJobRecordById: vi.fn().mockReturnValue(row),
      updateLocalCronJobRecord,
    } as unknown as AgentRuntimeBridge
    return { bridge, updateLocalCronJobRecord }
  }

  it('改身份字段（agentId / taskText / 节奏）被拒，且不写库', () => {
    const { bridge, updateLocalCronJobRecord } = makeBridge(pipelineJob)
    for (const patch of [
      { agentId: 'assistant' },
      { taskText: '帮我盯着微信' },
      { scheduleType: 'every' as const, scheduleExpr: '60000' },
    ]) {
      const r = handleCronUpdate(bridge, pipelineJob.id, patch)
      expect(r.status, JSON.stringify(patch)).toBe('error')
      expect(r.message).toContain('管道任务')
    }
    expect(updateLocalCronJobRecord).not.toHaveBeenCalled()
  })

  it('启停（enabled）照常放行——任务页开关是受支持的操作', () => {
    const { bridge, updateLocalCronJobRecord } = makeBridge(pipelineJob)
    expect(handleCronUpdate(bridge, pipelineJob.id, { enabled: false })).toEqual({
      status: 'ok',
      id: pipelineJob.id,
    })
    expect(updateLocalCronJobRecord).toHaveBeenCalledTimes(1)
    expect(updateLocalCronJobRecord.mock.calls[0][0]).toMatchObject({
      id: pipelineJob.id,
      enabled: false,
      taskText: '__wechat_watch__',
      agentId: undefined,
    })
  })

  it('普通任务不受影响（照常可改）', () => {
    const { bridge, updateLocalCronJobRecord } = makeBridge({ ...pipelineJob, task_text: '提醒我喝水' })
    expect(handleCronUpdate(bridge, pipelineJob.id, { agentId: 'assistant' }).status).toBe('ok')
    expect(updateLocalCronJobRecord).toHaveBeenCalledTimes(1)
  })
})
