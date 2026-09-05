/**
 * WikiMigrateReviewView — 库级迁移映射预览审阅
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiMigrateReviewView } from './WikiMigrateReviewView'
import type { WikiMigrateRunItem, WikiTopicTree } from '../../../hooks/business/useWikiPage'

const TOPIC_TREE: WikiTopicTree = {
  version: 2,
  categories: [
    { name: '工作', subtopics: ['项目', '例行'] },
    { name: '生活', subtopics: ['凭据'] },
  ],
}

const REVIEW_RUN: WikiMigrateRunItem = {
  runId: 'run-1',
  phase: 'review',
  importRoot: 'C:/import',
  inboxIds: ['i1', 'i2'],
  cancelRequested: false,
  progress: {
    runId: 'run-1',
    phase: 'review',
    phaseLabel: '待确认映射',
    done: 0,
    total: 2,
    currentItem: null,
  },
  error: null,
  mappings: [
    {
      folderRel: 'docs/reports',
      category: '工作',
      subtopic: '项目',
      confidence: 0.92,
      reason: '周报与项目文档',
      status: 'ok',
      inboxIds: ['i1'],
    },
    {
      folderRel: 'photos',
      category: null,
      subtopic: null,
      confidence: 0.4,
      reason: '无法确定用途',
      proposedSubtopic: '相册',
      status: 'conflict',
      inboxIds: ['i2'],
    },
  ],
}

describe('WikiMigrateReviewView', () => {
  it('review 阶段展示映射列表与操作按钮', () => {
    render(
      <WikiMigrateReviewView
        run={REVIEW_RUN}
        topicTree={TOPIC_TREE}
        applying={false}
        onUpdateMapping={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
        onReplan={vi.fn()}
      />,
    )

    expect(screen.getByText('docs/reports')).toBeInTheDocument()
    expect(screen.getByText('photos')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认整理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '丢弃方案' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新规划' })).toBeInTheDocument()
  })

  it('存在未处理 conflict 时禁用确认整理', () => {
    render(
      <WikiMigrateReviewView
        run={REVIEW_RUN}
        topicTree={TOPIC_TREE}
        applying={false}
        onUpdateMapping={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
        onReplan={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: '确认整理' })).toBeDisabled()
  })

  it('勾选批准 proposedSubtopic 触发 update-mapping', () => {
    const onUpdateMapping = vi.fn()
    render(
      <WikiMigrateReviewView
        run={REVIEW_RUN}
        topicTree={TOPIC_TREE}
        applying={false}
        onUpdateMapping={onUpdateMapping}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
        onReplan={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByLabelText(/批准新建小类「相册」/))
    expect(onUpdateMapping).toHaveBeenCalledWith('photos', { approvedProposedSubtopic: true })
  })

  it('点击忽略此夹触发 ignored 更新', () => {
    const onUpdateMapping = vi.fn()
    render(
      <WikiMigrateReviewView
        run={REVIEW_RUN}
        topicTree={TOPIC_TREE}
        applying={false}
        onUpdateMapping={onUpdateMapping}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
        onReplan={vi.fn()}
      />,
    )

    const ignoreButtons = screen.getAllByRole('button', { name: '忽略此夹' })
    fireEvent.click(ignoreButtons[1]!)
    expect(onUpdateMapping).toHaveBeenCalledWith('photos', { ignored: true })
  })

  it('无 run 时显示空状态', () => {
    render(
      <WikiMigrateReviewView
        run={null}
        topicTree={TOPIC_TREE}
        applying={false}
        onUpdateMapping={vi.fn()}
        onApply={vi.fn()}
        onDiscard={vi.fn()}
        onReplan={vi.fn()}
      />,
    )

    expect(screen.getByText(/还没有整理入库方案/)).toBeInTheDocument()
  })
})
