/**
 * 开机卡住态（Stall）纯逻辑。
 *
 * 与 DOM / Canvas 解耦，便于单测；视觉层只负责调用与展示。
 */

/** 同一阶段无新进度多久后进入卡住态（毫秒） */
export const STALL_MS = 6000

/**
 * 是否应进入卡住态。
 *
 * 完成后不再进入；阈值用闭区间，刚好到 STALL_MS 即算卡住。
 */
export function shouldEnterStall(
  now: number,
  lastPhaseAt: number,
  options: { completed?: boolean; stallMs?: number } = {},
): boolean {
  if (options.completed) return false
  const threshold = options.stallMs ?? STALL_MS
  return now - lastPhaseAt >= threshold
}

/**
 * 卡住态阶段文案：友好名 + 已等待秒数。
 *
 * @param label 阶段友好名；空则回退「等待启动信号」
 * @param waitedSec 已等待整秒（向下取整，至少 0）
 */
export function formatStallPhaseText(label: string, waitedSec: number): string {
  const name = label.trim() || '等待启动信号'
  const sec = Math.max(0, Math.floor(waitedSec))
  return `仍在：${name} · 已等待 ${sec}s`
}

/**
 * 是否允许兜底时间曲线推高进度。
 *
 * 卡住态必须关掉假爬升，否则会出现「已等待」文案与进度条同向前进的矛盾。
 */
export function shouldApplyFallbackCurve(state: {
  completed: boolean
  hasRealProgress: boolean
  stalled: boolean
}): boolean {
  return !state.completed && !state.hasRealProgress && !state.stalled
}
