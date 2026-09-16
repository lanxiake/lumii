/**
 * 资讯管线定位测试。
 *
 * 不起真库（同 seed-cron-jobs.test.ts 的取舍）：用最小 stub 驱动 prepare().get()，
 * 要验的是「认哪条任务 / 回落成什么」，不是 SQL 本身。
 */

import { describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import {
  NEWS_FEED_FALLBACK_AGENT_ID,
  newsFeedAgentId,
  newsFeedConversationId,
  newsFeedConversationTitle,
  resolveNewsFeedJob,
} from './news-feed-job'

interface JobRow {
  id: string
  name: string | null
  agent_id: string | null
  task_text: string | null
  system_prompt: string | null
  created_at: number
}

/** 按 SQL 形态回答：id 精确查 / LIKE 前缀查（模拟 ORDER BY created_at DESC LIMIT 1） */
function createFakeDb(rows: readonly JobRow[]): DatabaseAdapter {
  return {
    prepare: (sql: string) => ({
      get: (param: unknown) => {
        const key = String(param)
        if (sql.includes('WHERE id = ?')) {
          return rows.find((r) => r.id === key)
        }
        if (sql.includes('LIKE ?')) {
          const marker = key.replaceAll('%', '')
          return [...rows]
            .filter((r) => r.task_text?.includes(marker))
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))[0]
        }
        return undefined
      },
    }),
  } as unknown as DatabaseAdapter
}

function job(over: Partial<JobRow> & { id: string }): JobRow {
  return {
    name: `任务 ${over.id}`,
    agent_id: 'info-curator',
    task_text: '调用 dashboard_feed_write 写资讯卡',
    system_prompt: null,
    created_at: 1,
    ...over,
  }
}

describe('resolveNewsFeedJob', () => {
  it('预置 id news-pipeline 存在时优先认它', () => {
    const db = createFakeDb([
      job({ id: 'local-cron-9-zzz', created_at: 999 }),
      job({ id: 'news-pipeline', created_at: 1 }),
    ])
    expect(resolveNewsFeedJob(db)?.id).toBe('news-pipeline')
  })

  it('预置任务被删后，认领最近一条驱动资讯卡的自建任务', () => {
    const db = createFakeDb([
      job({ id: 'local-cron-1-aaa', created_at: 100 }),
      job({ id: 'local-cron-2-bbb', created_at: 200 }),
      job({ id: 'local-cron-3-ccc', task_text: '整理工作区', created_at: 300 }),
    ])
    expect(resolveNewsFeedJob(db)?.id).toBe('local-cron-2-bbb')
  })

  it('任务不存在时返回 null（手动抓取据此回落，不因任务被删而失效）', () => {
    const db = createFakeDb([job({ id: 'local-cron-3-ccc', task_text: '整理工作区' })])
    expect(resolveNewsFeedJob(db)).toBeNull()
  })

  it('执行者取任务自己的 agent_id；空值回落「灵栖情报」而非通用助手', () => {
    const db = createFakeDb([
      job({ id: 'news-pipeline', agent_id: 'system-keeper' }),
    ])
    expect(resolveNewsFeedJob(db)?.agentId).toBe('system-keeper')

    const blank = createFakeDb([job({ id: 'news-pipeline', agent_id: null })])
    expect(newsFeedAgentId(resolveNewsFeedJob(blank))).toBe(NEWS_FEED_FALLBACK_AGENT_ID)
  })

  it('会话 id / 标题与调度器的 cron:<jobId> 口径一致', () => {
    const ref = resolveNewsFeedJob(createFakeDb([job({ id: 'news-pipeline', name: '资讯抓取与综述' })]))
    expect(newsFeedConversationId(ref)).toBe('cron:news-pipeline')
    expect(newsFeedConversationTitle(ref)).toBe('定时任务 · 资讯抓取与综述')
  })

  it('任务缺失时会话回落历史约定 id，标题沿用预置名', () => {
    expect(newsFeedConversationId(null)).toBe('cron:news-pipeline')
    expect(newsFeedConversationTitle(null)).toBe('定时任务 · 资讯抓取与综述')
    expect(newsFeedAgentId(null)).toBe(NEWS_FEED_FALLBACK_AGENT_ID)
  })
})
