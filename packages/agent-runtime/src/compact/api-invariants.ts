/**
 * api-invariants —— API 契约守护
 *
 * OpenAI 兼容 API（含 DeepSeek）对 tool_calls / role:tool 配对极其严格，
 * 压缩任何一步都可能破坏配对触发 400。集中守护逻辑：
 * - stripLeadingOrphanToolResults：去首部孤立 toolResult
 * - stripAllOrphanToolResults：去全部孤立 toolResult
 * - alignSplitIndexForToolBoundary：分割点向左对齐到非 toolResult 边界
 * - validateAndRepairMessageSequence：序列校验与自动修复（最后防线）
 *
 * 平移自原 context-compactor.ts。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

const logger = {
  info: (msg: string) => console.log(`[compact/api-invariants] ${msg}`),
};

/**
 * 读取 Agent 消息的 role
 */
export function readMessageRole(msg: AgentMessage | undefined): string | undefined {
  if (!msg || typeof msg !== "object") {
    return undefined;
  }
  const r = (msg as { role?: unknown }).role;
  return typeof r === "string" ? r : undefined;
}

/**
 * 去除序列首部孤立的 toolResult。
 *
 * OpenAI 兼容 API（含 DeepSeek）要求：`role: tool` 必须紧跟在带 `tool_calls` 的 assistant 之后。
 * 上下文压缩的回退分割可能把「工具结果」划到 `recent` 段开头，导致 400。
 */
export function stripLeadingOrphanToolResults(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  let start = 0;
  while (start < messages.length && readMessageRole(messages[start]) === "toolResult") {
    start += 1;
  }
  if (start === 0) {
    return [...messages];
  }
  return messages.slice(start);
}

/**
 * 去除序列中所有孤立的 toolResult（无对应 assistant tool_calls 的）。
 *
 * iterativeDropUntilUnder 丢弃 assistant（含 tool_calls）后，其后的 toolResult 可能不在序列
 * 开头，stripLeadingOrphanToolResults 无法处理。此函数扫描整个序列，移除所有悬挂 toolResult。
 */
export function stripAllOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
  // 收集所有 assistant 消息中的 toolCall id（ToolCall block 字段为 id）
  const assistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (readMessageRole(msg) !== "assistant") continue;
    const content = (msg as { content?: Array<{ type?: string; id?: string }> }).content ?? [];
    for (const b of content) {
      if (b.type === "toolCall" && b.id) assistantToolCallIds.add(b.id);
    }
  }
  // 过滤掉无对应 assistant toolCall 的 toolResult（ToolResultMessage.toolCallId 是顶层字段）
  return messages.filter((msg) => {
    if (readMessageRole(msg) !== "toolResult") return true;
    const id = (msg as { toolCallId?: string }).toolCallId;
    return id ? assistantToolCallIds.has(id) : true;
  });
}

/**
 * 将分割索引向左移动，使 `messages[splitIndex]` 不是 toolResult
 */
export function alignSplitIndexForToolBoundary(
  messages: AgentMessage[],
  splitIndex: number,
): number {
  let i = Math.min(Math.max(0, splitIndex), messages.length);
  while (i > 0 && readMessageRole(messages[i]) === "toolResult") {
    i -= 1;
  }
  return i;
}

/**
 * 消息序列验证与自动修复（防御性最后防线）
 *
 * 在 finalizeHistoryMessages 出口处验证 tool/toolResult 配对完整性。
 * 检测到不一致时 warn 并自动修复，避免将损坏序列发给 LLM 触发 400。
 */
export function validateAndRepairMessageSequence(
  messages: AgentMessage[],
  logLabel: string,
): AgentMessage[] {
  const assistantToolCallIds = new Set<string>();
  const toolResultCallIds = new Set<string>();

  for (const msg of messages) {
    const role = readMessageRole(msg);
    if (role === "assistant") {
      const content = (msg as { content?: Array<{ type?: string; id?: string }> }).content ?? [];
      for (const b of content) {
        if (b.type === "toolCall" && b.id) assistantToolCallIds.add(b.id);
      }
    }
    if (role === "toolResult") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (id) toolResultCallIds.add(id);
    }
  }

  // 检查孤立 toolResult（无对应 assistant toolCall）
  const orphanToolResults: string[] = [];
  for (const id of toolResultCallIds) {
    if (!assistantToolCallIds.has(id)) orphanToolResults.push(id);
  }

  if (orphanToolResults.length === 0) return messages;

  logger.info(
    `[validateMessageSequence] ${logLabel}: 检测到 ${orphanToolResults.length} 个孤立 toolResult，自动修复`,
  );

  return stripAllOrphanToolResults(messages);
}

/**
 * 按 API 轮次分组（借鉴 claude-code grouping.ts groupMessagesByApiRound）。
 *
 * 一个"轮"= 一次 API 往返：以 assistant 消息为边界，连续的 user/toolResult 归入
 * 紧邻其前的 assistant 组（首个 assistant 之前的前导消息单独成第一组）。
 *
 * 适配本项目消息结构（pi-agent-core 无 message.id）：以"出现新的 assistant 消息"
 * 作为唯一边界。由于本项目工具循环中 toolResult 紧跟产生它的 assistant(含 toolCall)，
 * 整组丢弃天然不会拆散 toolCall→toolResult 配对，是 hard-trim 整轮丢弃的基础。
 *
 * @returns 轮次分组（按出现顺序，每组 ≥ 1 条消息）
 */
export function groupMessagesByApiRound(messages: AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  let current: AgentMessage[] = [];

  for (const msg of messages) {
    if (readMessageRole(msg) === "assistant" && current.length > 0) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}
