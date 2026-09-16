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
    // 必须钉住本次用例的 db：下面的 setTimeout 是**故意**留到用例之后的
    // （用来模拟「prompt 先返回、落库 500ms 后才到」）。回调里若直接读 describe 作用域的
    // `db`，它会在运行时取到**下一个用例 beforeEach 刚建的空库**，
    // 往一个没有 conversations 行的库里插 messages → FOREIGN KEY constraint failed，
    // 且因为是定时器回调，表现为 unhandled error，整个 test run 以 exit 1 结束。
    const testDb = db
    const convId = 'cron:seed-daily-report'
    const taskText = '整理我今天的工作进度，生成一份简短日报。'
    const agentReply = '今天完成\n- 修复定时任务回读\n\n进行中\n- 无\n\n明天优先\n- 验证早间简报'

    testDb.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets, system_prompt)
       VALUES ('seed-daily-report', '工作日报整理', ?, 'assistant', 'cron', '0 18 * * *', 0, NULL, 1, 0, 'system', '写日报')`,
    ).run(taskText)

    testDb.prepare(
      `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务', ?)`,
    ).run(convId, new Date().toISOString())

    let destroyed = false
    const scheduler = new CronScheduler({ isOpen: true, db: testDb } as never, {
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
          testDb
            .prepare(
              `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
             VALUES (?, ?, 'assistant', 'assistant', ?, ?)`,
            )
            .run(
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

describe.skipIf(!hasFts5Db)('cron driveAgent 会话归属与落库顺序', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    db = createMigratedDb()
  })

  /** 插入一条 silent 定时任务与它的会话记录，返回会话 id */
  function seedJob(jobId: string, agentId: string, taskText: string): string {
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets, system_prompt)
       VALUES (?, '早间简报', ?, ?, 'cron', '30 8 * * 1', 0, NULL, 1, 0, 'silent', '写简报')`,
    ).run(jobId, taskText, agentId)
    const convId = `cron:${jobId}`
    db.prepare(
      `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务 · 早间简报', ?)`,
    ).run(convId, new Date().toISOString())
    return convId
  }

  function runWith(
    reply: string,
    saveMessage: ReturnType<typeof vi.fn>,
    setConversationAgent: ReturnType<typeof vi.fn>,
    opts: { onPrompt?: () => void } = {},
  ) {
    const scheduler = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: vi.fn(),
      getLastActiveConvId: () => null,
      ensureConversationExists: () => true,
      setConversationAgent,
      notifyIncomingMessage: vi.fn(),
      createInstanceById: async () => 'inst-persist',
      waitForInstanceIdle: async () => undefined,
      getAssistantOutputFromInstance: () => reply,
      prompt: async () => {
        opts.onPrompt?.()
      },
      destroy: () => undefined,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
      saveMessage,
    } as never)
    return (
      scheduler as unknown as {
        runLocalCronJob: (
          job: { id: string; task_text: string; agent_id: string | null },
          options?: { manual?: boolean },
        ) => Promise<void>
      }
    ).runLocalCronJob({ id: 'seed-morning-briefing', task_text: '汇总今天要关注的事项', agent_id: 'chronicler' }, { manual: true })
  }

  it('会话归属执行它的 Agent，侧栏才能把记录归到「记事」分组', async () => {
    const convId = seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const setConversationAgent = vi.fn()
    await runWith('早间简报正文', vi.fn(), setConversationAgent)
    expect(setConversationAgent).toHaveBeenCalledWith(convId, 'chronicler')
  })

  it('任务指令与兜底产出按时间递增落库，顺序稳定', async () => {
    seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const saveMessage = vi.fn()
    await runWith('早间简报正文', saveMessage, vi.fn())

    const saved = saveMessage.mock.calls.map((call) => call[0] as { role: string; timestamp?: string })
    const user = saved.find((m) => m.role === 'user')
    const assistant = saved.find((m) => m.role === 'assistant')
    expect(user?.timestamp).toBeTruthy()
    expect(assistant?.timestamp).toBeTruthy()
    expect(Date.parse(assistant!.timestamp!)).toBeGreaterThan(Date.parse(user!.timestamp!))
  })

  it('任务指令用任务开始时刻，不晚于流式回复的落库时刻（否则 UI 里回复排到指令上面）', async () => {
    seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const saveMessage = vi.fn()
    let streamedAt = 0
    await runWith('早间简报正文', saveMessage, vi.fn(), {
      // 模拟 bridge 的流式落库：回复以「收尾时刻」为 timestamp 写入会话
      onPrompt: () => {
        streamedAt = Date.now()
      },
    })

    const user = saveMessage.mock.calls
      .map((call) => call[0] as { role: string; timestamp?: string })
      .find((m) => m.role === 'user')
    expect(Date.parse(user!.timestamp!)).toBeLessThanOrEqual(streamedAt)
  })

  it('NO_REPLY 哨兵不落库为产出，会话里不会出现看不懂的 NO_REPLY 气泡', async () => {
    seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const saveMessage = vi.fn()
    await runWith('NO_REPLY', saveMessage, vi.fn())

    const roles = saveMessage.mock.calls.map((call) => (call[0] as { role: string }).role)
    expect(roles).toEqual(['user'])
  })

  it('流式回复已落库时不重复补写产出，同一回复不会在会话里出现两份', async () => {
    const convId = seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const saveMessage = vi.fn()
    await runWith('早间简报正文', saveMessage, vi.fn(), {
      // 模拟 bridge 的流式落库：prompt 期间已把完整回复写进会话
      onPrompt: () => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
           VALUES ('msg-streamed', ?, 'assistant', ?, ?, 0)`,
        ).run(
          convId,
          JSON.stringify({
            type: 'assistant_parts',
            parts: [{ type: 'text', id: 't1', text: '早间简报正文（含工具轨迹）', status: 'done' }],
          }),
          new Date().toISOString(),
        )
      },
    })

    const roles = saveMessage.mock.calls.map((call) => (call[0] as { role: string }).role)
    expect(roles).toEqual(['user'])
  })

  it('本轮只有工具轨迹（无正文）时也算已落库，不再补写一份纯文本产出', async () => {
    const convId = seedJob('seed-morning-briefing', 'chronicler', '汇总今天要关注的事项')
    const saveMessage = vi.fn()
    await runWith('本轮结论', saveMessage, vi.fn(), {
      onPrompt: () => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, role, content_json, timestamp, is_streaming)
           VALUES ('msg-tools', ?, 'assistant', ?, ?, 1)`,
        ).run(
          convId,
          JSON.stringify({
            type: 'assistant_parts',
            parts: [{ type: 'tool', id: 'tool-1', name: 'work_report_read', args: {}, status: 'completed' }],
          }),
          new Date().toISOString(),
        )
      },
    })

    const roles = saveMessage.mock.calls.map((call) => (call[0] as { role: string }).role)
    expect(roles).toEqual(['user'])
  })
})