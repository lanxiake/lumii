/**
 * Token 用量估算 —— compact 子系统基础设施
 *
 * 合并自原 agent/token-estimate.ts 与 context-compactor.ts 的估算逻辑，
 * 使 token 估算成为压缩子系统的一等基础设施（不再寄居 agent 目录）。
 *
 * 口径（DeepSeek 官方换算）：
 * - 1 个英文字符 ≈ 0.3 token
 * - 1 个中文字符 ≈ 0.6 token
 *
 * 覆盖块类型：text / thinking / image / tool_use / tool_result / toolCall 等。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** CJK 及常见东亚字符范围（中文、日文假名、韩文） */
const CJK_CHAR_RE =
  /[一-鿿㐀-䶿豈-﫿぀-ゟ゠-ヿ가-힯]/u;

/**
 * 估算单段文本的 token 数（按字符类型加权）
 */
export function estimateTextTokenCount(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += CJK_CHAR_RE.test(ch) ? 0.6 : 0.3;
  }
  return tokens;
}

/**
 * 将 token 数向上取整为整数（计费与阈值比较用）
 */
export function ceilTokenEstimate(tokens: number): number {
  return Math.ceil(tokens);
}

/**
 * 将消息体字符量转为 token 估算（覆盖各块类型）
 */
function estimateMessageBodyTokens(msg: { role?: string; content?: unknown }): number {
  const content = msg.content;
  if (typeof content === "string") {
    return estimateTextTokenCount(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let tokens = 0;
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;
    const t = b["type"];
    if (t === "text" && typeof b["text"] === "string") {
      tokens += estimateTextTokenCount(b["text"]);
      continue;
    }
    if (t === "thinking" && typeof b["thinking"] === "string") {
      tokens += estimateTextTokenCount(b["thinking"]);
      continue;
    }
    if (t === "image") {
      tokens += 3;
      continue;
    }
    if (t === "tool_use") {
      tokens += estimateTextTokenCount(JSON.stringify(b["input"] ?? {}));
      continue;
    }
    if (t === "tool_result") {
      const result = b["content"];
      tokens += estimateTextTokenCount(
        typeof result === "string" ? result : JSON.stringify(result ?? ""),
      );
      continue;
    }
    if (t === "toolCall" || t === "toolUse" || t === "functionCall") {
      tokens += estimateTextTokenCount(JSON.stringify(b));
      continue;
    }
    tokens += estimateTextTokenCount(JSON.stringify(b));
  }
  return tokens;
}

/**
 * 粗略估算消息列表的 token 数
 *
 * 策略：覆盖 text / thinking / toolCall 等块；按中英文字符分别换算后向上取整。
 */
export function estimateTokenCount(messages: AgentMessage[]): number {
  let totalTokens = 0;
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    totalTokens += estimateMessageBodyTokens(m);
    if (m.role === "toolResult") {
      totalTokens += estimateTextTokenCount(
        JSON.stringify({
          toolCallId: (m as { toolCallId?: unknown }).toolCallId,
          toolName: (m as { toolName?: unknown }).toolName,
        }),
      );
    }
  }
  return ceilTokenEstimate(totalTokens);
}
