/**
 * strategies/summary-compact —— 第二级压缩：LLM 摘要（含 PTL 重试逃生口）
 *
 * 抽取自原 transform-context 内联摘要流程，新增 PTL（prompt-too-long）重试（B2）：
 * 当历史极长、连"摘要请求"本身都超模型输入上限时，丢弃最老 API 轮次后重试摘要，
 * 而非直接降级占位（占位会丢失全部历史语义）。借鉴 claude-code truncateHeadForPTLRetry。
 *
 * 降级链：LLM 摘要 → PTL 重试 ×N → 占位摘要（由 transform-context 兜底）。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { groupMessagesByApiRound } from "../api-invariants.js";
import { stripImagesFromMessages } from "../message-ops.js";
import {
  buildCompactSummaryPrompt,
  formatCompactSummary,
  NO_TOOLS_PREAMBLE,
  NO_TOOLS_TRAILER,
} from "../summary-prompt.js";
import { buildLlmSummaryMessage } from "../summary-message.js";
import type { CompactConfig } from "../types.js";

const logger = {
  info: (msg: string) => console.log(`[compact/summary-compact] ${msg}`),
};

/** 摘要阶段结果 */
export interface SummaryStageResult {
  /** 成功生成的摘要注入消息；null 表示需降级占位 */
  summaryMessage: AgentMessage | null;
  /** 本次 PTL 重试次数 */
  ptlRetries: number;
  /** 是否发生了非 PTL 失败（计入断路器） */
  failed: boolean;
}

/**
 * 内置 PTL 错误判断（未注入 isContextLengthError 时的兜底）。
 * 关键字对齐 reliability/message-repair PROMPT_TOO_LONG 模式。
 */
function defaultIsContextLengthError(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    text.includes("prompt is too long") ||
    text.includes("prompt too long") ||
    text.includes("context_length_exceeded") ||
    text.includes("context length") ||
    text.includes("maximum context")
  );
}

/**
 * 丢弃最老的 dropRatio 比例 API 轮次（PTL 重试用，借鉴 truncateHeadForPTLRetry）。
 * 至少保留最后一轮，至少丢一轮（避免无进展死循环）。
 */
function truncateHeadForPtlRetry(messages: AgentMessage[], dropRatio = 0.2): AgentMessage[] {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length <= 1) return messages;
  const dropCount = Math.max(1, Math.floor(groups.length * dropRatio));
  const kept = groups.slice(Math.min(dropCount, groups.length - 1));
  return kept.flat();
}

/**
 * 运行摘要阶段：调用 LLM 生成摘要，PTL 时丢最老轮次重试，最多 maxPtlRetries 次。
 *
 * @param oldMessages 待摘要的旧消息段（已分割）
 * @returns 摘要结果（summaryMessage=null 时调用方降级占位）
 */
export async function runSummaryStage(
  oldMessages: AgentMessage[],
  config: CompactConfig,
  signal?: AbortSignal,
): Promise<SummaryStageResult> {
  if (!config.generateSummary) {
    return { summaryMessage: null, ptlRetries: 0, failed: false };
  }

  const maxPtlRetries = config.maxPtlRetries ?? 3;
  const isPtl = config.isContextLengthError ?? defaultIsContextLengthError;

  const prompt =
    NO_TOOLS_PREAMBLE +
    buildCompactSummaryPrompt({
      activeTasks: config.activeTasks,
      domainHint: config.domainHint ?? "general",
      customInstructions: config.customInstructions,
    }) +
    NO_TOOLS_TRAILER;

  // 压缩前剥离图片
  let messagesForSummary = stripImagesFromMessages(oldMessages);
  let ptlRetries = 0;

  for (let attempt = 0; attempt <= maxPtlRetries; attempt++) {
    if (signal?.aborted) {
      return { summaryMessage: null, ptlRetries, failed: false };
    }
    try {
      logger.info(
        `调用 LLM 摘要生成，待摘要消息数=${messagesForSummary.length}` +
          (attempt > 0 ? `（PTL 重试 ${attempt}/${maxPtlRetries}）` : ""),
      );
      const rawSummary = await config.generateSummary(messagesForSummary, prompt, signal);

      if (rawSummary && rawSummary.trim().length > 0) {
        const formatted = formatCompactSummary(rawSummary);
        logger.info(`LLM 摘要生成成功，摘要长度=${formatted.length}, PTL 重试=${ptlRetries}`);
        return {
          summaryMessage: buildLlmSummaryMessage(formatted, {
            historyRecallHint: config.historyRecallHint ?? false,
            sessionKey: config.sessionKey,
            // summary 策略始终在摘要后保留最近 recentMessages（见 transform-context）
            recentMessagesPreserved: true,
            resumeMode: config.resumeMode ?? "resume-task",
          }),
          ptlRetries,
          failed: false,
        };
      }
      // 空返回：不是 PTL，直接降级（计断路器）
      logger.info(`LLM 摘要返回空文本，降级为占位摘要`);
      return { summaryMessage: null, ptlRetries, failed: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPtl(err) && attempt < maxPtlRetries) {
        ptlRetries++;
        const before = messagesForSummary.length;
        messagesForSummary = truncateHeadForPtlRetry(messagesForSummary, 0.2);
        logger.info(
          `摘要请求 PTL，丢弃最老轮次后重试: ${before} → ${messagesForSummary.length} 条（重试 ${ptlRetries}/${maxPtlRetries}）`,
        );
        // 丢弃后无进展（轮次不可再分）则放弃重试
        if (messagesForSummary.length >= before) {
          logger.info(`PTL 重试无法继续缩减，降级为占位摘要`);
          return { summaryMessage: null, ptlRetries, failed: true };
        }
        continue;
      }
      // 非 PTL 错误或重试耗尽：降级（计断路器）
      logger.info(
        `LLM 摘要生成失败，降级为占位摘要: ${errMsg}（PTL 重试=${ptlRetries}）`,
      );
      return { summaryMessage: null, ptlRetries, failed: true };
    }
  }

  return { summaryMessage: null, ptlRetries, failed: true };
}
