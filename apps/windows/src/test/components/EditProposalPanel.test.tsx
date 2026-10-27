/**
 * 改写建议面板：loading 取消、ready 的 diff 与应用/放弃、error 文案。
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { EditProposalPanel } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/EditProposalPanel'
import type { ArtifactEditProposal } from '../../shared/artifact-edit-types'

const PROPOSAL: ArtifactEditProposal = {
  ok: true,
  editId: 'edit-1',
  candidatePath: '.lumii/edits/edit-1/candidate.md',
  changedScope: { type: 'text-range', start: 2, end: 4 },
  baseHash: 'hash',
  beforeBytes: 10,
  afterBytes: 12,
  diff: {
    insertions: 1,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ['-旧段落', '+新段落'],
      },
    ],
  },
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof EditProposalPanel>> = {}) {
  const props = {
    status: 'ready' as const,
    proposal: PROPOSAL,
    error: null,
    busy: false,
    onApply: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  }
  render(<EditProposalPanel {...props} />)
  return props
}

describe('EditProposalPanel', () => {
  it('loading 显示进度与取消', () => {
    const props = renderPanel({ status: 'loading', proposal: null })
    expect(screen.getByText(/正在生成改写建议/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(props.onCancel).toHaveBeenCalled()
  })

  it('ready 展示 diff 统计与行；应用/放弃回调', () => {
    const props = renderPanel()
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText('+新段落')).toBeInTheDocument()
    expect(screen.getByText('-旧段落')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '应用' }))
    expect(props.onApply).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    expect(props.onDiscard).toHaveBeenCalled()
  })

  it('CRLF 文件的 diff 行尾 \\r 不显示', () => {
    renderPanel({
      proposal: {
        ...PROPOSAL,
        diff: {
          insertions: 1,
          deletions: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-旧\r', '+新\r'],
            },
          ],
        },
      },
    })
    expect(screen.getByText('-旧')).toBeInTheDocument()
    expect(screen.getByText('+新')).toBeInTheDocument()
    expect(screen.queryByText('-旧\r')).toBeNull()
  })

  it('error 显示原因并关闭', () => {
    const props = renderPanel({ status: 'error', proposal: null, error: '模型返回过长' })
    expect(screen.getByText('模型返回过长')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(props.onDiscard).toHaveBeenCalled()
  })

  it('busy 时禁用应用/放弃', () => {
    renderPanel({ busy: true })
    expect(screen.getByRole('button', { name: '应用中…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '放弃' })).toBeDisabled()
  })
})
