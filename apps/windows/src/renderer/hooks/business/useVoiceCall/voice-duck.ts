/**
 * 两段式打断的压音门槛（纯逻辑，便于单测）。
 *
 * 为什么不能写死一个绝对值（2026-11-01 计划 §2.6 G3）：
 * 渲染侧原来用固定 `RMS_THRESHOLD = 0.02` 判定"用户开口了，先压音"，而主进程用
 * `baseline × INTERRUPT_RMS_MULTIPLIER` 做确认。安静房间 baseline≈0.003 时两边
 * 差不多，但在嘈杂环境 baseline≈0.03 → 主进程门槛 0.075，而渲染侧在
 * 0.02~0.075 之间会**一直压音却永远等不到确认**，用户听感就是"AI 突然很小声"。
 *
 * 这里改成按当前环境自动估门槛，并夹在 [0.015, 0.06]：
 * - 下限：安静房间的空调/风扇底噪不该触发压音；
 * - 上限：嘈杂环境不会落进"压了但主进程不认"的空档。
 */
export const DUCK_MIN_THRESHOLD = 0.015
export const DUCK_MAX_THRESHOLD = 0.06
export const DUCK_MULTIPLIER = 2.5
/** 压音后等主进程确认的上限：超时就回弹，避免永久小声 */
export const DUCK_TIMEOUT_MS = 1200

export function duckThreshold(floor: number | null): number {
  if (floor === null || !Number.isFinite(floor) || floor <= 0) {
    return DUCK_MAX_THRESHOLD
  }
  return Math.min(DUCK_MAX_THRESHOLD, Math.max(DUCK_MIN_THRESHOLD, floor * DUCK_MULTIPLIER))
}

const WINDOW = 64

/**
 * 播放期间的环境底噪估计（25 分位，与主进程 `NoiseProfiler` 同口径）。
 *
 * 刻意不 import 主进程那份：渲染层不该反向依赖插件实现（跨进程边界的模块
 * 一旦被渲染 bundle 拉进来，打包体积与依赖面都失控）。这里只有十来行分位数，
 * 复制比共享便宜；口径若有变化，两边同改。
 */
export class DuckFloorTracker {
  private frames: number[] = []
  private cursor = 0

  push(rms: number): void {
    if (!Number.isFinite(rms) || rms < 0) return
    if (this.frames.length < WINDOW) {
      this.frames.push(rms)
      return
    }
    this.frames[this.cursor] = rms
    this.cursor = (this.cursor + 1) % WINDOW
  }

  floor(): number | null {
    if (this.frames.length < WINDOW / 2) return null
    const sorted = [...this.frames].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * 0.25)] ?? null
  }

  /** 当前压音门槛；样本不足时先按上限算（宁可少压，不乱压） */
  threshold(): number {
    return duckThreshold(this.floor())
  }

  reset(): void {
    this.frames = []
    this.cursor = 0
  }
}
