/**
 * CheckpointDialog（P2 T7）：计划清单、固定文案、分支勾选、结果与撤销。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CheckpointDialog } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/CheckpointDialog'
import type { CheckpointPlan } from '../../shared/artifact-checkpoint-types'

const PLAN: CheckpointPlan = {
  anchor: { turnId: 't1', timestamp: new Date(2026, 9, 27, 18, 12).getTime() },
  files: [
    { path: 'outputs/a/doc.md', action: 'restore', content: 'git', firstStatus: 'modified' },
    { path: 'outputs/a/deck.pptx', action: 'restore', content: 'pin', firstStatus: 'modified' },
    { path: 'outputs/a/new.md', action: 'trash', firstStatus: 'added' },
    { path: 'outputs/a/pic.png', action: 'skip', reason: '二进制旧版没有副本，无法恢复' },
  ],
  textCommitOid: 'oid-1',
  canRestoreConversation: true,
  warnings: ['这一轮的快照经过合并，可能包含紧随其后的改动。'],
}

function install(overrides: Record<string, unknown> = {}) {
  const api = {
    checkpointPlan: vi.fn(async () => ({ ok: true, plan: PLAN })),
    checkpointApply: vi.fn(async () => ({
      ok: true,
      checkpointId: 'cp-1',
      restored: 2,
      trashed: 1,
      skipped: 1,
      backupOid: 'backup-1',
      newSessionKey: 'branch-1',
    })),
    checkpointUndo: vi.fn(async () => ({ ok: true, restored: 1, restoredFromTrash: 1 })),
    ...overrides,
  }
  ;(window.electronAPI as any).artifact = api
  return api
}

function renderDialog(onApplied = vi.fn(), onClose = vi.fn()) {
  return render(
    <CheckpointDialog sessionKey="conv-1" turnId="t1" onClose={onClose} onApplied={onApplied} />,
  )
}

describe('CheckpointDialog', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).artifact = undefined
  })

  it('列出恢复/回收站/跳过三类，并给固定文案与警告', async () => {
    install()
    renderDialog()
    await waitFor(() => expect(screen.getByText('将恢复 2 个文件')).toBeInTheDocument())

    expect(screen.getByText(/不恢复配置、依赖、环境变量与数据库/)).toBeInTheDocument()
    expect(screen.getByText(/可能包含紧随其后的改动/)).toBeInTheDocument()
    expect(screen.getByText('移入回收站 1 个文件（这一轮之后新增）')).toBeInTheDocument()
    expect(screen.getByText('跳过 1 个文件')).toBeInTheDocument()
    expect(screen.getByText('二进制旧版没有副本，无法恢复')).toBeInTheDocument()
    expect(screen.getByText('固化副本')).toBeInTheDocument()
    expect(screen.getByText('可恢复')).toBeInTheDocument()
  })

  it('默认勾选「同时分支对话」；取消勾选后 apply 传 false', async () => {
    const api = install()
    renderDialog()
    await waitFor(() => expect(screen.getByText('将恢复 2 个文件')).toBeInTheDocument())

    const checkbox = screen.getByRole('checkbox', {
      name: /同时从此轮分支对话/,
    }) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(checkbox)
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))
    await waitFor(() =>
      expect(api.checkpointApply).toHaveBeenCalledWith({
        sessionKey: 'conv-1',
        turnId: 't1',
        restoreConversation: false,
      }),
    )
  })

  it('恢复后给摘要与「撤销这次恢复」，并把新会话交给上层', async () => {
    const api = install()
    const onApplied = vi.fn()
    renderDialog(onApplied)
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '恢复' }))

    await waitFor(() => expect(screen.getByText(/已恢复 2 个、移入回收站 1 个、跳过 1 个/)).toBeInTheDocument())
    expect(screen.getByText(/已创建对话分支/)).toBeInTheDocument()
    expect(onApplied).toHaveBeenCalledWith(
      expect.objectContaining({ checkpointId: 'cp-1', newSessionKey: 'branch-1' }),
    )
    // 恢复后不再显示「恢复」按钮
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '撤销这次恢复' }))
    await waitFor(() => expect(api.checkpointUndo).toHaveBeenCalledWith('cp-1'))
    expect(screen.getByText(/已撤销：回退 1 个文件，回收站放回 1 个/)).toBeInTheDocument()
  })

  it('没有 VCS 的诚实降级：文本跳过 + 警告，仍可把新增文件移入回收站', async () => {
    install({
      checkpointPlan: vi.fn(async () => ({
        ok: true,
        plan: {
          ...PLAN,
          textCommitOid: null,
          files: [
            { path: 'outputs/a/doc.md', action: 'skip', reason: '没有可用的文本快照' },
            { path: 'outputs/a/new.md', action: 'trash', firstStatus: 'added' },
          ],
          warnings: ['没有可用的文本快照（VCS 未启用，或这一轮之前没有提交）；文本文件不会回退。'],
        } satisfies CheckpointPlan,
      })),
    })
    renderDialog()
    await waitFor(() =>
      expect(screen.getAllByText(/没有可用的文本快照/).length).toBeGreaterThan(0),
    )
    expect(screen.getByText('将恢复 0 个文件')).toBeInTheDocument()
    expect(screen.getByText('移入回收站 1 个文件（这一轮之后新增）')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '恢复' })).toBeEnabled()
  })

  it('计划读取失败给可读错误', async () => {
    install({
      checkpointPlan: vi.fn(async () => ({ ok: false, error: '找不到这一轮（可能已被清理）' })),
    })
    renderDialog()
    await waitFor(() =>
      expect(screen.getByText('找不到这一轮（可能已被清理）')).toBeInTheDocument(),
    )
  })
})
