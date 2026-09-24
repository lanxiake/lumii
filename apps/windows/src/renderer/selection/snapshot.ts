/**
 * snapshot.ts - 划词快照
 *
 * 单独成文件是为了能不碰真实 DOM 就跑测试：所有判定都收在纯函数里，
 * 调用方只负责把 Selection 递进来。
 *
 * 为什么要快照：消息列表是窗口化渲染（useWindowedRows），离屏行的整棵子树
 * 会被卸载。任何在 mouseup 之后仍持有活 Range 的写法，都会在「选完滚一下」
 * 时静默失效 —— getBoundingClientRect 返回全零、toString 返回空，且不报错。
 * 所以 rect 存的是数值，快照做完就把 Range 丢掉。
 */

/** 快照里的矩形。不用 DOMRect 是为了测试能直接构造字面量 */
export interface SnapshotRect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

type SelectionSourceKind =
  | 'chat-message'
  | 'markdown-preview'
  | 'wiki'
  | 'skill-doc'
  | 'memory'
  | 'plain'

export interface SelectionSource {
  readonly kind: SelectionSourceKind
  readonly conversationId?: string
  readonly messageId?: string
  readonly role?: 'user' | 'assistant'
  readonly title?: string
}

export interface SelectionSnapshot {
  readonly text: string
  /** 选区联合框；气泡锚点用 */
  readonly rect: SnapshotRect
  /**
   * 选区末行框；浮条锚点用。
   * 多行选区的联合框上沿在第一行、横向铺满整行，浮条贴上去会离指针很远。
   */
  readonly anchorRect: SnapshotRect
  readonly source: SelectionSource
  readonly createdAt: number
}

/**
 * 以下 *Like 只声明真正读取的成员：真实的 Selection / Range / Element 天然满足，
 * 测试里则能用几行字面量造假对象，不必在 jsdom 上凑一整套 DOM 实现。
 */
export interface ElementLike {
  readonly parentElement: ElementLike | null
  closest(selector: string): ElementLike | null
  getAttribute(name: string): string | null
}

export interface NodeLike {
  readonly parentElement: ElementLike | null
}

export interface RangeLike {
  readonly startContainer: NodeLike | ElementLike
  /** jsdom 的 Range 没有这个方法，所以是可选的 */
  getBoundingClientRect?(): SnapshotRect
  getClientRects?(): ArrayLike<SnapshotRect>
}

export interface SelectionLike {
  readonly isCollapsed: boolean
  readonly rangeCount: number
  toString(): string
  getRangeAt(index: number): RangeLike
}

/** 正文容器用来标注出处的属性名（见设计 §5.1 的 source） */
export const SOURCE_ATTR = 'data-lumii-source'

const KNOWN_SOURCE_KINDS: readonly SelectionSourceKind[] = [
  'chat-message',
  'markdown-preview',
  'wiki',
  'skill-doc',
  'memory',
]

const ZERO_RECT: SnapshotRect = { top: 0, left: 0, width: 0, height: 0 }

/**
 * 可编辑区一律不弹浮条：输入框里的复制/粘贴交给原生右键菜单更可靠，
 * 浮条挤在光标旁边只会碍事。
 *
 * contenteditable 是继承的：往上找最近一个**显式声明**它的祖先，只有那一个的值
 * 作数（显式 "false" 会打断继承）。所以不能用 closest('[contenteditable="true"]')
 * —— 那会漏掉 <div contenteditable="true"><span>text</span></div> 里的 span。
 */
export function isInEditableArea(el: ElementLike | null): boolean {
  if (!el) return false
  if (el.closest('input, textarea')) return true
  const declared = el.closest('[contenteditable]')
  return declared !== null && declared.getAttribute('contenteditable') !== 'false'
}

/** 文本节点没有 closest，靠 parentElement 上浮一层 */
function asElement(node: NodeLike | ElementLike | null): ElementLike | null {
  if (!node) return null
  const maybeElement = node as Partial<ElementLike>
  if (typeof maybeElement.closest === 'function') return node as ElementLike
  return node.parentElement
}

function readSource(el: ElementLike | null): SelectionSource {
  const host = el?.closest(`[${SOURCE_ATTR}]`) ?? null
  if (!host) return { kind: 'plain' }

  const raw = host.getAttribute(SOURCE_ATTR)
  if (!raw || !KNOWN_SOURCE_KINDS.includes(raw as SelectionSourceKind)) {
    return { kind: 'plain' }
  }

  const role = host.getAttribute('data-lumii-role')
  return {
    kind: raw as SelectionSourceKind,
    conversationId: host.getAttribute('data-lumii-conversation-id') ?? undefined,
    messageId: host.getAttribute('data-lumii-message-id') ?? undefined,
    role: role === 'user' || role === 'assistant' ? role : undefined,
    title: host.getAttribute('data-lumii-title') ?? undefined,
  }
}

function toRect(r: SnapshotRect): SnapshotRect {
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/**
 * 取末行的矩形当浮条锚点。
 *
 * 从后往前跳过零面积矩形：选区末尾常常带一个零宽矩形（换行符），
 * 认了它浮条会飘到下一行行首。
 */
function lastClientRect(range: RangeLike): SnapshotRect | null {
  const rects = range.getClientRects?.()
  if (!rects) return null
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (r.width > 0 && r.height > 0) return toRect(r)
  }
  return null
}

export interface BuildSnapshotOptions {
  /** 便于测试断言；不传则取当前时间 */
  readonly now?: number
}

/**
 * 选区 → 快照。不可用时返回 null（调用方据此决定不弹浮条）。
 *
 * 返回 null 的情形：无选区 / 选区已折叠 / 全是空白 / 落在可编辑区内。
 */
export function buildSnapshot(
  selection: SelectionLike | null,
  options: BuildSnapshotOptions = {},
): SelectionSnapshot | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const text = selection.toString()
  // 存原文不 trim（会吃掉有意义的换行与缩进），只用 trim 判空
  if (text.trim().length === 0) return null

  const range = selection.getRangeAt(0)
  const startEl = asElement(range.startContainer)
  if (isInEditableArea(startEl)) return null

  // 环境不一定给了 Range.getBoundingClientRect（jsdom 就没有）：退到末行矩形，
  // 再退到零矩形 —— 有 text/source 的快照仍可用，气泡顶多锚在视口左上角
  const rect = toRect(range.getBoundingClientRect?.() ?? ZERO_RECT)

  return {
    text,
    rect,
    anchorRect: lastClientRect(range) ?? rect,
    source: readSource(startEl),
    createdAt: options.now ?? Date.now(),
  }
}

export interface Point {
  readonly x: number
  readonly y: number
}

/** 位移超过这个距离才算拖拽；低于它是点击（双击选词的位移落在这里） */
export const DRAG_THRESHOLD_PX = 4

/**
 * 判断这次指针手势是不是拖拽。
 *
 * 用途是**拖拽过程中提前收起浮条**，免得浮条横在用户正在扩展的选区上；
 * 阈值则保证普通点击不会把它收掉。
 *
 * 注意：它不用来决定「要不要弹浮条」—— 拖拽出选区恰恰是最主流的选中方式。
 */
export function isDragGesture(
  start: Point | null,
  end: Point,
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  if (!start) return false
  return Math.hypot(end.x - start.x, end.y - start.y) > threshold
}
