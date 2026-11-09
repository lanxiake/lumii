/**
 * TTS 音频后处理（纯函数）。放在 shared：voice 插件与各引擎插件都要用，插件之间不能互相 import。
 */

/**
 * 把各段 RMS 拉到中位数，增益限制在 [0.5, 2] 且不让峰值超过 0.95（不削波）。
 * ponytail: 整段 RMS 而非 LUFS，段内忽大忽小管不到；需要时换 EBU R128 门限响度。
 */
export function normalizeLoudness(segments: number[][]): number[][] {
  const rms = segments.map((s) =>
    s.length ? Math.sqrt(s.reduce((a, v) => a + v * v, 0) / s.length) : 0,
  )
  const voiced = rms.filter((r) => r > 1e-4).sort((a, b) => a - b)
  if (voiced.length < 2) return segments
  const target = voiced[voiced.length >> 1]!
  return segments.map((s, i) => {
    if (rms[i]! <= 1e-4) return s
    const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    const gain = Math.min(Math.max(target / rms[i]!, 0.5), 2, peak > 0 ? 0.95 / peak : 2)
    return Math.abs(gain - 1) < 0.02 ? s : s.map((v) => v * gain)
  })
}

/** 多段 PCM 按顺序拼接，段间插入静音（句间自然停顿，也避免首尾直接相接的爆音） */
export function concatWithGaps(segments: number[][], sampleRate: number, gapSec = 0.2): Float32Array {
  const gap = Math.round(sampleRate * gapSec)
  const voiced = segments.filter((s) => s.length > 0)
  const total = voiced.reduce((n, s) => n + s.length, 0) + gap * Math.max(0, voiced.length - 1)
  const out = new Float32Array(total)
  let offset = 0
  voiced.forEach((s, i) => {
    if (i > 0) offset += gap
    out.set(s, offset)
    offset += s.length
  })
  return out
}
