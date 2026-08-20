/**
 * idle-trigger —— Idle Compaction 触发纯谓词
 *
 * 移植 Hermes _should_idle_compact（turn_context.py:L368-L400）。
 * 4 条件 AND，纯函数可单测。
 */

/**
 * Idle Compaction 触发判断：纯谓词，4 条件 AND
 *
 * @returns true 表示可以跑后台压缩
 */
export function shouldIdleCompact(params: {
  enabled: boolean;
  idleAfterSeconds: number;
  idleGapSeconds: number; // 实际挂钟间隙 = now - lastActivityAt
  tokens: number; // 当前会话估算 tokens
  floorTokens: number; // 目标地板（比这个小就不压）
  cooldownActive: boolean; // 是否在失败冷却中（Phase3 才启用，Phase2 恒 false）
}): boolean {
  const { enabled, idleAfterSeconds, idleGapSeconds, tokens, floorTokens, cooldownActive } = params;
  // ① 开关未开/0 → 不做
  if (!enabled || idleAfterSeconds <= 0) return false;
  // ② 挂钟间隙未到 → 不做
  if (idleGapSeconds < idleAfterSeconds) return false;
  // ③ 冷却中 → 不做
  if (cooldownActive) return false;
  // ④ 上下文比地板还小 → 不压
  return tokens > floorTokens;
}

/** 一次 idle 压缩之后应施加的冷却时长（ms）；0 = 不冷却 */
export const IDLE_COOLDOWN_FAILURE_MS = 10 * 60_000;
export const IDLE_COOLDOWN_LOW_YIELD_MS = 30 * 60_000;

/**
 * 一次 idle 压缩结束后该冷却多久：纯函数，便于单测。
 *
 * 事务 ROLLBACK 只返回 success=false 而不抛异常，若按收益分支处理会被误判成
 * 「收益过低」冷却 30min，掩盖 DB 故障。故失败优先判定。
 */
export function decideIdleCooldownMs(result: {
  success: boolean;
  tokensBefore: number;
  tokensAfter: number;
  minReclaimTokens?: number;
  minReclaimRatio?: number;
}): { cooldownMs: number; reason: string } {
  const { success, tokensBefore, tokensAfter } = result;
  if (!success) {
    return { cooldownMs: IDLE_COOLDOWN_FAILURE_MS, reason: '压缩未成功（事务回滚或无可压缩内容）' };
  }
  const reclaimed = tokensBefore - tokensAfter;
  const ratio = tokensBefore > 0 ? reclaimed / tokensBefore : 0;
  const minTokens = result.minReclaimTokens ?? 4096;
  const minRatio = result.minReclaimRatio ?? 0.1;
  if (reclaimed < minTokens || ratio < minRatio) {
    return {
      cooldownMs: IDLE_COOLDOWN_LOW_YIELD_MS,
      reason: `收益过低：回收 ${reclaimed} tokens / ${(ratio * 100).toFixed(1)}%`,
    };
  }
  return { cooldownMs: 0, reason: '' };
}
