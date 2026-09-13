/**
 * Markdown 轻量块提取（行级正则，不上完整 AST）。
 *
 * 推送正文只需要「结构 + 可读性」，不需要保真 —— 与 cron-notify-format
 * 的降级约定一致。块模型是四个渠道编译器的公共输入：
 * 飞书卡片要拆元素、企微/QQ 要清洗语法子集、微信用它做段落聚合。
 */

export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'hr' }

const FENCE_RE = /^(```|~~~)/
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/
const HEADING_RE = /^(#{1,6})\s+(.+)$/
const QUOTE_RE = /^>\s?/
const UL_RE = /^[-*+]\s+/
const OL_RE = /^(\d+)[.)]\s+/
const TABLE_ROW_RE = /^\|.*\|$/
/** 表格分隔行单元格：--- / :--- / ---: / :---: */
const TABLE_SEP_CELL_RE = /^:?-{3,}:?$/

/** 行是否是「块起始」（段落循环遇到即停）。 */
function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HR_RE.test(line) ||
    HEADING_RE.test(line) ||
    QUOTE_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    TABLE_ROW_RE.test(line)
  )
}

export function parseMarkdownBlocks(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // 空行只做块分隔
    if (!trimmed) {
      i++
      continue
    }

    // 围栏代码块：内部行原样收走，不参与其它解析；未闭合时吃到文末
    if (FENCE_RE.test(trimmed)) {
      const marker = trimmed.slice(0, 3)
      i++
      const buf: string[] = []
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        buf.push(lines[i])
        i++
      }
      if (i < lines.length) i++
      blocks.push({ kind: 'code', text: buf.join('\n') })
      continue
    }

    if (HR_RE.test(trimmed)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    const heading = trimmed.match(HEADING_RE)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    // 表格：连续 |...| 行；纯分隔行丢弃（无对齐需求）
    if (TABLE_ROW_RE.test(trimmed)) {
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i].trim())) {
        const cells = lines[i]
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim())
        if (!cells.every((c) => TABLE_SEP_CELL_RE.test(c))) rows.push(cells)
        i++
      }
      blocks.push({ kind: 'table', rows })
      continue
    }

    if (QUOTE_RE.test(trimmed)) {
      const buf: string[] = []
      while (i < lines.length && QUOTE_RE.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(QUOTE_RE, ''))
        i++
      }
      blocks.push({ kind: 'quote', text: buf.join('\n') })
      continue
    }

    // 列表：连续同类列表项合并；序号一律重排（源序号可能全写 1）
    const ordered = OL_RE.test(trimmed)
    if (ordered || UL_RE.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const t = lines[i].trim()
        const m = ordered ? t.match(/^\d+[.)]\s+(.+)$/) : t.match(/^[-*+]\s+(.+)$/)
        if (!m) break
        items.push(m[1].trim())
        i++
      }
      if (items.length > 0) {
        blocks.push({ kind: 'list', ordered, items })
        continue
      }
    }

    // 段落：连续普通行合并，保留软换行
    const buf: string[] = [trimmed]
    i++
    while (i < lines.length) {
      const t = lines[i].trim()
      if (!t || isBlockStart(t)) break
      buf.push(t)
      i++
    }
    blocks.push({ kind: 'paragraph', text: buf.join('\n') })
  }

  return blocks
}
