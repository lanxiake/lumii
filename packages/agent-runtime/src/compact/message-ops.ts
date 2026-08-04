/**
 * message-ops —— 纯消息变换工具集（无副作用）
 *
 * 平移自原 context-compactor.ts：
 * - stripImagesFromMessages：压缩前剥离图片/文档，避免摘要 LLM 触发 prompt-too-long
 * - truncateHeavyToolResults：截断单条过大的工具结果
 * - truncateHeavyThinkingBlocks：截断过长 thinking 块
 *
 * 这些函数仅做内容变换，不涉及序列结构/配对，故独立于 api-invariants。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * 压缩前剥离图片和文档内容（参考 Claude Code stripImagesFromMessages）
 *
 * 图片内容不需要传给摘要 LLM，且可能导致摘要请求本身触发 prompt-too-long。
 * 用文本占位符替换，确保摘要中记录"曾有图片"这一事实。
 */
export function stripImagesFromMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return msg;
    }

    let hasMedia = false;
    const newContent = (content as unknown[]).map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as Record<string, unknown>;
      if (b.type === "image") {
        hasMedia = true;
        return { type: "text", text: "[image]" };
      }
      if (b.type === "document") {
        hasMedia = true;
        return { type: "text", text: "[document]" };
      }
      // 剥离 tool_result 内嵌套的图片
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        let toolHasMedia = false;
        const newToolContent = (b.content as unknown[]).map((item) => {
          if (typeof item !== "object" || item === null) return item;
          const tb = item as Record<string, unknown>;
          if (tb.type === "image") {
            toolHasMedia = true;
            return { type: "text", text: "[image]" };
          }
          if (tb.type === "document") {
            toolHasMedia = true;
            return { type: "text", text: "[document]" };
          }
          return item;
        });
        if (toolHasMedia) {
          hasMedia = true;
          return { ...b, content: newToolContent };
        }
      }
      return block;
    });

    if (!hasMedia) return msg;
    return { ...(msg as object), content: newContent } as AgentMessage;
  });
}

/**
 * 截断过大的工具调用结果（toolResult 消息）
 *
 * 单次工具调用（如 file_read 读取大文件、grep 返回大量匹配）可能产生数万字符的结果，
 * 直接撑爆上下文窗口。此函数将超过阈值的工具结果截断并附加提示，
 * 让 Agent 知道结果已被截断，可以用更精确的参数重新调用。
 */
export function truncateHeavyToolResults(
  messages: AgentMessage[],
  maxCharsPerResult: number,
): AgentMessage[] {
  return messages.map((msg) => {
    if ((msg as { role?: string }).role !== "toolResult") return msg;
    const content = (msg as { content?: unknown }).content;
    // toolResult 内容可能是字符串或 content block 数组
    if (typeof content === "string") {
      if (content.length <= maxCharsPerResult) return msg;
      const truncated = content.slice(0, maxCharsPerResult);
      return {
        ...(msg as object),
        content:
          truncated +
          `\n\n[工具结果过大已截断（原始 ${content.length} 字符，保留前 ${maxCharsPerResult} 字符）。如需完整内容，请使用更精确的参数重新调用工具。]`,
      } as AgentMessage;
    }
    if (!Array.isArray(content)) return msg;
    let changed = false;
    const newContent = (content as unknown[]).map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text.length > maxCharsPerResult) {
        changed = true;
        return {
          ...b,
          text:
            b.text.slice(0, maxCharsPerResult) +
            `\n\n[工具结果过大已截断（原始 ${b.text.length} 字符，保留前 ${maxCharsPerResult} 字符）。如需完整内容，请使用更精确的参数重新调用工具。]`,
        };
      }
      return block;
    });
    if (!changed) return msg;
    return { ...(msg as object), content: newContent } as AgentMessage;
  });
}

/**
 * 将过长的 thinking 块截断，避免单条消息撑爆上下文窗口
 */
export function truncateHeavyThinkingBlocks(
  messages: AgentMessage[],
  maxChars: number,
): AgentMessage[] {
  return messages.map((msg) => {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return msg;
    }
    let changed = false;
    const newContent = content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const b = block as Record<string, unknown>;
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > maxChars) {
        changed = true;
        return {
          ...b,
          thinking: `${b.thinking.slice(0, maxChars)}\n\n[思考块过长已截断以适配上下文上限]`,
        };
      }
      return block;
    });
    if (!changed) {
      return msg;
    }
    return { ...(msg as object), content: newContent } as AgentMessage;
  });
}
