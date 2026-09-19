/**
 * 退出清场守卫回归：库已关闭（应用正在退出）后，cron 触发路径不得再碰 DB。
 *
 * 背景：2026-09-19 退出日志里 autonomous-tick 连环报错——
 * - `runLocalCronJob` 一进来就 `this.localDb.db.prepare(...)`，库已关则抛
 *   "Database not initialized. Call open() first."；
 * - 调度层那些 `void this.runLocalCronJob(job).finally(() => this.localDb.db…)` 的 finally
 *   里同样抛，而 `.finally()` 返回的新 promise 没人接 → UnhandledPromiseRejection。
 *
 * 两条路径都要在库关闭后静默收手。这里用桩模拟 LocalDatabase：close() 后 isOpen=false，
 * 且任何 db 访问都会抛与真实实现同款的错误（访问次数直接作为「是否碰过库」的判据）。
 */

import { describe, expect, it, vi } from 'vitest'

const { CronScheduler } = await import('./cron-scheduler')

/** 桩 LocalDatabase：记录 db 访问次数；关闭后 isOpen=false */
function createClosableLocalDb() {
  let open = true
  const prepare = vi.fn(() => ({ run: vi.fn() }))
  const accessed = vi.fn()
  const localDb = {
    get isOpen() {
      return open
    },
    get db() {
      accessed()
      if (!open) throw new Error('Database not initialized. Call open() first.')
      return { prepare } as never
    },
  }
  return { localDb, accessed, prepare, close: () => (open = false) }
}

function makeScheduler(localDb: unknown) {
  return new CronScheduler(localDb as never, {
    showCronNotification: vi.fn(),
    getLastActiveConvId: () => null,
    ensureConversationExists: () => true,
    notifyIncomingMessage: vi.fn(),
    createInstanceById: async () => 'inst-default',
    prompt: async () => undefined,
    destroy: () => undefined,
    getFileRepo: () => null,
    getCwd: () => 'C:/tmp',
  } as never)
}

type PrivateScheduler = {
  runLocalCronJob: (job: {
    id: string
    task_text: string
    agent_id: string | null
  }) => Promise<void>
  writeNextRunAt: (jobId: string, nextRunAt: number) => void
  finishOneShotJob: (jobId: string) => void
}

describe('CronScheduler 关库守卫', () => {
  it('库已关闭：runLocalCronJob 静默跳过，不触碰 DB、不抛错', async () => {
    const { localDb, accessed, close } = createClosableLocalDb()
    const scheduler = makeScheduler(localDb)
    close()

    await expect(
      (scheduler as unknown as PrivateScheduler).runLocalCronJob({
        id: 'job-1',
        task_text: '做点什么',
        agent_id: null,
      }),
    ).resolves.toBeUndefined()
    expect(accessed).not.toHaveBeenCalled()
  })

  it('库已关闭：writeNextRunAt / finishOneShotJob 不抛错（.finally 里没人接错误）', () => {
    const { localDb, accessed, close } = createClosableLocalDb()
    const scheduler = makeScheduler(localDb)
    close()

    expect(() => (scheduler as unknown as PrivateScheduler).writeNextRunAt('job-1', Date.now())).not.toThrow()
    expect(() => (scheduler as unknown as PrivateScheduler).finishOneShotJob('job-1')).not.toThrow()
    expect(accessed).not.toHaveBeenCalled()
  })

  it('库仍打开：writeNextRunAt 照常落库（守卫不过度拦截）', () => {
    const { localDb, accessed, prepare } = createClosableLocalDb()
    const scheduler = makeScheduler(localDb)

    ;(scheduler as unknown as PrivateScheduler).writeNextRunAt('job-1', 1_700_000_000_000)

    expect(accessed).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
