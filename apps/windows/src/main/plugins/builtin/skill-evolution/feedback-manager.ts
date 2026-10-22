/**
 * 反馈管理器 — 信号检测、trustScore 非对称更新、熔断判断
 */

import type { SkillMeta } from './types'
import { readMeta, updateMeta } from './skill-writer'

export type FeedbackSignal = 'positive' | 'partial' | 'negative'

const HELPFUL_DELTA = 0.05
const UNHELPFUL_DELTA = -0.10
const PARTIAL_DELTA = -0.03

const NEGATIVE_WORDS = ['不对', '错了', '重来', '不是这样', '不行', 'wrong', 'incorrect', 'redo', 'not right']
const POSITIVE_WORDS = ['好的', '完成了', '谢谢', '对的', '就是这样', '完美', 'done', 'perfect', 'great', 'correct']
const PARTIAL_WORDS = ['有点问题', '不太对', '差不多', 'almost', 'not quite']

/** 从用户消息中检测隐式反馈信号（消息过短时不检测，避免误判） */
export function detectSignal(message: string): FeedbackSignal | null {
  if (message.trim().length < 5) return null
  const lower = message.toLowerCase()
  if (NEGATIVE_WORDS.some(w => lower.includes(w.toLowerCase()))) return 'negative'
  if (PARTIAL_WORDS.some(w => lower.includes(w.toLowerCase()))) return 'partial'
  if (POSITIVE_WORDS.some(w => lower.includes(w.toLowerCase()))) return 'positive'
  return null
}

/** 判断本次是否需要向用户询问反馈（基于 trustScore 动态调整频率） */
export async function shouldAskFeedback(skillName: string): Promise<boolean> {
  const meta = await readMeta(skillName)
  if (!meta) return false

  const { trustScore, useCount } = meta

  // 新技能前 3 次使用必问（无论 trustScore）
  if (useCount <= 3) return true

  if (trustScore < 0.5) {
    // 低信任：每次都问
    return true
  } else if (trustScore <= 0.8) {
    // 中信任：每5次问一次
    return useCount % 5 === 0
  } else {
    // 高信任：每10次问一次
    return useCount % 10 === 0
  }
}

/** 记录一次反馈，非对称更新 trustScore */
export async function recordFeedback(
  skillName: string,
  signal: FeedbackSignal,
): Promise<{ oldTrust: number; newTrust: number }> {
  const meta = await readMeta(skillName)
  if (!meta) throw new Error(`Skill not found: ${skillName}`)

  const oldTrust = meta.trustScore
  let delta = 0
  if (signal === 'positive') delta = HELPFUL_DELTA
  else if (signal === 'negative') delta = UNHELPFUL_DELTA
  else if (signal === 'partial') delta = PARTIAL_DELTA

  const newTrust = Math.max(0, Math.min(1, oldTrust + delta))

  const newConsecutiveNegative =
    signal === 'negative' ? meta.consecutiveNegative + 1 : 0

  await updateMeta(skillName, {
    trustScore: newTrust,
    consecutiveNegative: newConsecutiveNegative,
    feedbackStats: {
      positive: meta.feedbackStats.positive + (signal === 'positive' ? 1 : 0),
      partial: meta.feedbackStats.partial + (signal === 'partial' ? 1 : 0),
      negative: meta.feedbackStats.negative + (signal === 'negative' ? 1 : 0),
    },
  })

  return { oldTrust, newTrust }
}

/** 检查是否触发熔断（建议废弃） */
export function shouldSuggestDeprecation(meta: SkillMeta): boolean {
  return meta.consecutiveNegative >= 3 || meta.trustScore < 0.2
}
