/**
 * 结果动作条：按 kind 的动作矩阵、菜单项回调、危险动作二次确认、不可用动作不出现。
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ArtifactActionBar } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ArtifactActionBar'
import { primaryActionsFor } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/artifact-actions'
import type { Artifact } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'
import type { ArtifactKind } from '../../shared/artifact-rules'

function makeArtifact(kind: ArtifactKind): Artifact {
  return {
    path: `outputs/x/a.${kind === 'image' ? 'png' : 'md'}`,
    kind,
    role: 'deliverable',
    status: 'added',
    timestamp: 1,
    turnId: 't1',
  }
}

function renderBar(kind: ArtifactKind = 'image') {
  const props = {
    onEdit: vi.fn(),
    onLocate: vi.fn(),
    onCompare: vi.fn(),
    onExport: vi.fn(),
    onMore: vi.fn(),
  }
  render(<ArtifactActionBar artifact={makeArtifact(kind)} {...props} />)
  return props
}

describe('primaryActionsFor 动作矩阵', () => {
  it.each([
    ['image', ['exportMenu', 'locate', 'compare', 'more']],
    ['video', ['exportMenu', 'locate', 'compare', 'more']],
    ['audio', ['exportMenu', 'locate', 'compare', 'more']],
    ['doc', ['edit', 'exportMenu', 'locate', 'more']],
    ['sheet', ['edit', 'exportMenu', 'locate', 'more']],
    ['slides', ['edit', 'exportMenu', 'locate', 'more']],
    ['code', ['exportMenu', 'locate', 'more']],
    ['other', ['exportMenu', 'locate', 'more']],
  ] as const)('%s → %j', (kind, expected) => {
    expect(primaryActionsFor(kind)).toEqual(expected)
  })

  it('一级动作永远不超过 5 个', () => {
    const kinds: ArtifactKind[] = ['image', 'video', 'audio', 'doc', 'sheet', 'slides', 'code', 'other', 'site', 'archive', 'image-set']
    for (const kind of kinds) expect(primaryActionsFor(kind).length).toBeLessThanOrEqual(5)
  })
})

describe('ArtifactActionBar', () => {
  it('图片：有「对比」、没有「编辑」（不可用动作不出现）', () => {
    renderBar('image')
    expect(screen.getByRole('button', { name: '对比' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('文档：有「编辑」（PPT 也有，点了给 P2 提示）', () => {
    renderBar('doc')
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '对比' })).toBeNull()
  })

  it('导出 ▾ 三个子项分别回调', () => {
    const props = renderBar('code')
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '另存为…' }))
    expect(props.onExport).toHaveBeenCalledWith('saveAs')

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出到文件夹…' }))
    expect(props.onExport).toHaveBeenCalledWith('toFolder')

    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '复制路径' }))
    expect(props.onExport).toHaveBeenCalledWith('copyPath')
  })

  it('⋯ 里「移入回收站」要点两次：第一次只变文案，第二次才回调', () => {
    const props = renderBar('code')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '移入回收站…' }))
    expect(props.onMore).not.toHaveBeenCalled()
    expect(screen.getByRole('menuitem', { name: /再点一次确认/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('menuitem', { name: /再点一次确认/ }))
    expect(props.onMore).toHaveBeenCalledWith('trash')
  })

  it('⋯ 的「在系统中打开」立即回调', () => {
    const props = renderBar('code')
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '在系统中打开' }))
    expect(props.onMore).toHaveBeenCalledWith('reveal')
  })

  it('定位不打开菜单，直接回调', () => {
    const props = renderBar('image')
    fireEvent.click(screen.getByRole('button', { name: '定位' }))
    expect(props.onLocate).toHaveBeenCalled()
  })

  it('点外面收起菜单', () => {
    renderBar('code')
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('ArtifactActionBar · 撤销本地修改', () => {
  function renderWithUndo(canUndoEdit: boolean) {
    const onMore = vi.fn()
    render(
      <ArtifactActionBar
        artifact={makeArtifact('doc')}
        onEdit={vi.fn()}
        onLocate={vi.fn()}
        onCompare={vi.fn()}
        onExport={vi.fn()}
        onMore={onMore}
        canUndoEdit={canUndoEdit}
      />,
    )
    return { onMore }
  }

  it('没有本地修改时不出现撤销项', () => {
    renderWithUndo(false)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    expect(screen.queryByRole('menuitem', { name: '撤销最近一次本地修改' })).toBeNull()
  })

  it('有本地修改时出现并回调 undoEdit', () => {
    const props = renderWithUndo(true)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '撤销最近一次本地修改' }))
    expect(props.onMore).toHaveBeenCalledWith('undoEdit')
  })
})
