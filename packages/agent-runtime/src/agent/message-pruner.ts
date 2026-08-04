/**
 * message-pruner —— 按 DeepSeek 思考模式规则，在发往 LLM 前裁剪 assistant thinking block。
 *
 * 纯函数，无副作用，便于单测。不修改原始 messages 引用，按需返回浅拷贝。
 *
 * 设计依据：2026-06-23-agent-thinking-tool-result-pruning-design.md §6.3
 *
 * DeepSeek 思考模式规则（官方「多轮对话」文档）：
 * - 同一 user 轮内、工具循环进行中：reasoning_content 必须保留（否则 400）
 * - 已完成的历史 user 轮、该轮无 tool_call：reasoning_content 可丢弃（API 会忽略，浪费 token）
 * - 已完成的历史 user 轮、该轮有 tool_call：该轮所有 assistant 的 reasoning_content 必须保留（跨轮仍要携带）
 *
 * 与展示/存储解耦：UI/DB 始终保留完整 thinking 供审计，仅在 convert 前对发往 LLM 的副本裁剪。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * thinking 裁剪策略
 * - `off`：不裁剪（非 DeepSeek 模型或显式关闭）
 * - `deepseek`：按 DeepSeek 规则裁剪（默认）
 * - `aggressive`：仅保留「当前未闭合 user 轮」的 thinking，历史轮一律剥离
 *   （仅当确认无跨轮 tool 需求时使用，否则可能触发 DeepSeek 400）
 */
export type PruneThinkingPolicy = "off" | "deepseek" | "aggressive";

interface MsgView {
  role?: string;
  content?: unknown;
}

function readRole(msg: AgentMessage): string | undefined {
  if (typeof msg !== "object" || msg === null) return undefined;
  const r = (msg as MsgView).role;
  return typeof r === "string" ? r : undefined;
}

/** 该 assistant 消息是否含 toolCall block */
function assistantHasToolCall(msg: AgentMessage): boolean {
  const content = (msg as MsgView).content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as { type?: string })?.type === "toolCall");
}

/** 该 assistant 消息是否含 thinking block */
function assistantHasThinking(msg: AgentMessage): boolean {
  const content = (msg as MsgView).content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as { type?: string })?.type === "thinking");
}

/** 剥离一条 assistant 消息的 thinking block，返回浅拷贝（无 thinking 时原样返回） */
function stripThinking(msg: AgentMessage): AgentMessage {
  const content = (msg as MsgView).content;
  if (!Array.isArray(content)) return msg;
  if (!content.some((b) => (b as { type?: string })?.type === "thinking")) return msg;
  const filtered = content.filter((b) => (b as { type?: string })?.type !== "thinking");
  return { ...(msg as object), content: filtered } as AgentMessage;
}

/**
 * 轮次切片：以 user 消息为分界，将消息序列切成若干「轮」。
 *
 * 每个轮从一条 user 消息开始，包含其后到下一条 user 之前的全部消息（assistant + toolResult）。
 * 序列开头若有非 user 消息（如恢复历史时的孤立片段），归入第一个轮（无前导 user）。
 *
 * @returns 轮的下标区间列表 `[start, end)`，按出现顺序；最后一个区间即「当前未闭合 user 轮」。
 */
function sliceTurns(messages: AgentMessage[]): Array<{ start: number; end: number }> {
  const turns: Array<{ start: number; end: number }> = [];
  let turnStart = 0;
  // 从第二条起扫描：遇到 user 即在其前闭合上一个轮。首条（i=0）无论是否 user 都归入第一个轮。
  for (let i = 1; i < messages.length; i++) {
    if (readRole(messages[i] as AgentMessage) === "user") {
      turns.push({ start: turnStart, end: i });
      turnStart = i;
    }
  }
  turns.push({ start: turnStart, end: messages.length });
  return turns;
}

/**
 * 按 DeepSeek 思考模式规则裁剪 assistant thinking block。
 *
 * @param messages 内存完整态消息（含 thinking）
 * @param policy   裁剪策略，默认 `"deepseek"`
 * @returns 裁剪后的新数组（未发生裁剪时返回原数组引用）
 */
export function pruneThinkingForDeepSeek(
  messages: AgentMessage[],
  policy: PruneThinkingPolicy = "deepseek",
): AgentMessage[] {
  if (policy === "off") return messages;
  if (messages.length === 0) return messages;

  const turns = sliceTurns(messages);
  if (turns.length === 0) return messages;

  // 最后一个轮 = 当前未闭合 user 轮，始终保留 thinking
  const lastTurnIndex = turns.length - 1;

  let changed = false;
  const result = messages.slice();

  for (let t = 0; t < turns.length; t++) {
    if (t === lastTurnIndex) continue; // 当前轮全保留

    const { start, end } = turns[t]!;

    // 该历史轮是否发生过工具调用（任一 assistant 含 toolCall）
    let turnHasToolCall = false;
    if (policy === "deepseek") {
      for (let i = start; i < end; i++) {
        const msg = result[i] as AgentMessage;
        if (readRole(msg) === "assistant" && assistantHasToolCall(msg)) {
          turnHasToolCall = true;
          break;
        }
      }
    }
    // aggressive：历史轮一律剥离（turnHasToolCall 恒为 false）

    if (turnHasToolCall) continue; // 有工具调用的历史轮必须保留 thinking

    // 无工具调用的历史轮：剥离该轮所有 assistant 的 thinking
    for (let i = start; i < end; i++) {
      const msg = result[i] as AgentMessage;
      if (readRole(msg) !== "assistant" || !assistantHasThinking(msg)) continue;
      result[i] = stripThinking(msg);
      changed = true;
    }
  }

  return changed ? result : messages;
}

// 导出供测试使用
export { sliceTurns, assistantHasToolCall, assistantHasThinking };
