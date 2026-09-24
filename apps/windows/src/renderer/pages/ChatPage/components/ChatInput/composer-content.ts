/**
 * composer-content.ts - 富文本输入框的「文本 ↔ 内容」翻译层
 *
 * 输入框从 `<textarea>` 换成 contenteditable 之后，**文本仍然是唯一的对外契约**：
 * 发送、草稿持久化、渠道出站、Agent 解析都只认那段文本。DOM 只是它的一种渲染。
 * 所以这里只有两个方向：
 *
 * - `serializeComposer()`：DOM → 文本（每次输入后取一遍，喂给草稿层）
 * - `parseComposerText()`：文本 → 片段（挂载/切会话时重建 DOM，并把引用还原成 chip）
 *
 * chip 是原子的（`contenteditable=false`），它的文本形态就是它要写进消息里的样子：
 * 引用是 markdown 引用块，文件引用是 `@相对路径`。**这两条格式不能改** ——
 * 前者是消息列表渲染与渠道出站的既有口径，后者是 Agent 侧认路径的依据。
 *
 * 解析是**保守**的：只有能精确反解出我们自己的生成格式时才认 chip，否则一律当普通文本。
 */

import { buildQuoteMarkdown, type QuoteInput } from '../../../../selection/quote-bridge'
import styles from './RichComposer.module.css'
import type { FileReference } from './index'

/** chip 根节点上的判别标记 */
export const CHIP_ATTR = 'data-composer-chip'

interface QuoteChipSpec {
  kind: 'quote'
  input: QuoteInput
}

interface FileChipSpec {
  kind: 'file'
  ref: FileReference
}

type ChipSpec = QuoteChipSpec | FileChipSpec

export type ComposerSegment =
  | { kind: 'text'; text: string }
  | QuoteChipSpec
  | FileChipSpec

/** 文件引用写进消息里的文本形态（Agent 侧按它认路径，不能改） */
function fileToken(ref: FileReference): string {
  return `@${ref.relativePath}`
}

/**
 * 引用块的逐行反解 —— `buildQuoteMarkdown` 的逆。
 *
 * 出处行在**最后一行**，且形状固定（见 quote-bridge 的 sourceLine）。认不出来就整体当正文，
 * 不做猜测：把用户自己写的 `> 引用` 误判成「来自某处」会让出处凭空出现。
 */
export function parseQuoteLines(lines: readonly string[]): QuoteInput | null {
  if (lines.length === 0) return null
  if (!lines.every((line) => line.startsWith('>'))) return null

  let body = lines
  let title: string | undefined
  let role: QuoteInput['role']

  const last = lines[lines.length - 1]
  const titled = /^> —— 来自《(.+)》$/.exec(last)
  if (titled) {
    title = titled[1]
    body = lines.slice(0, -1)
  } else if (last === '> —— 来自助手回复') {
    role = 'assistant'
    body = lines.slice(0, -1)
  } else if (last === '> —— 来自我的提问') {
    role = 'user'
    body = lines.slice(0, -1)
  }

  const text = body.map((line) => (line === '>' ? '' : line.slice(2))).join('\n')
  return { text, title, role }
}

/** 从 `start` 起的一段连续 `>` 行，返回块的结束位置（不含行尾换行；无块时返回 start） */
function endOfQuoteBlock(text: string, start: number): number {
  let cursor = start
  let end = start
  while (cursor < text.length && text[cursor] === '>') {
    const newline = text.indexOf('\n', cursor)
    if (newline === -1) return text.length
    end = newline
    cursor = newline + 1
  }
  return end
}

/**
 * `at` 处是否正好是一个文件引用。
 *
 * 取**最长匹配**（`workspace/src` 与 `workspace/src/a.ts` 同时在册时不能被短的抢先），
 * 并要求后面是空白或结束 —— 否则 `@a/b` 会命中 `@a/bc` 的前缀。
 */
function matchFileRefAt(text: string, at: number, refs: readonly FileReference[]): FileReference | null {
  let best: FileReference | null = null
  let bestLength = 0
  for (const ref of refs) {
    const token = fileToken(ref)
    if (token.length <= 1 || !text.startsWith(token, at)) continue
    const after = text[at + token.length]
    if (after !== undefined && !/\s/.test(after)) continue
    if (token.length > bestLength) {
      best = ref
      bestLength = token.length
    }
  }
  return best
}

/**
 * 文本 → 片段。原始格式在片段里逐字保留（没有命中的部分原样落进 `text`），
 * 所以 `parseComposerText` 之后重建 DOM 再 `serializeComposer`，得到的仍是同一段文本。
 */
export function parseComposerText(
  text: string,
  fileRefs: readonly FileReference[] = [],
): ComposerSegment[] {
  const segments: ComposerSegment[] = []
  let buffer = ''
  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }

  let i = 0
  while (i < text.length) {
    const atLineStart = i === 0 || text[i - 1] === '\n'

    // 引用块：只在行首（正文中间的 `>` 是普通字符）
    if (atLineStart && text[i] === '>') {
      const end = endOfQuoteBlock(text, i)
      const input = parseQuoteLines(text.slice(i, end).split('\n'))
      if (input && end > i) {
        flush()
        segments.push({ kind: 'quote', input })
        i = end
        continue
      }
    }

    // 文件引用：行首或空白之后，且整段相对路径都在册
    if ((atLineStart || /\s/.test(text[i - 1] ?? '')) && text[i] === '@') {
      const ref = matchFileRefAt(text, i, fileRefs)
      if (ref) {
        flush()
        segments.push({ kind: 'file', ref })
        i += fileToken(ref).length
        continue
      }
    }

    buffer += text[i]
    i += 1
  }

  flush()
  return segments
}

/**
 * DOM → 文本。
 *
 * chip 认 `data-composer-chip` 判别标记而不是「有某个 data 属性」：
 * 判别与取值分开，缺字段时不会把半个 chip 序列化成空串。
 *
 * `trimTrailingBreak` 默认开：浏览器在末尾留的那个 `<br>` 是给光标落脚的，不是内容，
 * 而发送前本来就会 trim，末尾空行没有语义。**量光标偏移时不能开** ——
 * 那里要的是逐字对应的长度。
 */
export function serializeComposer(
  root: Node,
  options: { trimTrailingBreak?: boolean } = {},
): string {
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? ''
      return
    }
    if (!(node instanceof HTMLElement)) return

    const kind = node.getAttribute(CHIP_ATTR)
    if (kind === 'quote') {
      out += buildQuoteMarkdown({
        text: node.getAttribute('data-quote-text') ?? '',
        title: node.getAttribute('data-quote-title') ?? undefined,
        role: (node.getAttribute('data-quote-role') as QuoteInput['role']) ?? undefined,
      })
      return
    }
    if (kind === 'file') {
      out += `@${node.getAttribute('data-file-path') ?? ''}`
      return
    }
    if (node.tagName === 'BR') {
      out += '\n'
      return
    }
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
  if (options.trimTrailingBreak === false) return out
  return out.endsWith('\n') ? out.slice(0, -1) : out
}

/**
 * 文本 → 节点。chip 之外的文本按 `\n` 拆成 text + `<br>`（contenteditable 的常规表示）。
 */
export function buildComposerNodes(segments: readonly ComposerSegment[], doc: Document): Node[] {
  const nodes: Node[] = []
  const pushText = (text: string) => {
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (index > 0) nodes.push(doc.createElement('br'))
      if (line.length > 0) nodes.push(doc.createTextNode(line))
    })
  }

  for (const segment of segments) {
    if (segment.kind === 'text') {
      pushText(segment.text)
      continue
    }
    if (segment.kind === 'quote') {
      nodes.push(createQuoteChipNode(segment.input, doc))
      continue
    }
    nodes.push(createFileChipNode(segment.ref, doc))
  }
  return nodes
}

/** chip 的展示文案：截断的摘要 + 出处，够辨认即可 —— 全文在消息里，输入框里不重复铺开 */
export function quoteChipLabel(input: QuoteInput): string {
  const flat = input.text.replace(/\s+/g, ' ').trim()
  const excerpt = flat.length > 18 ? `${flat.slice(0, 18)}…` : flat
  const source = input.title ? `《${input.title}》` : input.role === 'assistant' ? '助手回复' : input.role === 'user' ? '我的提问' : null
  return source ? `引用 ${excerpt} · 来自${source}` : `引用 ${excerpt}`
}

/** chip 的类名。写在这里是因为 chip 是**命令式**建出来的（React 不管这棵子树），
 *  拿不到 JSX 里的 styles 引用，只能从模块里取。 */
const CHIP_CLASS: Record<ChipSpec['kind'], string> = {
  quote: styles['composer-chip--quote'],
  file: styles['composer-chip--file'],
}

function buildChipShell(doc: Document, kind: ChipSpec['kind']): HTMLSpanElement {
  const chip = doc.createElement('span')
  chip.setAttribute(CHIP_ATTR, kind)
  // 原子：光标进不去，退格整块删
  chip.setAttribute('contenteditable', 'false')
  chip.className = `${styles['composer-chip']} ${CHIP_CLASS[kind]}`
  return chip
}

function appendLabel(chip: HTMLElement, text: string, doc: Document): void {
  const label = doc.createElement('span')
  label.className = styles['composer-chip-label']
  label.textContent = text
  chip.appendChild(label)
}

/**
 * chip 上的 × 按钮。只建结构、不挂监听 —— 点击走根节点的**事件委托**
 * （见 RichComposer 的 handleClick），那样重建 DOM 不会漏挂。
 */
function appendRemoveButton(chip: HTMLElement, label: string, doc: Document): void {
  const button = doc.createElement('button')
  button.type = 'button'
  button.setAttribute('data-chip-remove', '')
  button.className = styles['composer-chip-remove']
  button.setAttribute('aria-label', label)
  button.textContent = '×'
  chip.appendChild(button)
}

export function createQuoteChipNode(input: QuoteInput, doc: Document): HTMLSpanElement {
  const chip = buildChipShell(doc, 'quote')
  chip.setAttribute('data-quote-text', input.text)
  if (input.title) chip.setAttribute('data-quote-title', input.title)
  if (input.role) chip.setAttribute('data-quote-role', input.role)
  // 悬停给全文：chip 上只放摘要，被引的正文不该在输入框里铺开
  chip.title = buildQuoteMarkdown(input)
  appendLabel(chip, quoteChipLabel(input), doc)
  appendRemoveButton(chip, '移除引用', doc)
  return chip
}

export function createFileChipNode(ref: FileReference, doc: Document): HTMLSpanElement {
  const chip = buildChipShell(doc, 'file')
  chip.setAttribute('data-file-path', ref.relativePath)
  chip.title = ref.isDirectory ? `目录引用：${ref.relativePath}` : ref.relativePath
  appendLabel(chip, `${ref.isDirectory ? '目录 ' : ''}${ref.name}`, doc)
  appendRemoveButton(chip, `移除引用 ${ref.name}`, doc)
  return chip
}
