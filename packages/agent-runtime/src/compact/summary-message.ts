/**
 * summary-message —— 摘要注入消息构建
 *
 * 平移自原 context-compactor.ts：
 * - buildLlmSummaryMessage：LLM 摘要成功后的注入消息（含 historyRecallHint 原文回查指针）
 * - createFallbackPlaceholder：无 LLM 时的占位降级摘要
 * - isCompactionSummaryMessage：判断是否为压缩摘要消息
 *
 * 本阶段（A2）保持原有行为，resumeMode / recentMessagesPreserved 增强在阶段 B3 进行。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readMessageRole } from "./api-invariants.js";
import type { LlmSummaryMessageOptions } from "./types.js";

/** 续聊指令：任务型（强反漂移，对齐 claude-code suppressFollowUpQuestions 路径） */
const RESUME_DIRECTIVE_TASK = `Continue the conversation from where it left off. Resume directly — do not acknowledge this summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`;

/** 续聊指令：陪伴型（自然继续，允许轻量过渡） */
const RESUME_DIRECTIVE_SOFT = `Continue the conversation naturally from where it left off, picking up the last topic without a hard restart.`;

/** 完成态真实性约束（防"摘要幻觉导致跳过实际未做的工作"） */
const COMPLETION_GUARD = `IMPORTANT: Items marked as completed in the summary above come from the prior transcript and may be unverified. Before relying on any claimed completion to proceed — especially files written, messages sent, or other external actions — quickly confirm it actually exists or was actually performed (e.g. read the file). Do not assume completion from the summary alone, and never claim you did something you have not actually done in this continued session.`;

/**
 * 判断是否为上下文压缩生成的摘要消息
 */
export function isCompactionSummaryMessage(msg: AgentMessage | undefined): boolean {
  if (!msg || readMessageRole(msg) !== "user") {
    return false;
  }
  const c = (msg as { content?: unknown }).content;
  return (
    typeof c === "string" &&
    (c.includes("<conversation_summary>") ||
      c.includes("This session is being continued from a previous conversation"))
  );
}

/**
 * 构建 LLM 生成摘要后的注入消息（参考 Claude Code getCompactUserSummaryMessage）
 *
 * 三段式结构（02 篇 §3.1）：
 *   [背景声明] + [摘要正文] + [追溯指针 + 保留提示 + 完成态约束 + 续聊指令]
 *
 * @param formattedSummary 已格式化的摘要正文
 * @param opts.historyRecallHint     追加 memory_search→memory_read 回查指针
 * @param opts.sessionKey            当前会话标识，回查指针引导优先检索本会话
 * @param opts.recentMessagesPreserved 告知最近消息逐字保留在摘要之后
 * @param opts.resumeMode            续聊强度（默认 resume-task）
 *
 * 兼容旧调用：第二参数也接受 boolean（等价 { historyRecallHint }）。
 */
export function buildLlmSummaryMessage(
  formattedSummary: string,
  opts: LlmSummaryMessageOptions | boolean = {},
): AgentMessage {
  const o: LlmSummaryMessageOptions = typeof opts === "boolean" ? { historyRecallHint: opts } : opts;
  const {
    historyRecallHint = false,
    sessionKey,
    recentMessagesPreserved = false,
    resumeMode = "resume-task",
  } = o;

  const sessionHint = sessionKey?.trim()
    ? `优先在当前会话 sessionKey=${sessionKey.trim()} 内检索`
    : "检索相关历史";
  const recallLine = historyRecallHint
    ? `\n\n如需本摘要未覆盖的精确原文或细节，可用 \`memory_search\`（${sessionHint}）拿到 \`drawer_id\`，再用 \`memory_read\` 按 \`drawer_id\` 读取该会话归档原文，而不是凭印象作答。`
    : "";

  const preservedLine = recentMessagesPreserved
    ? `\n\n最近若干轮消息已逐字保留在本摘要之后，可直接参考其原文。`
    : "";

  const resumeDirective = resumeMode === "resume-soft" ? RESUME_DIRECTIVE_SOFT : RESUME_DIRECTIVE_TASK;

  const content = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}

${resumeDirective}

${COMPLETION_GUARD}${preservedLine}${recallLine}`;

  return { role: "user", content, timestamp: Date.now() };
}

/**
 * 创建降级占位摘要消息（无 LLM 时使用）
 *
 * 比原版更信息丰富：包含已用工具名称、重要警告。
 */
export function createFallbackPlaceholder(oldMessages: AgentMessage[]): AgentMessage {
  // 提取首条 user 消息文本（原始请求）
  let originalRequest = "";
  for (const msg of oldMessages) {
    if ((msg as { role?: string }).role === "user") {
      const content = (msg as { content?: unknown }).content;
      if (typeof content === "string") {
        originalRequest = content.slice(0, 500);
        break;
      }
    }
  }

  // 统计已使用的工具名
  const toolNames = new Set<string>();
  for (const msg of oldMessages) {
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content as unknown[]) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>)["type"] === "tool_use" &&
          typeof (block as Record<string, unknown>)["name"] === "string"
        ) {
          toolNames.add((block as Record<string, unknown>)["name"] as string);
        }
      }
    }
  }

  let text = `<conversation_summary>\n`;
  text += `[Earlier conversation (${oldMessages.length} messages) has been compacted.]\n`;
  if (originalRequest) {
    text += `\nOriginal user request: "${originalRequest}"\n`;
  }
  if (toolNames.size > 0) {
    text += `\nTools already used: ${[...toolNames].join(", ")}\n`;
  }
  text += `\nIMPORTANT: If you have already attempted to fulfill the request multiple times without success, `;
  text += `inform the user what you tried and what the limitations are. Do NOT repeat the same tool calls.\n`;
  text += `</conversation_summary>`;

  return { role: "user", content: text, timestamp: Date.now() };
}
