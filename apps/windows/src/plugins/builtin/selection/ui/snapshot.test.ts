/**
 * 划词快照测试
 *
 * 全部走假对象，不依赖 jsdom 的 Selection 实现 —— 这里验的是判定逻辑，
 * 不是浏览器怎么实现选区。
 */
import { describe, expect, it } from 'vitest'
import {
  buildSnapshot,
  DRAG_THRESHOLD_PX,
  isDragGesture,
  isInEditableArea,
  SOURCE_ATTR,
  type ElementLike,
  type NodeLike,
  type RangeLike,
  type SelectionLike,
  type SnapshotRect,
} from './snapshot'

// ---------- 编译期断言 ----------
//
// 下面这些 *Like 是结构化声明的，测试又全用假对象 —— 于是「真实 DOM 类型到底
// 满不满足」这条前提一直没被编译检查过。步骤 3 要直接传 window.getSelection()，
// 那时才发现不满足就得回头改本文件。在这里先钉死：任一条不成立，本文件编译不过。
const domAssignability: {
  selection: (s: Selection) => SelectionLike
  range: (r: Range) => RangeLike
  element: (e: Element) => ElementLike
  node: (n: Node) => NodeLike
} = {
  selection: (s) => s,
  range: (r) => r,
  element: (e) => e,
  node: (n) => n,
}

// ---------- 假对象 ----------

function rect(top: number, left: number, width: number, height: number): SnapshotRect {
  return { top, left, width, height }
}

/**
 * 造一个元素桩。closest 不做选择器解析，直接查表 —— 测的是「谁来接这一问」，
 * 不是 CSS 选择器引擎。
 */
function makeEl(
  attrs: Record<string, string> = {},
  closestMap: Record<string, ElementLike | null> = {},
): ElementLike {
  return {
    parentElement: null,
    closest: (selector: string) => closestMap[selector] ?? null,
    getAttribute: (name: string) => attrs[name] ?? null,
  }
}

const SOURCE_SELECTOR = `[${SOURCE_ATTR}]`

interface SelectionStubOptions {
  text?: string
  collapsed?: boolean
  rangeCount?: number
  rect?: SnapshotRect
  clientRects?: SnapshotRect[]
  startContainer?: ElementLike | { parentElement: ElementLike | null } | null
  closestMap?: Record<string, ElementLike | null>
}

function makeSelection(opts: SelectionStubOptions = {}): SelectionLike {
  const {
    text = '选中的一段话',
    collapsed = false,
    rangeCount = 1,
    rect: r = rect(100, 100, 200, 20),
    clientRects,
    closestMap = {},
  } = opts
  const startContainer = opts.startContainer ?? makeEl({}, closestMap)

  return {
    isCollapsed: collapsed,
    rangeCount,
    toString: () => text,
    getRangeAt: () => ({
      startContainer,
      getBoundingClientRect: () => r,
      getClientRects: clientRects ? () => clientRects : undefined,
    }),
  }
}

// ---------- buildSnapshot ----------

describe('buildSnapshot', () => {
  it('正常选区产出快照，文本保留原样不 trim', () => {
    const snap = buildSnapshot(makeSelection({ text: '  保留两侧空白  ' }), { now: 1234 })

    expect(snap).not.toBeNull()
    expect(snap!.text).toBe('  保留两侧空白  ')
    expect(snap!.createdAt).toBe(1234)
    expect(snap!.rect).toEqual(rect(100, 100, 200, 20))
  })

  it('无选区 / 选区折叠 / 无 range 一律返回 null', () => {
    expect(buildSnapshot(null)).toBeNull()
    expect(buildSnapshot(makeSelection({ rangeCount: 0 }))).toBeNull()
    expect(buildSnapshot(makeSelection({ collapsed: true }))).toBeNull()
  })

  it('全是空白的选区返回 null，但不吃掉正常文本里的空白', () => {
    expect(buildSnapshot(makeSelection({ text: '   \n\t  ' }))).toBeNull()
    expect(buildSnapshot(makeSelection({ text: '\n a \n' }))).not.toBeNull()
  })

  it('浮条锚点取末行而不是联合框', () => {
    const snap = buildSnapshot(
      makeSelection({
        rect: rect(100, 100, 600, 120),
        clientRects: [rect(100, 100, 600, 20), rect(120, 100, 600, 20), rect(140, 100, 180, 20)],
      }),
    )

    expect(snap!.rect).toEqual(rect(100, 100, 600, 120))
    expect(snap!.anchorRect).toEqual(rect(140, 100, 180, 20))
  })

  it('跳过末尾的零面积矩形（换行符），否则浮条飘到下一行行首', () => {
    const snap = buildSnapshot(
      makeSelection({
        clientRects: [rect(100, 100, 600, 20), rect(140, 100, 180, 20), rect(160, 100, 0, 20)],
      }),
    )

    expect(snap!.anchorRect).toEqual(rect(140, 100, 180, 20))
  })

  it('拿不到 client rects 时退回联合框', () => {
    const snap = buildSnapshot(makeSelection({ rect: rect(100, 100, 200, 20) }))

    expect(snap!.anchorRect).toEqual(rect(100, 100, 200, 20))
  })

  it('可编辑区内的选区返回 null', () => {
    const textarea = makeEl()
    expect(buildSnapshot(makeSelection({ closestMap: { 'input, textarea': textarea } }))).toBeNull()

    const richText = makeEl({ contenteditable: 'true' })
    expect(buildSnapshot(makeSelection({ closestMap: { '[contenteditable]': richText } }))).toBeNull()
  })

  it('文本节点的 startContainer 靠 parentElement 上浮', () => {
    const source = makeEl({ [SOURCE_ATTR]: 'chat-message', 'data-lumii-message-id': 'm1' })
    const textNode = { parentElement: makeEl({}, { [SOURCE_SELECTOR]: source }) }

    const snap = buildSnapshot(makeSelection({ startContainer: textNode }))

    expect(snap!.source).toEqual({ kind: 'chat-message', messageId: 'm1' })
  })

  it('命中出处标记时读全四个字段', () => {
    const source = makeEl({
      [SOURCE_ATTR]: 'chat-message',
      'data-lumii-conversation-id': 'c1',
      'data-lumii-message-id': 'm2',
      'data-lumii-role': 'assistant',
      'data-lumii-title': '关于划词的讨论',
    })

    const snap = buildSnapshot(makeSelection({ closestMap: { [SOURCE_SELECTOR]: source } }))

    expect(snap!.source).toEqual({
      kind: 'chat-message',
      conversationId: 'c1',
      messageId: 'm2',
      role: 'assistant',
      title: '关于划词的讨论',
    })
  })

  it('未命中出处标记时退回 plain，引用的可选字段全为 undefined', () => {
    const snap = buildSnapshot(makeSelection())

    expect(snap!.source).toEqual({ kind: 'plain' })
    expect(snap!.source.conversationId).toBeUndefined()
    expect(snap!.source.messageId).toBeUndefined()
  })

  it('出处标记的取值不在已知枚举内时也退回 plain', () => {
    const source = makeEl({ [SOURCE_ATTR]: 'unknown-kind', 'data-lumii-message-id': 'm3' })

    const snap = buildSnapshot(makeSelection({ closestMap: { [SOURCE_SELECTOR]: source } }))

    expect(snap!.source.kind).toBe('plain')
    expect(snap!.source.messageId).toBeUndefined()
  })

  it('role 只认 user / assistant，别的值当没写', () => {
    const source = makeEl({ [SOURCE_ATTR]: 'wiki', 'data-lumii-role': 'system' })

    const snap = buildSnapshot(makeSelection({ closestMap: { [SOURCE_SELECTOR]: source } }))

    expect(snap!.source.kind).toBe('wiki')
    expect(snap!.source.role).toBeUndefined()
  })
})

// ---------- isInEditableArea ----------

describe('isInEditableArea', () => {
  it('input / textarea 内为真', () => {
    expect(isInEditableArea(makeEl({}, { 'input, textarea': makeEl() }))).toBe(true)
  })

  it('contenteditable="true" 为真，contenteditable="false" 为假', () => {
    expect(isInEditableArea(makeEl({}, { '[contenteditable]': makeEl({ contenteditable: 'true' }) }))).toBe(true)
    // 显式 false 会打断继承：contenteditable=false 的子树里的选区是普通文本
    expect(isInEditableArea(makeEl({}, { '[contenteditable]': makeEl({ contenteditable: 'false' }) }))).toBe(false)
  })

  it('空元素与不在可编辑区内为假', () => {
    expect(isInEditableArea(null)).toBe(false)
    expect(isInEditableArea(makeEl())).toBe(false)
  })
})

// ---------- isDragGesture ----------

describe('isDragGesture', () => {
  it('位移超过阈值算拖拽', () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: DRAG_THRESHOLD_PX + 1, y: 0 })).toBe(true)
    expect(isDragGesture({ x: 10, y: 10 }, { x: 13, y: 14 })).toBe(true)
  })

  it('阈值内的抖动算点击，双击选词不会被当成拖拽', () => {
    expect(isDragGesture({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false)
    expect(isDragGesture({ x: 100, y: 100 }, { x: 102, y: 101 })).toBe(false)
    // 恰好等于阈值也算点击（判定用 >）
    expect(isDragGesture({ x: 0, y: 0 }, { x: DRAG_THRESHOLD_PX, y: 0 })).toBe(false)
  })

  it('没有起点时不算拖拽（例如 mouseup 前没收到 mousedown）', () => {
    expect(isDragGesture(null, { x: 999, y: 999 })).toBe(false)
  })

  it('阈值可覆盖', () => {
    expect(isDragGesture({ x: 0, y: 0 }, { x: 10, y: 0 }, 20)).toBe(false)
  })
})

// ---------- 结构约束 ----------

describe('结构约束', () => {
  it('真实 DOM 类型满足 *Like（检查在编译期，见文件顶部 domAssignability）', () => {
    // 运行期只确认这份映射存在；真正的把关由 tsc 完成 —— vitest 不做类型检查
    expect(Object.keys(domAssignability)).toEqual(['selection', 'range', 'element', 'node'])
  })
})
