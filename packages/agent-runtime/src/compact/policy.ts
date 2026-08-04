/**
 * policy —— 压缩阈值计算与触发判断
 *
 * 平移自原 context-compactor.ts 的 computeMaxEstimatedHistoryTokens / checkCompactionNeeded。
 * 断路器（CircuitBreaker）状态机化在阶段 B1 进行，本阶段触发逻辑仍由 transform-context 闭包持有。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokenCount } from "./token-estimate.js";
import type { CompactConfig, TokenEstimation } from "./types.js";

/**
 * 计算单次 LLM 调用中，history messages 允许的最大「估算 token」上限。
 * 扣除 output/summary 预留后，再乘 0.75 系数为 system prompt 与 API 计费误差留余量。
 * 不设硬上限，以支持大上下文模型（如 DeepSeek 1M）。
 *
 * 注：原 0.62 系数过于保守，导致压缩目标与触发阈值（0.78）差距仅 18K，
 * 每次压缩释放空间极少。提升至 0.75 后，压缩目标约为触发阈值的 94%，
 * 实际释放空间扩大约 2-3 倍。
 */
export function computeMaxEstimatedHistoryTokens(config: CompactConfig): number {
  const eff = config.contextWindow - config.outputReserveTokens - config.summaryReserveTokens;
  const safe = Math.floor(Math.max(0, eff) * 0.75);
  return Math.max(8_000, safe);
}

/**
 * 检查是否需要压缩
 *
 * 触发判断只看「真实上下文窗口 × triggerRatio」（如 1M × 0.78 = 780k），
 * 对齐模型真实窗口，避免大窗口被过早压缩。
 *
 * 注意：output/summary 预留**不参与触发判断**，它们只在
 * computeMaxEstimatedHistoryTokens 中决定「压缩到多少」。早期把预留计入触发
 * 阈值会导致大窗口下触发点远早于预期（如 25% output 预留使 1M 窗口在 ~56% 即触发）。
 */
export function checkCompactionNeeded(
  messages: AgentMessage[],
  config: CompactConfig,
): TokenEstimation {
  const totalTokens = estimateTokenCount(messages);
  const threshold = Math.floor(config.contextWindow * config.triggerRatio);

  return {
    totalTokens,
    threshold,
    needsCompaction: totalTokens >= threshold,
  };
}

/**
 * 断路器 —— 连续压缩失败计数状态机
 *
 * 替代原 createTransformContext 闭包变量 consecutiveFailures，提升为显式状态机
 * 便于单测与未来跨实例复用。语义对齐 claude-code MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES：
 * 上下文不可压缩时（如 prompt_too_long），连续失败超阈值后停止重试，避免每轮浪费 API 调用。
 */
export class CircuitBreaker {
  private _failures = 0;

  constructor(private readonly maxFailures: number) {}

  /** 是否已熔断（连续失败达到阈值） */
  get tripped(): boolean {
    return this._failures >= this.maxFailures;
  }

  /** 当前连续失败计数 */
  get failures(): number {
    return this._failures;
  }

  /** 记录一次成功，重置计数 */
  recordSuccess(): void {
    this._failures = 0;
  }

  /** 记录一次失败，计数 +1 */
  recordFailure(): void {
    this._failures += 1;
  }
}
