/**
 * 本地定时任务工具（cron_create / cron_list / cron_delete）与资讯卡片写入工具（dashboard_feed_write）。
 *
 * 从 bridge-tool-registrar.ts 抽离，纯函数式注册，仅依赖注入的 deps。
 */

import {
  createMtBotTool,
  type MtBotToolConfig,
  cronCreateToolConfig,
  cronListToolConfig,
  cronDeleteToolConfig,
  dashboardFeedWriteToolConfig,
  dashboardFeedReadToolConfig,
  workReportReadToolConfig,
} from '@mtbot/agent-runtime'
import {
  agentRuntimeLog as log,
  jsonToolResult,
  parseAtScheduleExpr,
  parseStrictMs,
} from './bridge-utils'
import {
  writeDashboardFeedSnapshot,
  readDashboardFeedPage,
  countDashboardFeedItems,
  DEFAULT_DASHBOARD_FEED_ID,
  uniqueDashboardFeedItemId,
} from '../dashboard-feed-store'
import { classifyCronJobSource } from './cron-job-meta'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

/**
 * 从 sessionKey 前缀解析出创建定时任务时所在的渠道，用作 notify_targets 默认值。
 * 微信/企微是被动回复模式，没有主动推送渠道，回落系统通知；只有飞书有主动推送能力。
 */
export function resolveChannelFromSessionKey(sessionKey: string | undefined): string {
  if (sessionKey?.startsWith('feishu:')) return 'feishu'
  return 'system'
}

/**
 * 注册本地定时任务工具（cron_create / cron_list / cron_delete），完全不依赖 Gateway。
 */
export function registerLocalCronTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const cronCreate: MtBotToolConfig = {
    ...cronCreateToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        name: string
        taskText: string
        scheduleType: 'at' | 'every' | 'cron'
        scheduleExpr: string
        agentId?: string
        notifyTargets?: string
      }
      const scheduleExpr = p.scheduleExpr?.trim() ?? ''
      if (!p.name?.trim()) {
        return jsonToolResult({ status: 'error', message: 'name is required' })
      }
      if (!p.taskText?.trim()) {
        return jsonToolResult({ status: 'error', message: 'taskText is required' })
      }
      if (!scheduleExpr) {
        return jsonToolResult({ status: 'error', message: 'scheduleExpr is required' })
      }
      if (!deps.localDb.isOpen) {
        return jsonToolResult({ status: 'error', message: 'database not initialized' })
      }

      const now = Date.now()
      let nextRunAt = now
      let intervalMs: number | null = null

      if (p.scheduleType === 'every') {
        const everyMs = parseStrictMs(scheduleExpr)
        if (everyMs === undefined || everyMs <= 0) {
          return jsonToolResult({
            status: 'error',
            message: 'Invalid scheduleExpr for every. Use integer milliseconds string, e.g. "60000".',
          })
        }
        intervalMs = everyMs
        nextRunAt = now + everyMs
      } else if (p.scheduleType === 'at') {
        const atMs = parseAtScheduleExpr(scheduleExpr)
        if (atMs === undefined) {
          return jsonToolResult({
            status: 'error',
            message: 'Invalid scheduleExpr for at. Use unix timestamp ms or `${Date.now() + ...}`.',
          })
        }
        nextRunAt = atMs
      } else {
        // 客户端调度器本身支持 cron 表达式，但 Agent 工具暂只开放 at/every：
        // 让模型自己写标准 cron 表达式容易出错，需要周期任务时用 every + intervalMs。
        return jsonToolResult({
          status: 'error',
          message: 'cron_create supports "at" and "every" only. Use "every" with intervalMs for recurring tasks.',
        })
      }

      // 未显式指定推送渠道时，默认使用当前对话所在渠道（sessionKey 前缀解析）—
      // 微信/企微是被动回复模式没有主动推送能力，回落系统通知
      const currentInstanceId = deps.getCurrentToolExecutorInstanceId()
      const sessionKey = currentInstanceId
        ? deps.instanceToConversation.get(currentInstanceId)
        : undefined
      const notifyTargets = p.notifyTargets?.trim() || resolveChannelFromSessionKey(sessionKey)

      // 未指定执行 Agent 时回落到当前 Agent：任务文本本就是写给 Agent 的指令，
      // agent_id 为空会让调度器把指令原文当通知正文推送，任务实际从未执行
      const fallbackAgentId = currentInstanceId
        ? deps.getDefinitionIdByInstanceId(currentInstanceId)
        : undefined
      const agentId = p.agentId?.trim() || fallbackAgentId || null

      const jobId = `local-cron-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const row = {
        id: jobId,
        name: p.name.trim(),
        task_text: p.taskText,
        agent_id: agentId,
        schedule_type: p.scheduleType,
        schedule_expr: scheduleExpr,
        next_run_at: nextRunAt,
        interval_ms: intervalMs,
        enabled: 1,
        created_at: now,
        notify_targets: notifyTargets,
      } as const

      deps.localDb.db.prepare(
        `INSERT INTO local_cron_jobs
         (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at, notify_targets)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        row.id,
        row.name,
        row.task_text,
        row.agent_id,
        row.schedule_type,
        row.schedule_expr,
        row.next_run_at,
        row.interval_ms,
        row.enabled,
        row.created_at,
        row.notify_targets,
      )

      deps.getCronScheduler().scheduleJob(row)
      return jsonToolResult({
        status: 'ok',
        job: {
          id: row.id,
          name: row.name,
          scheduleType: row.schedule_type,
          scheduleExpr: row.schedule_expr,
          nextRunAt: row.next_run_at,
          intervalMs: row.interval_ms ?? undefined,
          enabled: true,
        },
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(cronCreate, ctx))

  const cronList: MtBotToolConfig = {
    ...cronListToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { includeDisabled?: boolean }
      const includeDisabled = p.includeDisabled ?? true
      if (!deps.localDb.isOpen) {
        return jsonToolResult({ status: 'error', message: 'database not initialized' })
      }
      const rows = deps.localDb.db.prepare<{
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
      }>(
        `SELECT id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at
         FROM local_cron_jobs
         ${includeDisabled ? '' : 'WHERE enabled = 1'}
         ORDER BY created_at DESC`
      ).all()

      return jsonToolResult({
        status: 'ok',
        jobs: rows.map((job) => ({
          id: job.id,
          name: job.name,
          taskText: job.task_text,
          agentId: job.agent_id ?? undefined,
          scheduleType: job.schedule_type,
          scheduleExpr: job.schedule_expr,
          nextRunAt: job.next_run_at,
          intervalMs: job.interval_ms ?? undefined,
          enabled: job.enabled === 1,
          createdAt: job.created_at,
        })),
        total: rows.length,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(cronList, ctx))

  const cronDelete: MtBotToolConfig = {
    ...cronDeleteToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { id: string }
      const id = p.id?.trim()
      if (!id) {
        return jsonToolResult({ status: 'error', message: 'id is required' })
      }
      // 来源守卫（硬防线）：Agent 只能撤掉**自己这一类**任务——规划器落地的
      // `agent-self:*` 与 cron_create 自建的 `local-cron-*`，不能删用户手工创建
      // （UUID id）、系统预置（seed-* / news-pipeline）或其他 Agent 的任务。
      //
      // 判定复用 cron-job-meta 的唯一起源分类，不要在这里另写前缀表：
      // 原先只放行 `agent-self:*`，于是 Agent 建得出任务却删不掉自己刚建的
      // （cron_create 生成的是 `local-cron-*`），手册却写着可以——两边长期不一致。
      if (classifyCronJobSource(id) !== 'agent') {
        return jsonToolResult({
          status: 'error',
          message: '只能删除自己创建的任务（agent-self:* / local-cron-*）',
        })
      }
      deps.getCronScheduler().clearLocalCronTimer(id)
      const result = deps.localDb.db
        .prepare(`DELETE FROM local_cron_jobs WHERE id = ?`)
        .run(id)
      return jsonToolResult({
        status: result.changes > 0 ? 'ok' : 'not_found',
        id,
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(cronDelete, ctx))
  log.info('[registerToolOverrides] local cron tools registered: cron_create/cron_list/cron_delete')
}

/**
 * 注册 dashboard_feed_write：Agent 抓取资讯后落盘结构化结果到概览页资讯卡片。
 * feedId 固定用 DEFAULT_DASHBOARD_FEED_ID（'news'）—— 当前仅有这一个 feed 在用。
 */
export function registerDashboardFeedTool(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const dashboardFeedWrite: MtBotToolConfig = {
    ...dashboardFeedWriteToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        title: string
        summary?: string
        items: Array<{ title: string; summary?: string; href?: string; source?: string }>
      }
      if (!p.title?.trim()) {
        return jsonToolResult({ status: 'error', message: 'title is required' })
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return jsonToolResult({ status: 'error', message: 'items must be a non-empty array' })
      }
      try {
        // 本次写入 = 一期：综述记在本期上（不再覆盖上一期），并记录出自哪个会话。
        // 两个取值都容错——工具注册的 deps 未必带这些反查能力（测试替身、精简装配），
        // 缺了就退化成「来源未知的一期」，不能让一次资讯写入整个失败。
        const executorId = deps.getCurrentToolExecutorInstanceId?.()
        const convId = executorId ? deps.instanceToConversation?.get(executorId) : undefined
        await writeDashboardFeedSnapshot({
          feedId: DEFAULT_DASHBOARD_FEED_ID,
          title: p.title.trim(),
          updatedAt: Date.now(),
          ...(p.summary?.trim() ? { summary: p.summary.trim() } : {}),
          batch: { source: 'agent', ...(convId ? { conversationId: convId } : {}) },
          items: (() => {
            const seenIds = new Map<string, number>()
            return p.items.map((item, index) => ({
              id: uniqueDashboardFeedItemId(
                { href: item.href?.trim(), title: item.title },
                index,
                seenIds,
              ),
              title: item.title,
              ...(item.summary ? { summary: item.summary } : {}),
              ...(item.href ? { href: item.href } : {}),
              ...(item.source ? { source: item.source } : {}),
              timestamp: Date.now(),
              kind: 'news',
            }))
          })(),
        })
        return jsonToolResult({ status: 'ok', itemCount: p.items.length })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(dashboardFeedWrite, ctx))
  log.info('[registerDashboardFeedTool] dashboard_feed_write registered')

  const dashboardFeedRead: MtBotToolConfig = {
    ...dashboardFeedReadToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { limit?: number }
      const requested = Number.isFinite(p.limit) ? Number(p.limit) : 30
      const limit = Math.max(1, Math.min(100, Math.trunc(requested)))
      try {
        const page = await readDashboardFeedPage(DEFAULT_DASHBOARD_FEED_ID, { limit })
        return jsonToolResult({
          status: 'ok',
          feedId: DEFAULT_DASHBOARD_FEED_ID,
          count: page.items.length,
          // 卡片上总共多少条：只有 hasMore 而不给总数时，模型没法说清「还有多少没看到」，
          // 容易被它当成没有更多。策展看的是「推过什么」，总数是这句判断的锚点。
          totalCount: countDashboardFeedItems(DEFAULT_DASHBOARD_FEED_ID),
          hasMore: page.nextCursor !== null,
          items: page.items.map((item) => ({
            title: item.title,
            ...(item.summary ? { summary: item.summary } : {}),
            ...(item.source ? { source: item.source } : {}),
            ...(item.href ? { href: item.href } : {}),
            ...(typeof item.timestamp === 'number'
              ? { timestamp: new Date(item.timestamp).toISOString() }
              : {}),
            ...(item.kind ? { kind: item.kind } : {}),
          })),
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(dashboardFeedRead, ctx))
  log.info('[registerDashboardFeedTool] dashboard_feed_read registered')
}

/**
 * 注册 work_report_read：读工作日报/每周复盘产出（只读）。
 *
 * 供早间简报、每周复盘等预置任务直接取「进行中 / 明天优先」等结构化结论。
 * 数据源：local_cron_runs 里 seed-daily-report / seed-weekly-review 的 summary。
 */
export function registerWorkReportReadTool(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const JOB_ID_BY_KIND = {
    daily: 'seed-daily-report',
    weekly: 'seed-weekly-review',
  } as const

  const workReportRead: MtBotToolConfig = {
    ...workReportReadToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { kind?: 'daily' | 'weekly' | 'all'; limit?: number; days?: number }
      const kind = p.kind ?? 'daily'
      const limit = Math.max(1, Math.min(Math.floor(p.limit ?? 3), 10))
      if (!deps.localDb.isOpen) {
        return jsonToolResult({ status: 'error', message: 'database not initialized' })
      }

      const jobIds =
        kind === 'all'
          ? [JOB_ID_BY_KIND.daily, JOB_ID_BY_KIND.weekly]
          : [JOB_ID_BY_KIND[kind]]

      try {
        const cutoff = p.days && p.days > 0 ? Date.now() - Math.floor(p.days) * 86_400_000 : 0
        const reports = []
        for (const jobId of jobIds) {
          const rows = deps.localDb.db
            .prepare<{
              id: string
              started_at: number
              finished_at: number
              summary: string | null
            }>(
              `SELECT id, started_at, finished_at, summary
               FROM local_cron_runs
               WHERE job_id = ? AND status = 'ok' AND summary IS NOT NULL AND summary != ''
                 AND started_at >= ?
               ORDER BY started_at DESC
               LIMIT ?`,
            )
            .all(jobId, cutoff, limit)
          for (const row of rows) {
            reports.push({
              jobId,
              startedAt: row.started_at,
              finishedAt: row.finished_at,
              summary: row.summary,
            })
          }
        }
        reports.sort((a, b) => b.startedAt - a.startedAt)

        return jsonToolResult({
          status: 'ok',
          count: reports.length,
          reports,
          note:
            reports.length === 0
              ? '没有找到任何工作日报/复盘产出。请用 memory_manage action=list 或 wiki_search 兜底。'
              : undefined,
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(workReportRead, ctx))
  log.info('[registerWorkReportReadTool] work_report_read registered')
}
