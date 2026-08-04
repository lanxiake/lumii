/**
 * strategies/hard-trim —— 第三级压缩：硬截断兜底
 *
 * 当摘要后（或断路器触发跳过摘要）估算 token 仍超硬预算时，从后往前收紧：
 * - 微压缩可压缩工具旧结果（更激进，仅保留最近 4 个）
 * - 截断过大工具结果 / thinking 块
 * - 逐条丢弃最老消息（保留摘要占位）
 * - 必要时整段头部丢弃 + 插入占位摘要
 *
 * 平移自原 context-compactor.ts iterativeDropUntilUnder / trimHistoryHeadUntilUnderBudget。
 * 本阶段（A3）保持逐条丢弃实现；API 轮次分组丢弃重写在阶段 B1 进行。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  groupMessagesByApiRound,
  stripAllOrphanToolResults,
  stripLeadingOrphanToolResults,
} from "../api-invariants.js";
import { truncateHeavyThinkingBlocks, truncateHeavyToolResults } from "../message-ops.js";
import { estimateTokenCount } from "../token-estimate.js";
import { createFallbackPlaceholder, isCompactionSummaryMessage } from "../summary-message.js";
import { microcompactToolResults } from "./micro-compact.js";

/**
 * 基于 API 轮次分组的整轮丢弃（B1，借鉴 claude-code grouping）。
 *
 * 相比逐条 slice(1)+反复修复配对，整轮丢弃天然保持 toolCall→toolResult 配对完整，
 * 且一次丢弃一轮更快逼近预算。从最老轮开始丢，但：
 * - 若首条是压缩摘要占位消息，则保留它（不丢首组的摘要），从次老轮开始丢
 * - 至少保留最后一轮（最近上下文）
 *
 * 不保证一定降到预算内（最后一轮可能仍超），收尾交给 iterativeDropUntilUnder 精修。
 */
function dropOldestRoundsUntilUnder(
  messages: AgentMessage[],
  maxEstimatedTokens: number,
): AgentMessage[] {
  if (messages.length <= 1 || estimateTokenCount(messages) <= maxEstimatedTokens) {
    return messages;
  }

  const hasSummaryHead = isCompactionSummaryMessage(messages[0]);
  const summaryHead = hasSummaryHead ? messages[0] : undefined;
  const body = hasSummaryHead ? messages.slice(1) : messages;

  let groups = groupMessagesByApiRound(body);

  // 从最老轮开始整组丢弃，保留至少最后一组
  while (groups.length > 1) {
    const candidate = groups.slice(1);
    const flat = candidate.flat();
    const withHead = summaryHead ? [summaryHead, ...flat] : flat;
    if (estimateTokenCount(withHead) <= maxEstimatedTokens) {
      // 丢到这一步已满足预算：丢弃当前最老轮即可达标，再多丢会损失上下文
      groups = candidate;
      break;
    }
    groups = candidate;
  }

  const rebuilt = summaryHead ? [summaryHead, ...groups.flat()] : groups.flat();
  return stripLeadingOrphanToolResults(rebuilt);
}

/**
 * 在保留摘要占位的前提下，从后往前收紧直到估算 token 低于上限
 *
 * @param useRoundBased 是否先用 API 轮次分组整轮丢弃（B1，默认 true，killswitch）。
 *   true 时先整轮快速逼近预算，再走逐条精修；false 回退原逐条逻辑。
 */
export function iterativeDropUntilUnder(
  messages: AgentMessage[],
  maxEstimatedTokens: number,
  useRoundBased = true,
): AgentMessage[] {
  let m = stripLeadingOrphanToolResults(messages);

  // 第零道防线：微压缩可压缩工具的旧结果（兜底路径更激进，仅保留最近 4 个）
  if (estimateTokenCount(m) > maxEstimatedTokens) {
    m = microcompactToolResults(m, 4);
  }

  // 第一道防线：截断过大的工具结果（单条超过 8000 字符），避免因单条消息撑爆而不得不删整条
  if (estimateTokenCount(m) > maxEstimatedTokens) {
    m = truncateHeavyToolResults(m, 8_000);
    m = stripAllOrphanToolResults(m);
    m = stripLeadingOrphanToolResults(m);
  }

  // 第二道防线（B1）：整轮丢弃最老 API 轮次，快速逼近预算且保持配对完整
  if (useRoundBased && estimateTokenCount(m) > maxEstimatedTokens) {
    m = dropOldestRoundsUntilUnder(m, maxEstimatedTokens);
    m = stripAllOrphanToolResults(m);
    m = stripLeadingOrphanToolResults(m);
  }

  for (let i = 0; i < 48 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    if (m.length >= 3 && isCompactionSummaryMessage(m[0])) {
      m = [m[0] as AgentMessage, ...m.slice(2)];
    } else {
      m = m.slice(1);
    }
    m = stripAllOrphanToolResults(m);
    m = stripLeadingOrphanToolResults(m);
  }
  for (let i = 0; i < 16 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    m = truncateHeavyThinkingBlocks(m, 12_000);
    m = stripAllOrphanToolResults(m);
    m = stripLeadingOrphanToolResults(m);
    if (estimateTokenCount(m) <= maxEstimatedTokens) {
      break;
    }
  }
  for (let i = 0; i < 8 && m.length > 1 && estimateTokenCount(m) > maxEstimatedTokens; i++) {
    m = m.slice(1);
    m = stripAllOrphanToolResults(m);
    m = stripLeadingOrphanToolResults(m);
  }
  return m;
}

/**
 * 从头丢弃整段前缀，使尾部估算 token 落在预算内（必要时插入摘要占位）。
 */
export function trimHistoryHeadUntilUnderBudget(
  messages: AgentMessage[],
  maxEstimatedTokens: number,
  summaryMessage?: AgentMessage,
  useRoundBased = true,
): AgentMessage[] {
  if (messages.length <= 1 || estimateTokenCount(messages) <= maxEstimatedTokens) {
    return messages;
  }
  let lo = 0;
  let hi = messages.length - 1;
  let bestSkip = messages.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const tail = messages.slice(mid);
    if (estimateTokenCount(tail) <= maxEstimatedTokens) {
      bestSkip = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const dropped = messages.slice(0, bestSkip);
  const kept = messages.slice(bestSkip);
  if (dropped.length === 0) {
    return iterativeDropUntilUnder(messages, maxEstimatedTokens, useRoundBased);
  }
  const placeholder = summaryMessage ?? createFallbackPlaceholder(dropped);
  return iterativeDropUntilUnder(
    stripLeadingOrphanToolResults([placeholder, ...kept]),
    maxEstimatedTokens,
    useRoundBased,
  );
}
