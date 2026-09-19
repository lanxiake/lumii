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

/**
 * 飞行任务穿越关库边界（2026-09-20 退出实测第二轮）
 *
 * 上一轮修了「开始时库已关」与 `.finally` 回调；本轮补的是**飞行中**：
 * runLocalCronJob 已通过入口检查，长动作（心跳几十秒）跨过关库边界后继续
 * 走收尾记账 → 抛 "Database not initialized" → catch 块自身再写库再抛
 * → promise 变成 UnhandledPromiseRejection。
 */
describe('CronScheduler 飞行任务穿越关库边界', () => {
  /** 可通完整流程的桩：currentRow 查询返回一行有效任务记录 */
  function createRowAwareLocalDb() {
    let open = true
    const accessed = vi.fn()
    const prepare = vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(() => ({
        name: '测试任务',
        enabled: 1,
        active_days: null,
        active_hour_start: null,
        active_hour_end: null,
        system_prompt: null,
        notify_targets: null,
      })),
      all: vi.fn(() => []),
    }))
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

  const baseDeps = (extra: Record<string, unknown>) =>
    ({
      showCronNotification: vi.fn(),
      getLastActiveConvId: () => null,
      ensureConversationExists: () => true,
      notifyIncomingMessage: vi.fn(),
      createInstanceById: async () => 'inst-default',
      prompt: async () => undefined,
      destroy: () => undefined,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
      ...extra,
    }) as never

  it('飞行中关库：companion 收尾记账静默跳过，promise resolve 不 reject', async () => {
    const { localDb, accessed, close } = createRowAwareLocalDb()
    let accessedAtClose = -1
    const scheduler = new CronScheduler(
      localDb as never,
      baseDeps({
        handleCompanionInstruction: async () => {
          // 模拟：心跳跑到一半，进程进入退出清场（finalizeShutdown 关库）
          close()
          accessedAtClose = accessed.mock.calls.length
          return '心跳完成'
        },
      }),
    )

    await expect(
      (scheduler as unknown as PrivateScheduler).runLocalCronJob({
        id: 'job-1',
        task_text: '__evolution_tick__',
        agent_id: null,
      }),
    ).resolves.toBeUndefined()

    // 关库后不再触碰 DB（检查点在 companion 返回后先收手），也就没有二次抛错
    expect(accessedAtClose).toBeGreaterThan(0)
    expect(accessed.mock.calls.length).toBe(accessedAtClose)
  })

  it('stop() 后飞行任务在下一个检查点安静退出（库还开着也不写记账）', async () => {
    const { localDb, prepare } = createRowAwareLocalDb()
    let releaseCompanion: ((v: string) => void) | undefined
    const companionGate = new Promise<string>((resolve) => {
      releaseCompanion = resolve
    })
    const companionSpy = vi.fn(() => companionGate)
    const scheduler = new CronScheduler(
      localDb as never,
      baseDeps({ handleCompanionInstruction: companionSpy }),
    )

    const runPromise = (scheduler as unknown as PrivateScheduler).runLocalCronJob({
      id: 'job-1',
      task_text: '__evolution_tick__',
      agent_id: null,
    })
    await vi.waitFor(() => expect(companionSpy).toHaveBeenCalledTimes(1))

    // 退出清场按序进行：stop() 先关调度（早于 finalizeShutdown 关库）
    scheduler.stop()
    releaseCompanion!('心跳完成')

    await expect(runPromise).resolves.toBeUndefined()
    // 只到「标记 running」为止（currentRow 查询 + running 更新），收尾记账未发生
    expect(prepare).toHaveBeenCalledTimes(2)
  })
})
