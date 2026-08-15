/**
 * 工作空间工作台跨面板协调回归测试
 */

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceWorkbench } from '../../renderer/pages/ChatPage/components/WorkspaceWorkbench'
import { WorkspaceFilePanel } from '../../renderer/pages/ChatPage/components/WorkspaceFilePanel'
import { WorkspaceVersionPanel } from '../../renderer/pages/ChatPage/components/WorkspaceVersionPanel/WorkspaceVersionPanel'

const refreshVcs = vi.fn(async () => undefined)

vi.mock('../../renderer/hooks/business/useWorkspaceVcs', () => ({
  useWorkspaceVcs: () => ({
    history: [],
    uncommittedDiff: [{ filepath: 'changed.ts', insertions: 1, deletions: 0, status: 'modified' }],
    loading: false,
    commit: vi.fn(),
    rollback: vi.fn(),
    revertFile: vi.fn(),
    diffList: vi.fn(),
    diffFile: vi.fn(),
    refresh: refreshVcs,
  }),
}))

vi.mock('../../renderer/hooks/business/useWorkspace', () => ({
  useWorkspace: () => ({ workspaceDir: 'D:\\workspace', isInitializing: false }),
}))

vi.mock('../../renderer/hooks/business/useFiles', () => ({
  useFiles: () => ({ renameFile: vi.fn() }),
}))

vi.mock('../../renderer/hooks/business/useCodingDevProjects', () => ({
  useCodingDevProjects: () => ({ reload: vi.fn() }),
}))

vi.mock('../../renderer/pages/ChatPage/components/WorkspaceFilePanel/FileTree', () => ({
  FileTree: ({ onSelect }: { onSelect: (item: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onSelect({ name: 'notes.md', path: 'D:\\workspace\\notes.md', isDirectory: false })}
    >
      打开预览
    </button>
  ),
}))

vi.mock('../../renderer/pages/ChatPage/components/WorkspaceFilePanel/FileSearchBar', () => ({
  FileSearchBar: () => null,
}))

vi.mock('../../renderer/pages/ChatPage/components/WorkspaceFilePanel/ProjectsSection', () => ({
  ProjectsSection: () => null,
}))

vi.mock('../../renderer/components/FilePreviewModal', () => ({
  FilePreviewModal: ({ onClose }: { onClose: () => void }) => {
    React.useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [onClose])
    return (
      <div role="dialog" data-file-preview-open>
        文件预览
      </div>
    )
  },
}))

vi.mock('../../renderer/components/ui/Modal/ConfirmModal', () => ({
  ConfirmModal: () => null,
}))

describe('WorkspaceWorkbench 面板协调', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('由版本面板向工作台同步未提交数量与刷新函数', async () => {
    const onUncommittedCountChange = vi.fn()
    const refreshRef: React.MutableRefObject<(() => Promise<void>) | null> = { current: null }

    render(
      <WorkspaceVersionPanel
        open={false}
        embedded
        onClose={vi.fn()}
        onUncommittedCountChange={onUncommittedCountChange}
        refreshRef={refreshRef}
      />,
    )

    await waitFor(() => {
      expect(onUncommittedCountChange).toHaveBeenLastCalledWith(1)
      expect(refreshRef.current).toBe(refreshVcs)
    })
  })

  it('嵌入文件面板有预览时 Esc 先关闭预览而不关闭工作台', () => {
    const onClose = vi.fn()

    render(
      <WorkspaceWorkbench
        open
        tab="files"
        onTabChange={vi.fn()}
        onClose={onClose}
        uncommittedCount={0}
        childrenFiles={<WorkspaceFilePanel open embedded onClose={onClose} />}
        childrenVcs={null}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '打开预览' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('文件预览')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
