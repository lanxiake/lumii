/**
 * 用户反馈信号采集
 *
 * user_feedback 维度原本恒为 0.5（消息数比值永远命中中性值），不携带区分度。
 * 这里采集真实的负反馈信号，供满意度评分使用。
 *
 * 为什么必须主动记录：编辑是原地 UPDATE content_json（无历史），
 * abort 完全不落库——两者都无法事后从库里回溯统计。
 *
 * 存储用 runtime_state（已有设施，无需新迁移），键形如
 * feedback:{conversationId}，值为 JSON 计数。会话评分后清零。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const KEY_PREFIX = 'feedback:'

export interface FeedbackCounters {
  /** 用户编辑已发出的消息：说明上一轮表达没被正确理解 */
  edits: number
  /** 用户编辑并重发：比单纯编辑更强的否定 */
  resends: number
  /** 用户主动打断回复：当前输出没价值 */
  aborts: number
}

const EMPTY: FeedbackCounters = { edits: 0, resends: 0, aborts: 0 }

function key(conversationId: string): string {
  return `${KEY_PREFIX}${conversationId}`
}

function read(db: DatabaseAdapter, conversationId: string): FeedbackCounters {
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(key(conversationId))
    if (!row?.value) return { ...EMPTY }
    const parsed = JSON.parse(row.value) as Partial<FeedbackCounters>
    return {
      edits: Number(parsed.edits) || 0,
      resends: Number(parsed.resends) || 0,
      aborts: Number(parsed.aborts) || 0,
    }
  } catch {
    // 脏数据按无信号处理，不让计数器故障影响评分
    return { ...EMPTY }
  }
}

function write(db: DatabaseAdapter, conversationId: string, counters: FeedbackCounters): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key(conversationId), JSON.stringify(counters), new Date().toISOString())
}

/** 累加一类信号；失败只记日志，反馈采集不能影响用户操作 */
function bump(
  db: DatabaseAdapter,
  conversationId: string,
  field: keyof FeedbackCounters,
): void {
  try {
    const counters = read(db, conversationId)
    counters[field] += 1
    write(db, conversationId, counters)
  } catch (err) {
    log.warn(`[feedback] 记录 ${field} 失败:`, err instanceof Error ? err.message : err)
  }
}

export function recordEdit(db: DatabaseAdapter, conversationId: string): void {
  bump(db, conversationId, 'edits')
}

export function recordResend(db: DatabaseAdapter, conversationId: string): void {
  bump(db, conversationId, 'resends')
}

export function recordAbort(db: DatabaseAdapter, conversationId: string): void {
  bump(db, conversationId, 'aborts')
}

export function readCounters(db: DatabaseAdapter, conversationId: string): FeedbackCounters {
  return read(db, conversationId)
}

/**
 * 评分完成后清零，让每轮反馈只影响它所属的那次评分。
 * 不清零会导致一次编辑永久拉低后续所有轮次。
 */
export function resetCounters(db: DatabaseAdapter, conversationId: string): void {
  try {
    db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key(conversationId))
  } catch (err) {
    log.warn('[feedback] 清零失败:', err instanceof Error ? err.message : err)
  }
}

/**
 * 由负反馈信号推导 user_feedback 分值。
 *
 * 满分 1.0 起扣：
 * - 每次 abort  -0.25（当前输出被判定无用）
 * - 每次 resend -0.20（需要重来）
 * - 每次 edit   -0.10（表达需修正，程度最轻）
 *
 * 无任何信号时返回 0.85 而非 1.0：没有负反馈只能说明"没出错"，
 * 不等于"表现优秀"，留出区分空间给未来的显式正反馈。
 */
export function deriveUserFeedback(counters: FeedbackCounters): number {
  const penalty = counters.aborts * 0.25 + counters.resends * 0.2 + counters.edits * 0.1
  const score = 0.85 - penalty
  return Math.max(0, Math.min(1, score))
}
