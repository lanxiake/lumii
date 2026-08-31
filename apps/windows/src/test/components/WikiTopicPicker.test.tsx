/**
 * WikiTopicPicker：分区（=树中大类）+ 小类两级选择，小类可留空（暂不细分）
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTopicPicker } from '../../renderer/pages/MemoriesPage/components/WikiTopicPicker'
import type { WikiTopicTree } from '../../renderer/hooks/business/useWikiPage'

const TREE: WikiTopicTree = {
  version: 2,
  categories: [
    { name: '工作', subtopics: ['项目', '例行', '对外'] },
    { name: '学习', subtopics: ['在学', '参考'] },
    { name: '生活', subtopics: ['凭据', '家事', '自留'] },
    { name: '收藏', subtopics: ['待读', '可复用'] },
  ],
}

describe('WikiTopicPicker', () => {
  it('第一步显示树中的大类，默认包含已归档', () => {
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />)

    for (const label of ['工作', '学习', '生活', '收藏']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: '已归档' })).toBeInTheDocument()
  })

  it('includeArchived 为 false 时不显示已归档', () => {
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        includeArchived={false}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: '已归档' })).not.toBeInTheDocument()
  })

  it('选「生活」后展示其小类', () => {
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: '生活' }))
    expect(screen.getByRole('button', { name: '凭据' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '家事' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '自留' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '项目' })).not.toBeInTheDocument()
  })

  it('确认时回传大类与小类', () => {
    const onConfirm = vi.fn()
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '生活' }))
    fireEvent.click(screen.getByRole('button', { name: '凭据' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    expect(onConfirm).toHaveBeenCalledWith('生活', '凭据')
  })

  it('选「暂不细分」时小类回传 null', () => {
    const onConfirm = vi.fn()
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={onConfirm} />)

    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    fireEvent.click(screen.getByRole('button', { name: '暂不细分' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    expect(onConfirm).toHaveBeenCalledWith('收藏', null)
  })

  it('已归档分区无小类，确定走 onConfirmArchive', () => {
    const onConfirmArchive = vi.fn()
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        onCancel={() => undefined}
        onConfirm={onConfirm}
        onConfirmArchive={onConfirmArchive}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    expect(onConfirmArchive).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('未选大类时禁用确认；只选大类未选小类也可确认（小类可选）', () => {
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />)

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '项目' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeEnabled()
  })

  it('切换分区时清空已选小类，避免跨分区误提交', () => {
    render(<WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />)

    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    fireEvent.click(screen.getByRole('button', { name: '例行' }))
    fireEvent.click(screen.getByRole('button', { name: '生活' }))

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '例行' })).not.toBeInTheDocument()
  })
})
