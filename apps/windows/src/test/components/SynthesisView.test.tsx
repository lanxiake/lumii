/**
 * SynthesisView：综述页列表与一键刷新
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { SynthesisView } from '../../renderer/pages/MemoriesPage/components/SynthesisView'
import type { WikiPageListItem } from '../../renderer/hooks/business/useWikiPage'

const MOCK_PAGES: readonly WikiPageListItem[] = [
  { id: 'p1', path: 'syntheses/overview-sources', category: 'syntheses', title: '资料综述', version: 1, updatedAt: 1 },
  { id: 'p2', path: 'sources/arch', category: 'sources', title: '架构设计', version: 1, updatedAt: 2 },
  { id: 'p3', path: 'syntheses/overview-media', category: 'syntheses', title: '多媒体综述', version: 1, updatedAt: 3 },
]

function renderSynthesisView(overrides: Partial<Parameters<typeof SynthesisView>[0]> = {}) {
  const autoRunSynthesis = vi.fn(async () => ({
    results: [
      { category: 'sources', pageId: 'p1', path: 'syntheses/overview-sources' },
      { category: 'media', pageId: 'p3', path: 'syntheses/overview-media', skipped: true },
    ],
  }))
  const onOpenPage = vi.fn()
  const onRefreshPages = vi.fn(async () => {})

  render(
    <SynthesisView
      pages={MOCK_PAGES}
      autoRunSynthesis={autoRunSynthesis}
      onOpenPage={onOpenPage}
      onRefreshPages={onRefreshPages}
      {...overrides}
    />,
  )

  return { autoRunSynthesis, onOpenPage, onRefreshPages }
}

describe('SynthesisView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('展示 syntheses 页列表，无多选发起区；点击刷新调用 autoRun', async () => {
    const { autoRunSynthesis, onRefreshPages } = renderSynthesisView()

    expect(screen.queryByText('发起综述合成')).not.toBeInTheDocument()
    expect(screen.getByText('资料综述')).toBeInTheDocument()
    expect(screen.getByText('多媒体综述')).toBeInTheDocument()
    expect(screen.queryByText('架构设计')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /立即刷新全部/ }))

    await waitFor(() => {
      expect(autoRunSynthesis).toHaveBeenCalledTimes(1)
      expect(onRefreshPages).toHaveBeenCalledTimes(1)
    })
  })

  it('空态提示定时任务与手动刷新', () => {
    renderSynthesisView({ pages: [] })
    expect(screen.getByText(/定时任务会自动生成分类综述/)).toBeInTheDocument()
  })

  it('点击综述页调用 onOpenPage', () => {
    const { onOpenPage } = renderSynthesisView()
    fireEvent.click(screen.getByText('资料综述'))
    expect(onOpenPage).toHaveBeenCalledWith('p1')
  })

  it('刷新完成后展示成功与跳过状态行', async () => {
    renderSynthesisView()
    fireEvent.click(screen.getByRole('button', { name: /立即刷新全部/ }))

    await waitFor(() => {
      expect(screen.getByText(/sources.*成功/)).toBeInTheDocument()
      expect(screen.getByText(/media.*跳过/)).toBeInTheDocument()
    })
  })

  it('刷新中按钮显示 loading 且禁用', async () => {
    let resolveRun: (() => void) | undefined
    const autoRunSynthesis = vi.fn(
      () =>
        new Promise<{ results: readonly [] }>((resolve) => {
          resolveRun = () => resolve({ results: [] })
        }),
    )
    renderSynthesisView({ autoRunSynthesis })

    const btn = screen.getByRole('button', { name: /立即刷新全部/ })
    fireEvent.click(btn)

    await waitFor(() => {
      expect(btn).toBeDisabled()
      expect(btn).toHaveTextContent(/刷新中/)
    })

    resolveRun?.()
    await waitFor(() => {
      expect(btn).not.toBeDisabled()
    })
  })
})
