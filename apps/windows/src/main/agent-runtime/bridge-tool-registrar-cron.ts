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
} from '@mtbot/agent-runtime'
import {
  agentRuntimeLog as log,
  jsonToolResult,
  parseAtScheduleExpr,
  parseStrictMs,
} from './bridge-utils'
import {
  writeDashboardFeedSnapshot,
  DEFAULT_DASHBOARD_FEED_ID,
  uniqueDashboardFeedItemId,
} from '../dashboard-feed-store'
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
        // 独立版无 Gateway，cron 表达式调度目前无本地实现，明确报错
        return jsonToolResult({
          status: 'error',
          message: 'Local mode currently supports only "at" and "every" schedule types, not "cron".',
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
        await writeDashboardFeedSnapshot({
          feedId: DEFAULT_DASHBOARD_FEED_ID,
          title: p.title.trim(),
          updatedAt: Date.now(),
          ...(p.summary?.trim() ? { summary: p.summary.trim() } : {}),
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
}
