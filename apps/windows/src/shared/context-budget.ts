/**
 * 上下文预算：区分固定开销与可压缩部分
 *
 * 压缩只能动对话历史（applyConversationCompactToUsage 的口径），
 * 但触发判断一直按整窗占用算 `used > contextWindow × ratio`。
 * 当系统提示词 + 工具 + MCP 定义本身就吃掉大半窗口时，这个条件恒真而压缩恒无效：
 * 实测 200K 窗口下 MCP 独占 150K，固定开销 164K 已高于 floor(156K)，
 * 压缩反复触发、反复只能从 9.5K 的对话池里挤，用量数字一动不动。
 *
 * 改为按「可压缩预算」判断：只把对话历史与它实际可用的空间做比较。
 */

import type { ContextUsageBreakdownEntry, ContextUsageCategory } from './agent-runtime-events'

/** 不可压缩的分类：压缩动不了它们，只能靠禁用 MCP/技能来降 */
const FIXED_CATEGORIES: readonly ContextUsageCategory[] = [
  'systemPrompt',
  'tools',
  'skills',
  'mcp',
  'subagents',
  'memory',
  'dynamicContext',
]

export interface ContextBudget {
  /** 不可压缩的固定开销 */
  readonly fixedOverhead: number
  /** 可压缩部分的当前占用（对话历史） */
  readonly compressible: number
  /** 留给对话历史的空间；<= 0 表示固定开销已挤满窗口 */
  readonly budget: number
  /** 固定开销 + 补全预留已超窗口，压缩无法解决 */
  readonly exhausted: boolean
}

/**
 * 计算上下文预算。
 *
 * 无 breakdown（无活跃实例）时退化为旧口径：整窗占用视为可压缩，
 * 避免因拿不到明细就完全不压缩。
 *
 * @param usedTokens 整窗已用
 * @param contextWindow 模型窗口
 * @param breakdown 分类明细
 * @param reserveForCompletion 为模型输出预留的 token
 */
export function computeContextBudget(
  usedTokens: number,
  contextWindow: number,
  breakdown: readonly ContextUsageBreakdownEntry[] | undefined,
  reserveForCompletion: number,
): ContextBudget {
  if (!breakdown?.length) {
    const budget = Math.max(0, contextWindow - reserveForCompletion)
    return {
      fixedOverhead: 0,
      compressible: usedTokens,
      budget,
      exhausted: budget <= 0,
    }
  }

  const fixed = new Set<ContextUsageCategory>(FIXED_CATEGORIES)
  let fixedOverhead = 0
  let conversation = 0
  for (const entry of breakdown) {
    if (fixed.has(entry.category)) fixedOverhead += entry.tokens
    else conversation += entry.tokens
  }

  // breakdown 是估算，usedTokens 来自提供商实测：以实测为准反推可压缩量，
  // 但不低于 breakdown 里的对话估算，避免缓存命中让 used 偏低时判定为无需压缩。
  const compressible = Math.max(conversation, usedTokens - fixedOverhead, 0)
  const budget = contextWindow - fixedOverhead - reserveForCompletion

  return {
    fixedOverhead,
    compressible,
    budget: Math.max(0, budget),
    exhausted: budget <= 0,
  }
}

/**
 * 是否该触发压缩。
 *
 * 固定开销挤满窗口时返回 false —— 此时压缩救不了，应提示用户禁用 MCP server，
 * 而不是反复启动无效压缩。
 */
export function shouldCompactByBudget(budget: ContextBudget, triggerRatio: number): boolean {
  if (budget.exhausted) return false
  return budget.compressible > budget.budget * triggerRatio
}
