/**
 * 智能 cues 生成器：从 timeline 自动计算合理的字幕时间轴
 *
 * 目标：降低 Agent 出错概率，自动处理时间冲突
 */
import type { ScreenRecordMarker, ScreenRecordTimelineEntry } from '../../shared/screen-record'

export interface SmartCue {
  startMs: number
  endMs: number
  text: string
  /** 原始 mark 的 label */
  label: string
  /** 是否为自动合并的结果 */
  merged?: boolean
}

export interface SmartCuesOptions {
  /** 总视频时长(ms) */
  durationMs: number
  /** 相邻 cues 最小间隔(ms)，小于此值自动合并。默认 800 */
  minGapMs?: number
  /** 每段结尾缓冲时间(ms)，为下一段留白。默认 300 */
  bufferMs?: number
  /** 首个 mark 超过此值时在开头补开场白。默认 1500 */
  addOpeningThresholdMs?: number
  /** 开场白文本生成函数 */
  generateOpeningText?: (firstLabel: string) => string
}

/**
 * 从 timeline 中的 markers 智能生成 cues。
 *
 * 自动处理：
 * 1. 过短间隔合并（< minGapMs）
 * 2. 添加缓冲时间避免 TTS 截断
 * 3. 首段前补开场白（可选）
 * 4. 最后一段自动对齐视频结尾
 */
export function generateSmartCues(
  timeline: ScreenRecordTimelineEntry[],
  options: SmartCuesOptions,
): SmartCue[] {
  const {
    durationMs,
    minGapMs = 800,
    bufferMs = 300,
    addOpeningThresholdMs = 1500,
    generateOpeningText,
  } = options

  const markers = timeline
    .filter((entry): entry is ScreenRecordMarker => entry.entryType === 'marker')
    .sort((a, b) => a.atMs - b.atMs)

  if (markers.length === 0) return []

  const result: SmartCue[] = []

  // 补开场白
  const firstMark = markers[0]!
  if (firstMark.atMs > addOpeningThresholdMs && generateOpeningText) {
    result.push({
      startMs: 0,
      endMs: firstMark.atMs,
      text: generateOpeningText(firstMark.label),
      label: '[开场]',
    })
  }

  // 逐段生成，自动合并过短间隔
  for (let i = 0; i < markers.length; i++) {
    const curr = markers[i]!
    const next = markers[i + 1]

    // 计算理想 endMs：下一段开始前留缓冲，或视频结尾
    let idealEndMs: number
    if (next) {
      idealEndMs = next.atMs - bufferMs
    } else {
      idealEndMs = durationMs
    }

    // 检查是否需要与前一段合并
    const prevCue = result[result.length - 1]
    if (prevCue) {
      const gap = curr.atMs - prevCue.startMs // 与前段开始时间的间隔
      if (gap < minGapMs) {
        // 合并到前一段
        prevCue.endMs = idealEndMs
        prevCue.text += ` ${curr.label}` // 简单拼接，实际使用时 Agent 会覆盖
        prevCue.label += ` + ${curr.label}`
        prevCue.merged = true
        continue // 跳过，不创建新段
      }
    }

    // 新建独立段
    result.push({
      startMs: curr.atMs,
      endMs: idealEndMs,
      text: curr.label, // 占位，Agent 需扩写成完整旁白
      label: curr.label,
    })
  }

  return result
}

/**
 * 根据 TTS 实际时长调整 cues，确保不重叠。
 *
 * 策略：
 * 1. 每段 cue 的实际结束时间 = startMs + TTS 实际时长
 * 2. 若与下一段冲突，压缩下一段的 startMs（整体后移）
 * 3. 返回调整后的 cues 和时间偏移报告
 */
export function alignCuesWithActualDuration(
  cues: Array<{ startMs: number; text: string; audioPath?: string }>,
  actualDurations: Map<string, number>, // audioPath -> durationMs
): {
  aligned: Array<{ startMs: number; endMs: number; text: string; audioPath?: string }>
  adjustments: Array<{ index: number; originalStart: number; adjustedStart: number; reason: string }>
} {
  const aligned: Array<{ startMs: number; endMs: number; text: string; audioPath?: string }> = []
  const adjustments: Array<{ index: number; originalStart: number; adjustedStart: number; reason: string }> = []

  let accumulatedDelay = 0 // 累积的时间偏移

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!
    const originalStart = cue.startMs
    const adjustedStart = originalStart + accumulatedDelay

    // 获取 TTS 实际时长（若无 audioPath 则估算）
    const actualDur = cue.audioPath
      ? actualDurations.get(cue.audioPath) ?? Math.round((cue.text.length / 4) * 1000)
      : Math.round((cue.text.length / 4) * 1000)

    const actualEnd = adjustedStart + actualDur

    // 检查与下一段的冲突
    const nextCue = cues[i + 1]
    if (nextCue) {
      const nextOriginalStart = nextCue.startMs + accumulatedDelay
      if (actualEnd > nextOriginalStart) {
        // 冲突：需要延迟下一段
        const conflict = actualEnd - nextOriginalStart
        accumulatedDelay += conflict + 200 // 额外留 200ms 缓冲
        adjustments.push({
          index: i + 1,
          originalStart: nextCue.startMs,
          adjustedStart: nextCue.startMs + accumulatedDelay,
          reason: `避免与前段重叠(冲突${conflict}ms)`,
        })
      }
    }

    aligned.push({
      startMs: adjustedStart,
      endMs: actualEnd,
      text: cue.text,
      audioPath: cue.audioPath,
    })
  }

  return { aligned, adjustments }
}
