/**
 * 长文按引擎单次上限打包成合成段。
 *
 * 句子尽量合并（段越少越快，句间韵律也更连贯），但每段不超过 maxChars；
 * 首段单独收紧到 firstMax：首段要当音色锚点，参考音超过 30 秒会被拒收，
 * 中文约 4 字/秒，80 字约 20 秒。
 */
export function packTtsSegments(sentences: string[], maxChars: number, firstMax = 80): string[] {
  const out: string[] = []
  let cur = ''
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    const limit = out.length === 0 ? Math.min(firstMax, maxChars) : maxChars
    if (cur && cur.length + s.length > limit) {
      out.push(cur)
      cur = s
    } else {
      cur += s
    }
  }
  if (cur) out.push(cur)
  return out
}
