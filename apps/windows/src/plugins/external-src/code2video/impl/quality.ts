/**
 * 画质档位：草稿要快，成片要好。
 *
 * ## 为什么分档而不是固定
 *
 * 实测一节 12fps 渲染约 35 秒、24fps 约 70 秒。草稿阶段用户只想确认「讲法对不对」，
 * 用 24fps 等于让他在看不见画质差别的地方多等一倍。
 *
 * 反过来，成片如果还是 12fps，元素移动时肉眼能看出顿挫——文字动画够用，
 * 但「一个方块滑过去」在 12fps 下只有 4~5 个中间帧。
 *
 * ## 为什么音量要单独管
 *
 * 改了帧率/编码不影响音量，但**多句配音用 amix 叠加时会互压**：
 * 2018 年那份 ffmpeg 的 amix 没有 normalize 选项，几路信号直接相加后
 * 总响度取决于同时有几路在响。句子本来不重叠所以问题不大，
 * 但不同音色的合成响度本来就有差异（实测晓伊比晓晓低 2~3dB）。
 * 所以合成完要统一做一次 loudnorm。
 */

export interface QualityPreset {
  /** 画面帧率 */
  fps: number
  /** libx264 的 CRF：越小越好，18 接近无损，28 明显有块 */
  crf: number
  /** 编码速度档：越慢同画质文件越小 */
  preset: 'veryfast' | 'medium' | 'slow'
  /** 编码线程数（0 = 自动） */
  threads: number
}

/**
 * 三档。
 *
 * - `draft`   草稿验证用：12fps / crf 28 / veryfast。和旧行为一致（旧版就是这组）。
 * - `standard` 默认成片：24fps / crf 20 / medium。翻倍帧率但编码更慢，
 *              单节耗时约 1.6 倍（帧数 ×2，但 medium 比 veryfast 每帧快一点）。
 * - `high`    追求画质：30fps / crf 17 / slow。耗时约 2.5 倍。
 */
export const QUALITY: Record<'draft' | 'standard' | 'high', QualityPreset> = {
  draft: { fps: 12, crf: 28, preset: 'veryfast', threads: 0 },
  standard: { fps: 24, crf: 20, preset: 'medium', threads: 0 },
  high: { fps: 30, crf: 17, preset: 'slow', threads: 0 },
}

export type QualityKey = keyof typeof QUALITY

export function resolveQuality(key: string | undefined): QualityPreset {
  if (key === 'draft' || key === 'high' || key === 'standard') return QUALITY[key]
  return QUALITY.standard
}

/**
 * 统一响度用的目标值。
 *
 * -16 LUFS 是播客/短视频的通行标准；对话内容在 -16~-14 之间都自然。
 * 取 -16 是因为教学视频常有长时间静音（等观众看画面），响度算低了不会刺耳。
 */
export const TARGET_LOUDNESS = { I: -16, TP: -1.5, LRA: 11 } as const

/** loudnorm 滤镜串。两遍法更准，但这里内容短、差异小，单遍足够。 */
export function loudnormFilter(): string {
  return `loudnorm=I=${TARGET_LOUDNESS.I}:TP=${TARGET_LOUDNESS.TP}:LRA=${TARGET_LOUDNESS.LRA}`
}
