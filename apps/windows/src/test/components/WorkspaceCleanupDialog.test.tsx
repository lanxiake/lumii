import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WorkspaceCleanupDialog } from '../../renderer/pages/ChatPage/components/WorkspaceCleanupDialog'

const cleanupScan = vi.fn()
const cleanupRun = vi.fn()
const cleanupListTrash = vi.fn()
const cleanupRestore = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  cleanupListTrash.mockResolvedValue([])
  cleanupScan.mockResolvedValue({
    ok: true,
    scan: {
      workspaceDir: 'E:/ws',
      classes: {
        deliverable: { count: 2, bytes: 100 },
        intermediate: { count: 300, bytes: 2048 },
        ephemeral: { count: 10, bytes: 1024 },
        internal: { count: 1, bytes: 1 },
      },
      candidates: [],
      skipped: [],
      truncated: false,
      scannedAt: 0,
    },
  })
  cleanupRun.mockImplementation((payload: { dryRun: boolean }) =>
    Promise.resolve(
      payload.dryRun
        ? { ok: true, dryRun: true, removed: 4, bytes: 4096, skipped: 306 }
        : { ok: true, dryRun: false, removed: 4, bytes: 4096, skipped: 306, trashId: 't1' },
    ),
  )
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    workspace: { cleanupScan, cleanupRun, cleanupListTrash, cleanupRestore },
  }
})

describe('WorkspaceCleanupDialog', () => {
  it('用干跑结果报「实际将清理」，并把声明成品作为保护路径传下去', async () => {
    render(
      <WorkspaceCleanupDialog
        open
        onClose={vi.fn()}
        protectedPaths={['outputs/x/frames/final.mp4']}
      />,
    )

    await waitFor(() => expect(cleanupRun).toHaveBeenCalled())
    expect(cleanupRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        target: 'intermediate',
        protectedPaths: ['outputs/x/frames/final.mp4'],
      }),
    )
    await waitFor(() =>
      expect(screen.getByText(/实际将清理 4 个/)).toBeInTheDocument(),
    )

    fireEvent.click(screen.getByRole('button', { name: /移入回收站/ }))
    await waitFor(() =>
      expect(cleanupRun).toHaveBeenCalledWith(
        expect.objectContaining({
          dryRun: false,
          protectedPaths: ['outputs/x/frames/final.mp4'],
        }),
      ),
    )
  })

  it('干跑报 0 个时按钮禁用（不会假装能清）', async () => {
    cleanupRun.mockResolvedValue({ ok: true, dryRun: true, removed: 0, bytes: 0, skipped: 300 })
    render(<WorkspaceCleanupDialog open onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/实际将清理 0 个/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /移入回收站/ })).toBeDisabled()
  })
})
