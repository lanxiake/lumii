/**
 * WikiReclassifyView：进度态、候选审阅、部分接受、applyError 保留
 * 计划：docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md Task 6
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiReclassifyView } from '../../renderer/pages/MemoriesPage/components/WikiReclassifyView'
import type { WikiReclassifyRunItem } from '../../renderer/hooks/business/useWikiPage'

const CANDIDATE = {
  id: 'c1',
  sourceId: 's1',
  title: '2027年度OKR草案.docx',
  fromCategory: '做事记录',
  fromSubtopic: '项目/任务资料',
  toCategory: '计划与复盘',
  toSubtopic: '目标规划方案',
  reason: '尚未执行的规划',
  decidedBy: 'structure' as const,
}

const reviewRun: WikiReclassifyRunItem = {
  runId: 'r1',
  status: 'review',
  total: 1,
  processed: 1,
  droppedInvalid: 0,
  unchanged: 0,
  error: null,
  candidates: [CANDIDATE],
}

function cbs() {
  return {
    onApply: vi.fn(),
    onIgnore: vi.fn(),
    onDiscard: vi.fn(),
  }
}

describe('WikiReclassifyView', () => {
  it('running 时显示进度不显示候选', () => {
    const run: WikiReclassifyRunItem = { ...reviewRun, status: 'running', processed: 12, total: 80, candidates: [] }
    render(<WikiReclassifyView run={run} {...cbs()} />)
    expect(screen.getByText(/12\s*\/\s*80/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '全部接受' })).not.toBeInTheDocument()
  })

  it('review 时显示 from → to 与理由', () => {
    render(<WikiReclassifyView run={reviewRun} {...cbs()} />)
    expect(screen.getByText('做事记录 / 项目/任务资料')).toBeInTheDocument()
    expect(screen.getByText('计划与复盘 / 目标规划方案')).toBeInTheDocument()
    expect(screen.getByText('尚未执行的规划')).toBeInTheDocument()
    expect(screen.getByText(/1 条建议/)).toBeInTheDocument()
  })

  it('接受已选只提交勾选项', () => {
    const handlers = cbs()
    const run: WikiReclassifyRunItem = {
      ...reviewRun,
      total: 2,
      candidates: [CANDIDATE, { ...CANDIDATE, id: 'c2', sourceId: 's2', title: '另一份.docx' }],
    }
    render(<WikiReclassifyView run={run} {...handlers} />)
    fireEvent.click(screen.getByLabelText('选择 2027年度OKR草案.docx'))
    fireEvent.click(screen.getByRole('button', { name: '接受已选' }))
    expect(handlers.onApply).toHaveBeenCalledWith(['c1'])
  })

  it('未勾选时接受已选按钮禁用', () => {
    render(<WikiReclassifyView run={reviewRun} {...cbs()} />)
    expect(screen.getByRole('button', { name: '接受已选' })).toBeDisabled()
  })

  it('全部接受提交所有候选 id', () => {
    const handlers = cbs()
    const run: WikiReclassifyRunItem = {
      ...reviewRun,
      candidates: [CANDIDATE, { ...CANDIDATE, id: 'c2', sourceId: 's2', title: '另一份.docx' }],
    }
    render(<WikiReclassifyView run={run} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '全部接受' }))
    expect(handlers.onApply).toHaveBeenCalledWith(['c1', 'c2'])
  })

  it('单条忽略回调带候选 id', () => {
    const handlers = cbs()
    render(<WikiReclassifyView run={reviewRun} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '忽略' }))
    expect(handlers.onIgnore).toHaveBeenCalledWith('c1')
  })

  it('全部忽略走 discard', () => {
    const handlers = cbs()
    render(<WikiReclassifyView run={reviewRun} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '全部忽略' }))
    expect(handlers.onDiscard).toHaveBeenCalled()
  })

  it('applyError 的行保留并显示红字', () => {
    const run: WikiReclassifyRunItem = {
      ...reviewRun,
      candidates: [{ ...CANDIDATE, applyError: '目标目录已不存在：计划与复盘 / 目标规划方案' }],
    }
    render(<WikiReclassifyView run={run} {...cbs()} />)
    expect(screen.getByText(/目标目录已不存在/)).toBeInTheDocument()
    expect(screen.getByText('2027年度OKR草案.docx')).toBeInTheDocument()
  })

  it('failed 状态显示错误原因', () => {
    const run: WikiReclassifyRunItem = {
      ...reviewRun,
      status: 'failed',
      error: '模型不可用',
      candidates: [],
    }
    render(<WikiReclassifyView run={run} {...cbs()} />)
    expect(screen.getByText(/模型不可用/)).toBeInTheDocument()
  })

  it('review 但无候选时说明已归档文件无需调整', () => {
    render(<WikiReclassifyView run={{ ...reviewRun, candidates: [], unchanged: 5 }} {...cbs()} />)
    expect(screen.getByText(/没有需要调整的目录建议/)).toBeInTheDocument()
  })

  it('run 为 null 时提示尚未运行', () => {
    render(<WikiReclassifyView run={null} {...cbs()} />)
    expect(screen.getByText(/还没有重新编目/)).toBeInTheDocument()
  })
})
