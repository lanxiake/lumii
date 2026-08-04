/**
 * mouth-waveform — 口型开合波形（纯函数，pet-core）
 *
 * 从 apps/windows PetFakeLipSync 抽出的**纯波形算法**：按时间 t（秒）合成 0~1 的
 * 嘴开度。带 requestAnimationFrame 的驱动循环与渲染副作用留在各端渲染层
 * （Windows renderer / mobile WebView），它们调用本纯函数取每帧目标开度。
 *
 * 这样 Windows 已验证的口型手感（多正弦叠加 + 半波整流）在两端一致，且可单测。
 */

/** 基础张合频率（Hz）——每秒约开合 3.5 次，接近自然语速 */
export const MOUTH_BASE_FREQ_HZ = 3.5;
/** 叠加的次谐波频率（Hz），让节奏不机械 */
export const MOUTH_SUB_FREQ_HZ = 7.0;
/** 平滑系数（指数移动平均，与真口型一致的手感） */
export const MOUTH_SMOOTHING = 0.5;

/**
 * 按时间 t（秒）合成 0~1 的嘴开度。多正弦叠加，半波整流到非负。
 * 纯函数：相同 t 恒返回相同值。
 */
export function computeMouthOpen(t: number): number {
  const TWO_PI = Math.PI * 2;
  const primary = Math.sin(t * MOUTH_BASE_FREQ_HZ * TWO_PI);
  const sub = 0.4 * Math.sin(t * MOUTH_SUB_FREQ_HZ * TWO_PI);
  // 半波整流到 0~1，再压一点幅度避免一直大张嘴
  const raw = (primary + sub + 1.4) / 2.8;
  return Math.max(0, Math.min(1, raw * 1.15));
}

/**
 * 指数移动平均平滑：把上一帧值向目标值逼近，消除口型抖动。
 * prev 与 target 均 0~1；smoothing 越大越平滑（默认 MOUTH_SMOOTHING）。
 */
export function smoothMouthValue(prev: number, target: number, smoothing = MOUTH_SMOOTHING): number {
  return prev * smoothing + target * (1 - smoothing);
}
