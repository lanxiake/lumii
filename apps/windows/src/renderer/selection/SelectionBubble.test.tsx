/**
 * 气泡组件测试
 *
 * 只测「状态 → 界面」这一层：三态各自渲染什么、有没有该有的按钮。
 * 状态机本身在 bubble-store.test.ts 里，这里不重复。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { SelectionBubbleState } from './bubble-store'

let bubbleState: SelectionBubbleState | null = null
const closeBubble = vi.fn()
const insertQuote = vi.fn(() => true)
const writeClipboardText = vi.fn()

vi.mock('./bubble-store', () => ({
  useSelectionBubble: () => bubbleState,
  closeBubble: () => closeBubble(),
}))
vi.mock('./quote-bridge', () => ({
  hasQuoteSink: () => true,
  insertQuote: (...args: unknown[]) => insertQuote(...args),
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
  return render(<SelectionBubble rootRef={ref} />)
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

  it('点复制把结果写进剪贴板', () => {
    bubbleState = state({ status: 'done', result: '结果文本' })
    renderBubble()

    screen.getByText('复制').click()
    expect(writeClipboardText).toHaveBeenCalledWith('结果文本')
  })

  it('点引用把结果投给引用桥并收起气泡', () => {
    bubbleState = state({ status: 'done', result: '结果文本' })
    renderBubble()

    screen.getByText('引用').click()
    expect(insertQuote).toHaveBeenCalledWith({ text: '结果文本' })
    expect(closeBubble).toHaveBeenCalled()
  })
})
