/**
 * `wake_mode` 的三条硬约束：
 *   1. `active` 且有活跃会话 → 注进去，**不建实例、不落 user 消息**；
 *   2. 投不进去（实例忙 / 没有实例）→ **回落到自己的会话**，任务不能丢；
 *   3. `own`（默认）行为与改造前一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'
import { cronConversationId } from './cron-job-meta'

const { CronScheduler } = await import('./cron-scheduler')

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

const JOB_ID = 'wake-job'

describe.skipIf(!hasFts5Db)('定时任务唤醒落点 wake_mode', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets, wake_mode)
       VALUES (?, '喝口水', '提醒我起来活动一下', 'assistant', 'every', '600000', 0, 600000, 1, 0, 'silent', 'active')`,
    ).run(JOB_ID)
  })

  function scheduler(overrides: Record<string, unknown> = {}) {
    const createInstanceById = vi.fn(async () => 'inst-cron')
    const deliverInternalMessage = vi.fn(async () => ({ delivered: true, output: '好，起来走两步' }))
    const saveMessage = vi.fn()
    const s = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: vi.fn(),
      getLastActiveConvId: () => 'conv-user',
      createInstanceById,
      deliverInternalMessage,
      // 产出直接从实例内存取，否则 collectAssistantOutput 会一直轮询等落库（测试里永远等不到）
      getAssistantOutputFromInstance: () => '好，起来走两步',
      prompt: async () => undefined,
      waitForInstanceIdle: async () => undefined,
      destroy: () => undefined,
      ensureConversationExists: () => true,
      setConversationAgent: () => undefined,
      notifyIncomingMessage: vi.fn(),
      saveMessage,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
      ...overrides,
    } as never)
    return { s, createInstanceById, deliverInternalMessage, saveMessage }
  }

  const run = (s: unknown) =>
    (
      s as {
        runLocalCronJob: (
          job: { id: string; task_text: string; agent_id: string | null },
          o?: { manual?: boolean },
        ) => Promise<void>
      }
    ).runLocalCronJob(
      { id: JOB_ID, task_text: '提醒我起来活动一下', agent_id: 'assistant' },
      { manual: true },
    )

  it('active + 有活跃会话 → 注入活跃会话，不建实例、不落 user 消息', async () => {
    const { s, createInstanceById, deliverInternalMessage, saveMessage } = scheduler()
    await run(s)

    expect(deliverInternalMessage).toHaveBeenCalledTimes(1)
    const [convId, text] = deliverInternalMessage.mock.calls[0] as unknown as [string, string]
    expect(convId).toBe('conv-user')
    // 消息头要说明「这不是用户刚说的话」，否则模型会当成用户指令
    expect(text).toContain('定时任务')
    expect(text).toContain('提醒我起来活动一下')

    expect(createInstanceById).not.toHaveBeenCalled()
    expect(saveMessage).not.toHaveBeenCalled()

    const runs = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = ?`)
      .all(JOB_ID)
    expect(runs[0]?.summary).toBe('好，起来走两步')
  })

  it('投不进活跃会话 → 回落到自己的会话（任务不丢）', async () => {
    // 覆盖后再从覆盖对象上取 spy：scheduler() 返回的是默认那个（没被调用）
    const deliverMissed = vi.fn(async () => ({ delivered: false, output: '' }))
    const { s, createInstanceById } = scheduler({ deliverInternalMessage: deliverMissed })
    await run(s)

    expect(deliverMissed).toHaveBeenCalledTimes(1)
    expect(createInstanceById).toHaveBeenCalledWith(
      'assistant',
      cronConversationId('喝口水', 'assistant'),
      cronConversationId('喝口水', 'assistant'),
    )
  })

  it('投递成功但没说话（只调工具 / NO_REPLY）→ 不回落、不再跑第二轮', async () => {
    const silent = vi.fn(async () => ({ delivered: true, output: '' }))
    const { s, createInstanceById } = scheduler({ deliverInternalMessage: silent })
    await run(s)

    expect(silent).toHaveBeenCalledTimes(1)
    // 关键：空产出**不能**被当成「没投进去」——否则同一条任务会跑两轮、出两份通知
    expect(createInstanceById).not.toHaveBeenCalled()
    const runs = db
      .prepare<{ status: string }>(`SELECT status FROM local_cron_runs WHERE job_id = ?`)
      .all(JOB_ID)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.status).toBe('ok')
  })

  it('活跃会话本身是 cron / evolution 会话时不注入（那些不是「用户在看」的会话）', async () => {
    const { s, createInstanceById, deliverInternalMessage } = scheduler({
      getLastActiveConvId: () => cronConversationId('别的事', 'assistant'),
    })
    await run(s)

    expect(deliverInternalMessage).not.toHaveBeenCalled()
    expect(createInstanceById).toHaveBeenCalled()
  })

  it('wake_mode=own 时完全不碰活跃会话', async () => {
    db.prepare(`UPDATE local_cron_jobs SET wake_mode = 'own' WHERE id = ?`).run(JOB_ID)
    const { s, createInstanceById, deliverInternalMessage } = scheduler()
    await run(s)

    expect(deliverInternalMessage).not.toHaveBeenCalled()
    expect(createInstanceById).toHaveBeenCalled()
  })

  it('有 origin 会话 → 回投发起它的那条会话（不是当前打开的）', async () => {
    // wake_mode 仍是 'own'，origin 优先——「谁派的回谁那」比「用户此刻开着谁」更稳
    db.prepare(`UPDATE local_cron_jobs SET origin_conversation_id = ? WHERE id = ?`).run(
      'conv-origin',
      JOB_ID,
    )
    const { s, deliverInternalMessage } = scheduler()
    await run(s)

    expect(deliverInternalMessage).toHaveBeenCalledTimes(1)
    expect((deliverInternalMessage.mock.calls[0] as unknown as [string])[0]).toBe('conv-origin')
  })

  it('origin 回投成功 → 不弹通知（汇报已在用户眼前）', async () => {
    db.prepare(`UPDATE local_cron_jobs SET origin_conversation_id = ? WHERE id = ?`).run(
      'conv-origin',
      JOB_ID,
    )
    const showCronNotification = vi.fn()
    const { s } = scheduler({ showCronNotification })
    await run(s)

    expect(showCronNotification).not.toHaveBeenCalled()
  })

  it('origin 会话投不进去 → 回落自己的会话（任务不丢）', async () => {
    db.prepare(`UPDATE local_cron_jobs SET origin_conversation_id = ? WHERE id = ?`).run(
      'conv-origin',
      JOB_ID,
    )
    const missed = vi.fn(async () => ({ delivered: false, output: '' }))
    const { s, createInstanceById } = scheduler({ deliverInternalMessage: missed })
    await run(s)

    expect(createInstanceById).toHaveBeenCalledWith(
      'assistant',
      cronConversationId('喝口水', 'assistant'),
      cronConversationId('喝口水', 'assistant'),
    )
  })

  it('abortRunningJob：没在跑时返回 false；跑动中能打到实例', async () => {
    const abortInstance = vi.fn()
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const { s } = scheduler({
      abortInstance,
      // prompt 挂住，让 runLocalCronJob 停在「实例已在跑」的窗口里
      prompt: () => gate,
    })
    db.prepare(`UPDATE local_cron_jobs SET wake_mode = 'own' WHERE id = ?`).run(JOB_ID)

    const running = run(s)
    // 等 driveAgent 建完实例、记进 localCronRunningInstances
    await new Promise((r) => setTimeout(r, 20))

    expect(s.abortRunningJob(JOB_ID)).toBe(true)
    expect(abortInstance).toHaveBeenCalledWith('inst-cron')

    release?.()
    await running
    // 跑完清掉映射：再中断就是 false
    expect(s.abortRunningJob(JOB_ID)).toBe(false)
  })
})
