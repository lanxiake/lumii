/**
 * CompareView：列数上限（窄档 2 / 宽档 4）、被截断时的提示、点格子回普通预览。
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  ArtifactCompareView,
  COMPARE_COMPACT_BREAKPOINT,
  compareLimit,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/CompareView'
import type { Artifact } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

function makeArtifact(index: number): Artifact {
  return {
    path: `outputs/covers/${index}.png`,
    kind: 'image',
    role: 'deliverable',
    status: 'added',
    timestamp: 1000 + index,
    turnId: 't1',
    meta: { width: 1024, height: 768 },
  }
}

const ITEMS = [0, 1, 2, 3].map(makeArtifact)
const toAbsolutePath = (relativePath: string): string => `/ws/${relativePath}`

describe('compareLimit', () => {
  it('860 是宽/窄分界：宽档 4 项，窄档 2 项', () => {
    expect(compareLimit(COMPARE_COMPACT_BREAKPOINT - 1)).toBe(2)
    expect(compareLimit(COMPARE_COMPACT_BREAKPOINT)).toBe(4)
  })
})

describe('ArtifactCompareView', () => {
  it('窄档只并排 2 项，并说明还有几项没显示', () => {
    render(
      <ArtifactCompareView
        items={ITEMS}
        toAbsolutePath={toAbsolutePath}
        width={700}
        onPick={vi.fn()}
        onExit={vi.fn()}
      />,
    )
    expect(screen.getByText('对比 2 项')).toBeInTheDocument()
    expect(screen.getByText(/还有 2 项未显示/)).toBeInTheDocument()
    expect(screen.queryByText('2.png')).toBeNull()
  })

  it('宽档并排 4 项，点格子回普通预览', () => {
    const onPick = vi.fn()
    render(
      <ArtifactCompareView
        items={ITEMS}
        toAbsolutePath={toAbsolutePath}
        width={1000}
        onPick={onPick}
        onExit={vi.fn()}
      />,
    )
    expect(screen.getByText('对比 4 项')).toBeInTheDocument()
    expect(screen.queryByText(/未显示/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /3\.png/ }))
    expect(onPick).toHaveBeenCalledWith('outputs/covers/3.png')
  })

  it('退出按钮把控制权交回调用方', () => {
    const onExit = vi.fn()
    render(
      <ArtifactCompareView
        items={ITEMS.slice(0, 2)}
        toAbsolutePath={toAbsolutePath}
        width={1000}
        onPick={vi.fn()}
        onExit={onExit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '退出对比' }))
    expect(onExit).toHaveBeenCalled()
  })
})
