/**
 * SRT 字幕生成（UTF-8）
 */

/** 毫秒 → SRT 时间码 HH:MM:SS,mmm */
export function formatSrtTimestamp(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms))
  const h = Math.floor(clamped / 3_600_000)
  const m = Math.floor((clamped % 3_600_000) / 60_000)
  const s = Math.floor((clamped % 60_000) / 1000)
  const milli = clamped % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`
}

export interface SrtCue {
  startMs: number
  endMs: number
  text: string
}

/**
 * 将 cues 转为 SRT 文本（UTF-8，条目间空行分隔）。
 * 跳过空文本；若 endMs <= startMs 则 endMs = startMs + 1。
 */
export function cuesToSrt(cues: SrtCue[]): string {
  const blocks: string[] = []
  let index = 1
  for (const cue of cues) {
    const text = (cue.text ?? '').trim()
    if (!text) continue
    const start = Math.max(0, cue.startMs)
    const end = cue.endMs > start ? cue.endMs : start + 1
    blocks.push(
      `${index}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}`,
    )
    index += 1
  }
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : ''
}
