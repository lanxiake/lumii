import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WorkspaceWorkbench } from './index'

function renderShell(props: Partial<React.ComponentProps<typeof WorkspaceWorkbench>> = {}) {
  return render(
    <WorkspaceWorkbench
      open
      view="workspace"
      onlyArtifacts
      preset="half"
      onViewChange={vi.fn()}
      onOnlyArtifactsChange={vi.fn()}
      onPresetChange={vi.fn()}
      onClose={vi.fn()}
      uncommittedCount={0}
      rail={<div>台账内容</div>}
      main={<div>预览内容</div>}
      {...props}
    />,
  )
}

describe('WorkspaceWorkbench · 布局与视图', () => {
  it('关闭时宽度为 0 且 aria-hidden', () => {
    const { container } = renderShell({ open: false })
    const aside = container.querySelector('aside')!
    expect(aside).toHaveAttribute('aria-hidden', 'true')
    expect(aside.style.width).toBe('0px')
  })

  it('两个视图：工作区 / 版本（版本停用则整条消失）', () => {
    const onViewChange = vi.fn()
    const { rerender } = renderShell({ onViewChange })
    expect(screen.getByRole('button', { name: '工作区' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /版本/ }))
    expect(onViewChange).toHaveBeenCalledWith('vcs')

    rerender(
      <WorkspaceWorkbench
        open
        view="workspace"
        onlyArtifacts
        preset="half"
        onViewChange={vi.fn()}
        onOnlyArtifactsChange={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={0}
        vcsEnabled={false}
        rail={<div>台账内容</div>}
        main={<div>预览内容</div>}
      />,
    )
    expect(screen.queryByRole('button', { name: /版本/ })).toBeNull()
  })

  it('VCS 停用但 view=vcs 时回退工作区，避免空白内容区', () => {
    const onViewChange = vi.fn()
    renderShell({
      view: 'vcs',
      vcsEnabled: false,
      onViewChange,
      rail: <div>台账内容</div>,
      main: <div>预览内容</div>,
      childrenVcs: <div>版本内容</div>,
    })
    expect(onViewChange).toHaveBeenCalledWith('workspace')
    expect(screen.getByText('台账内容')).toBeInTheDocument()
    expect(screen.getByText('预览内容')).toBeInTheDocument()
    expect(screen.queryByText('版本内容')).not.toBeVisible()
  })

  it('VCS 停用 + view=vcs：工作台关着时不强行打开', () => {
    const onViewChange = vi.fn()
    renderShell({ open: false, view: 'vcs', vcsEnabled: false, onViewChange })
    expect(onViewChange).not.toHaveBeenCalled()
  })

  it('单击拖拽条（无位移）不写 custom；pointercancel 也不写', () => {
    const onPresetChange = vi.fn()
    const { container } = renderShell({ onPresetChange })
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 800, pointerId: 1 })
    expect(onPresetChange).not.toHaveBeenCalled()

    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 2 })
    fireEvent.pointerMove(handle, { clientX: 700, pointerId: 2 })
    fireEvent.pointerCancel(handle, { pointerId: 2 })
    expect(onPresetChange).not.toHaveBeenCalled()
  })

  it('拖拽松手按 pointerup 坐标写回 custom 宽度，不依赖过期 state', () => {
    const onPresetChange = vi.fn()
    const { container } = renderShell({ onPresetChange, preset: 'half' })
    const handle = container.querySelector('[role="separator"]') as HTMLElement
    // jsdom 无 Pointer Capture API
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    fireEvent.pointerDown(handle, { clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 700, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 600, pointerId: 1 })
    expect(onPresetChange).toHaveBeenCalledWith('custom', expect.any(Number))
    const saved = onPresetChange.mock.calls[0]?.[1] as number
    // half 起点约 480，向左拖 200px → 约 680；至少要比只拖到 700 时更宽
    expect(saved).toBeGreaterThanOrEqual(680)
  })

  it('「只看产出」开关只在工作区视图出现，点击回调', () => {
    const onOnlyArtifactsChange = vi.fn()
    const { rerender } = renderShell({ onOnlyArtifactsChange })
    fireEvent.click(screen.getByRole('button', { name: '只看产出' }))
    expect(onOnlyArtifactsChange).toHaveBeenCalledWith(false)

    rerender(
      <WorkspaceWorkbench
        open
        view="vcs"
        onlyArtifacts
        preset="half"
        onViewChange={vi.fn()}
        onOnlyArtifactsChange={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={0}
        rail={<div>台账内容</div>}
        main={<div>预览内容</div>}
        childrenVcs={<div>版本内容</div>}
      />,
    )
    expect(screen.queryByRole('button', { name: '只看产出' })).toBeNull()
    expect(screen.getByText('版本内容')).toBeInTheDocument()
  })

  it('三档宽度按钮回调 preset', () => {
    const onPresetChange = vi.fn()
    renderShell({ onPresetChange })
    fireEvent.click(screen.getByRole('button', { name: '宽' }))
    fireEvent.click(screen.getByRole('button', { name: '满' }))
    expect(onPresetChange).toHaveBeenNthCalledWith(1, 'wide')
    expect(onPresetChange).toHaveBeenNthCalledWith(2, 'full')
  })

  it('选中产物时显示面包屑与 main；未选中只显示空 main 内容', () => {
    const { rerender } = renderShell({ selectedPath: 'outputs/a.png' })
    expect(screen.getByText('outputs/a.png')).toBeInTheDocument()
    expect(screen.getByText('预览内容')).toBeInTheDocument()

    rerender(
      <WorkspaceWorkbench
        open
        view="workspace"
        onlyArtifacts
        preset="half"
        onViewChange={vi.fn()}
        onOnlyArtifactsChange={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={0}
        rail={<div>台账内容</div>}
        main={<div>空态</div>}
      />,
    )
    expect(screen.getByText('空态')).toBeInTheDocument()
  })

  it('不渲染 portal：aside 就在调用位置', () => {
    const { container } = render(
      <div data-testid="parent">
        <WorkspaceWorkbench
          open
          view="workspace"
          onlyArtifacts
          preset="half"
          onViewChange={vi.fn()}
          onOnlyArtifactsChange={vi.fn()}
          onPresetChange={vi.fn()}
          onClose={vi.fn()}
          uncommittedCount={0}
          rail={<div>台账内容</div>}
          main={<div>预览内容</div>}
        />
      </div>,
    )
    expect(container.querySelector('[data-testid="parent"] aside')).not.toBeNull()
  })

  it('非单栏时可收起/展开左侧产物路径 rail', () => {
    // wide=860 ≥560，双栏
    renderShell({
      preset: 'wide',
      selectedPath: 'outputs/a.png',
      rail: <div>台账内容</div>,
      main: <div>预览内容</div>,
    })
    expect(screen.getByText('台账内容')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '收起产物列表' }))
    expect(screen.queryByText('台账内容')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开产物列表' }))
    expect(screen.getByText('台账内容')).toBeVisible()
  })

  it('并排 inspector（满档）可用「信息」钮收起/展开', () => {
    const onInspectorOpenChange = vi.fn()
    const { rerender } = renderShell({
      preset: 'full',
      selectedPath: 'outputs/a.png',
      inspector: <div>规格详情</div>,
      inspectorOpen: true,
      onInspectorOpenChange,
    })
    expect(screen.getByText('规格详情')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '产物信息与版本' }))
    expect(onInspectorOpenChange).toHaveBeenCalledWith(false)

    rerender(
      <WorkspaceWorkbench
        open
        view="workspace"
        onlyArtifacts
        preset="full"
        selectedPath="outputs/a.png"
        onViewChange={vi.fn()}
        onOnlyArtifactsChange={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={0}
        rail={<div>台账内容</div>}
        main={<div>预览内容</div>}
        inspector={<div>规格详情</div>}
        inspectorOpen={false}
        onInspectorOpenChange={onInspectorOpenChange}
      />,
    )
    expect(screen.queryByText('规格详情')).not.toBeInTheDocument()
  })

  it('专注预览：顶栏按钮收起两侧，再按按快照恢复', () => {
    const onInspectorOpenChange = vi.fn()
    const base = {
      open: true as const,
      view: 'workspace' as const,
      onlyArtifacts: true,
      preset: 'full' as const,
      selectedPath: 'outputs/a.png',
      onViewChange: vi.fn(),
      onOnlyArtifactsChange: vi.fn(),
      onPresetChange: vi.fn(),
      onClose: vi.fn(),
      uncommittedCount: 0,
      rail: <div>台账内容</div>,
      main: <div>预览内容</div>,
      inspector: <div>规格详情</div>,
      onInspectorOpenChange,
    }
    const { rerender } = render(<WorkspaceWorkbench {...base} inspectorOpen />)
    expect(screen.getByText('台账内容')).toBeVisible()
    expect(screen.getByText('规格详情')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: '专注预览' }))
    expect(screen.queryByText('台账内容')).not.toBeInTheDocument()
    expect(onInspectorOpenChange).toHaveBeenCalledWith(false)

    onInspectorOpenChange.mockClear()
    rerender(<WorkspaceWorkbench {...base} inspectorOpen={false} />)
    fireEvent.click(screen.getByRole('button', { name: '退出专注预览' }))
    expect(screen.getByText('台账内容')).toBeVisible()
    expect(onInspectorOpenChange).toHaveBeenCalledWith(true)
  })

  it('Ctrl+B 在工作台打开时切换专注预览（捕获阶段拦住侧栏）', () => {
    const onInspectorOpenChange = vi.fn()
    const sidebarSpy = vi.fn()
    window.addEventListener('keydown', sidebarSpy)

    renderShell({
      preset: 'full',
      selectedPath: 'outputs/a.png',
      inspector: <div>规格详情</div>,
      inspectorOpen: true,
      onInspectorOpenChange,
      rail: <div>台账内容</div>,
    })

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByText('台账内容')).not.toBeInTheDocument()
    expect(onInspectorOpenChange).toHaveBeenCalledWith(false)
    expect(sidebarSpy).not.toHaveBeenCalled()

    window.removeEventListener('keydown', sidebarSpy)
  })
})
