/**
 * 对照视图：左源站 / 右本地产物，两个 webview 各自可滚/缩放。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ComparePreviewModal } from './ComparePreviewModal'

const SOURCE = 'https://example.com/'
const LOCAL = 'lumii-local://local/E:/ws/projects/demo/out/index.html'

function webviews(): string[] {
  return Array.from(document.querySelectorAll('webview')).map((el) => el.getAttribute('src') ?? '')
}

afterEach(() => {
  // 组件走 createPortal，必须让 RTL 自己卸载；直接清 body 会撞 「node to be removed」
  cleanup()
})

describe('ComparePreviewModal', () => {
  it('左右两栏各一个 webview，src 分别是源站与本地导出', () => {
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={() => {}} />)
    expect(webviews()).toEqual([SOURCE, LOCAL])
  })

  it('没有本地产物 → 不渲染本地 webview，说明「需自行 npm run dev」而不是白屏', () => {
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={null} onClose={() => {}} />)
    expect(webviews()).toEqual([SOURCE])
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument()
  })

  it('Esc 与关闭按钮都触发 onClose', () => {
    const onClose = vi.fn()
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '关闭复刻对照' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('dom-ready 之前调 setZoomFactor 会同步抛错 → 缩放按钮在 ready 前禁用', () => {
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={() => {}} />)
    // jsdom 里没有真实 webview 事件；未 ready 时点缩放不应抛（真机实测会抛并打红卡片）
    expect(() => fireEvent.click(screen.getByRole('button', { name: '放大源站' }))).not.toThrow()
    expect(screen.getByRole('button', { name: '刷新源站' })).toBeDisabled()
  })
})
