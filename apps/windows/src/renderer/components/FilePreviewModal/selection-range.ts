/**
 * 把 textarea 的选区偏移映射回磁盘原文（P2 T2）
 *
 * 浏览器会把 textarea 的值按 HTML 规范把 `\r\n` / `\r` 归一化为 `\n`，
 * 而磁盘内容保留 CRLF；`selectionStart/End` 是归一化文本的偏移，直接拿去
 * 替换原文会错位。这里按原始内容的换行长度建立「归一化下标 → 原文下标」映射。
 *
 * 纯函数，单测覆盖 LF / CRLF / 单独 CR。
 */

export interface RawTextSelection {
  /** 原文（磁盘）偏移 */
  start: number
  end: number
  /** 归一化后的选中文本（仅用于展示/日志，不用于写盘） */
  text: string
}

export function mapNormalizedSelectionToRaw(
  content: string,
  start: number,
  end: number,
): RawTextSelection | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) return null

  // rawByNorm[n] = 归一化文本第 n 个字符对应的原文下标
  const rawByNorm: number[] = []
  let index = 0
  while (index < content.length) {
    rawByNorm.push(index)
    if (content[index] === '\r') {
      index += content[index + 1] === '\n' ? 2 : 1
    } else {
      index += 1
    }
  }
  rawByNorm.push(content.length)

  const normalizedLength = rawByNorm.length - 1
  if (end > normalizedLength) return null

  const rawStart = rawByNorm[start]
  const rawEnd = rawByNorm[end]
  if (rawStart === undefined || rawEnd === undefined) return null

  const normalized = content.replace(/\r\n?/g, '\n')
  return { start: rawStart, end: rawEnd, text: normalized.slice(start, end) }
}
