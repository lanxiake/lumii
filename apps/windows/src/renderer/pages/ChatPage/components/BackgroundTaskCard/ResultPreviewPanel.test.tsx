import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { detectCodeFence, downloadUrl, ResultPreviewPanel, tryParseJsonResult } from './ResultPreviewPanel'

describe('ResultPreviewPanel', () => {
  it('预览图片、视频，并识别代码块和 JSON', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { rerender } = render(
      <ResultPreviewPanel
        outputs={[
          { name: 'a.png', path: 'a.png', kind: 'image', url: 'https://example.test/a.png' },
          { name: 'b.mp4', path: 'b.mp4', kind: 'video', url: 'https://example.test/b.mp4' },
        ]}
      />,
    )
    expect(screen.getByRole('img', { name: 'a.png' })).toBeTruthy()
    expect(document.querySelector('video')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '放大' }))
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()

    rerender(<ResultPreviewPanel result={'```ts\nconst n = 1\n```'} />)
    expect(screen.getByText('代码 (ts)')).toBeTruthy()
    expect(screen.getByText('const n = 1')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '复制代码' }))
    expect(writeText).toHaveBeenCalledWith('const n = 1\n')

    rerender(<ResultPreviewPanel result={'{"ok":true,"n":1}'} />)
    fireEvent.click(screen.getByRole('button', { name: /展开/ }))
    expect(screen.getByText(/"ok": true/)).toBeTruthy()
  })

  it('没有可预览内容时不渲染', () => {
    const { container } = render(
      <ResultPreviewPanel outputs={[{ name: 'a.txt', path: 'a.txt', kind: 'file' }]} result="纯文本" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('解析代码块、JSON，并触发下载', () => {
    expect(detectCodeFence('```js\n1\n```')).toEqual({ language: 'js', code: '1\n' })
    expect(detectCodeFence('不是代码')).toBeNull()
    expect(tryParseJsonResult('{"a":1}')).toEqual({ a: 1 })
    expect(tryParseJsonResult('hello')).toBeNull()

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    downloadUrl('https://example.test/a.png', 'a.png')
    expect(click).toHaveBeenCalled()
    click.mockRestore()
  })
})
