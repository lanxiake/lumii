/**
 * CronScheduler — 本地定时任务调度管理
 *
 * 职责：
 * - 启动时从 SQLite 恢复任务定时器
 * - 调度 at/every 类型任务（cron 类型依赖 Gateway）
 * - 执行任务：驱动 Agent 或发送系统通知
 * - 文件清理定时器（30 天软删除硬清理）
 * - CRUD：提供 DB 记录的增删改查接口
 *
 * 从 bridge.ts 提取，通过构造注入依赖，外部 API（CRUD 方法）签名不变
 */

import path from 'node:path'
import fs from 'node:fs'
import { Cron } from 'croner'
import type { LocalDatabase, FileRepo } from '@mtbot/agent-runtime'

const log = {
  info: (...args: unknown[]) => console.log('[CronScheduler]', ...args),
  warn: (...args: unknown[]) => console.warn('[CronScheduler]', ...args),
  error: (...args: unknown[]) => console.error('[CronScheduler]', ...args),
}

/** 本地 Cron 任务记录（与 SQLite 表字段对应） */
export type LocalCronJobRow = {
  id: string
  name: string
  task_text: string
  agent_id: string | null
  schedule_type: 'at' | 'every' | 'cron'
  schedule_expr: string
  next_run_at: number
  interval_ms: number | null
  enabled: number
  created_at: number
  last_run_at: number | null
  last_status: 'ok' | 'error' | 'running' | null
}

export interface CronSchedulerDeps {
  /** 是否显示系统通知 */
  showCronNotification?: (title: string, body: string) => void
  /** 获取当前活跃会话 ID（Cron Agent 实例挂载用） */
  getLastActiveConvId: () => string | null
  /** 按 Agent ID 创建 Agent 实例 */
  createInstanceById: (agentId: string, sessionKey?: string, conversationId?: string) => Promise<string>
  /** 向指定 Agent 实例发送消息 */
  prompt: (instanceId: string, message: string) => Promise<void>
  /** 销毁 Agent 实例 */
  destroy: (instanceId: string) => void
  /** 获取文件仓储（用于文件清理任务） */
  getFileRepo: () => FileRepo | null
  /** 获取 workspace 根目录（用于文件清理任务） */
  getCwd: () => string
  /**
   * Companion 魔法指令处理器（__companion_tick__ 等）
   * 返回执行结果描述供 cron_runs 记录；返回 null 表示不拦截（走正常 Agent 流程）
   */
  handleCompanionInstruction?: (instruction: string) => Promise<string | null>
}

export class CronScheduler {
  private readonly localCronTimers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>()
  private readonly localCronRunningJobs = new Set<string>()
  private readonly cronInstances = new Map<string, Cron>()

  constructor(
    private readonly localDb: LocalDatabase,
    private readonly deps: CronSchedulerDeps,
  ) {}

  /**
   * 启动所有调度器（在 bridge.initialize() 末尾调用）
   */
  start(): void {
    this.startLocalCronScheduler()
    this.startFileCleanupScheduler()
  }

  /**
   * 停止所有定时器（在 bridge.destroyAll() 中调用）
   */
  stop(): void {
    for (const timer of this.localCronTimers.values()) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.localCronTimers.clear()
    this.localCronRunningJobs.clear()
    for (const instance of this.cronInstances.values()) {
      instance.stop()
    }
    this.cronInstances.clear()
  }

  /**
   * 重新加载本地 Cron 调度（用于 IPC 增删改任务后即时生效）。
   */
  reloadLocalCronScheduler(): void {
    for (const timer of this.localCronTimers.values()) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.localCronTimers.clear()
    this.localCronRunningJobs.clear()
    for (const instance of this.cronInstances.values()) {
      instance.stop()
    }
    this.cronInstances.clear()
    this.startLocalCronScheduler()
  }

  /**
   * 插入一条本地 Cron 任务记录。
   */
  createLocalCronJobRecord(params: {
    id: string
    name: string
    taskText: string
    agentId?: string
    scheduleType: 'at' | 'every' | 'cron'
    scheduleExpr: string
    nextRunAt: number
    intervalMs?: number
    enabled?: boolean
    createdAt: number
  }): void {
    this.localDb.db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.id,
      params.name,
      params.taskText,
      params.agentId?.trim() || null,
      params.scheduleType,
      params.scheduleExpr,
      params.nextRunAt,
      params.intervalMs ?? null,
      params.enabled === false ? 0 : 1,
      params.createdAt,
    )
  }

  /**
   * 查询本地 Cron 任务列表。
   */
  listLocalCronJobRecords(includeDisabled: boolean): Array<LocalCronJobRow> {
    return this.localDb.db.prepare<LocalCronJobRow>(
      `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, last_run_at, last_status
       FROM local_cron_jobs
       ${includeDisabled ? '' : 'WHERE enabled = 1'}
       ORDER BY created_at DESC`
    ).all()
  }

  /**
   * 按 ID 查询单条本地 Cron 任务。
   */
  getLocalCronJobRecordById(id: string): LocalCronJobRow | undefined {
    return this.localDb.db.prepare<LocalCronJobRow>(
      `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, last_run_at, last_status
       FROM local_cron_jobs
       WHERE id = ?`
    ).get(id)
  }

  /**
   * 删除本地 Cron 任务，返回受影响行数。
   */
  deleteLocalCronJobRecord(id: string): number {
    const result = this.localDb.db.prepare(`DELETE FROM local_cron_jobs WHERE id = ?`).run(id)
    return result.changes
  }

  /**
   * 更新本地 Cron 任务基础字段。
   */
  updateLocalCronJobRecord(params: { id: string; name: string; taskText: string; enabled: boolean }): number {
    const result = this.localDb.db.prepare(
      `UPDATE local_cron_jobs
       SET name = ?, task_text = ?, enabled = ?
       WHERE id = ?`
    ).run(params.name, params.taskText, params.enabled ? 1 : 0, params.id)
    return result.changes
  }

  /**
   * 查询本地 Cron 运行历史。
   */
  listLocalCronRuns(jobId: string, limit: number): Array<{
    id: string
    status: 'ok' | 'error'
    started_at: number
    finished_at: number
    duration_ms: number
    summary: string | null
    error: string | null
  }> {
    return this.localDb.db.prepare<{
      id: string
      status: 'ok' | 'error'
      started_at: number
      finished_at: number
      duration_ms: number
      summary: string | null
      error: string | null
    }>(
      `SELECT id, status, started_at, finished_at, duration_ms, summary, error
       FROM local_cron_runs
       WHERE job_id = ?
       ORDER BY started_at DESC
       LIMIT ?`
    ).all(jobId, Math.max(1, Math.min(limit, 200)))
  }

  /**
   * 公开接口：手动立即执行一次 Cron 任务（与自动触发走同一路径）。
   */
  async runCronJobManually(job: { id: string; task_text: string; agent_id: string | null }): Promise<void> {
    return this.runLocalCronJob(job)
  }

  /**
   * 按任务配置注册本地计时器。
   * 供 registerLocalCronTools 工具实现调用（接收 scheduleLocalCronJob 回调）。
   */
  scheduleJob(job: {
    id: string
    task_text: string
    agent_id: string | null
    schedule_type: 'at' | 'every' | 'cron'
    next_run_at: number
    interval_ms: number | null
    schedule_expr?: string
  }): void {
    this.clearLocalCronTimer(job.id)
    if (job.schedule_type === 'at') {
      const delay = Math.max(0, job.next_run_at - Date.now())
      const handle = setTimeout(() => {
        void this.runLocalCronJob(job).finally(() => {
          this.clearLocalCronTimer(job.id)
          // one-shot 任务执行后仅禁用，保留记录与历史
          this.localDb.db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`).run(job.id)
        })
      }, delay)
      this.localCronTimers.set(job.id, handle)
      return
    }
    const intervalMs = job.interval_ms
    if (job.schedule_type === 'every' && intervalMs && intervalMs > 0) {
      const wait = Math.max(0, job.next_run_at - Date.now())
      if (wait > 0) {
        const firstHandle = setTimeout(() => {
          void this.runLocalCronJob(job).finally(() => {
            this.localDb.db
              .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
              .run(Date.now() + intervalMs, job.id)
          })
          const intervalHandle = setInterval(() => {
            void this.runLocalCronJob(job).finally(() => {
              this.localDb.db
                .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
                .run(Date.now() + intervalMs, job.id)
            })
          }, intervalMs)
          this.localCronTimers.set(job.id, intervalHandle)
        }, wait)
        this.localCronTimers.set(job.id, firstHandle)
      } else {
        const intervalHandle = setInterval(() => {
          void this.runLocalCronJob(job).finally(() => {
            this.localDb.db
              .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
              .run(Date.now() + intervalMs, job.id)
          })
        }, intervalMs)
        this.localCronTimers.set(job.id, intervalHandle)
      }
      return
    }
    // cron 类型：使用 croner 解析标准 cron 表达式并定时调度
    if (job.schedule_type === 'cron' && job.schedule_expr) {
      try {
        const cronInstance = new Cron(job.schedule_expr, { timezone: 'Asia/Shanghai' }, () => {
          void this.runLocalCronJob(job).finally(() => {
            const next = cronInstance.nextRun()
            if (next) {
              this.localDb.db
                .prepare(`UPDATE local_cron_jobs SET next_run_at = ? WHERE id = ?`)
                .run(next.getTime(), job.id)
            }
          })
        })
        this.cronInstances.set(job.id, cronInstance)
        log.info(`[scheduleJob] cron 任务已注册 jobId=${job.id} expr="${job.schedule_expr}"`)
      } catch (err) {
        log.error(`[scheduleJob] cron 表达式解析失败 jobId=${job.id} expr="${job.schedule_expr}":`, err)
      }
    }
  }

  /**
   * 清理单个本地定时任务计时器。
   */
  clearLocalCronTimer(jobId: string): void {
    const handle = this.localCronTimers.get(jobId)
    if (!handle) return
    clearTimeout(handle)
    clearInterval(handle)
    this.localCronTimers.delete(jobId)
  }

  // ─── 私有方法 ───────────────────────────────────────────────

  /**
   * 启动时从 SQLite 恢复本地定时任务并重新调度。
   */
  private startLocalCronScheduler(): void {
    if (!this.localDb.isOpen) return
    type JobRow = {
      id: string
      name: string
      task_text: string
      agent_id: string | null
      schedule_type: 'at' | 'every' | 'cron'
      schedule_expr: string
      next_run_at: number
      interval_ms: number | null
      enabled: number
      created_at: number
    }
    try {
      const jobs = this.localDb.db.prepare<JobRow>(
        `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at
         FROM local_cron_jobs
         WHERE enabled = 1`
      ).all()
      for (const job of jobs) {
        this.scheduleJob(job)
      }
      log.info(`[startLocalCronScheduler] 已恢复 ${jobs.length} 个本地定时任务`)
    } catch (err) {
      log.error('[startLocalCronScheduler] 恢复本地定时任务失败:', err)
    }
  }

  /**
   * 定期硬删除 30 天前软删除的文件（物理文件 + DB 记录）。
   * 每 24 小时执行一次，启动时延迟 60 秒首次执行。
   */
  private startFileCleanupScheduler(): void {
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
    const run = async (): Promise<void> => {
      const fileRepo = this.deps.getFileRepo()
      if (!fileRepo) return
      try {
        const threshold = new Date(Date.now() - THIRTY_DAYS_MS)
        const rows = fileRepo.listSoftDeletedBefore(threshold)
        if (rows.length === 0) return
        const cwd = this.deps.getCwd()
        let removed = 0
        for (const row of rows) {
          const absPath = path.resolve(cwd, row.localPath)
          try {
            await fs.promises.unlink(absPath)
          } catch (err) {
            // ENOENT — 文件已不存在，静默忽略
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              log.warn(`[fileCleanup] unlink failed for ${absPath}:`, err)
            }
          }
          fileRepo.hardDelete(row.id)
          removed++
        }
        if (removed > 0) {
          log.info(`[fileCleanup] 硬删除 ${removed} 个过期文件`)
        }
      } catch (err) {
        log.error('[fileCleanup] 清理任务出错:', err)
      }
    }

    // 启动后延迟 60 秒首次执行（避免与初始化竞争）
    setTimeout(() => {
      void run()
      setInterval(() => { void run() }, 24 * 60 * 60 * 1000)
    }, 60 * 1000)
  }

  /**
   * 执行本地定时任务：推送系统通知，并按需驱动指定 Agent 完成任务。
   */
  private async runLocalCronJob(job: { id: string; task_text: string; agent_id: string | null }): Promise<void> {
    if (this.localCronRunningJobs.has(job.id)) {
      log.info(`[runLocalCronJob] jobId=${job.id} 已在运行中，跳过`)
      return
    }

    // 执行前从 DB 重新校验任务是否仍存在且 enabled=1（防止任务已删除/禁用但 timer 尚未清理时触发）
    const currentRow = this.localDb.db.prepare<{ enabled: number }>(
      `SELECT enabled FROM local_cron_jobs WHERE id = ?`
    ).get(job.id)
    if (!currentRow) {
      log.warn(`[runLocalCronJob] 任务 jobId=${job.id} 已从 DB 删除，跳过执行`)
      this.clearLocalCronTimer(job.id)
      return
    }
    if (currentRow.enabled === 0) {
      log.warn(`[runLocalCronJob] 任务 jobId=${job.id} 已禁用，跳过执行`)
      this.clearLocalCronTimer(job.id)
      return
    }

    this.localCronRunningJobs.add(job.id)
    const startedAt = Date.now()
    const runId = `local-run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`
    log.info(`[runLocalCronJob] 开始执行 jobId=${job.id} taskText="${job.task_text.slice(0, 60)}" agentId=${job.agent_id ?? 'none'}`)

    // 执行前标记 running 状态
    this.localDb.db.prepare(
      `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'running' WHERE id = ?`
    ).run(startedAt, job.id)

    try {
      // Companion 魔法指令拦截：优先走本地 companion handler，不创建 Agent 实例
      const companionHandler = this.deps.handleCompanionInstruction
      if (companionHandler && !job.agent_id) {
        const companionResult = await companionHandler(job.task_text)
        if (companionResult !== null) {
          log.info(`[runLocalCronJob] companion 指令处理完成 jobId=${job.id} result="${companionResult}"`)
          const finishedAt = Date.now()
          this.localDb.db.prepare(
            `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'ok' WHERE id = ?`
          ).run(finishedAt, job.id)
          this.localDb.db.prepare(
            `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
             VALUES (?, ?, 'ok', ?, ?, ?, ?, NULL)`
          ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, companionResult)
          return
        }
      }

      if (job.agent_id) {
        // 有指定 Agent：驱动 Agent 执行任务，通知在 Agent 完成后发出
        log.info(`[runLocalCronJob] 驱动 Agent agentId=${job.agent_id} 执行任务`)
        const convId = this.deps.getLastActiveConvId() ?? undefined
        const instanceId = await this.deps.createInstanceById(job.agent_id, convId, convId)
        try {
          await this.deps.prompt(instanceId, job.task_text)
        } finally {
          this.deps.destroy(instanceId)
        }
        // Agent 完成后发系统通知（告知用户任务已执行）
        this.deps.showCronNotification?.('灵栖 定时任务已完成', job.task_text)
      } else {
        // 纯提醒任务（无 Agent）：直接发系统通知
        this.deps.showCronNotification?.('灵栖 定时提醒', job.task_text)
      }

      const finishedAt = Date.now()
      // 更新任务状态为 ok + last_run_at
      this.localDb.db.prepare(
        `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'ok' WHERE id = ?`
      ).run(finishedAt, job.id)
      this.localDb.db.prepare(
        `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
         VALUES (?, ?, 'ok', ?, ?, ?, ?, NULL)`
      ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, job.task_text)
      log.info(`[runLocalCronJob] 执行完成 jobId=${job.id} durationMs=${finishedAt - startedAt}`)
    } catch (err) {
      log.error(`[runLocalCronJob] 执行失败 jobId=${job.id}:`, err)
      const finishedAt = Date.now()
      const message = err instanceof Error ? err.message : String(err)
      // 更新任务状态为 error
      this.localDb.db.prepare(
        `UPDATE local_cron_jobs SET last_run_at = ?, last_status = 'error' WHERE id = ?`
      ).run(finishedAt, job.id)
      this.localDb.db.prepare(
        `INSERT INTO local_cron_runs (id, job_id, status, started_at, finished_at, duration_ms, summary, error)
         VALUES (?, ?, 'error', ?, ?, ?, ?, ?)`
      ).run(runId, job.id, startedAt, finishedAt, finishedAt - startedAt, job.task_text, message)
    } finally {
      this.localCronRunningJobs.delete(job.id)
    }
  }
}
