/**
 * message-repair — LLM 错误分类、消息修复、ConvertToLlm
 *
 * 从 agent-instance.ts 提取的纯函数，无副作用。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

// ==================== defaultConvertToLlm ====================

/**
 * 默认消息转换：AgentMessage[] → LLM Message[]
 *
 * 过滤掉非标准 LLM 消息（自定义消息等），只保留 user/assistant/toolResult。
 * 同时处理以下场景，避免 LLM 400 "Messages with role 'tool' must be a response
 * to a preceding message with 'tool_calls'" 错误：
 *   1. error/aborted assistant 消息及其关联 toolResult
 *   2. 有 toolCall 但无对应 toolResult 的 assistant 消息（中止导致的孤立 toolCall）
 *   3. 有 toolResult 但无对应 assistant toolCall 的孤立 toolResult
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  // 第一遍：保留 user/assistant/toolResult
  const filtered = messages.filter((m): m is Message => {
    if (typeof m !== "object" || m === null || !("role" in m)) return false;
    const role = (m as { role: string }).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });

  // ToolCall block（assistant content 里）的字段是 id，不是 toolCallId
  type AssistantMsg = {
    role: string;
    stopReason?: string;
    content?: Array<{ type?: string; id?: string }>;
  };
  // ToolResultMessage 的 toolCallId 是顶层字段，不在 content 里
  type ToolResultMsg = { role: string; toolCallId?: string; content?: Array<{ type?: string }> };

  // 第二遍：收集 error/aborted assistant 中的 toolCall id（旧逻辑）
  const orphanToolCallIds = new Set<string>();
  for (const msg of filtered) {
    if ((msg as AssistantMsg).role !== "assistant") continue;
    const assistantMsg = msg as AssistantMsg;
    if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
      for (const b of assistantMsg.content ?? []) {
        if (b.type === "toolCall" && b.id) orphanToolCallIds.add(b.id);
      }
    }
  }

  // 第三遍：双向一致性检查
  const assistantToolCallIds = new Set<string>();
  for (const msg of filtered) {
    if ((msg as AssistantMsg).role !== "assistant") continue;
    for (const b of (msg as AssistantMsg).content ?? []) {
      if (b.type === "toolCall" && b.id) assistantToolCallIds.add(b.id);
    }
  }
  const toolResultIds = new Set<string>();
  for (const msg of filtered) {
    const m = msg as ToolResultMsg;
    if (m.role !== "toolResult") continue;
    if (m.toolCallId) toolResultIds.add(m.toolCallId);
  }

  for (let i = filtered.length - 1; i >= 0; i--) {
    const msg = filtered[i] as AssistantMsg;
    if (msg.role !== "assistant") continue;
    const toolCalls = (msg.content ?? []).filter((b) => b.type === "toolCall" && b.id);
    if (toolCalls.length === 0) break;
    const hasOrphan = toolCalls.some((b) => b.id && !toolResultIds.has(b.id));
    if (hasOrphan) {
      for (const b of toolCalls) {
        if (b.id) orphanToolCallIds.add(b.id);
      }
    }
    break;
  }

  const danglingToolResultIds = new Set<string>();
  for (const id of toolResultIds) {
    if (!assistantToolCallIds.has(id)) danglingToolResultIds.add(id);
  }

  if (orphanToolCallIds.size === 0 && danglingToolResultIds.size === 0) return filtered;

  return filtered.filter((msg) => {
    const role = (msg as AssistantMsg).role;
    if (role === "assistant") {
      const assistantMsg = msg as AssistantMsg;
      if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted")
        return false;
      const toolCalls = (assistantMsg.content ?? []).filter((b) => b.type === "toolCall");
      if (toolCalls.length > 0 && toolCalls.every((b) => b.id && orphanToolCallIds.has(b.id))) {
        return false;
      }
    }
    if (role === "toolResult") {
      const id = (msg as ToolResultMsg).toolCallId;
      if (id && (orphanToolCallIds.has(id) || danglingToolResultIds.has(id))) return false;
    }
    return true;
  });
}

// ==================== 自愈层辅助函数 ====================

/** LLM 错误分类 */
export type LlmErrorCategory =
  | "tool_pairing"
  | "prompt_too_long"
  | "rate_limit"
  | "server_error"
  | "thinking_required"
  | "unrecoverable";

const TOOL_PAIRING_PATTERNS = [
  "role 'tool' must be a response to a preceding message with 'tool_calls'",
  "tool_use ids were not found",
  "tool_call_id",
  "invalid tool_use block",
];

const PROMPT_TOO_LONG_PATTERNS = [
  "prompt is too long",
  "maximum context length",
  "context_length_exceeded",
  "token limit",
  "too many tokens",
];

export function classifyLlmError(errorText: string): LlmErrorCategory {
  const lower = errorText.toLowerCase();

  for (const p of TOOL_PAIRING_PATTERNS) {
    if (lower.includes(p.toLowerCase())) return "tool_pairing";
  }
  for (const p of PROMPT_TOO_LONG_PATTERNS) {
    if (lower.includes(p.toLowerCase())) return "prompt_too_long";
  }
  if (
    /\b429\b/.test(lower) ||
    lower.includes("rate limit") ||
    lower.includes("too many requests")
  ) {
    return "rate_limit";
  }
  if (/\b50[23]\b/.test(lower) || lower.includes("overloaded") || lower.includes("server error")) {
    return "server_error";
  }
  // DeepSeek 思考模式：reasoning_content 必须回传
  if (lower.includes("reasoning_content") && lower.includes("thinking mode")) {
    return "thinking_required";
  }
  return "unrecoverable";
}

/**
 * 修复损坏的消息序列：移除孤立 toolResult、错误 assistant、悬挂 toolCall
 */
export function repairMessageSequence(messages: AgentMessage[]): AgentMessage[] {
  type AMsg = {
    role: string;
    stopReason?: string;
    content?: Array<{ type?: string; id?: string }>;
  };
  type TMsg = { role: string; toolCallId?: string };

  // 1. 移除 error/aborted assistant 消息
  let result = messages.filter((m) => {
    const msg = m as AMsg;
    if (msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted")) {
      return false;
    }
    return true;
  });

  // 2. 收集所有 assistant toolCall id
  const assistantToolCallIds = new Set<string>();
  for (const m of result) {
    const msg = m as AMsg;
    if (msg.role !== "assistant") continue;
    for (const b of msg.content ?? []) {
      if (b.type === "toolCall" && b.id) assistantToolCallIds.add(b.id);
    }
  }

  // 3. 移除无对应 assistant toolCall 的孤立 toolResult
  result = result.filter((m) => {
    const msg = m as TMsg;
    if (msg.role !== "toolResult") return true;
    return msg.toolCallId ? assistantToolCallIds.has(msg.toolCallId) : true;
  });

  // 4. 重新收集 toolResult id，检查尾部 assistant 是否有悬挂 toolCall
  const toolResultIds = new Set<string>();
  for (const m of result) {
    const msg = m as TMsg;
    if (msg.role === "toolResult" && msg.toolCallId) {
      toolResultIds.add(msg.toolCallId);
    }
  }

  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i] as AMsg;
    if (msg.role !== "assistant") break;
    const toolCalls = (msg.content ?? []).filter((b) => b.type === "toolCall" && b.id);
    if (toolCalls.length === 0) break;
    const allDangling = toolCalls.every((b) => b.id && !toolResultIds.has(b.id));
    if (allDangling) {
      const nonToolCallContent = (msg.content ?? []).filter((b) => b.type !== "toolCall");
      if (nonToolCallContent.length > 0) {
        result = [
          ...result.slice(0, i),
          { ...result[i], content: nonToolCallContent } as AgentMessage,
          ...result.slice(i + 1),
        ];
      } else {
        result = [...result.slice(0, i), ...result.slice(i + 1)];
      }
    }
    break;
  }

  return result;
}
