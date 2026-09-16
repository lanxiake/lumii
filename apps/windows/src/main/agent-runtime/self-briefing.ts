/**
 * 执行时注入的「自述」。
 *
 * 为什么需要它：cron 执行是**全新实例、跑完即销毁**（`restoreHistoryForInstance`
 * 只在上下文压缩时被调用），所以 `cron:<jobId>` 会话里累积的「上一轮/上上轮」记录，
 * Agent 在执行时**看不到**。它每轮都从零开始：不知道自己昨天推过什么、
 * 上次体检发现了什么、同一件事是不是已经做过。
 *
 * 为什么不是「恢复历史」：
 * - 全量历史贵且噪声大（调研：朴素的摘要式巩固会破坏信息，35.3% vs 98.0%）
 * - 且 cron 会话的历史无界增长，恢复它很快会撞上压缩
 * - 这里是**加法**（补一句摘要，原文仍在会话里可查），不是那个「替代」场景
 *
 * 纯拼装、无 IO，便于单测。
 */

export interface SelfBriefingInput {
  /** 该会话**本次执行之前**最近一次 assistant 产出；从没跑过则为 null */
  lastOutput: string | null
  /** 上次产出落库时刻（epoch ms）；无则 null */
  lastOutputAt: number | null
  /** 上期维护报告的一句话结论；非维护任务或没有报告时为 null */
  lastMaintenanceSummary?: string | null
  /** 上期报告的资产范围（记忆 / Wiki…），用来把结论说全 */
  lastMaintenanceScope?: string | null
  /** 上期报告发现了几项 */
  lastMaintenanceFindingCount?: number | null
  /** 当前时刻；注入以便单测 */
  now: number
}

/** 上次产出的展示上限——它只是「上次说到哪」的提示，不是要复述整篇 */
export const LAST_OUTPUT_MAX_CHARS = 300

/** 压成单行并截断（与失败审计同一套理由：多行会把提示撑成一大段） */
function condense(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 绝对时刻：同年只显示月-日 时:分，跨年才补年份 */
function formatClock(ts: number, now: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd} ${hh}:${mi}`
}

/**
 * 相对时间。
 *
 * 刻意同时给绝对与相对：绝对时间回答「具体什么时候」，
 * 相对时间回答「隔了多久」——「14 小时前」比「昨天 12:00」更容易让模型判断
 * 「这算不算同一批/还来不来得及接着做」。
 */
export function formatElapsed(from: number, now: number): string {
  const ms = Math.max(0, now - from)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 拼「你上次的情况」段。
 *
 * **没有任何可说的就返回空串**——首次执行不该拿到一个空的「你上次…」块，
 * 那只会让模型以为上轮出了什么问题。
 */
export function buildSelfBriefing(input: SelfBriefingInput): string {
  const lines: string[] = []

  if (input.lastOutputAt != null) {
    lines.push(
      `上次执行：${formatClock(input.lastOutputAt, input.now)}（${formatElapsed(input.lastOutputAt, input.now)}）`,
    )
  }
  const lastOutput = input.lastOutput?.trim()
  if (lastOutput) {
    lines.push(`上次产出：${condense(lastOutput, LAST_OUTPUT_MAX_CHARS)}`)
  }

  const summary = input.lastMaintenanceSummary?.trim()
  if (summary) {
    const scope = input.lastMaintenanceScope?.trim()
    const count = input.lastMaintenanceFindingCount ?? 0
    const detail = count > 0 ? `，发现 ${count} 项` : '，未发现问题'
    lines.push(`上期体检：${condense(summary, 160)}（范围${scope ? `：${scope}` : ''}${detail}）`)
  }

  if (lines.length === 0) return ''

  // 抬头必须点明「这不是本轮任务」：上次产出里往往带着结论与数字，
  // 不加这句模型很容易把上一轮的事再答一遍，或者以为任务已经做完了。
  return [
    '=== 你上次的情况（供接续参考，不是本轮任务）===',
    ...lines,
    '（以上是你自己上一轮留下的记录。本轮任务见下方分隔线之后。）',
  ].join('\n')
}
