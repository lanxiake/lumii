/**
 * CleanupView：筛选、全选、一键归档与删除确认
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CleanupView } from '../../renderer/pages/MemoriesPage/components/CleanupView'
import { filterCleanupSuggestions } from '../../renderer/pages/MemoriesPage/components/cleanupSelection'
import type { WikiCleanupSuggestionItem } from '../../renderer/hooks/business/useWikiPage'

const MOCK_SUGGESTIONS: readonly WikiCleanupSuggestionItem[] = [
  { sourceId: 'a', title: '长期未用资料', reason: 'stale' },
  { sourceId: 'b', title: '失效来源', reason: 'broken_source' },
  { sourceId: 'c', title: '重复内容', reason: 'duplicate_content' },
]

function renderCleanupView(overrides: Partial<Parameters<typeof CleanupView>[0]> = {}) {
  const cleanupScan = vi.fn(async () => MOCK_SUGGESTIONS)
  const archiveSources = vi.fn(async () => 1)
  const restoreSources = vi.fn(async () => 1)
  const deleteSources = vi.fn(async () => 1)

  render(
    <CleanupView
      cleanupScan={cleanupScan}
      archiveSources={archiveSources}
      restoreSources={restoreSources}
      deleteSources={deleteSources}
      {...overrides}
    />,
  )

  return { cleanupScan, archiveSources, restoreSources, deleteSources }
}

describe('filterCleanupSuggestions', () => {
  it('filterCleanupSuggestions 按 reason 过滤', () => {
    const items = [
      { sourceId: 'a', title: 'A', reason: 'stale' as const },
      { sourceId: 'b', title: 'B', reason: 'broken_source' as const },
    ]
    expect(filterCleanupSuggestions(items, 'stale')).toHaveLength(1)
    expect(filterCleanupSuggestions(items, 'all')).toHaveLength(2)
  })

  it('duplicate_content 筛选仅返回对应项', () => {
    expect(filterCleanupSuggestions(MOCK_SUGGESTIONS, 'duplicate_content')).toHaveLength(1)
    expect(filterCleanupSuggestions(MOCK_SUGGESTIONS, 'duplicate_content')[0]?.sourceId).toBe('c')
  })
})

describe('CleanupView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('筛选后列表变短，仅显示对应原因', async () => {
    renderCleanupView()
    await screen.findByText('长期未用资料')

    fireEvent.click(screen.getByRole('button', { name: '长期未用' }))
    await waitFor(() => {
      expect(screen.getByText('长期未用资料')).toBeInTheDocument()
      expect(screen.queryByText('失效来源')).not.toBeInTheDocument()
      expect(screen.queryByText('重复内容')).not.toBeInTheDocument()
    })
  })

  it('全选当前仅勾选可见项', async () => {
    renderCleanupView()
    await screen.findByText('长期未用资料')

    fireEvent.click(screen.getByRole('button', { name: '长期未用' }))
    await waitFor(() => expect(screen.queryByText('失效来源')).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '全选当前' }))

    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes.filter((c) => c.checked)).toHaveLength(1)
    expect(checkboxes[0]?.checked).toBe(true)
  })

  it('筛选变更时清空勾选', async () => {
    renderCleanupView()
    await screen.findByText('长期未用资料')

    fireEvent.click(screen.getByRole('button', { name: '全选当前' }))
    expect(screen.getByRole('button', { name: /批量归档（3）/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '长期未用' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /批量归档（0）/ })).toBeInTheDocument()
    })
  })

  it('一键归档确认后归档全部 suggestions（不受筛选）', async () => {
    const { archiveSources } = renderCleanupView()
    await screen.findByText('长期未用资料')

    fireEvent.click(screen.getByRole('button', { name: '长期未用' }))
    fireEvent.click(screen.getByRole('button', { name: '一键归档全部建议' }))

    expect(screen.getByText(/将归档 3 条清理建议/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))

    await waitFor(() => {
      expect(archiveSources).toHaveBeenCalledWith(['a', 'b', 'c'])
    })
  })

  it('批量删除无确认不调用 deleteSources', async () => {
    const { deleteSources } = renderCleanupView()
    await screen.findByText('长期未用资料')

    fireEvent.click(screen.getByRole('button', { name: '全选当前' }))
    fireEvent.click(screen.getByRole('button', { name: /批量删除/ }))

    expect(screen.getByText(/将永久删除已选 3 条/)).toBeInTheDocument()
    expect(deleteSources).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(deleteSources).toHaveBeenCalledWith(['a', 'b', 'c'])
    })
  })
})
