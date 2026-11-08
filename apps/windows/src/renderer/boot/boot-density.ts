/**
 * 开机五幕密度表（纯数据 + 纯函数）。
 *
 * CSS 与 Canvas 都应对齐本表，避免「前段仪表过早全开」。
 */

/** 与 boot-visual 幕名一致 */
export type BootAct = 'dark' | 'dormant' | 'neural' | 'energize' | 'cognition' | 'gate'

/** 单幕的 HUD / 画布密度（0～1） */
export interface ActDensity {
  topbar: number
  telemetry: number
  checks: number
  armor: number
  frame: number
  compass: number
  floor: number
  bar: number
  scanlines: number
  /** Canvas 核心目标亮度 */
  core: number
  /** 能量环绘制强度 */
  rings: number
}

/**
 * 前弱后强密度表。
 *
 * energize 之前环强度为 0；cognition 环略降把戏份让给向心粒子。
 */
export const ACT_DENSITY: Record<BootAct, ActDensity> = {
  dark: {
    topbar: 0.18,
    telemetry: 0,
    checks: 0,
    armor: 0,
    frame: 0,
    compass: 0,
    floor: 0,
    bar: 0,
    scanlines: 0.08,
    core: 0.16,
    rings: 0,
  },
  dormant: {
    topbar: 0.38,
    telemetry: 0,
    checks: 0,
    armor: 0,
    frame: 0,
    compass: 0,
    floor: 0,
    bar: 0.32,
    scanlines: 0.12,
    core: 0.26,
    rings: 0,
  },
  neural: {
    topbar: 0.62,
    telemetry: 0.28,
    checks: 0.22,
    armor: 0.28,
    frame: 0.28,
    compass: 0.18,
    floor: 0.22,
    bar: 0.7,
    scanlines: 0.18,
    core: 0.42,
    rings: 0,
  },
  energize: {
    topbar: 0.88,
    telemetry: 0.62,
    checks: 0.58,
    armor: 0.7,
    frame: 0.68,
    compass: 0.48,
    floor: 0.7,
    bar: 1,
    scanlines: 0.32,
    core: 0.62,
    rings: 1,
  },
  cognition: {
    topbar: 0.95,
    telemetry: 0.92,
    checks: 0.95,
    armor: 1,
    frame: 1,
    compass: 0.9,
    floor: 0.5,
    bar: 1,
    scanlines: 0.48,
    core: 0.88,
    rings: 0.75,
  },
  gate: {
    topbar: 0.95,
    telemetry: 0.92,
    checks: 0.95,
    armor: 1,
    frame: 1,
    compass: 0.9,
    floor: 0.28,
    bar: 1,
    scanlines: 0.32,
    core: 0.55,
    rings: 0.5,
  },
}

/** 前四幕（不含高潮）按叙事顺序 */
export const EARLY_ACTS: BootAct[] = ['dark', 'dormant', 'neural', 'energize']

/**
 * 返回某层在前四幕的密度序列，供单测断言严格递增。
 */
export function earlyDensitySeries(layer: keyof ActDensity): number[] {
  return EARLY_ACTS.map((act) => ACT_DENSITY[act][layer])
}

/**
 * 卡住态核心底光：不低于当前幕，且早幕抬到可读。
 */
export function stalledCoreTarget(act: BootAct): number {
  const base = ACT_DENSITY[act].core
  if (act === 'dark' || act === 'dormant') return Math.max(base, 0.42)
  return Math.max(base, 0.55)
}

/**
 * 正常态核心目标亮度。
 */
export function coreTargetForAct(act: BootAct, stalled: boolean): number {
  return stalled ? stalledCoreTarget(act) : ACT_DENSITY[act].core
}

/**
 * 能量环绘制强度。
 */
export function ringStrengthForAct(act: BootAct): number {
  return ACT_DENSITY[act].rings
}
