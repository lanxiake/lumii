/**
 * 开机高潮判定（纯函数）。
 *
 * cognition / gate 的视觉与音效档位由此决定，便于单测且避免
 * boot-visual 与 early-splash 各写一套阈值。
 */

/** 高潮相关幕名 */
export type ClimaxAct = 'cognition' | 'gate'

/** 阶段推进时的音效档 */
export type BootAudioCue = 'pulse' | 'climax' | 'none'

/**
 * 按阶段进度选音效档：后段 cognition 用加重脉冲，其余普通嘀声。
 */
export function audioCueForProgress(index: number, total: number): BootAudioCue {
  if (total <= 0 || index <= 0) return 'none'
  const r = index / total
  // 与 actForPhase 的 cognition 窗对齐（r > 0.73）
  if (r > 0.73 && r < 1) return 'climax'
  return 'pulse'
}

/**
 * cognition 粒子向心拉力（0～1+）；非高潮或卡住时为 0。
 */
export function cognitionPullStrength(options: {
  act: string
  stalled: boolean
  beatPhase: number
}): number {
  if (options.stalled || options.act !== 'cognition') return 0
  const thump = Math.pow(1 - options.beatPhase, 4)
  return 0.55 + thump * 1.35
}

/**
 * 核心光晕倍率：cognition 加重，其余保持 1。
 */
export function coreGlowMultiplier(act: string, stalled: boolean): number {
  if (stalled) return 1.15
  if (act === 'cognition') return 1.45
  if (act === 'gate') return 1.1
  return 1
}
