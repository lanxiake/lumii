/**
 * Token Budget — 单 turn token 预算跟踪与决策
 *
 * 移植自 Claude Code Rev tokenBudget.ts，用于在 Agent 多轮对话中：
 * - 当 token 消耗低于阈值时注入 nudge 消息推动继续工作
 * - 当 token 消耗超过阈值或连续 3 轮递减低于 500 tokens 时停止
 *
 * **核心语义**：
 * - COMPLETION_THRESHOLD = 0.9：达到预算 90% 强停
 * - DIMINISHING_THRESHOLD = 500：连续 3 轮增量低于 500 tokens 视为边际递减，强停
 * - 每轮 turn_end 检查一次，决策为 continue（注入 nudge）或 stop（不再注入）
 */

const COMPLETION_THRESHOLD = 0.9;
const DIMINISHING_THRESHOLD = 500;

export interface BudgetTracker {
  /** 已触发的 continuation 次数（每次 continue 决策 +1） */
  continuationCount: number;
  /** 上次检查时的增量 tokens */
  lastDeltaTokens: number;
  /** 上次检查时的全局累积 tokens */
  lastGlobalTurnTokens: number;
  /** 跟踪器创建时间戳（用于计算总耗时） */
  startedAt: number;
}

export function createBudgetTracker(): BudgetTracker {
  return {
    continuationCount: 0,
    lastDeltaTokens: 0,
    lastGlobalTurnTokens: 0,
    startedAt: Date.now(),
  };
}

export interface ContinueDecision {
  action: "continue";
  /** 注入到 followUp 的 nudge 消息（提醒 LLM 继续工作、不要总结） */
  nudgeMessage: string;
  continuationCount: number;
  pct: number;
  turnTokens: number;
  budget: number;
}

export interface StopDecision {
  action: "stop";
  /** 非 null 时表示因预算触发停止，可用于遥测上报 */
  completionEvent: {
    continuationCount: number;
    pct: number;
    turnTokens: number;
    budget: number;
    /** 是否因边际递减停止（连续 3 轮低于 500 tokens） */
    diminishingReturns: boolean;
    durationMs: number;
  } | null;
}

export type TokenBudgetDecision = ContinueDecision | StopDecision;

/**
 * 检查 token 预算并决策是否继续
 *
 * @param tracker - 预算跟踪器（可变状态，会原地更新）
 * @param agentId - 子 Agent ID（非 null 时跳过预算检查，避免子 Agent 继承父预算）
 * @param budget - token 预算上限（null/0/负数时跳过检查）
 * @param globalTurnTokens - 当前累积消耗的 tokens（从 turn_end.message.usage.totalTokens 获取）
 * @returns 决策对象（continue=注入 nudge / stop=停止）
 */
export function checkTokenBudget(
  tracker: BudgetTracker,
  agentId: string | undefined,
  budget: number | null,
  globalTurnTokens: number,
): TokenBudgetDecision {
  // 跳过子 Agent 和无效预算
  if (agentId || budget === null || budget <= 0) {
    return { action: "stop", completionEvent: null };
  }

  const turnTokens = globalTurnTokens;
  const pct = Math.round((turnTokens / budget) * 100);
  const deltaSinceLastCheck = globalTurnTokens - tracker.lastGlobalTurnTokens;

  // 边际递减检测：连续 3 轮增量均低于阈值 → 停止
  const isDiminishing =
    tracker.continuationCount >= 3 &&
    deltaSinceLastCheck < DIMINISHING_THRESHOLD &&
    tracker.lastDeltaTokens < DIMINISHING_THRESHOLD;

  // 未达到边际递减 且 未达 90% 预算 → 继续（注入 nudge）
  if (!isDiminishing && turnTokens < budget * COMPLETION_THRESHOLD) {
    tracker.continuationCount++;
    tracker.lastDeltaTokens = deltaSinceLastCheck;
    tracker.lastGlobalTurnTokens = globalTurnTokens;
    return {
      action: "continue",
      nudgeMessage: getBudgetContinuationMessage(pct, turnTokens, budget),
      continuationCount: tracker.continuationCount,
      pct,
      turnTokens,
      budget,
    };
  }

  // 达到边际递减 或 已触发过 continuation（现在超限）→ 停止
  if (isDiminishing || tracker.continuationCount > 0) {
    return {
      action: "stop",
      completionEvent: {
        continuationCount: tracker.continuationCount,
        pct,
        turnTokens,
        budget,
        diminishingReturns: isDiminishing,
        durationMs: Date.now() - tracker.startedAt,
      },
    };
  }

  // 其他情况（budget 存在但从未触发 continuation）→ 静默停止
  return { action: "stop", completionEvent: null };
}

/**
 * 生成预算 continuation nudge 消息（注入到 followUp，推动 Agent 继续工作）
 *
 * @param pct - 当前预算消耗百分比
 * @param turnTokens - 当前累积 tokens
 * @param budget - 预算上限
 * @returns nudge 消息文本（英文，对齐 CCR）
 */
export function getBudgetContinuationMessage(
  pct: number,
  turnTokens: number,
  budget: number,
): string {
  const fmt = (n: number): string => new Intl.NumberFormat("en-US").format(n);
  return `Stopped at ${pct}% of token target (${fmt(turnTokens)} / ${fmt(budget)}). Keep working — do not summarize.`;
}
