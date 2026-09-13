/**
 * 初始化竞态回归：bridge 未完成初始化（instanceFactory 尚未创建）时，
 * CronScheduler.start() 不得注册任务——过期 every 任务会立即补跑并驱动 Agent，
 * 落空后抛 "Cannot read properties of undefined (reading 'createInstanceById')"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'

const { CronScheduler } = await import('./cron-scheduler')

type SchedulerInstance = InstanceType<typeof CronScheduler>
type PrivateScheduler = { runLocalCronJob: (...args: never[]) => Promise<void> }

function createMigratedDb(): DatabaseAdapter {
  const db = createTestSqliteAdapter()
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

const hasFts5Db = (() => {
  try {
    const db = createTestSqliteAdapter()
    db.close()
    return true
  } catch {
    return false
  }
})()

/** 插入一条已过期的 agent-self every 任务（会命中 scheduleJob 的立即补跑分支） */
function insertOverdueSelfJob(db: DatabaseAdapter): void {
  db.prepare(
    `INSERT INTO local_cron_jobs
     (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
     VALUES ('agent-self:overdue-1', '过期自建任务', '做点规划内的事', 'assistant', 'every', '', ?, 43200000, 1, 0, 'silent')`,
  ).run(Date.now() - 60_000)
}

function makeScheduler(
  db: DatabaseAdapter,
  isReady: () => boolean,
): { scheduler: SchedulerInstance; createRestrictedInstanceById: ReturnType<typeof vi.fn> } {
  const createRestrictedInstanceById = vi.fn(async () => 'inst-self-restricted')
  const scheduler = new CronScheduler({ isOpen: true, db } as never, {
    showCronNotification: vi.fn(),
    getLastActiveConvId: () => null,
    isReady,
    ensureConversationExists: () => true,
    notifyIncomingMessage: vi.fn(),
    createInstanceById: async () => 'inst-default',
    createRestrictedInstanceById,
    waitForInstanceIdle: async () => undefined,
    getAssistantOutputFromInstance: () => '产出',
    prompt: async () => undefined,
    destroy: () => undefined,
    getFileRepo: () => null,
    getCwd: () => 'C:/tmp',
  } as never)
  return { scheduler, createRestrictedInstanceById }
}

describe.skipIf(!hasFts5Db)('CronScheduler 启动就绪守卫', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
    insertOverdueSelfJob(db)
  })

  it('bridge 未就绪：start() 不注册任何任务，过期任务不补跑', async () => {
    const runSpy = vi.spyOn(CronScheduler.prototype as unknown as PrivateScheduler, 'runLocalCronJob')
    const { scheduler, createRestrictedInstanceById } = makeScheduler(db, () => false)

    scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(runSpy).not.toHaveBeenCalled()
    expect(createRestrictedInstanceById).not.toHaveBeenCalled()
    runSpy.mockRestore()
  })

  it('bridge 就绪：start() 补跑过期任务，且走受限实例（agent-self 白名单护栏）', async () => {
    const { scheduler, createRestrictedInstanceById } = makeScheduler(db, () => true)

    scheduler.start()
    await vi.waitFor(() => {
      const run = db
        .prepare<{ status: string }>(`SELECT status FROM local_cron_runs WHERE job_id = ?`)
        .get('agent-self:overdue-1')
      expect(run?.status).toBe('ok')
    })

    expect(createRestrictedInstanceById).toHaveBeenCalledTimes(1)
    scheduler.stop()
  })
})
