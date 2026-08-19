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
