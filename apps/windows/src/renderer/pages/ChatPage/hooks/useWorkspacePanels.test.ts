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

describe('useWorkspacePanels · 未查看产出（lastSeenAt）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('第一次进入某会话：lastSeenAt 初始化为当前时间（历史产出不会变成巨大角标）', () => {
    const before = Date.now()
    const { result } = renderHook(() => useWorkspacePanels('chat', 'sess-1'))
    expect(result.current.lastSeenAt).toBeGreaterThanOrEqual(before)
    // 已落盘，后续进入不会重新初始化
    expect(Number(localStorage.getItem('lumii.workbench.seen.sess-1'))).toBeGreaterThan(0)
  })

  it('打开工作台会刷新 lastSeenAt 并落盘', async () => {
    const { result } = renderHook(() => useWorkspacePanels('chat', 'sess-2'))
    const first = result.current.lastSeenAt
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    act(() => result.current.toggleWorkbench())
    expect(result.current.lastSeenAt).toBeGreaterThanOrEqual(first)
    expect(Number(localStorage.getItem('lumii.workbench.seen.sess-2'))).toBe(
      result.current.lastSeenAt,
    )
  })

  it('切会话读回各自的记录，不串档', () => {
    localStorage.setItem('lumii.workbench.seen.sess-a', '111')
    localStorage.setItem('lumii.workbench.seen.sess-b', '222')
    const { result, rerender } = renderHook(
      ({ session }: { session: string }) => useWorkspacePanels('chat', session),
      { initialProps: { session: 'sess-a' } },
    )
    expect(result.current.lastSeenAt).toBe(111)
    rerender({ session: 'sess-b' })
    expect(result.current.lastSeenAt).toBe(222)
  })

  it('follow 默认关，setFollow 改内存态', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat', 'sess-3'))
    expect(result.current.workbench.follow).toBe(false)
    act(() => result.current.setFollow(true))
    expect(result.current.workbench.follow).toBe(true)
  })
})
