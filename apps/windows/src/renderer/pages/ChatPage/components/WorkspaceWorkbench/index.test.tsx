import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WorkspaceWorkbench } from './index'
import { WORKBENCH_ENTRIES, type WorkbenchTabKind } from './layout'

function renderShell(props: Partial<React.ComponentProps<typeof WorkspaceWorkbench>> = {}) {
  const tabRender: Partial<Record<WorkbenchTabKind, React.ReactNode>> = {}
  return render(
    <WorkspaceWorkbench
      open
      tabs={['artifacts']}
      activeTab="artifacts"
      preset="half"
      onOpenTab={vi.fn()}
      onCloseTab={vi.fn()}
      onPresetChange={vi.fn()}
      onClose={vi.fn()}
      uncommittedCount={0}
      renderPane={(kind) => ({
        rail: <div>台账内容</div>,
        main: tabRender[kind] ?? <div>预览内容</div>,
      })}
      {...props}
    />,
  )
}

describe('WorkspaceWorkbench · 布局', () => {
  it('关闭时宽度为 0 且 aria-hidden', () => {
    const { container } = renderShell({ open: false })
    const aside = container.querySelector('aside')!
    expect(aside).toHaveAttribute('aria-hidden', 'true')
    expect(aside.style.width).toBe('0px')
  })

  it('不渲染 portal：aside 就在调用位置', () => {
    const { container } = render(
      <div data-testid="parent">
        <WorkspaceWorkbench
          open
          tabs={['artifacts']}
          activeTab="artifacts"
          preset="half"
          onOpenTab={vi.fn()}
          onCloseTab={vi.fn()}
          onPresetChange={vi.fn()}
          onClose={vi.fn()}
          uncommittedCount={0}
          renderPane={() => ({ rail: <div>台账内容</div>, main: <div>预览内容</div> })}
        />
      </div>,
    )
    expect(container.querySelector('[data-testid="parent"] aside')).not.toBeNull()
  })

  it('三档宽度按钮回调 preset', () => {
    const onPresetChange = vi.fn()
    renderShell({ onPresetChange })
    fireEvent.click(screen.getByRole('button', { name: '宽' }))
    fireEvent.click(screen.getByRole('button', { name: '满' }))
    expect(onPresetChange).toHaveBeenNthCalledWith(1, 'wide')
    expect(onPresetChange).toHaveBeenNthCalledWith(2, 'full')
  })
})

describe('WorkspaceWorkbench · tab 可关可增', () => {
  it('tab 条只画开着的页，每个都带关闭按钮', () => {
    const onCloseTab = vi.fn()
    renderShell({
      tabs: ['artifacts', 'files'],
      onCloseTab,
      renderPane: () => ({ rail: <div>台账内容</div>, main: <div>预览内容</div> }),
    })
    expect(screen.getByRole('button', { name: '只看产出' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭「工作区文件」' }))
    expect(onCloseTab).toHaveBeenCalledWith('files')
  })

  it('点「+」出开始页；选一个入口就打开它', () => {
    const onOpenTab = vi.fn()
    renderShell({ onOpenTab })
    // 有 tab 时开始页不出现
    expect(screen.queryByRole('button', { name: /新建终端/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '打开新页面' }))
    expect(screen.getByRole('button', { name: /新建终端/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /新建终端/ }))
    expect(onOpenTab).toHaveBeenCalledWith('terminal')
    // 选完收起开始页，回到当前 tab
    expect(screen.queryByRole('button', { name: /段在项目目录里跑命令/ })).toBeNull()
  })

  it('一个 tab 都没有时直接显示开始页（关掉最后一个后收起整列的场景）', () => {
    renderShell({ tabs: [], activeTab: null })
    for (const entry of WORKBENCH_ENTRIES) {
      expect(screen.getByRole('button', { name: new RegExp(entry.description) })).toBeInTheDocument()
    }
    expect(screen.queryByText('台账内容')).toBeNull()
  })

  it('开始页的入口可以按调用方过滤（插件停用时不放注定失败的门）', () => {
    const entries = WORKBENCH_ENTRIES.filter((entry) => entry.kind !== 'vcs')
    renderShell({ tabs: [], activeTab: null, entries })
    expect(screen.queryByRole('button', { name: /变更与提交历史/ })).toBeNull()
    expect(screen.getByRole('button', { name: /本会话的成品与过程文件/ })).toBeInTheDocument()
  })

  it('数字键直接打开对应页；Esc 先收开始页，再关工作台', () => {
    const onOpenTab = vi.fn()
    const onClose = vi.fn()
    renderShell({ onOpenTab, onClose })

    fireEvent.keyDown(window, { key: '4' })
    expect(onOpenTab).toHaveBeenCalledWith('terminal')

    onClose.mockClear()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()

    // 开始页开着时，Esc 只收开始页
    fireEvent.click(screen.getByRole('button', { name: '打开新页面' }))
    onClose.mockClear()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /新建终端/ })).toBeNull()
  })

  it('版本角标只在版本页开着时显示', () => {
    const { rerender } = renderShell({ tabs: ['vcs'], activeTab: 'vcs', uncommittedCount: 3 })
    expect(screen.getByText('3')).toBeInTheDocument()

    rerender(
      <WorkspaceWorkbench
        open
        tabs={['artifacts', 'vcs']}
        activeTab="artifacts"
        preset="half"
        onOpenTab={vi.fn()}
        onCloseTab={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={3}
        renderPane={() => ({ rail: <div>台账内容</div>, main: <div>预览内容</div> })}
      />,
    )
    expect(screen.getByText('3')).toBeInTheDocument()
  })
})

describe('WorkspaceWorkbench · 双栏与 inspector', () => {
  it('选中产物时显示面包屑与 main', () => {
    renderShell({ selectedPath: 'outputs/a.png' })
    expect(screen.getByText('outputs/a.png')).toBeInTheDocument()
    expect(screen.getByText('预览内容')).toBeInTheDocument()
  })

  it('单栏 tab 不画 rail（project/terminal/vcs 自带布局）', () => {
    renderShell({
      tabs: ['terminal'],
      activeTab: 'terminal',
      renderPane: () => ({ main: <div>终端内容</div> }),
    })
    expect(screen.getByText('终端内容')).toBeInTheDocument()
    expect(screen.queryByText('台账内容')).toBeNull()
  })

  it('非单栏时可收起/展开 rail', () => {
    renderShell({ preset: 'wide', selectedPath: 'outputs/a.png' })
    expect(screen.getByText('台账内容')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '收起列表' }))
    expect(screen.queryByText('台账内容')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开列表' }))
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
        tabs={['artifacts']}
        activeTab="artifacts"
        preset="full"
        selectedPath="outputs/a.png"
        onOpenTab={vi.fn()}
        onCloseTab={vi.fn()}
        onPresetChange={vi.fn()}
        onClose={vi.fn()}
        uncommittedCount={0}
        renderPane={() => ({ rail: <div>台账内容</div>, main: <div>预览内容</div> })}
        inspector={<div>规格详情</div>}
        inspectorOpen={false}
        onInspectorOpenChange={onInspectorOpenChange}
      />,
    )
    expect(screen.queryByText('规格详情')).not.toBeInTheDocument()
  })

  it('专注预览：收起两侧，再按按快照恢复', () => {
    const onInspectorOpenChange = vi.fn()
    const base = {
      open: true as const,
      tabs: ['artifacts'] as const,
      activeTab: 'artifacts' as const,
      preset: 'full' as const,
      selectedPath: 'outputs/a.png',
      onOpenTab: vi.fn(),
      onCloseTab: vi.fn(),
      onPresetChange: vi.fn(),
      onClose: vi.fn(),
      uncommittedCount: 0,
      renderPane: () => ({ rail: <div>台账内容</div>, main: <div>预览内容</div> }),
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
    })

    fireEvent.keyDown(window, { key: 'b', ctrlKey: true })
    expect(screen.queryByText('台账内容')).not.toBeInTheDocument()
    expect(onInspectorOpenChange).toHaveBeenCalledWith(false)
    expect(sidebarSpy).not.toHaveBeenCalled()

    window.removeEventListener('keydown', sidebarSpy)
  })
})
