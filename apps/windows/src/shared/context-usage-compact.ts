/**
 * 上下文压缩的占用记账：只扣对话历史，系统提示 / 工具 / MCP 定义保持不变。
 */

import type { ContextUsageBreakdownEntry } from './agent-runtime-events'

/**
 * 用对话估算差值从整窗占用里扣，避免清掉提供商缓存后整表等比缩放，
 * 把 MCP 工具定义也「看起来被压缩了」。
 */
export function applyConversationCompactToUsage(
  usedTokensBefore: number,
  conversationTokensBefore: number,
  conversationTokensAfter: number,
): number {
  const saved = Math.max(0, conversationTokensBefore - conversationTokensAfter)
  return Math.max(0, usedTokensBefore - saved)
}

/**
 * 压缩后更新分类明细：只改 conversation，其余分类保持压缩前的展示值。
 */
export function patchBreakdownAfterConversationCompact(
  breakdown: readonly ContextUsageBreakdownEntry[],
  conversationTokensBefore: number,
  conversationTokensAfter: number,
): readonly ContextUsageBreakdownEntry[] {
  const convBefore =
    breakdown.find((e) => e.category === 'conversation')?.tokens ?? conversationTokensBefore
  const ratio =
    conversationTokensBefore > 0 ? conversationTokensAfter / conversationTokensBefore : 1
  const convAfter = Math.max(0, Math.round(convBefore * ratio))
  return breakdown
    .map((entry) => (entry.category === 'conversation' ? { ...entry, tokens: convAfter } : entry))
    .filter((entry) => entry.tokens > 0)
}
