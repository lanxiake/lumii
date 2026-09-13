/**
 * 渠道消息编译器：把 Markdown 正文编译成各渠道最优发送形态。
 *
 * 各渠道能力不同，用户主要是在手机上看这些消息：
 * - 飞书：短文本走 text 消息；报告类（有标题结构或超长）走 interactive 卡片
 * - 企微 / QQ：协议原生支持 Markdown，清洗到各自语法子集后直发
 * - 微信：iLink 协议无富文本，编译成手机友好纯文本并按段落打包分段
 *
 * 纯函数、可独立单测；调用方（login service / provider / adapter）
 * 只负责把编译结果交给协议层发送。
 */

import { markdownToPlainText, truncate } from '../../agent-runtime/cron-notify-format.js'
import { parseMarkdownBlocks, type MdBlock } from './markdown-blocks.js'

/** 飞书超过此长度或有标题结构就走卡片；短对话消息维持 text */
const FEISHU_CARD_MIN_CHARS = 500
/** 飞书卡片正文上限（卡片 JSON ≤30KB，中文按 UTF-8 三字节/字留足结构开销） */
const FEISHU_CARD_MAX_CHARS = 5000
/** 飞书 text 消息正文兜底上限（短文本分支的保险丝，正常远达不到） */
const FEISHU_TEXT_MAX_CHARS = 3000
/** 企微 markdown 消息上限 */
const WECOM_MAX_CHARS = 4000
/** QQ 单条 Markdown 上限：被动回复窗口内每轮回复条数有限，编译必须单条 */
const QBOT_MAX_CHARS = 3500
/** 微信单段上限 */
const WEIXIN_SEGMENT_MAX_CHARS = 1000
/** 微信单次最多段数，超出截断（连发过多条易打扰） */
const WEIXIN_MAX_SEGMENTS = 5
/** 微信超长截断的尾部提示 */
const WEIXIN_OVERFLOW_NOTE = '…（内容过长，完整报告请在客户端查看）'

export interface FeishuCardJson {
  config: { wide_screen_mode: boolean }
  header: { template: string; title: { tag: 'plain_text'; content: string } }
  elements: Array<{ tag: 'div'; text: { tag: 'lark_md'; content: string } } | { tag: 'hr' }>
}

export type FeishuCompiled =
  | { kind: 'text'; text: string }
  /** fallbackText 供卡片发送失败时回退 text，避免丢消息 */
  | { kind: 'card'; card: FeishuCardJson; fallbackText: string }

/**
 * 飞书编译：短文本 → 降级纯文本；报告类 → interactive 卡片。
 * header 标题取显式 title，其次首个标题块（并从正文提走，避免重复）。
 */
export function compileForFeishu(md: string, title?: string): FeishuCompiled {
  const blocks = parseMarkdownBlocks(md)
  const useCard = md.length > FEISHU_CARD_MIN_CHARS || blocks.some((b) => b.kind === 'heading')
  const t = title?.trim()
  const prefix = t ? `【${markdownToPlainText(t)}】\n` : ''
  const fallbackText = truncate(prefix + markdownToPlainText(md), FEISHU_TEXT_MAX_CHARS)

  if (!useCard) {
    return { kind: 'text', text: fallbackText }
  }

  let rest = blocks
  let derivedTitle = t ?? ''
  if (!derivedTitle) {
    const idx = blocks.findIndex((b) => b.kind === 'heading')
    if (idx >= 0) {
      derivedTitle = (blocks[idx] as Extract<MdBlock, { kind: 'heading' }>).text
      rest = blocks.filter((_, j) => j !== idx)
    }
  }

  const elements: FeishuCardJson['elements'] = []
  let budget = FEISHU_CARD_MAX_CHARS
  let overflow = false
  for (const b of rest) {
    if (b.kind === 'hr') {
      elements.push({ tag: 'hr' })
      continue
    }
    const content = blockToLarkMd(b)
    if (!content) continue
    if (content.length > budget) {
      if (budget > 60) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: truncate(content, budget) } })
      }
      overflow = true
      break
    }
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } })
    budget -= content.length
  }
  if (overflow) {
    elements.push({ tag: 'hr' })
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '…（内容过长，完整报告请在客户端查看）' },
    })
  }

  return {
    kind: 'card',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: truncate(derivedTitle || '灵栖', 60) },
      },
      elements,
    },
    fallbackText,
  }
}

/** 企微编译：原生 Markdown（语法子集清洗后单条直发）。 */
export function compileForWecom(md: string, title?: string): string {
  return truncate(withTitlePrefix(title) + renderChatMarkdown(md), WECOM_MAX_CHARS)
}

/** QQ 编译：官方 Markdown（msg_type=2），受被动回复条数限制必须单条。 */
export function compileForQbot(md: string, title?: string): string {
  return truncate(withTitlePrefix(title) + renderChatMarkdown(md), QBOT_MAX_CHARS)
}

/**
 * 微信编译：手机友好纯文本 + 段落级分段。
 * 去装饰、列表带序号、标题转【】独立成段；按段打包，超段数上限截断加提示。
 */
export function compileForWeixin(md: string, title?: string): string[] {
  const chunks = parseMarkdownBlocks(md)
    .map(blockToMobileText)
    .filter((c) => c.trim().length > 0)
  let body = chunks.join('\n\n')
  const t = title?.trim()
  if (t) body = `【${markdownToPlainText(t)}】\n\n${body}`
  return packSegments(body, WEIXIN_SEGMENT_MAX_CHARS, WEIXIN_MAX_SEGMENTS)
}

/** 块 → 飞书 lark_md 内容（卡片元素正文）。 */
function blockToLarkMd(b: MdBlock): string {
  switch (b.kind) {
    case 'heading':
      return `**${b.text}**`
    case 'paragraph':
      return b.text
    case 'list':
      return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n')
    case 'quote':
      return b.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'code':
      return b.text
    case 'table':
      return b.rows.map((r) => r.join(' | ')).join('\n')
    case 'hr':
      return ''
  }
}

/** 块 → 企微/QQ 共享的 Markdown 子集（标题/列表/引用保留，表格与代码块降级为文本行）。 */
function blockToChatMarkdown(b: MdBlock): string {
  switch (b.kind) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${b.text}`
    case 'paragraph':
      return b.text
    case 'list':
      return b.items.map((it, i) => (b.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join('\n')
    case 'quote':
      return b.text
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'code':
      return b.text
    case 'table':
      return b.rows.map((r) => r.map((c) => markdownToPlainText(c)).join(' | ')).join('\n')
    case 'hr':
      return '---'
  }
}

/** 块 → 微信手机友好文本。 */
function blockToMobileText(b: MdBlock): string {
  switch (b.kind) {
    case 'heading':
      return `【${markdownToPlainText(b.text)}】`
    case 'paragraph':
      return markdownToPlainText(b.text)
    case 'list':
      return b.items
        .map((it, i) => (b.ordered ? `${i + 1}. ${markdownToPlainText(it)}` : `· ${markdownToPlainText(it)}`))
        .join('\n')
    case 'quote':
      return markdownToPlainText(b.text)
    case 'code':
      return b.text
    case 'table':
      return b.rows.map((r) => r.map((c) => markdownToPlainText(c)).join(' | ')).join('\n')
    case 'hr':
      return ''
  }
}

function withTitlePrefix(title?: string): string {
  const t = title?.trim()
  return t ? `# ${t}\n\n` : ''
}

/** 企微/QQ 共享的整篇渲染。 */
function renderChatMarkdown(md: string): string {
  return parseMarkdownBlocks(md)
    .map(blockToChatMarkdown)
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
}

/**
 * 按行打包成段：单段 ≤max 字；超过 limit 段丢弃剩余并在末段加截断提示。
 * 超长单行先硬切，保证任何输入都能收进上限内。
 */
function packSegments(body: string, max: number, limit: number): string[] {
  const normalized = body.replace(/\n{3,}/g, '\n\n')
  const lines: string[] = []
  for (const line of normalized.split('\n')) {
    if (line.length <= max) {
      lines.push(line)
      continue
    }
    for (let i = 0; i < line.length; i += max) lines.push(line.slice(i, i + max))
  }

  const segments: string[] = []
  let buf: string[] = []
  let len = 0
  let dropped = false

  const flush = () => {
    const text = buf.join('\n').trim()
    buf = []
    len = 0
    if (text) segments.push(text)
  }

  for (const line of lines) {
    if (segments.length >= limit) {
      dropped = true
      break
    }
    const lineLen = line.length + 1
    if (len + lineLen > max && buf.some((l) => l.trim())) {
      flush()
      if (segments.length >= limit) {
        dropped = true
        break
      }
    }
    buf.push(line)
    len += lineLen
  }
  if (!dropped) flush()

  if (dropped && segments.length > 0) {
    segments[segments.length - 1] = `${segments[segments.length - 1]}\n${WEIXIN_OVERFLOW_NOTE}`
  }
  return segments
}
