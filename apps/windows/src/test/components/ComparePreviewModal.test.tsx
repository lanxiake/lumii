/**
 * 复刻对照弹窗：两边都摆出来，缺本地产物时说清楚，而不是白屏。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ComparePreviewModal } from '../../renderer/components/ComparePreview'

const SOURCE = 'https://example.com/'
const LOCAL = 'lumii-local://local/E:/ws/projects/demo/out/index.html'

describe('ComparePreviewModal', () => {
  it('左右各一个 webview，src 分别指向源站与本地产物', () => {
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={() => {}} />)
    // 弹窗走 portal，挂在 document.body 而不是 render 容器里
    const webviews = Array.from(document.querySelectorAll('webview'))
    expect(webviews.map((el) => el.getAttribute('src'))).toEqual([SOURCE, LOCAL])
  })

  it('没有静态导出产物时，右栏给说明而不是空白', () => {
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={null} onClose={() => {}} />)
    expect(document.querySelectorAll('webview')).toHaveLength(1)
    expect(screen.getByText('没有静态导出产物')).toBeInTheDocument()
    expect(screen.getByText(/npm run dev/)).toBeInTheDocument()
  })

  it('点关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Escape 关闭', () => {
    const onClose = vi.fn()
    render(<ComparePreviewModal sourceUrl={SOURCE} localUrl={LOCAL} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
