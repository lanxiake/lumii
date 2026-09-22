/**
 * quote-bridge.ts - 引用投递桥
 *
 * 引用是「把一段文字投递到当前输入框」，不是「同步一份状态」——所以用模块级注册桥，
 * 而不是把 Composer 草稿抽成全局 store。SelectionLayer 挂在 GlobalModals（全局），
 * ChatInput 只在对话页存在，两者的交汇点就是这里。
 *
 * 没有 sink（不在对话页）时 insertQuote 返回 false，动作据此置为 disabled。
 */

export interface QuoteInput {
  text: string
  /** 出处标题（Wiki 页面 / 技能 / 记忆条目）；聊天消息没有标题 */
  title?: string
  /** 标题缺失时的兜底出处 */
  role?: 'user' | 'assistant'
}

export type QuoteSink = (input: QuoteInput) => boolean

let activeSink: QuoteSink | null = null

/** 注册投递目标；返回注销函数（ChatInput 卸载时调） */
export function registerQuoteSink(sink: QuoteSink): () => void {
  activeSink = sink
  return () => {
    // 只清自己那一个：后挂的 sink 不该被先卸载的那个顺手清掉
    if (activeSink === sink) activeSink = null
  }
}

/** 当前是否可引用（动作的 isEnabled 用） */
export function hasQuoteSink(): boolean {
  return activeSink !== null
}

/** 投递一条引用；无 sink 时返回 false */
export function insertQuote(input: QuoteInput): boolean {
  return activeSink ? activeSink(input) : false
}

/**
 * 出处行。标题优先，其次按角色兜底，都没有就不写这一行。
 *
 * 之所以要 role 兜底：聊天消息拿不到会话标题（ChatMessage 只收到 message），
 * 而「来自助手回复」比「来自当前会话」有用得多 —— 引用本来就投在本会话里。
 */
function sourceLine(input: QuoteInput): string | null {
  if (input.title) return `> —— 来自《${input.title}》`
  if (input.role === 'assistant') return '> —— 来自助手回复'
  if (input.role === 'user') return '> —— 来自我的提问'
  return null
}

/**
 * 拼引用块。逐行加 `>` —— 直接把整段丢进 blockquote 在 Markdown 里不成立，
 * 只有第一行会被算进引用，后面的裸行会把引用截断。
 * 空行写成 `>` 而不是 `>` + 空格：后者会在多数渲染器里留下尾随空白。
 */
export function buildQuoteMarkdown(input: QuoteInput): string {
  const lines = input.text.split('\n').map((line) => (line.length > 0 ? `> ${line}` : '>'))
  const source = sourceLine(input)
  if (source) lines.push(source)
  return lines.join('\n')
}
