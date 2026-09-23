/**
 * RichComposer 的交互契约测试。
 *
 * 这个组件替掉了原来的 `<textarea>`，而它对外**只吐一段文本** —— 所以这里盯的不是
 * 内部实现，而是那三件最容易被实现细节带偏的事：
 *   1. 插进来的引用/文件引用，序列化出去必须还是老格式（发送与 Agent 解析都认它）；
 *   2. chip 上的 × 点得掉，且删完文本跟着变；
 *   3. 外部把引用摘掉时（上方 chip 行删除），框内的内联 chip 要同步消失。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { RichComposer, type RichComposerHandle } from './RichComposer'
import type { FileReference } from './index'

const REF: FileReference = {
  relativePath: 'workspace/src/app.ts',
  name: 'app.ts',
  absolutePath: 'C:/ws/workspace/src/app.ts',
  isDirectory: false,
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

type ComposerOverrides = Omit<Partial<React.ComponentProps<typeof RichComposer>>, 'onChange'> & {
  value: string
  onChange?: (text: string) => void
}

function setup(initialProps: ComposerOverrides) {
  let handle: RichComposerHandle | null = null
  const onChange = initialProps.onChange ?? vi.fn()
  const element = (props: ComposerOverrides) => (
    <RichComposer
      ref={(instance) => {
        handle = instance
      }}
      {...props}
      onChange={props.onChange ?? onChange}
    />
  )

  const utils = render(element(initialProps))
  const root = utils.container.querySelector<HTMLElement>('[role="textbox"]')!
  const placeCaretAtEnd = () => {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  }
  return {
    onChange,
    root,
    placeCaretAtEnd,
    rerender: (next: Partial<ComposerOverrides>) =>
      utils.rerender(element({ ...initialProps, ...next })),
    get handle() {
      return handle as unknown as RichComposerHandle
    },
  }
}

describe('RichComposer', () => {
  it('把初始草稿铺成 DOM，空态标在 data-empty 上（占位符靠它显示）', () => {
    const { root } = setup({ value: '第一行\n第二行' })
    expect(root.textContent).toBe('第一行第二行')
    expect(root.querySelectorAll('br')).toHaveLength(1)
    expect(root.getAttribute('data-empty')).toBe('false')

    const empty = setup({ value: '' })
    expect(empty.root.getAttribute('data-empty')).toBe('true')
  })

  it('外部值变化会重建 DOM，值没变则不动（免得每渲染一次就把光标顶回开头）', () => {
    const { root, rerender, handle } = setup({ value: '初始' })
    const textNode = root.firstChild

    // 值没变 → 同一个文本节点留着，光标不会被顶走
    rerender({ value: '初始' })
    expect(root.firstChild).toBe(textNode)

    // 值变了 → 重建
    rerender({ value: '外部改过' })
    expect(handle.getText()).toBe('外部改过')
    expect(root.firstChild).not.toBe(textNode)
  })

  it('插入引用：落成 markdown 引用块，光标前没有换行时自动补一个', () => {
    const { handle, placeCaretAtEnd, onChange, root } = setup({ value: '先写一句' })
    placeCaretAtEnd()

    act(() => {
      handle.insertQuote({ text: '被引正文', title: '会话标题' })
    })

    const expected = '先写一句\n> 被引正文\n> —— 来自《会话标题》'
    expect(handle.getText()).toBe(expected)
    expect(onChange).toHaveBeenLastCalledWith(expected)
    // 框内是 chip，不是裸文本
    expect(root.querySelectorAll('[data-composer-chip="quote"]')).toHaveLength(1)
  })

  it('插入文件引用：落成 `@相对路径 `，供 Agent 认路径', () => {
    const { handle, placeCaretAtEnd } = setup({ value: '' })
    placeCaretAtEnd()

    act(() => {
      handle.insertFileReference(REF)
    })

    expect(handle.getText()).toBe('@workspace/src/app.ts ')
  })

  it('点 chip 的 × 删掉整块，文本随之更新', () => {
    const { handle, root, placeCaretAtEnd, onChange } = setup({ value: '' })
    placeCaretAtEnd()
    act(() => {
      handle.insertQuote({ text: '被引正文', role: 'assistant' })
    })
    expect(root.querySelectorAll('[data-composer-chip]')).toHaveLength(1)

    const removeButton = root.querySelector('[data-chip-remove]') as HTMLElement
    act(() => {
      removeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(root.querySelectorAll('[data-composer-chip]')).toHaveLength(0)
    // 引用前后的分隔换行是独立文本节点，删 chip 不动它们（与手删一段文字同构）
    expect(handle.getText().trim()).toBe('')
    expect(onChange).toHaveBeenLastCalledWith(handle.getText())
  })

  it('删文件 chip 会通知外部把引用一起摘掉（两侧同一个引用不能只删一边）', () => {
    const onFileChipRemove = vi.fn()
    const { handle, root, placeCaretAtEnd } = setup({
      value: '',
      fileReferences: [REF],
      onFileChipRemove,
    })
    placeCaretAtEnd()
    act(() => {
      handle.insertFileReference(REF)
    })

    act(() => {
      ;(root.querySelector('[data-chip-remove]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })

    expect(onFileChipRemove).toHaveBeenCalledWith(REF)
    expect(handle.getText().trim()).toBe('')
  })

  it('外部摘掉引用（上方 chip 行删除）时，框内的内联 chip 同步消失', () => {
    const { root, rerender, handle } = setup({
      value: `看 @${REF.relativePath} 这段`,
      fileReferences: [REF],
    })
    expect(root.querySelectorAll('[data-composer-chip]')).toHaveLength(1)

    rerender({ fileReferences: [] })

    // chip 就是那段 `@路径` 本身，摘掉 chip 就等于把路径从正文里去掉
    expect(root.querySelectorAll('[data-composer-chip]')).toHaveLength(0)
    expect(handle.getText()).toBe('看  这段')
  })
})
