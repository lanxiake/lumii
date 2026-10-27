/**
 * 结果动作条：按 kind 的动作矩阵、菜单项回调、危险动作二次确认、不可用动作不出现。
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ArtifactActionBar } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ArtifactActionBar'
import {
  primaryActionsFor,
  variantSourceFor,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/artifact-actions'
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
    for (const kind of kinds) {
      expect(primaryActionsFor(kind).length).toBeLessThanOrEqual(5)
      expect(primaryActionsFor(kind, { canVariant: true }).length).toBeLessThanOrEqual(5)
    }
  })

  it('只有图片带「变体」，且排在第一位', () => {
    expect(primaryActionsFor('image', { canVariant: true })).toEqual([
      'variant',
      'exportMenu',
      'locate',
      'compare',
      'more',
    ])
    expect(primaryActionsFor('video', { canVariant: true })).toEqual([
      'exportMenu',
      'locate',
      'compare',
      'more',
    ])
  })
})

describe('variantSourceFor（D9：只认声明）', () => {
  const withMeta = (meta: Artifact['meta'], extra: Partial<Artifact> = {}): Artifact => ({
    ...makeArtifact('image'),
    meta,
    ...extra,
  })

  it('原始提示词 + 模型 + 尺寸 → 可复现参数', () => {
    expect(
      variantSourceFor(
        withMeta({ model: 'nano-banana-2', sourcePrompt: ' 一只猫 ', prompt: '猫', width: 1024 }),
      ),
    ).toEqual({ model: 'nano-banana-2', sourcePrompt: '一只猫', width: 1024 })
  })

  it('没有原始提示词时退回改写后的 prompt（老数据也能复现）', () => {
    expect(variantSourceFor(withMeta({ model: 'm', prompt: '改写后' }))?.sourcePrompt).toBe(
      '改写后',
    )
  })

  it('缺模型 / 缺提示词 / 非图片 / 远端 / 无声明 → null', () => {
    expect(variantSourceFor(undefined)).toBeNull()
    expect(variantSourceFor(withMeta({ sourcePrompt: 'x' }))).toBeNull()
    expect(variantSourceFor(withMeta({ model: 'm' }))).toBeNull()
    expect(variantSourceFor(withMeta({ model: '  ', sourcePrompt: 'x' }))).toBeNull()
    expect(variantSourceFor({ ...makeArtifact('video'), meta: { model: 'm', prompt: 'x' } })).toBeNull()
    expect(
      variantSourceFor(
        withMeta({ model: 'm', sourcePrompt: 'x' }, { remoteUrl: 'https://x/a.png' }),
      ),
    ).toBeNull()
    expect(variantSourceFor(makeArtifact('image'))).toBeNull()
  })
})

describe('ArtifactActionBar', () => {
  it('图片：有「对比」、没有「编辑」（不可用动作不出现）', () => {
    renderBar('image')
    expect(screen.getByRole('button', { name: '对比' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('图片有模型+提示词时出现「变体」，点击回调；生成中禁用并显示进度', () => {
    const onVariant = vi.fn()
    const { rerender } = render(
      <ArtifactActionBar
        artifact={makeArtifact('image')}
        onEdit={vi.fn()}
        onLocate={vi.fn()}
        onCompare={vi.fn()}
        onExport={vi.fn()}
        onMore={vi.fn()}
        canVariant
        onVariant={onVariant}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '变体' }))
    expect(onVariant).toHaveBeenCalledTimes(1)

    rerender(
      <ArtifactActionBar
        artifact={makeArtifact('image')}
        onEdit={vi.fn()}
        onLocate={vi.fn()}
        onCompare={vi.fn()}
        onExport={vi.fn()}
        onMore={vi.fn()}
        canVariant
        variantBusy
        onVariant={onVariant}
      />,
    )
    const busy = screen.getByRole('button', { name: '生成中…' })
    expect(busy).toBeDisabled()
    expect(screen.queryByRole('button', { name: '变体' })).toBeNull()
  })

  it('没有变体条件时不出现「变体」按钮', () => {
    renderBar('image')
    expect(screen.queryByRole('button', { name: '变体' })).toBeNull()
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

describe('ArtifactActionBar · 导出选定版（T6）', () => {
  it('有固化版本时导出菜单第一项是「导出选定版（HH:mm）」并回调', () => {
    const onExportVersion = vi.fn()
    const pinnedAt = new Date(2026, 0, 1, 17, 3).getTime()
    render(
      <ArtifactActionBar
        artifact={makeArtifact('image')}
        onEdit={vi.fn()}
        onLocate={vi.fn()}
        onCompare={vi.fn()}
        onExport={vi.fn()}
        onMore={vi.fn()}
        pinnedAt={pinnedAt}
        onExportVersion={onExportVersion}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '导出选定版（17:03）' }))
    expect(onExportVersion).toHaveBeenCalledTimes(1)
  })

  it('没有固化版本时菜单里没有这一项', () => {
    renderBar('image')
    fireEvent.click(screen.getByRole('button', { name: /导出/ }))
    expect(screen.queryByRole('menuitem', { name: /导出选定版/ })).toBeNull()
  })
})
