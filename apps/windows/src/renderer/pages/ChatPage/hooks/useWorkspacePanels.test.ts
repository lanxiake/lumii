import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useWorkspacePanels } from './useWorkspacePanels'
import { hashWorkspaceDir } from '../components/WorkspaceWorkbench/layout'

vi.mock('../../../hooks/business/useWorkspaceVcs', () => ({
  useWorkspaceVcs: () => ({ uncommittedDiff: [], refresh: vi.fn() }),
}))

vi.mock('../../../hooks/business/useWorkspace', () => ({
  useWorkspace: () => ({
    workspaceDir: 'E:/ws',
    toAbsolutePath: (p: string) => `E:/ws/${p}`,
    toRelativePath: (p: string) =>
      p.replace(/\\/g, '/').startsWith('E:/ws/') ? p.replace(/\\/g, '/').slice(6) : p,
  }),
}))

describe('useWorkspacePanels · 工作台状态', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认关闭、工作区视图、只看产出、半档', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    expect(result.current.workbench).toMatchObject({
      open: false,
      view: 'workspace',
      onlyArtifacts: true,
      preset: 'half',
    })
  })

  it('工具栏开关：打开工作区，再点关闭', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.toggleWorkbench())
    expect(result.current.workbench.open).toBe(true)
    expect(result.current.workbench.view).toBe('workspace')
    act(() => result.current.toggleWorkbench())
    expect(result.current.workbench.open).toBe(false)
  })

  it('openDoc 在工作区内 → 相对路径 + workspace 视图 + 选中', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('E:/ws/docs/a.md'))

    expect(result.current.workbench).toMatchObject({
      open: true,
      view: 'workspace',
      onlyArtifacts: true,
      selectedPath: 'docs/a.md',
    })
  })

  it('openDoc 工作区外 → 保留绝对路径（toAbsolutePath 原样透传）', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('D:/other/b.md'))
    expect(result.current.workbench.selectedPath).toBe('D:/other/b.md')
  })

  it('openDoc 工作区路径大小写不敏感（Windows）', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('e:/WS/docs/a.md'))
    expect(result.current.workbench.selectedPath).toBe('docs/a.md')
  })

  it('切视图 / 只看产出 / 选中 / 返回列表', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.selectWorkbenchView('vcs'))
    expect(result.current.workbench.view).toBe('vcs')
    act(() => result.current.setOnlyArtifacts(false))
    expect(result.current.workbench).toMatchObject({ view: 'workspace', onlyArtifacts: false })
    act(() => result.current.selectPath('outputs/a.png'))
    expect(result.current.workbench.selectedPath).toBe('outputs/a.png')
    act(() => result.current.selectPath(undefined))
    expect(result.current.workbench.selectedPath).toBeUndefined()
  })

  it('宽度与开关按工作区持久化，重开还原', () => {
    const first = renderHook(() => useWorkspacePanels('chat'))
    act(() => first.result.current.setPreset('wide'))
    act(() => first.result.current.setOnlyArtifacts(false))
    first.unmount()

    const stored = localStorage.getItem(`lumii.workbench.v2.${hashWorkspaceDir('E:/ws')}`)
    expect(stored).toContain('"preset":"wide"')
    expect(stored).toContain('"onlyArtifacts":false')

    const second = renderHook(() => useWorkspacePanels('chat'))
    expect(second.result.current.workbench.preset).toBe('wide')
    expect(second.result.current.workbench.onlyArtifacts).toBe(false)
  })

  it('拖拽后的 custom 宽度持久化', () => {
    const first = renderHook(() => useWorkspacePanels('chat'))
    act(() => first.result.current.setPreset('custom', 612))
    first.unmount()

    const second = renderHook(() => useWorkspacePanels('chat'))
    expect(second.result.current.workbench.preset).toBe('custom')
    expect(second.result.current.workbench.customWidth).toBe(612)
  })

  it('查看本轮变更：切回工作区文件视图并定位', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.handleReviewTurnFileChange('outputs/a.png', 'modified'))
    expect(result.current.workbench).toMatchObject({
      open: true,
      view: 'workspace',
      onlyArtifacts: false,
    })
    expect(result.current.locateFileTarget?.path).toBe('E:/ws/outputs/a.png')
    expect(result.current.locateFileTarget?.preview).toBe(true)
  })
})
