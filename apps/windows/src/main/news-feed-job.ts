/**
 * 资讯管线任务的定位（唯一真相源）
 *
 * 「资讯管线」有两条触发路径，必须落在**同一个会话、同一个执行者**上：
 * 1. 定时任务（`local_cron_jobs` 里驱动资讯卡的那条，由调度器 `driveAgent` 执行）；
 * 2. 概览页「立即抓取」按钮（`dashboard-feed:refresh`）。
 *
 * 历史问题（2026-09-16 之前）：两条路径各自硬编码——手动路径写死
 * `cron:news-pipeline` + `assistant`，定时路径用 `cron:<job.id>` + 任务自己的
 * `agent_id`。于是同一个「资讯抓取」在侧栏分裂成两个会话，且手动那次挂在
 * 「默认」分组下（执行者是通用助手，不是「灵栖情报」）。
 *
 * 判定「哪条任务是资讯管线」的依据是**任务指令里是否显式调用资讯卡工具**
 * （`dashboard_feed_write`）——任务名用户随手可改，指令里的工具调用才是这活的实质。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 资讯管线任务的判定标记：任务指令里出现即算「这活是情报的」 */
export const NEWS_FEED_TASK_MARKER = 'dashboard_feed_write'

/** 预置任务 id：老库的资讯管线正主，存在时优先认它 */
export const NEWS_FEED_SEED_JOB_ID = 'news-pipeline'

/** 资讯管线缺省执行者：一切回落路径都归「灵栖情报」 */
export const NEWS_FEED_FALLBACK_AGENT_ID = 'info-curator'

/** 定位结果：调用方拿它拼会话 id（`cron:<id>`）与实例（`agentId`） */
export interface NewsFeedJobRef {
  readonly id: string
  readonly name: string
  readonly agentId: string
  /** 任务指令（手动「立即抓取」复用，保证两条路径驱动方式逐字一致） */
  readonly taskText: string | null
  /** 任务系统提示词 */
  readonly systemPrompt: string | null
}

/** 任务行到定位结果的映射（手写而非展开，字段少且要处理 NULL） */
function toRef(row: {
  id: string
  name: string | null
  agent_id: string | null
  task_text?: string | null
  system_prompt?: string | null
}): NewsFeedJobRef {
  return {
    id: row.id,
    name: row.name ?? row.id,
    agentId: row.agent_id?.trim() || NEWS_FEED_FALLBACK_AGENT_ID,
    taskText: row.task_text ?? null,
    systemPrompt: row.system_prompt ?? null,
  }
}

/**
 * 找出当前承载资讯管线的定时任务。
 *
 * 优先级：预置 id `news-pipeline` → 最近创建的一条带标记的任务。
 * 找不到返回 null，由调用方决定回落（手动抓取仍要能跑，不因任务被删而失效）。
 */
export function resolveNewsFeedJob(db: DatabaseAdapter): NewsFeedJobRef | null {
  const seed = db
    .prepare<{
      id: string
      name: string | null
      agent_id: string | null
      task_text: string | null
      system_prompt: string | null
    }>(`SELECT id, name, agent_id, task_text, system_prompt FROM local_cron_jobs WHERE id = ?`)
    .get(NEWS_FEED_SEED_JOB_ID)
  if (seed) return toRef(seed)

  const row = db
    .prepare<{
      id: string
      name: string | null
      agent_id: string | null
      task_text: string | null
      system_prompt: string | null
    }>(
      `SELECT id, name, agent_id, task_text, system_prompt FROM local_cron_jobs
       WHERE task_text LIKE ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(`%${NEWS_FEED_TASK_MARKER}%`)
  if (!row) return null

  return toRef(row)
}

/**
 * 解析资讯管线要写入的会话 id。
 *
 * 有任务时用 `cron:<jobId>`（与调度器 `driveAgent` 完全一致，两条路径同一个会话）；
 * 任务不存在时退回历史约定的 `cron:news-pipeline`，保证手动抓取始终可用。
 */
export function newsFeedConversationId(job: NewsFeedJobRef | null): string {
  return job ? `cron:${job.id}` : `cron:${NEWS_FEED_SEED_JOB_ID}`
}

/** 会话标题（与调度器生成的口径一致） */
export function newsFeedConversationTitle(job: NewsFeedJobRef | null): string {
  return `定时任务 · ${job?.name ?? '资讯抓取与综述'}`
}

/** 执行者（任务被删时归「灵栖情报」，不回落通用助手） */
export function newsFeedAgentId(job: NewsFeedJobRef | null): string {
  return job?.agentId ?? NEWS_FEED_FALLBACK_AGENT_ID
}
