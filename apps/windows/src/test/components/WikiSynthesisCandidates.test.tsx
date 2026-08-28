/**
 * WikiSynthesisCandidates：候选列表、进度、接受到目录、拒绝
 * 计划：docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md Task 8 §11
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiSynthesisCandidates } from '../../renderer/pages/MemoriesPage/components/WikiSynthesisCandidates'
import type { WikiSynthesisListItem } from '../../renderer/hooks/business/useWikiPage'

function mkRow(overrides: Partial<WikiSynthesisListItem> = {}): WikiSynthesisListItem {
  return {
    id: 'sy1',
    title: '调研综述',
    status: 'candidate',
    sourcePageIds: [],
    outputPath: 'outputs/wiki-syntheses/2026-08-27/sy1-调研综述.md',
    error: null,
    progress: null,
    pageId: null,
    createdAt: Date.now(),
    finishedAt: null,
    ...overrides,
  }
}

function cbs() {
  return { onAccept: vi.fn(), onReject: vi.fn(), onRefresh: vi.fn() }
}

const TREE = {
  version: 1 as const,
  categories: [
    { name: '做事记录', subtopics: ['汇报总结文稿', '项目/任务资料'] },
    { name: '学习资料', subtopics: ['调研搜集材料'] },
  ],
}

describe('WikiSynthesisCandidates', () => {
  it('无候选时给出空提示', () => {
    render(<WikiSynthesisCandidates rows={[]} tree={TREE} {...cbs()} />)
    expect(screen.getByText(/还没有待审阅的综述/)).toBeInTheDocument()
  })

  it('候选行显示标题与接受/拒绝按钮', () => {
    render(<WikiSynthesisCandidates rows={[mkRow()]} tree={TREE} {...cbs()} />)
    expect(screen.getByText('调研综述')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接受到目录…' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '丢弃' })).toBeInTheDocument()
  })

  it('生成中的候选显示进度且不能接受', () => {
    const row = mkRow({ candidateMd: '', progress: { chunk: 2, total: 5 } } as never)
    render(<WikiSynthesisCandidates rows={[row]} tree={TREE} {...cbs()} />)
    expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '接受到目录…' })).not.toBeInTheDocument()
  })

  it('失败的候选显示原因', () => {
    render(
      <WikiSynthesisCandidates
        rows={[mkRow({ error: '模型不可用' })]}
        tree={TREE}
        {...cbs()}
      />,
    )
    expect(screen.getByText(/模型不可用/)).toBeInTheDocument()
  })

  it('truncated 标记不当成失败，仍可接受', () => {
    render(<WikiSynthesisCandidates rows={[mkRow({ error: 'truncated' })]} tree={TREE} {...cbs()} />)
    expect(screen.getByRole('button', { name: '接受到目录…' })).toBeInTheDocument()
    expect(screen.getByText(/已截断/)).toBeInTheDocument()
  })

  it('点接受打开目录选择器，选定后回调带 id 与两列', () => {
    const handlers = cbs()
    render(<WikiSynthesisCandidates rows={[mkRow()]} tree={TREE} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '接受到目录…' }))

    fireEvent.click(screen.getByRole('button', { name: '学习资料' }))
    fireEvent.click(screen.getByRole('button', { name: '调研搜集材料' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    expect(handlers.onAccept).toHaveBeenCalledWith('sy1', '学习资料', '调研搜集材料')
  })

  it('丢弃回调带候选 id', () => {
    const handlers = cbs()
    render(<WikiSynthesisCandidates rows={[mkRow()]} tree={TREE} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '丢弃' }))
    expect(handlers.onReject).toHaveBeenCalledWith('sy1')
  })
})
