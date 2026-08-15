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

/** 解析 SRT 时间码为毫秒；非法返回 null */
function parseSrtTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{1,3})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const s = Number(m[3])
  const ms = Number(m[4].padEnd(3, '0'))
  if (![h, min, s, ms].every((n) => Number.isFinite(n))) return null
  return h * 3_600_000 + min * 60_000 + s * 1000 + ms
}

/**
 * 解析 SRT 文本为 cues（跳过非法块；多行文本用 \\n 连接）。
 */
export function parseSrt(content: string): SrtCue[] {
  if (!content || !content.trim()) return []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalized.split(/\n\s*\n/)
  const cues: SrtCue[] = []

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, idx, arr) => !(idx === 0 && l.trim() === '') && !(idx === arr.length - 1 && l.trim() === ''))
    if (lines.length < 2) continue

    let arrowLineIdx = 0
    if (/^\d+$/.test(lines[0].trim())) {
      arrowLineIdx = 1
    }
    const arrowLine = lines[arrowLineIdx]
    if (!arrowLine) continue
    const arrow = arrowLine.match(
      /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/,
    )
    if (!arrow) continue
    const startMs = parseSrtTimestamp(arrow[1])
    const endMs = parseSrtTimestamp(arrow[2])
    if (startMs == null || endMs == null) continue
    const text = lines
      .slice(arrowLineIdx + 1)
      .join('\n')
      .trim()
    if (!text) continue
    cues.push({
      startMs,
      endMs: endMs > startMs ? endMs : startMs + 1,
      text,
    })
  }
  return cues
}
