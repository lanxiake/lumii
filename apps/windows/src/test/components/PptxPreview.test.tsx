/**
 * PptxPreview 页 API：外部页码跳转与页码回调（不验证真实渲染）。
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const previewer = {
  currentIndex: 0,
  slideCount: 4,
  preview: vi.fn(async () => undefined),
  destroy: vi.fn(),
  renderNextSlide: vi.fn(),
  renderPreSlide: vi.fn(),
  renderSingleSlide: vi.fn((index: number) => {
    previewer.currentIndex = index
  }),
}

vi.mock('pptx-preview', () => ({
  init: vi.fn(() => previewer),
}))
vi.mock('../../renderer/components/FilePreviewModal/sanitize-pptx', () => ({
  sanitizePptxForPreview: async (buffer: ArrayBuffer) => buffer,
}))

import { PptxPreview } from '../../renderer/components/FilePreviewModal/PptxPreview'

beforeEach(() => {
  previewer.currentIndex = 0
  previewer.slideCount = 4
  previewer.preview.mockClear()
  previewer.renderSingleSlide.mockClear()
})

describe('PptxPreview 页 API', () => {
  it('首次渲染后跳到指定页并回报页码', async () => {
    const onPageChange = vi.fn()
    render(
      <PptxPreview
        bytes={new Uint8Array([1, 2, 3])}
        fileName="deck.pptx"
        currentPage={2}
        onPageChange={onPageChange}
      />,
    )
    await waitFor(() => expect(previewer.preview).toHaveBeenCalled())
    await waitFor(() => expect(previewer.renderSingleSlide).toHaveBeenCalledWith(2))
    expect(onPageChange).toHaveBeenLastCalledWith(2, 4)
  })

  it('外部页码变化时再次跳页', async () => {
    const onPageChange = vi.fn()
    const { rerender } = render(
      <PptxPreview
        bytes={new Uint8Array([1, 2, 3])}
        fileName="deck.pptx"
        currentPage={1}
        onPageChange={onPageChange}
      />,
    )
    await waitFor(() => expect(previewer.renderSingleSlide).toHaveBeenCalledWith(1))
    rerender(
      <PptxPreview
        bytes={new Uint8Array([1, 2, 3])}
        fileName="deck.pptx"
        currentPage={3}
        onPageChange={onPageChange}
      />,
    )
    await waitFor(() => expect(previewer.renderSingleSlide).toHaveBeenCalledWith(3))
    expect(onPageChange).toHaveBeenLastCalledWith(3, 4)
  })
})
