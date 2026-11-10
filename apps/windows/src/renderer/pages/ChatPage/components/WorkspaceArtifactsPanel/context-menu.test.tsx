/**
 * 产物卡右键菜单（2026-11-05 用户报：产物列表的文件不能像工作区文件那样改名/复制路径）。
 *
 * 这里只钉住**交互接线**：右键开菜单、菜单项调对回调、重命名弹窗回填原名。
 * 真正的文件系统改名在 WorkspaceArtifactsPanel 里（走 window.electronAPI.file.move），
 * 不在这层；纯函数的换名规则见 local-edits.test.ts。
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../../../services/file-service', () => ({
  moveFile: vi.fn(async () => undefined),
}))
vi.mock('../../../../services/app-service', () => ({
  showItemInFolder: vi.fn(async () => undefined),
}))
vi.mock('../../../../components/FilePreviewModal', () => ({ FilePreviewModal: () => null }))

import { WorkspaceArtifactsPanel } from './index'
import { moveFile } from '../../../../services/file-service'

const ledger = {
  groups: [
    {
      key: 'outputs/demo',
      label: '做一组图',
      timestamp: 1000,
      startedAt: 1000,
      deliverables: [
        {
          path: 'outputs/demo/cover.png',
          kind: 'image' as const,
          role: 'deliverable' as const,
          status: 'added' as const,
          timestamp: 1000,
          turnId: 'm1',
        },
      ],
      intermediates: [],
    },
  ],
  counts: { deliverables: 1, intermediates: 0, byKind: { image: 1 } },
  versions: new Map(),
}

function renderPanel() {
  const onSelect = vi.fn()
  const onRenamed = vi.fn()
  const onTrashed = vi.fn()
  render(
    <WorkspaceArtifactsPanel
      ledger={ledger as never}
      toAbsolutePath={(p) => `C:/ws/${p}`}
      onSelect={onSelect}
      onRenamed={onRenamed}
      onTrashed={onTrashed}
    />,
  )
  return { onSelect, onRenamed, onTrashed }
}

describe('WorkspaceArtifactsPanel · 产物右键菜单', () => {
  it('右键卡片打开菜单，带预览/重命名/复制路径/删除', async () => {
    renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)

    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重命名' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制绝对路径' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
  })

  it('「预览」把相对路径交给父层选中', async () => {
    const { onSelect } = renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(onSelect).toHaveBeenCalledWith('outputs/demo/cover.png')
  })

  /**
   * 2026-11-10 用户报「右键菜单点了没反应」。
   *
   * 根因：关闭监听挂在 document 的**捕获阶段**（click, true），早于 React 的
   * onClick 派发，于是点任何一项都先 setMenu(null) 把菜单卸载了。
   * 旧测试只用 fireEvent.click 直接派发，压根不经过 document，所以没抓到。
   * 这里按真实序列来：先 mousedown（新逻辑靠它判内/外），再 click。
   */
  it('真实鼠标序列下菜单项仍能点到（回归：捕获阶段吞掉点击）', async () => {
    const { onSelect } = renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)

    const item = screen.getByRole('button', { name: '预览' })
    fireEvent.mouseDown(item)
    // 菜单不该在 mousedown 时就消失
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()
    fireEvent.click(item)
    expect(onSelect).toHaveBeenCalledWith('outputs/demo/cover.png')
  })

  it('点在菜单外面才收起', async () => {
    renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)
    expect(screen.getByRole('button', { name: '预览' })).toBeInTheDocument()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: '预览' })).not.toBeInTheDocument()
  })

  it('菜单里有「复制文件」（真文件进剪贴板，可在资源管理器粘贴）', async () => {
    renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)
    expect(screen.getByRole('button', { name: '复制文件' })).toBeInTheDocument()
  })

  it('重命名：弹窗回填原名，确认后调 moveFile 并上报新旧相对路径', async () => {
    const { onRenamed } = renderPanel()
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)
    fireEvent.click(screen.getByRole('button', { name: '重命名' }))

    const input = await screen.findByDisplayValue('cover.png')
    fireEvent.change(input, { target: { value: '封面.png' } })
    fireEvent.click(screen.getByRole('button', { name: '确定' }))

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('outputs/demo/cover.png', 'outputs/demo/封面.png'))
    expect(moveFile).toHaveBeenCalledWith('C:/ws/outputs/demo/cover.png', 'C:/ws/outputs/demo/封面.png')
  })

  it('不传 onRenamed 时不出现「重命名」（改了名 rail 与预览会对不上）', async () => {
    render(
      <WorkspaceArtifactsPanel
        ledger={ledger as never}
        toAbsolutePath={(p) => `C:/ws/${p}`}
        onSelect={vi.fn()}
      />,
    )
    const card = await screen.findByRole('button', { name: /cover\.png/ })
    fireEvent.contextMenu(card)
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument()
  })
})

/**
 * 运行状态区可收起（2026-11-05 用户报：工具报错一多，下面的产物列表就看不见了）。
 *
 * 两层防线：CSS 给列表封顶（自己滚），JS 给整块一个折叠按钮。
 * 这里钉 JS 那层——CSS 那层没法在 jsdom 里量。
 */
describe('WorkspaceArtifactsPanel · 运行状态可收起', () => {
  const failingCards = [
    {
      id: 'tool:1',
      turnId: 'm1',
      timestamp: 2000,
      kind: 'image' as const,
      lifecycle: 'failed' as const,
      title: 'cover.png',
      error: 'bash: command not found: xxxx',
    },
  ]

  it('有卡时出现「运行状态」开关，点一下收起、再点展开', async () => {
    render(
      <WorkspaceArtifactsPanel
        ledger={ledger as never}
        toAbsolutePath={(p) => `C:/ws/${p}`}
        onSelect={vi.fn()}
        cards={failingCards as never}
      />,
    )
    expect(await screen.findByText(/command not found/)).toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: /运行状态/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/command not found/)).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(await screen.findByText(/command not found/)).toBeInTheDocument()
  })
})
