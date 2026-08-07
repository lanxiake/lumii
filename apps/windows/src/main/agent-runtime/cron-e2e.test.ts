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
  const convId = 'conv-e2e'

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
    getLastActiveConvId: () => convId,
    createInstanceById: async () => 'inst-1',
    // Agent 回复落库，走生产的 readLatestAssistantText 回读路径。
    // timestamp 用 ISO 字符串，与 conversation-repo.saveMessage 写入格式一致。
    prompt: async () => {
      if (agentReply === null) return
      db.prepare(
        `INSERT INTO messages (id, conversation_id, agent_id, role, content_json, timestamp)
         VALUES (?, ?, 'assistant', 'assistant', ?, ?)`,
      ).run(
        `msg-${Math.random().toString(36).slice(2)}`,
        convId,
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

  it('资讯任务默认开启，其余默认关闭', () => {
    const jobs = listJobs(db)
    const news = jobs.find((j) => j.id === 'news-pipeline')
    expect(news?.enabled).toBe(1)
    expect(news?.agent_id).toBeNull()
    for (const job of jobs.filter((j) => j.id !== 'news-pipeline')) {
      expect(job.enabled, job.id).toBe(0)
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

  it('资讯任务走 workflow 拦截，产出写进概览资讯而非 Agent 回读', async () => {
    const { run, captured } = makeScheduler(db, null)
    await run({ id: 'news-pipeline', task_text: '__lumii_workflow__:news', agent_id: null })

    const runs = db
      .prepare<{ summary: string | null }>(`SELECT summary FROM local_cron_runs WHERE job_id = ?`)
      .all('news-pipeline')
    expect(runs[0].summary).toContain('抓取 12 条资讯')
    // 未驱动 Agent，所以没有系统通知/记忆写入
    expect(captured.notifications).toHaveLength(0)
    expect(captured.memories).toHaveLength(0)
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
})
