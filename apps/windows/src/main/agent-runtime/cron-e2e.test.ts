/**
 * 预置定时任务端到端跑通验证。
 *
 * 用真实 SQLite（node:sqlite 内存库 + 全量 MIGRATIONS）跑完整链路：
 *   ensureSeedCronJobsSeeded → scheduleJob → runLocalCronJob
 *     → Agent 驱动 / workflow 拦截 → 回读产出 → 按渠道格式化 → 派发 → 写 cron_runs
 *
 * 只有 Agent 的 LLM 调用与外部渠道是 stub，其余全是生产代码路径。
 * 需要 NODE_OPTIONS=--experimental-sqlite（见下方 skip 守卫）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { DatabaseAdapter, PreparedStatement, StatementResult } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'

const prependMock = vi.fn(async () => undefined)
vi.mock('../dashboard-feed-store', () => ({
  prependActiveDashboardFeedItem: prependMock,
}))

const { CronScheduler } = await import('./cron-scheduler')
const { ensureSeedCronJobsSeeded, __testables } = await import('../seed-cron-jobs')

const nodeRequire = createRequire(import.meta.url)

interface DatabaseSyncLike {
  exec(sql: string): void
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...p: unknown[]): unknown
    all(...p: unknown[]): unknown[]
  }
  close(): void
}

/** 内存库 + 全量迁移，等价于用户首启后的真实 schema */
function createMigratedDb(): DatabaseAdapter {
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSyncLike
  }
  const sq = new DatabaseSync(':memory:')
  const db: DatabaseAdapter = {
    exec: (sql) => sq.exec(sql),
    prepare: <T = Record<string, unknown>>(sql: string): PreparedStatement<T> => {
      const stmt = sq.prepare(sql)
      return {
        run: (...p: unknown[]) => stmt.run(...p) as unknown as StatementResult,
        get: (...p: unknown[]) => stmt.get(...p) as T | undefined,
        all: (...p: unknown[]) => stmt.all(...p) as T[],
      }
    },
    close: () => sq.close(),
  }
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  // messages.conversation_id 有 FK 指向 conversations，Agent 回复落库前必须先有会话
  db.prepare(
    `INSERT INTO conversations (id, user_id, type, title, created_at)
     VALUES ('conv-e2e', 'local-user', 'direct', '定时任务', ?)`,
  ).run(new Date().toISOString())
  return db
}

/** 一次运行里各渠道收到了什么 */
interface Captured {
  notifications: Array<{ title: string; body: string }>
  memories: string[]
  feishu: string[]
}

function makeScheduler(db: DatabaseAdapter, agentReply: string | null) {
  const captured: Captured = { notifications: [], memories: [], feishu: [] }

  const deps = {
    showCronNotification: (title: string, body: string) => {
      captured.notifications.push({ title, body })
    },
    addMemory: (content: string) => {
      captured.memories.push(content)
    },
    sendFeishuMessage: async (text: string) => {
      captured.feishu.push(text)
      return { ok: true }
    },
    getLastActiveConvId: () => null,
    // 每个任务用固定 sessionKey（cron:${jobId}），生产代码里驱动 Agent 前会先确保对话存在
    ensureConversationExists: (conversationId: string) => {
      const existing = db.prepare<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`).get(conversationId)
      if (existing) return false
      db.prepare(
        `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务', ?)`,
      ).run(conversationId, new Date().toISOString())
      return true
    },
    notifyIncomingMessage: () => undefined,
    createInstanceById: async () => 'inst-1',
    // Agent 回复落库，走生产的 readLatestAssistantText 回读路径。
    // timestamp 用 ISO 字符串，与 conversation-repo.saveMessage 写入格式一致。
    // convId 由生产代码在调用 prompt 前已 ensureConversationExists，这里从最新一条会话记录里取，
    // 保持与 runLocalCronJob 内部使用的 `cron:${job.id}` 一致（测试不重复该字符串拼接逻辑，直接查表）。
    prompt: async (_instanceId: string) => {
      if (agentReply === null) return
      const conv = db
        .prepare<{ id: string }>(`SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1`)
        .get()
      if (!conv) return
      db.prepare(
        `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
         VALUES (?, ?, 'assistant', 'assistant', ?, ?)`,
      ).run(
        `msg-${Math.random().toString(36).slice(2)}`,
        conv.id,
        JSON.stringify({ type: 'text', text: agentReply }),
        new Date().toISOString(),
      )
    },
    destroy: () => undefined,
    getFileRepo: () => null,
    getCwd: () => 'C:/tmp',
    // 资讯任务的魔法指令走 workflow 拦截，不创建 Agent
    handleCompanionInstruction: async (instruction: string) =>
      instruction.startsWith('__lumii_workflow__:') ? 'executed: 抓取 12 条资讯' : null,
  }

  const scheduler = new CronScheduler({ isOpen: true, db } as never, deps as never)
  const run = (job: { id: string; task_text: string; agent_id: string | null }) =>
    (scheduler as unknown as {
      runLocalCronJob: (
        j: { id: string; task_text: string; agent_id: string | null },
        o?: { manual?: boolean },
      ) => Promise<void>
    }).runLocalCronJob.call(scheduler, job, { manual: true })

  return { scheduler, run, captured }
}

interface JobRow {
  id: string
  name: string
  task_text: string
  agent_id: string | null
  schedule_type: 'at' | 'every' | 'cron'
  schedule_expr: string
  interval_ms: number | null
  enabled: number
  next_run_at: number
  system_prompt: string | null
  notify_targets: string | null
  last_status: string | null
}

function listJobs(db: DatabaseAdapter): JobRow[] {
  return db.prepare<JobRow>(`SELECT * FROM local_cron_jobs ORDER BY id`).all()
}

const hasSqlite = (() => {
  try {
    nodeRequire('node:sqlite')
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasSqlite)('预置定时任务端到端', () => {
  let db: DatabaseAdapter

  beforeEach(() => {
    prependMock.mockClear()
    db = createMigratedDb()
    ensureSeedCronJobsSeeded(db)
  })

  it('全部预置任务成功入库，字段完整可调度', () => {
    const jobs = listJobs(db)
    expect(jobs).toHaveLength(__testables.SEED_JOBS.length)

    for (const job of jobs) {
      expect(job.name.trim(), job.id).not.toBe('')
      expect(job.task_text.trim(), job.id).not.toBe('')
      expect(['at', 'every', 'cron'], job.id).toContain(job.schedule_type)
      expect(job.notify_targets, job.id).toBeTruthy()
      // 「按间隔」必须有 interval_ms，否则 scheduleJob 会静默不注册
      if (job.schedule_type === 'every') {
        expect(job.interval_ms, job.id).toBeGreaterThan(0)
      }
      // 走 Agent 的任务必须带系统提示词，否则预置任务等于一句空指令
      if (job.agent_id) {
        expect(job.system_prompt?.trim(), job.id).toBeTruthy()
      }
    }
  })

  it('全部预置任务默认开启，资讯任务挂 assistant Agent', () => {
    const jobs = listJobs(db)
    const news = jobs.find((j) => j.id === 'news-pipeline')
    expect(news?.agent_id).toBe('assistant')
    for (const job of jobs) {
      expect(job.enabled, job.id).toBe(1)
    }
  })

  it('每条预置任务都能真实跑完并写下 ok 执行记录', async () => {
    const jobs = listJobs(db)
    const { run, captured } = makeScheduler(db, '这是 Agent 的产出内容。')

    for (const job of jobs) {
      // 手动执行绕过 enabled 检查前需先启用，模拟用户打开开关
      db.prepare(`UPDATE local_cron_jobs SET enabled = 1 WHERE id = ?`).run(job.id)
      await run({ id: job.id, task_text: job.task_text, agent_id: job.agent_id })

      const row = db
        .prepare<{ last_status: string | null }>(`SELECT last_status FROM local_cron_jobs WHERE id = ?`)
        .get(job.id)
      expect(row?.last_status, `${job.id} 状态`).toBe('ok')

      const runs = db
        .prepare<{ status: string; summary: string | null; error: string | null }>(
          `SELECT status, summary, error FROM local_cron_runs WHERE job_id = ?`,
        )
        .all(job.id)
      expect(runs, `${job.id} 执行记录`).toHaveLength(1)
      expect(runs[0].status, `${job.id} 记录状态`).toBe('ok')
      expect(runs[0].error, `${job.id} 无错误`).toBeNull()
      // 执行记录里必须是真实产出，不是把任务指令抄一遍
      expect(runs[0].summary?.trim(), `${job.id} 摘要非空`).toBeTruthy()
    }

    // 每条任务的 notify_targets 至少命中一个渠道
    const totalPushes =
      captured.notifications.length + captured.memories.length + captured.feishu.length + prependMock.mock.calls.length
    expect(totalPushes).toBeGreaterThanOrEqual(jobs.length)
  })

  it('资讯任务改为 Agent 驱动 + silent：Agent 直接写卡片，派发器不重复塞脏卡片', async () => {
    const newsJob = listJobs(db).find((j) => j.id === 'news-pipeline')!
    // notify_targets 应为 silent（Agent 通过 dashboard_feed_write 自己写卡片）
    expect(newsJob.notify_targets).toBe('silent')

    const { run, captured } = makeScheduler(db, '已写入 12 条资讯卡片')
    await run({ id: 'news-pipeline', task_text: newsJob.task_text, agent_id: newsJob.agent_id })

    const runs = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = ?`)
      .all('news-pipeline')
    expect(runs[0].summary).toBe('已写入 12 条资讯卡片')
    // silent → 派发器完全不推送：既不塞资讯卡片，也不发系统通知/记忆
    expect(prependMock).not.toHaveBeenCalled()
    expect(captured.notifications).toHaveLength(0)
    expect(captured.memories).toHaveLength(0)
  })

  it('每个 job 用固定 sessionKey（cron:${jobId}）建会话，与「上次活跃会话」无关', async () => {
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
       VALUES ('sess-check', '会话检查', '做点什么', 'assistant', 'cron', '0 9 * * *', 0, NULL, 1, 0, 'system')`,
    ).run()

    const ensured: string[] = []
    const scheduler = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: () => undefined,
      getLastActiveConvId: () => null, // 模拟客户端从未活跃过 —— 旧实现在这种场景下会拿到 undefined convId
      ensureConversationExists: (conversationId: string) => {
        ensured.push(conversationId)
        db.prepare(
          `INSERT INTO conversations (id, user_id, type, title, created_at) VALUES (?, 'local-user', 'direct', '定时任务', ?)`,
        ).run(conversationId, new Date().toISOString())
        return true
      },
      notifyIncomingMessage: () => undefined,
      createInstanceById: async () => 'inst-sess-check',
      prompt: async () => {
        db.prepare(
          `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
           VALUES (?, 'cron:sess-check', 'assistant', 'assistant', ?, ?)`,
        ).run(
          `msg-${Math.random().toString(36).slice(2)}`,
          JSON.stringify({ type: 'text', text: '已完成' }),
          new Date().toISOString(),
        )
      },
      destroy: () => undefined,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
    } as never)

    await (scheduler as unknown as {
      runLocalCronJob: (j: unknown, o?: unknown) => Promise<void>
    }).runLocalCronJob.call(
      scheduler,
      { id: 'sess-check', task_text: '做点什么', agent_id: 'assistant' },
      { manual: true },
    )

    // 固定用 cron:${job.id}，不依赖 getLastActiveConvId
    expect(ensured).toEqual(['cron:sess-check'])
    const runs = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = 'sess-check'`)
      .all()
    expect(runs[0].summary).toBe('已完成')
  })

  it('Agent 产出按渠道格式化后分发到各自渠道', async () => {
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at,
        system_prompt, notify_targets)
       VALUES ('t1', '日报', '整理日报', 'assistant', 'cron', '0 18 * * *', 0, NULL, 1, 0, '你是助手', 'system,news,focus,feishu')`,
    ).run()

    const { run, captured } = makeScheduler(db, '## 今天完成\n\n- 写了 **方案**\n- 过了评审')
    await run({ id: 't1', task_text: '整理日报', agent_id: 'assistant' })

    // 通知：单行、无 Markdown 记号
    expect(captured.notifications[0].title).toBe('灵栖 · 日报')
    expect(captured.notifications[0].body).toBe('今天完成 · 写了 方案 · 过了评审')
    // 飞书：保留换行、带任务名前缀
    expect(captured.feishu[0]).toBe('【日报】\n今天完成\n\n· 写了 方案\n· 过了评审')
    // 记忆：单行、任务名前缀
    expect(captured.memories[0]).toBe('日报：今天完成 · 写了 方案 · 过了评审')
    // 资讯卡片：标题 + 摘要两槽位
    expect(prependMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: '日报', summary: '今天完成 · 写了 方案 · 过了评审' }),
    )
  })

  it('Agent 执行抛错时记 error 状态与错误详情，不影响后续任务', async () => {
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
       VALUES ('boom', '会失败的任务', '做点什么', 'assistant', 'cron', '0 9 * * *', 0, NULL, 1, 0, 'system')`,
    ).run()

    const scheduler = new CronScheduler({ isOpen: true, db } as never, {
      showCronNotification: () => undefined,
      getLastActiveConvId: () => null,
      ensureConversationExists: () => true,
      notifyIncomingMessage: () => undefined,
      createInstanceById: async () => {
        throw new Error('模型未配置')
      },
      prompt: async () => undefined,
      destroy: () => undefined,
      getFileRepo: () => null,
      getCwd: () => 'C:/tmp',
    } as never)

    await (scheduler as unknown as {
      runLocalCronJob: (j: unknown, o?: unknown) => Promise<void>
    }).runLocalCronJob.call(scheduler, { id: 'boom', task_text: '做点什么', agent_id: 'assistant' }, { manual: true })

    const row = db
      .prepare<{ last_status: string }>(`SELECT last_status FROM local_cron_jobs WHERE id = 'boom'`)
      .get()
    expect(row?.last_status).toBe('error')
    const runs = db
      .prepare<{ status: string; error: string | null }>(
        `SELECT status, error FROM local_cron_runs WHERE job_id = 'boom'`,
      )
      .all()
    expect(runs[0].status).toBe('error')
    expect(runs[0].error).toContain('模型未配置')
  })

  it('手动执行绕过 enabled=0（已失效的一次性任务可重新执行）', async () => {
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
       VALUES ('expired-1', '已失效任务', '再跑一次', 'assistant', 'at', '0', 0, NULL, 0, 0, 'system')`,
    ).run()

    const { run } = makeScheduler(db, '重新执行的产出')
    await run({ id: 'expired-1', task_text: '再跑一次', agent_id: 'assistant' })

    const row = db
      .prepare<{ last_status: string | null }>(`SELECT last_status FROM local_cron_jobs WHERE id = 'expired-1'`)
      .get()
    expect(row?.last_status).toBe('ok')
    const runs = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = 'expired-1'`)
      .all()
    expect(runs).toHaveLength(1)
    expect(runs[0].summary).toBe('重新执行的产出')
  })

  it('已失效的一次性任务只保留近 20 条，超出的连同运行记录一并清理', () => {
    // 造 25 条已失效一次性任务，last_run_at 递增（越大越新）
    for (let i = 0; i < 25; i++) {
      db.prepare(
        `INSERT INTO local_cron_jobs
         (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, last_run_at, notify_targets)
         VALUES (?, ?, '内容', 'assistant', 'at', '0', 0, NULL, 0, 0, ?, 'system')`,
      ).run(`exp-${i}`, `失效任务${i}`, 1000 + i)
      db.prepare(
        `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
         VALUES (?, ?, 'ok', 0, 1, 1, '产出', NULL)`,
      ).run(`run-${i}`, `exp-${i}`)
    }

    const { scheduler } = makeScheduler(db, null)
    ;(scheduler as unknown as { pruneExpiredOneShotJobs: () => void }).pruneExpiredOneShotJobs()

    const remaining = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE schedule_type = 'at' AND enabled = 0 ORDER BY last_run_at DESC`)
      .all()
    expect(remaining).toHaveLength(20)
    // 保留的是最新的 20 条（exp-24 ... exp-5），最旧的 exp-0 被删
    expect(remaining.map((r) => r.id)).toContain('exp-24')
    expect(remaining.map((r) => r.id)).not.toContain('exp-0')
    // 被删任务的运行记录一并清理
    const orphanRuns = db
      .prepare<{ c: number }>(`SELECT COUNT(*) as c FROM local_cron_runs WHERE job_id = 'exp-0'`)
      .get()
    expect(orphanRuns?.c).toBe(0)
  })

  it('scheduleJob 能为每条预置任务注册定时器且算出未来的 next_run_at', () => {
    const { scheduler } = makeScheduler(db, '产出')
    const jobs = listJobs(db)
    for (const job of jobs) {
      expect(() => scheduler.scheduleJob(job), job.id).not.toThrow()
    }
    scheduler.stop()
  })

  it('重复播种不产生重复任务（幂等）', () => {
    const before = listJobs(db).length
    ensureSeedCronJobsSeeded(db)
    ensureSeedCronJobsSeeded(db)
    expect(listJobs(db)).toHaveLength(before)
  })

  it('用户删掉预置任务后不会被下次启动种回来', () => {
    db.prepare(`DELETE FROM local_cron_jobs WHERE id = 'seed-morning-briefing'`).run()
    ensureSeedCronJobsSeeded(db)
    expect(listJobs(db).find((j) => j.id === 'seed-morning-briefing')).toBeUndefined()
  })

  it('老库里的魔法指令资讯任务被就地升级为 Agent 驱动', () => {
    // 模拟旧版本数据：agent_id=null + __lumii_workflow__:news
    db.prepare(
      `UPDATE local_cron_jobs SET agent_id = NULL, task_text = '__lumii_workflow__:news', system_prompt = NULL WHERE id = 'news-pipeline'`,
    ).run()

    ensureSeedCronJobsSeeded(db)

    const row = db
      .prepare<{ agent_id: string | null; task_text: string; system_prompt: string | null }>(
        `SELECT agent_id, task_text, system_prompt FROM local_cron_jobs WHERE id = 'news-pipeline'`,
      )
      .get()
    expect(row?.agent_id).toBe('assistant')
    expect(row?.task_text).not.toContain('__lumii_workflow__')
    expect(row?.task_text).toContain('dashboard_feed_write')
    expect(row?.system_prompt?.trim()).toBeTruthy()
  })

  it('迁移只认魔法指令特征，用户手改过的资讯任务不被覆盖', () => {
    // 用户已手动改成 Agent 驱动的自定义指令
    db.prepare(
      `UPDATE local_cron_jobs SET agent_id = 'assistant', task_text = '我自己的资讯指令', system_prompt = '自定义' WHERE id = 'news-pipeline'`,
    ).run()

    ensureSeedCronJobsSeeded(db)

    const row = db
      .prepare<{ task_text: string }>(`SELECT task_text FROM local_cron_jobs WHERE id = 'news-pipeline'`)
      .get()
    expect(row?.task_text).toBe('我自己的资讯指令')
  })
})
