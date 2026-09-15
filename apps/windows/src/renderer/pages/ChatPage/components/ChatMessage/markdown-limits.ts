/**
 * Markdown 渲染的体积闸门。
 *
 * 超长正文（多是用户粘贴的日志/堆栈）会让 remark/rehype 管线付出与内容价值完全
 * 不成比例的代价。实测某个真实会话：43 条消息 / 826KB 正文全量解析需 2.4s，产出
 * 8.9 万个 DOM 元素（其中 4.3 万个是 highlight.js 的 <span>），单条 94KB 的粘贴日志
 * 就要 340ms 解析并常驻 2 万个元素——滚动时每次布局都要为它们付出代价。
 *
 * 这些阈值集中放在这里，便于单测覆盖；调用方见 index.tsx 的 renderTextContent
 * 与 LargeTextBlock。
 */

/** 超过此长度的正文不走 Markdown 管线，默认按纯文本渲染 */
export const PLAIN_TEXT_THRESHOLD = 16 * 1024

/**
 * 超过此长度的正文不再挂载 remark-math / rehype-katex。
 * 日志里的 `$`（Java 内部类 `$1`、shell 变量、SQL）会被当作公式定界符交给 KaTeX，
 * 实测占该会话解析耗时的 44%，并伴随大量 "… used in math mode" 报错。
 */
export const MATH_MAX_CHARS = 8192

/** 超过此长度的代码块跳过高亮（保留代码块结构，只是不着色） */
export const HIGHLIGHT_MAX_CHARS = 12 * 1024

/** rehype 树的最小结构：只声明本文件用到的字段，避免引入 hast 类型依赖 */
export interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** 深度优先访问所有元素节点 */
export function walkHastElements(node: HastNode, visit: (el: HastNode) => void): void {
  if (node.type === 'element') visit(node)
  for (const child of node.children ?? []) walkHastElements(child, visit)
}

/** 节点文本是否超过 limit；累加超限即提前返回，不必拼出完整字符串 */
export function hastTextExceeds(node: HastNode, limit: number): boolean {
  let count = 0
  const walk = (current: HastNode): boolean => {
    if (current.type === 'text') {
      count += current.value?.length ?? 0
      return count > limit
    }
    for (const child of current.children ?? []) {
      if (walk(child)) return true
    }
    return false
  }
  return walk(node)
}

/**
 * 给超长代码块打上 rehype-highlight 认得的 `no-highlight` 标记，让它原样跳过。
 * `language-*` class 保留，样式与复制行为不受影响。
 *
 * 单独拆成不依赖 lowlight 实例的纯函数，既便于测试，也让 highlight 实例
 * 可以在模块顶层只创建一次。
 */
export function markLargeCodeBlocks(tree: HastNode): void {
  walkHastElements(tree, (el) => {
    if (el.tagName !== 'code' || !hastTextExceeds(el, HIGHLIGHT_MAX_CHARS)) return
    const className = el.properties?.['className']
    const list = Array.isArray(className) ? [...className] : []
    if (!list.includes('no-highlight')) list.push('no-highlight')
    el.properties = { ...el.properties, className: list }
  })
}
