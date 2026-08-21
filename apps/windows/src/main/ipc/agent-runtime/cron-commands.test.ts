import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { handleCronRun, handleCronRuns } from './cron-commands'

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
