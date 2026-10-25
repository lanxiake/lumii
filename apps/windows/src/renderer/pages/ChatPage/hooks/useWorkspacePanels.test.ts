import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useWorkspacePanels } from './useWorkspacePanels'

vi.mock('../../../hooks/business/useWorkspaceVcs', () => ({
  useWorkspaceVcs: () => ({ uncommittedDiff: [], refresh: vi.fn() }),
}))

vi.mock('../../../hooks/business/useWorkspace', () => ({
  useWorkspace: () => ({ workspaceDir: 'E:/ws', toAbsolutePath: (p: string) => `E:/ws/${p}` }),
}))

describe('useWorkspacePanels · openDoc', () => {
  it('打开文档 Tab 并记住路径', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('E:/ws/a.md'))

    expect(result.current.workbench).toEqual({ open: true, tab: 'doc' })
    expect(result.current.docPath).toBe('E:/ws/a.md')
  })

  it('换路径直接覆盖', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('E:/ws/a.md'))
    act(() => result.current.openDoc('E:/ws/b.md'))
    expect(result.current.docPath).toBe('E:/ws/b.md')
  })

  it('关闭工作台后 docPath 保留（再打开回到上次那份）', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('E:/ws/a.md'))
    act(() => result.current.closeWorkbench())

    expect(result.current.workbench.open).toBe(false)
    expect(result.current.docPath).toBe('E:/ws/a.md')
  })
})
