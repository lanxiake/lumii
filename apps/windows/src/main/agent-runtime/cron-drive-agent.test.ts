/**
 * cron driveAgent 产出回读：模拟 prompt 先返回、落库延后的竞态。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { createTestSqliteAdapter } from '../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'

const { CronScheduler } = await import('./cron-scheduler')

/** 内存库 + 全量迁移 */
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

describe.skipIf(!hasFts5Db)('cron driveAgent 产出回读', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  it('Agent 落库延后时仍能从内存回读到真实日报，而不是任务指令', async () => {
    const convId = 'cron:seed-daily-report'
    const taskText = '整理我今天的工作进度，生成一份简短日报。'
    const agentReply = '今天完成\n- 修复定时任务回读\n\n进行中\n- 无\n\n明天优先\n- 验证早间简报'

    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets, system_prompt)
       VALUES ('seed-daily-report', '工作日报整理', ?, 'assistant', 'cron', '0 18 * * *', 0, NULL, 1, 0, 'system', '写日报')`,
    ).run(taskText)

    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务', ?)`,
    ).run(convId, new Date().toISOString())

    let destroyed = false
    const scheduler = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: vi.fn(),
      getLastActiveConvId: () => null,
      ensureConversationExists: () => true,
      notifyIncomingMessage: vi.fn(),
      createInstanceById: async () => 'inst-delay',
      waitForInstanceIdle: async () => undefined,
      getAssistantOutputFromInstance: () => (destroyed ? null : agentReply),
      prompt: async () => {
        // 模拟 bridge agent:end 异步落库：prompt 先返回，DB 稍后才写入
        setTimeout(() => {
          db.prepare(
            `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
             VALUES (?, ?, 'assistant', 'assistant', ?, ?)`,
          ).run(
            'msg-delay',
            convId,
            JSON.stringify({
              type: 'assistant_parts',
              parts: [{ type: 'text', id: 't1', text: agentReply, status: 'done' }],
            }),
            new Date().toISOString(),
          )
        }, 500)
      },
      destroy: () => {
        destroyed = true
      },
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
    } as never)

    await (
      scheduler as unknown as {
        runLocalCronJob: (
          job: { id: string; task_text: string; agent_id: string | null },
          options?: { manual?: boolean },
        ) => Promise<void>
      }
    ).runLocalCronJob({ id: 'seed-daily-report', task_text: taskText, agent_id: 'assistant' }, { manual: true })

    const run = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = ?`)
      .get('seed-daily-report')
    expect(run?.summary).toBe(agentReply)
    expect(run?.summary).not.toBe(taskText)
  })

  it('产出落库携带任务执行者归属（saveMessage.agentId 透传）', async () => {
    const convId = 'cron:test-chronicler'
    const taskText = '整理今天的工作'
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets, system_prompt)
       VALUES ('test-chronicler', '测试记事', ?, 'chronicler', 'cron', '0 18 * * *', 0, NULL, 1, 0, 'silent', '写日报')`,
    ).run(taskText)
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务', ?)`,
    ).run(convId, new Date().toISOString())

    const saveMessage = vi.fn()
    const scheduler = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: vi.fn(),
      getLastActiveConvId: () => null,
      ensureConversationExists: () => true,
      notifyIncomingMessage: vi.fn(),
      createInstanceById: async () => 'inst-a',
      waitForInstanceIdle: async () => undefined,
      getAssistantOutputFromInstance: () => '产出',
      prompt: async () => undefined,
      destroy: () => undefined,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
      saveMessage,
    } as never)

    await (
      scheduler as unknown as {
        runLocalCronJob: (
          job: { id: string; task_text: string; agent_id: string | null },
          options?: { manual?: boolean },
        ) => Promise<void>
      }
    ).runLocalCronJob({ id: 'test-chronicler', task_text: taskText, agent_id: 'chronicler' }, { manual: true })

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant', text: '产出', agentId: 'chronicler' }),
    )
  })
})
