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

const V3 = (key: string): string => `lumii.workbench.v3.${key}`
const V2 = (key: string): string => `lumii.workbench.v2.${key}`
const WS = (): string => hashWorkspaceDir('E:/ws')

describe('useWorkspacePanels · 工作台状态', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认关闭、落在产物页、半档', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    expect(result.current.workbench).toMatchObject({
      open: false,
      tabs: ['artifacts'],
      activeTab: 'artifacts',
      preset: 'half',
    })
  })

  it('工具栏开关：打开工作台，再点关闭', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.toggleWorkbench())
    expect(result.current.workbench.open).toBe(true)
    act(() => result.current.toggleWorkbench())
    expect(result.current.workbench.open).toBe(false)
  })

  it('openPanel 已开则只切过去，不重复插；新页按固定顺序排', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openPanel('artifacts'))
    expect(result.current.workbench.tabs).toEqual(['artifacts'])

    act(() => result.current.openPanel('terminal'))
    expect(result.current.workbench.tabs).toEqual(['artifacts', 'terminal'])
    expect(result.current.workbench.activeTab).toBe('terminal')

    act(() => result.current.openPanel('files'))
    // TAB_ORDER：artifacts → files → project → terminal → vcs
    expect(result.current.workbench.tabs).toEqual(['artifacts', 'files', 'terminal'])

    act(() => result.current.openPanel('artifacts'))
    expect(result.current.workbench.tabs).toEqual(['artifacts', 'files', 'terminal'])
    expect(result.current.workbench.activeTab).toBe('artifacts')
  })

  it('closePanel 关掉当前页时接管相邻页', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openPanel('files'))
    act(() => result.current.openPanel('terminal'))
    act(() => result.current.closePanel('terminal'))
    expect(result.current.workbench.tabs).toEqual(['artifacts', 'files'])
    // 关的是当前页：接管右边那个，没有就左边
    expect(result.current.workbench.activeTab).toBe('files')
  })

  it('关掉最后一个页 = 收起整列（下次展开落在开始页）', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.closePanel('artifacts'))
    expect(result.current.workbench).toMatchObject({
      open: false,
      tabs: [],
      activeTab: null,
    })
    act(() => result.current.toggleWorkbench())
    expect(result.current.workbench.open).toBe(true)
    expect(result.current.workbench.tabs).toEqual([])
  })

  it('openDoc 在工作区内 → 相对路径 + 产物页 + 选中', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.openDoc('E:/ws/docs/a.md'))

    expect(result.current.workbench).toMatchObject({
      open: true,
      tabs: ['artifacts'],
      activeTab: 'artifacts',
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

  it('openArtifactsWorkbench 打开产物页', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat', 's1'))
    act(() => result.current.openPanel('files'))
    act(() => result.current.closeWorkbench())
    act(() => result.current.openArtifactsWorkbench())
    expect(result.current.workbench).toMatchObject({
      open: true,
      activeTab: 'artifacts',
    })
    expect(result.current.workbench.tabs).toContain('artifacts')
  })

  it('选中 / 返回列表', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.selectPath('outputs/a.png'))
    expect(result.current.workbench.selectedPath).toBe('outputs/a.png')
    act(() => result.current.selectPath(undefined))
    expect(result.current.workbench.selectedPath).toBeUndefined()
  })

  it('宽度与 tab 列表按工作区持久化，重开还原', () => {
    const first = renderHook(() => useWorkspacePanels('chat'))
    act(() => first.result.current.setPreset('wide'))
    act(() => first.result.current.openPanel('files'))
    act(() => first.result.current.openPanel('terminal'))
    first.unmount()

    const stored = localStorage.getItem(V3(WS()))
    expect(stored).toContain('"preset":"wide"')
    expect(stored).toContain('"tabs":["artifacts","files","terminal"]')

    const second = renderHook(() => useWorkspacePanels('chat'))
    expect(second.result.current.workbench.preset).toBe('wide')
    expect(second.result.current.workbench.tabs).toEqual(['artifacts', 'files', 'terminal'])
    expect(second.result.current.workbench.activeTab).toBe('terminal')
  })

  it('旧版（视图 + 只看产出）的持久化能迁移：关掉只看产出 → 文件页', () => {
    localStorage.setItem(
      V2(WS()),
      JSON.stringify({ view: 'workspace', onlyArtifacts: false, preset: 'wide', follow: false }),
    )
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    expect(result.current.workbench).toMatchObject({
      tabs: ['files'],
      activeTab: 'files',
      preset: 'wide',
    })
  })

  it('旧版 view=vcs 迁移到版本页', () => {
    localStorage.setItem(
      V2(WS()),
      JSON.stringify({ view: 'vcs', onlyArtifacts: true, preset: 'half' }),
    )
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    expect(result.current.workbench.tabs).toEqual(['vcs'])
    expect(result.current.workbench.activeTab).toBe('vcs')
  })

  it('持久化里的未知 kind 被过滤，非法 active 回落到第一个', () => {
    localStorage.setItem(
      V3(WS()),
      JSON.stringify({ tabs: ['type', 'files'], activeTab: 'terminal', preset: 'half' }),
    )
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    expect(result.current.workbench.tabs).toEqual(['files'])
    expect(result.current.workbench.activeTab).toBe('files')
  })

  it('拖拽后的 custom 宽度持久化', () => {
    const first = renderHook(() => useWorkspacePanels('chat'))
    act(() => first.result.current.setPreset('custom', 612))
    first.unmount()

    const second = renderHook(() => useWorkspacePanels('chat'))
    expect(second.result.current.workbench.preset).toBe('custom')
    expect(second.result.current.workbench.customWidth).toBe(612)
  })

  it('查看本轮变更：切到文件页并定位', () => {
    const { result } = renderHook(() => useWorkspacePanels('chat'))
    act(() => result.current.handleReviewTurnFileChange('outputs/a.png', 'modified'))
    expect(result.current.workbench).toMatchObject({
      open: true,
      activeTab: 'files',
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
