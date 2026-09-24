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

import { truncate } from '../../agent-runtime/cron-notify-format.js'
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
/** 超长截断的尾部提示（微信分段与飞书卡片共用） */
const OVERFLOW_NOTE = '…（内容过长已截断）'

export interface FeishuCardJson {
  config: { wide_screen_mode: boolean }
  header: { template: string; title: { tag: 'plain_text'; content: string } }
  elements: Array<{ tag: 'div'; text: { tag: 'lark_md'; content: string } } | { tag: 'hr' }>
}

/**
 * 行内记号降级（保守版）。
 *
 * 不复用 cron-notify-format.markdownToPlainText：它的斜体规则 `(\*|_)(.*?)\1`
 * 会把词内记号当斜体吞掉（user_id_x → useridx、__init__ → init），技术类
 * 回复会静默失真。这里只处理明确成对、被词边界包围的记号；`__` 粗体不处理
 * （dunder 变量名远多于该写法）。
 */
function stripInlineMarkdown(text: string): string {
  return text
    // 图片先于链接处理，否则 ![alt](url) 会剩一个孤立的 !
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接保留文字：URL 在手机上点不了，只占地方
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // 单星/单下划线：只认被空白或标点包围、且紧贴内容的成对记号（词内记号原样保留）
    .replace(/(^|[\s(（「])_(?!\s)([^_\n]+?)(?<!\s)_(?=$|[\s)）,.，。!！?？:：;；」])/g, '$1$2')
    .replace(/(^|[\s(（「])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=$|[\s)）,.，。!！?？:：;；」])/g, '$1$2')
    // 行内代码去反引号保内容
    .replace(/`([^`]+)`/g, '$1')
}

/** 整篇 Markdown → 手机可读纯文本（块渲染拼接，行内保护与微信一致）。 */
function plainTextOf(md: string): string {
  return parseMarkdownBlocks(md)
    .map(blockToMobileText)
    .filter((s) => s.trim().length > 0)
    .join('\n\n')
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
  const prefix = t ? `【${stripInlineMarkdown(t)}】\n` : ''
  const fallbackText = truncate(prefix + plainTextOf(md), FEISHU_TEXT_MAX_CHARS)

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
  // 正文没有可放卡片的文本（如全文只有一个标题）：空卡片会被飞书拒绝，直接走 text
  if (rest.every((b) => b.kind === 'hr' || !blockToLarkMd(b).trim())) {
    return { kind: 'text', text: fallbackText }
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
      text: { tag: 'lark_md', content: OVERFLOW_NOTE },
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
  let body = plainTextOf(md)
  const t = title?.trim()
  if (t) body = `【${stripInlineMarkdown(t)}】\n\n${body}`
  const segments = packSegments(body, WEIXIN_SEGMENT_MAX_CHARS, WEIXIN_MAX_SEGMENTS)
  if (segments.length === 0) {
    // 极端输入（纯分隔线/只有标记没有正文）编译为空：非空原文退回原样，保证有内容可发
    const raw = md.trim()
    return raw ? [raw] : []
  }
  return segments
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
      return b.rows.map((r) => r.map((c) => stripInlineMarkdown(c)).join(' | ')).join('\n')
    case 'hr':
      return '---'
  }
}

/** 块 → 微信手机友好文本。 */
function blockToMobileText(b: MdBlock): string {
  switch (b.kind) {
    case 'heading':
      return `【${stripInlineMarkdown(b.text)}】`
    case 'paragraph':
      return stripInlineMarkdown(b.text)
    case 'list':
      return b.items
        .map((it, i) => (b.ordered ? `${i + 1}. ${stripInlineMarkdown(it)}` : `· ${stripInlineMarkdown(it)}`))
        .join('\n')
    case 'quote':
      return stripInlineMarkdown(b.text)
    case 'code':
      return b.text
    case 'table':
      return b.rows.map((r) => r.map((c) => stripInlineMarkdown(c)).join(' | ')).join('\n')
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
    segments[segments.length - 1] = `${segments[segments.length - 1]}\n${OVERFLOW_NOTE}`
  }
  return segments
}
