/**
 * partition —— 消息分割
 *
 * 将消息序列分割为"待压缩的旧段"与"保留原文的最近段"。
 * 分割点：保留最近 N 个完整 turn（user + assistant 成对）。
 *
 * 平移自原 context-compactor.ts partitionMessages。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { alignSplitIndexForToolBoundary, readMessageRole } from "./api-invariants.js";

export interface MessagePartition {
  /** 需要被截断的旧消息 */
  oldMessages: AgentMessage[];
  /** 保留原文的最近消息 */
  recentMessages: AgentMessage[];
}

/**
 * 将消息分割为"旧部分"和"保留原文的新部分"
 *
 * 分割点：保留最近 N 个完整 turn（user + assistant 成对）
 */
export function partitionMessages(
  messages: AgentMessage[],
  keepRecentTurns: number,
): MessagePartition {
  let turnCount = 0;
  let splitIndex = messages.length;

  // 从尾部往前计数完整 turn
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string } | undefined;
    if (msg?.role === "user") {
      turnCount++;
      if (turnCount >= keepRecentTurns) {
        splitIndex = i;
        break;
      }
    }
  }

  // 保底检查：user 消息数不足时回退保留最近一半，至少 12 条
  if (splitIndex >= messages.length) {
    splitIndex = Math.max(0, messages.length - Math.max(12, Math.floor(messages.length / 2)));
  }

  // 确保至少保留一半消息用于摘要
  if (splitIndex === 0) {
    splitIndex = Math.floor(messages.length / 2);
  }

  splitIndex = alignSplitIndexForToolBoundary(messages, splitIndex);

  const suffixFromSplit = messages.slice(splitIndex);
  let dropLeadingToolResults = 0;
  while (
    dropLeadingToolResults < suffixFromSplit.length &&
    readMessageRole(suffixFromSplit[dropLeadingToolResults]) === "toolResult"
  ) {
    dropLeadingToolResults += 1;
  }

  const recentMessages = suffixFromSplit.slice(dropLeadingToolResults);
  const oldMessages = messages.slice(0, splitIndex + dropLeadingToolResults);

  return {
    oldMessages,
    recentMessages,
  };
}
