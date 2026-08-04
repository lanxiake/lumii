/**
 * transform-context —— Agent.transformContext 主编排
 *
 * 在每次 LLM 调用前被 pi-agent-core 自动调用。返回值仅用于当次 LLM 调用
 * （不持久化到 state.messages）。
 *
 * 三层减压管线：
 * 1. MicroCompact 第一级（[microCompactRatio, triggerRatio) 区间，仅清工具结果）
 * 2. Summary 全摘要（≥ triggerRatio，LLM 摘要 / 占位降级）
 * 3. Hard-Trim 硬截断（断路器触发 / finalize 兜底）
 *
 * 平移自原 context-compactor.ts createTransformContext + finalizeHistoryMessages。
 * 本阶段（A3）语义等价现状；PTL 重试 / 断路器状态机 / 提示词增强在阶段 B 进行。
 *
 * 设计依据: .qoder/design/agent-context-compact/01-上下文压缩模块独立化与精细化设计.md
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { stripLeadingOrphanToolResults, validateAndRepairMessageSequence } from "./api-invariants.js";
import { partitionMessages } from "./partition.js";
import { checkCompactionNeeded, computeMaxEstimatedHistoryTokens, CircuitBreaker } from "./policy.js";
import { estimateTokenCount } from "./token-estimate.js";
import { createFallbackPlaceholder } from "./summary-message.js";
import { microcompactToolResults } from "./strategies/micro-compact.js";
import { runSummaryStage } from "./strategies/summary-compact.js";
import {
  iterativeDropUntilUnder,
  trimHistoryHeadUntilUnderBudget,
} from "./strategies/hard-trim.js";
import { RecompactionTracker } from "./post-compact.js";
import {
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_MICRO_COMPACT_RATIO,
  type CompactConfig,
} from "./types.js";

const logger = {
  info: (msg: string) => console.log(`[compact/transform-context] ${msg}`),
  debug: (msg: string) => console.debug(`[compact/transform-context] ${msg}`),
};

/**
 * 统一出口：对齐模型实际上下文上限（含 system 外推余量），并做 API 契约校验
 */
function finalizeHistoryMessages(
  messages: AgentMessage[],
  config: CompactConfig,
  logLabel: string,
  summaryMessage?: AgentMessage,
): AgentMessage[] {
  const maxHist = computeMaxEstimatedHistoryTokens(config);
  const useRoundBased = config.useRoundBasedTrim ?? true;
  let out = stripLeadingOrphanToolResults(messages);
  const before = estimateTokenCount(out);
  if (before <= maxHist) {
    return validateAndRepairMessageSequence(out, logLabel);
  }
  logger.info(`${logLabel}: 估算 tokens=${before} 超过硬预算 ${maxHist}，执行收紧`);
  out = trimHistoryHeadUntilUnderBudget(out, maxHist, summaryMessage, useRoundBased);
  out = iterativeDropUntilUnder(out, maxHist, useRoundBased);
  const after = estimateTokenCount(out);
  if (after > maxHist) {
    logger.info(`收紧后估算 tokens=${after}（仍可能接近上限，已尽力截断）`);
  }
  return validateAndRepairMessageSequence(out, logLabel);
}

/**
 * 创建 Agent.transformContext 的实现
 *
 * 使用方式：
 * ```typescript
 * new Agent({
 *   transformContext: createTransformContext({
 *     contextWindow: 1_000_000,
 *     triggerRatio: 0.78,
 *     keepRecentTurns: 6,
 *     outputReserveTokens: 16_384,
 *     summaryReserveTokens: 8_192,
 *     generateSummary: async (msgs, prompt, signal) => callLlmForSummary(msgs, prompt, signal),
 *   }),
 * })
 * ```
 */
export function createTransformContext(
  config: CompactConfig,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const maxConsecutiveFailures = config.maxConsecutiveFailures ?? 3;
  /** 断路器状态机：连续压缩失败计数（B1 状态机化，替代闭包变量） */
  const breaker = new CircuitBreaker(maxConsecutiveFailures);
  /** 再压缩诊断追踪器（B4） */
  const recompactionTracker = new RecompactionTracker();
  /** 处理轮次计数（每次 transform 调用 +1，供再压缩诊断） */
  let turnCounter = 0;

  const enableMicroCompact = config.enableMicroCompact ?? true;
  const microCompactRatio = config.microCompactRatio ?? DEFAULT_MICRO_COMPACT_RATIO;
  const keepRecentToolResults = config.keepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    if (signal?.aborted) {
      return messages;
    }
    if (messages.length === 0) {
      return messages;
    }
    turnCounter += 1;

    // 去除首部孤立 toolResult 后再估算与压缩
    const working = stripLeadingOrphanToolResults(messages);

    const estimation = checkCompactionNeeded(working, config);

    if (!estimation.needsCompaction) {
      // 第一级 MicroCompact：在 [microCompactRatio, triggerRatio) 区间，
      // 仅清"可压缩工具"的旧结果、保留全部对话（不丢消息、不动 user/assistant/system）。
      if (enableMicroCompact) {
        const microThreshold = Math.floor(config.contextWindow * microCompactRatio);
        if (estimation.totalTokens >= microThreshold) {
          // 用确定性微摘要替代纯占位符，保留原文线索（退出码/行数/首尾行）降低编造。
          const micro = microcompactToolResults(working, keepRecentToolResults, {
            useSummary: true,
          });
          const afterTokens = estimateTokenCount(micro);
          if (afterTokens < estimation.totalTokens) {
            logger.info(
              `MicroCompact 第一级触发: tokens ${estimation.totalTokens} → ${afterTokens}, ` +
                `阈值=${microThreshold}（保留最近 ${keepRecentToolResults} 个工具结果，对话未动）`,
            );
            const finalizedMicro = finalizeHistoryMessages(micro, config, "MicroCompact-第一级");
            const microDiag = recompactionTracker.record(turnCounter);
            config.onCompaction?.({
              tokensBefore: estimation.totalTokens,
              tokensAfter: estimateTokenCount(finalizedMicro),
              threshold: microThreshold,
              messagesBefore: working.length,
              messagesAfter: finalizedMicro.length,
              usedSummary: false,
              strategy: "micro",
              isRecompaction: microDiag.isRecompaction,
              turnsSincePreviousCompact: microDiag.turnsSincePreviousCompact,
              consecutiveFailures: breaker.failures,
            });
            return finalizedMicro;
          }
        }
      }

      const base = working.length === messages.length ? messages : working;
      return finalizeHistoryMessages(base, config, "未触发轮次压缩");
    }

    // 断路器：连续失败超过阈值时跳过压缩，直接硬截断
    if (breaker.tripped) {
      logger.info(
        `断路器触发（连续失败 ${breaker.failures} 次），跳过压缩直接收紧`,
      );
      return finalizeHistoryMessages(working, config, "断路器-硬截断");
    }

    logger.info(
      `触发上下文压缩, 估算 tokens=${estimation.totalTokens}, ` +
        `阈值=${estimation.threshold}, 消息数=${working.length}`,
    );

    // 分割消息
    const { oldMessages, recentMessages } = partitionMessages(working, config.keepRecentTurns);

    if (oldMessages.length === 0) {
      logger.debug("无可压缩的旧消息，跳过");
      return finalizeHistoryMessages(working, config, "无旧段可截断");
    }

    if (recentMessages.length === 0) {
      logger.debug("压缩后无保留段（可能均为工具消息），跳过");
      return finalizeHistoryMessages(working, config, "无保留段");
    }

    if (signal?.aborted) {
      return finalizeHistoryMessages(working, config, "abort");
    }

    // 尝试 LLM 摘要（含 PTL 重试，B2）；未注入 generateSummary 时返回 null 走占位降级
    const stage = await runSummaryStage(oldMessages, config, signal);
    let summaryMessage = stage.summaryMessage;
    if (summaryMessage) {
      breaker.recordSuccess();
    } else if (stage.failed) {
      breaker.recordFailure();
    }

    // 降级：使用占位摘要
    if (!summaryMessage) {
      summaryMessage = createFallbackPlaceholder(oldMessages);
    }

    // 压缩后上下文重建钩子（B4 骨架，可选注入；未注入或失败时不影响主流程）
    let attachments: AgentMessage[] = [];
    if (config.postCompactRebuild?.buildAttachments) {
      try {
        attachments =
          (await config.postCompactRebuild.buildAttachments({
            oldMessages,
            recentMessages,
            strategy: "summary",
          })) ?? [];
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.info(`压缩后重建钩子失败（忽略，不影响压缩）: ${errMsg}`);
        attachments = [];
      }
    }

    const compacted = [summaryMessage, ...attachments, ...recentMessages];

    // 先做 finalizeHistoryMessages，再计算 tokensAfter，确保数字反映实际最终状态
    const finalized = finalizeHistoryMessages(compacted, config, "轮次压缩后", summaryMessage);
    const afterEstimation = checkCompactionNeeded(finalized, config);

    logger.info(
      `压缩完成: ${working.length} 条消息 → ${finalized.length} 条 ` +
        `(截断了 ${oldMessages.length} 条旧消息，保留最近 ${recentMessages.length} 条)` +
        `, tokens: ${estimation.totalTokens} → ${afterEstimation.totalTokens}`,
    );

    const summaryDiag = recompactionTracker.record(turnCounter);
    config.onCompaction?.({
      tokensBefore: estimation.totalTokens,
      tokensAfter: afterEstimation.totalTokens,
      threshold: estimation.threshold,
      messagesBefore: working.length,
      messagesAfter: finalized.length,
      usedSummary: Boolean(stage.summaryMessage),
      ptlRetries: stage.ptlRetries,
      strategy: "summary",
      isRecompaction: summaryDiag.isRecompaction,
      turnsSincePreviousCompact: summaryDiag.turnsSincePreviousCompact,
      consecutiveFailures: breaker.failures,
    });

    return finalized;
  };
}
