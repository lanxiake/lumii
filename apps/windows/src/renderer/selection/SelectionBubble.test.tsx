/**
 * 气泡组件测试
 *
 * 只测「状态 → 界面」这一层：三态各自渲染什么、有没有该有的按钮。
 * 状态机本身在 bubble-store.test.ts 里，这里不重复。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SelectionBubbleState } from './bubble-store'
import type { QuoteInput } from './quote-bridge'

let bubbleState: SelectionBubbleState | null = null
const closeBubble = vi.fn()
// 入参按真实签名写：`vi.fn(() => true)` 是零参签名，mock 里再 `(...args) => insertQuote(...args)`
// 会因「把 unknown[] 摊进零参函数」而类型不过（tsc 是仓库唯一的静态门禁）
const insertQuote = vi.fn((_input: QuoteInput): boolean => true)
const writeClipboardText = vi.fn()

vi.mock('./bubble-store', () => ({
  useSelectionBubble: () => bubbleState,
  closeBubble: () => closeBubble(),
}))
vi.mock('./quote-bridge', () => ({
  hasQuoteSink: () => true,
  insertQuote: (input: QuoteInput) => insertQuote(input),
}))
vi.mock('../services/clipboard-service', () => ({
  writeClipboardText: (...args: unknown[]) => writeClipboardText(...args),
}))

const { SelectionBubble } = await import('./SelectionBubble')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  bubbleState = null
})

/** 挂一个带尺寸的根节点（气泡是「先量后定位」，没有尺寸会一直 hidden） */
function renderBubble() {
  const root = document.createElement('div')
  root.getBoundingClientRect = () =>
    ({ width: 240, height: 120, top: 0, left: 0, right: 240, bottom: 120, x: 0, y: 0 }) as DOMRect
  document.body.appendChild(root)
  const ref = { current: root } as React.RefObject<HTMLDivElement>
  const utils = render(<SelectionBubble rootRef={ref} />)
  return Object.assign(utils, {
    ref,
    rerenderWithRef: () => utils.rerender(<SelectionBubble rootRef={ref} />),
  })
}

function state(overrides: Partial<SelectionBubbleState>): SelectionBubbleState {
  return {
    requestId: 'r1',
    action: 'translate',
    text: '一段被选中的文字',
    anchorRect: { top: 200, left: 100, width: 300, height: 20 },
    status: 'pending',
    ...overrides,
  }
}

describe('SelectionBubble', () => {
  it('没有状态时不渲染任何东西', () => {
    renderBubble()
    expect(document.querySelector('[data-selection-bubble]')).toBeNull()
  })

  it('pending：出气泡、显示动作名与「处理中」，且没有结果工具条', () => {
    bubbleState = state({ status: 'pending' })
    renderBubble()

    const bubble = document.querySelector('[data-selection-bubble]')
    expect(bubble).not.toBeNull()
    // 状态挂在正文节点上（根节点只有归位用的 data-selection-bubble）
    expect(bubble?.querySelector('[data-selection-bubble-status="pending"]')).not.toBeNull()
    expect(screen.getByText('翻译')).toBeInTheDocument()
    expect(screen.getByText('处理中…')).toBeInTheDocument()
    expect(screen.queryByText('复制')).toBeNull()
  })

  it('done：显示结果，并给出复制与引用的出口', () => {
    bubbleState = state({ status: 'done', result: 'A piece of selected text' })
    renderBubble()

    expect(screen.getByText('A piece of selected text')).toBeInTheDocument()
    expect(screen.getByText('复制')).toBeInTheDocument()
    expect(screen.getByText('引用')).toBeInTheDocument()
  })

  it('error：显示可读原因，且不给结果工具条', () => {
    bubbleState = state({ status: 'error', error: '模型端点长时间没有响应，请稍后重试' })
    renderBubble()

    expect(
      document.querySelector('[data-selection-bubble] [data-selection-bubble-status="error"]'),
    ).not.toBeNull()
    expect(screen.getByText('模型端点长时间没有响应，请稍后重试')).toBeInTheDocument()
    expect(screen.queryByText('复制')).toBeNull()
  })

  it('来源摘要取选中文本（换行折叠成空格）', () => {
    bubbleState = state({ text: '第一行\n第二行' })
    renderBubble()

    expect(screen.getByText('第一行 第二行')).toBeInTheDocument()
  })

  it('点关闭调 store 的 closeBubble', () => {
    bubbleState = state({ status: 'done', result: 'x' })
    renderBubble()

    screen.getByLabelText('关闭').click()
    expect(closeBubble).toHaveBeenCalled()
  })

  /**
   * 关闭按钮点不动的真因：头部 `pointerdown` 会 `setPointerCapture`，而**指针捕获会把
   * 后续的 click 派发到捕获元素（头部）而不是按钮**，onClick 于是永远不触发。
   * jsdom 不实现捕获重定向，所以上面那条「点关闭」用例在真机坏掉时照样绿 ——
   * 这里直接把机制本身钉住：按在按钮上不许捕获。
   */
  it('头部按下才捕获指针；按在关闭按钮上不捕获（否则 click 会被头部抢走）', () => {
    bubbleState = state({ status: 'done', result: 'x' })
    renderBubble()

    const capture = vi.fn()
    const proto = Element.prototype as unknown as Record<string, unknown>
    const originalCapture = proto.setPointerCapture
    const originalRelease = proto.releasePointerCapture
    proto.setPointerCapture = capture
    proto.releasePointerCapture = vi.fn()

    try {
      const head = document.querySelector('.selection-bubble__head') as HTMLElement
      const closeButton = screen.getByLabelText('关闭')

      fireEvent.pointerDown(closeButton, { button: 0, pointerId: 1 })
      expect(capture).not.toHaveBeenCalled()

      fireEvent.pointerDown(head, { button: 0, pointerId: 1 })
      expect(capture).toHaveBeenCalledTimes(1)
    } finally {
      proto.setPointerCapture = originalCapture
      proto.releasePointerCapture = originalRelease
    }
  })

  it('点复制把结果写进剪贴板', () => {
    bubbleState = state({ status: 'done', result: '结果文本' })
    renderBubble()

    screen.getByText('复制').click()
    expect(writeClipboardText).toHaveBeenCalledWith('结果文本')
  })

  it('复制后给出「已复制」反馈，过一会儿自己收掉', async () => {
    vi.useFakeTimers()
    try {
      bubbleState = state({ status: 'done', result: '结果文本' })
      renderBubble()

      fireEvent.click(screen.getByText('复制'))
      // handleCopy 是 async：等它把 setCopied 落到界面上
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByText('已复制')).toBeInTheDocument()
      expect(screen.queryByText('复制')).toBeNull()

      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByText('已复制')).toBeNull()
      expect(screen.getByText('复制')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('换一条结果（新 requestId）时「已复制」不跟着串台', async () => {
    bubbleState = state({ status: 'done', result: '旧结果' })
    const { rerenderWithRef } = renderBubble()

    fireEvent.click(screen.getByText('复制'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByText('已复制')).toBeInTheDocument()

    bubbleState = state({ requestId: 'r2', status: 'done', result: '新结果' })
    rerenderWithRef()
    expect(screen.queryByText('已复制')).toBeNull()
  })

  it('点引用把结果投给引用桥并收起气泡', () => {
    bubbleState = state({ status: 'done', result: '结果文本' })
    renderBubble()

    screen.getByText('引用').click()
    expect(insertQuote).toHaveBeenCalledWith({ text: '结果文本' })
    expect(closeBubble).toHaveBeenCalled()
  })
})
