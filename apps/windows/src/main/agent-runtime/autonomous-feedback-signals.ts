/**
 * 用户反馈信号采集
 *
 * user_feedback 维度原本恒为 0.5（消息数比值永远命中中性值），不携带区分度。
 * 这里采集真实的负反馈信号，供满意度评分使用。
 *
 * 为什么必须主动记录：编辑是原地 UPDATE content_json（无历史），
 * abort 完全不落库——两者都无法事后从库里回溯统计。
 *
 * ---------------------------------------------------------------------------
 * 两份存储，因为两个消费者的**生命周期不同**（2026-09-24 第四期补第二条）
 * ---------------------------------------------------------------------------
 * | 键 | 形态 | 谁消费 | 消费后 |
 * |---|---|---|---|
 * | `feedback:{会话}` | `{edits, resends, aborts}` 计数 | 满意度评分 | **清零** |
 * | `feedback-log:{会话}` | `[{k, at}]` 流水 | 宠物感知（`pet-sensing.ts`） | **不清** |
 *
 * 计数那份在读走后就清零（"一次编辑不该永久拉低后续所有轮次"），
 * 于是它**永远到不了 3**：打断一次 → 这一轮结束 → 归零 → 再打断 → 又是 1。
 * 而宠物的预判规则①要的正是"半小时内被打断了三次以上"——它需要一个不被消费的流水。
 * 两份写在同一个函数里，**不可能只写一份**。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const KEY_PREFIX = 'feedback:'
const LOG_KEY_PREFIX = 'feedback-log:'

/** 流水保留多久（读侧还会再按自己的窗口过滤，这里只是别让它无限长） */
const LOG_KEEP_MS = 24 * 60 * 60 * 1000
/** 单会话流水条数上限（半小时内要数到 3，留 50 条足够，也不会撑大 runtime_state） */
const LOG_MAX_ENTRIES = 50

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

function logKey(conversationId: string): string {
  return `${LOG_KEY_PREFIX}${conversationId}`
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

/**
 * 追加一条流水，**不参与消费**（见文件头两张存储的说明）。
 *
 * 顺手剪枝：超 24h 的与超出条数上限的都丢掉。剪枝只写回不放大的时候才落库，
 * 免得每一次按键都多一次写。
 */
function appendLog(db: DatabaseAdapter, conversationId: string, kind: keyof FeedbackCounters): void {
  const now = Date.now()
  let entries: Array<{ k: string; at: number }> = []
  try {
    const row = db
      .prepare<{ value: string }>('SELECT value FROM runtime_state WHERE key = ?')
      .get(logKey(conversationId))
    if (row?.value) {
      const parsed = JSON.parse(row.value) as unknown
      if (Array.isArray(parsed)) {
        entries = parsed.filter(
          (e): e is { k: string; at: number } =>
            typeof e === 'object' && e !== null && Number.isFinite(Number((e as { at?: unknown }).at)),
        )
      }
    }
  } catch {
    // 流水读坏了就从头开始：它是"最近有没有被打断"的证据，不是账本
    entries = []
  }
  entries.push({ k: kind, at: now })
  const kept = entries.filter((e) => now - e.at <= LOG_KEEP_MS).slice(-LOG_MAX_ENTRIES)
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(logKey(conversationId), JSON.stringify(kept), new Date().toISOString())
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
  try {
    appendLog(db, conversationId, field)
  } catch (err) {
    log.warn(`[feedback] 记录 ${field} 流水失败:`, err instanceof Error ? err.message : err)
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
 *
 * ⚠ **只清计数，不清流水**（键不同：`feedback:` vs `feedback-log:`）。
 * 流水是宠物感知的输入，被消费掉就没法回答"最近半小时被打断了几次"。
 * 改键名或改成前缀删除时，这条会静默失效——`autonomous-feedback-signals.test.ts` 有用例钉着它。
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
