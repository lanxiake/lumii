/**
 * 多选条：Ctrl 加选 / Shift 区间、按钮回调参数、删除后隐藏、对比入口。
 * 走真组件（不 mock 子组件）——这里验的是「修饰键 → 选择集 → 批量动作」这条链。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { WorkspaceArtifactsPanel } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel'
import {
  buildArtifactLedger,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

const toAbsolutePath = (relativePath: string): string => `/ws/${relativePath}`

const MESSAGES: LedgerMessageLike[] = [
  { id: 'u1', role: 'user', timestamp: 10, text: '做四张封面' },
  {
    id: 't1',
    role: 'assistant',
    timestamp: 20,
    fileChanges: ['a', 'b', 'c', 'd'].map(
      (name): FileChangeEntry => ({
        path: `outputs/covers/${name}.png`,
        status: 'added',
        confidence: 'exact',
      }),
    ),
  },
]

function renderPanel(props: Partial<React.ComponentProps<typeof WorkspaceArtifactsPanel>> = {}) {
  return render(
    <WorkspaceArtifactsPanel
      ledger={buildArtifactLedger(MESSAGES)}
      toAbsolutePath={toAbsolutePath}
      onSelect={vi.fn()}
      {...props}
    />,
  )
}

function card(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`${name}\\.png`) })
}

describe('WorkspaceArtifactsPanel 多选', () => {
  beforeEach(() => {
    ;(window.electronAPI as unknown as { artifact?: unknown }).artifact = undefined
  })

  it('Ctrl 点击加选，底部出现已选计数；再点一次减选', () => {
    renderPanel()
    fireEvent.click(card('a'), { ctrlKey: true })
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
    fireEvent.click(card('b'), { ctrlKey: true })
    expect(screen.getByText('已选 2 项')).toBeInTheDocument()
    fireEvent.click(card('b'), { ctrlKey: true })
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
  })

  it('Shift 区间只在可见项之间生效；普通点击回到单选', () => {
    renderPanel()
    fireEvent.click(card('a'), { ctrlKey: true })
    fireEvent.click(card('c'), { shiftKey: true })
    expect(screen.getByText('已选 3 项')).toBeInTheDocument()

    fireEvent.click(card('d'))
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
  })

  it('「×」清空选择；多选（Ctrl/Shift）不改变当前预览', () => {
    const onSelect = vi.fn()
    renderPanel({ onSelect })
    fireEvent.click(card('a'), { ctrlKey: true })
    fireEvent.click(card('b'), { shiftKey: true })
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '取消选择' }))
    expect(screen.queryByText(/已选/)).toBeNull()
  })

  it('对比按钮在多选不足 2 项时禁用，够 2 项时把路径交给上层', () => {
    const onCompare = vi.fn()
    renderPanel({ onCompare })
    fireEvent.click(card('a'), { ctrlKey: true })
    const compareBtn = screen.getByRole('button', { name: '对比' })
    expect(compareBtn).toBeDisabled()

    fireEvent.click(card('b'), { ctrlKey: true })
    expect(compareBtn).not.toBeDisabled()
    fireEvent.click(compareBtn)
    expect(onCompare).toHaveBeenCalledWith([
      'outputs/covers/a.png',
      'outputs/covers/b.png',
    ])
  })

  it('导出 zip 把选中路径交给主进程；成功后 toast 并保留选择', async () => {
    const exportFiles = vi.fn(async () => ({
      ok: true,
      exported: 2,
      bytes: 2048,
      destPath: 'C:/tmp/covers.zip',
    }))
    ;(window.electronAPI as unknown as { artifact: unknown }).artifact = { exportFiles }
    renderPanel()

    fireEvent.click(card('a'), { ctrlKey: true })
    fireEvent.click(card('b'), { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '导出 zip' }))

    await waitFor(() => expect(exportFiles).toHaveBeenCalled())
    expect(exportFiles).toHaveBeenCalledWith(
      ['outputs/covers/a.png', 'outputs/covers/b.png'],
      'zip',
    )
  })

  it('移入回收站：成功后清空选择并上抛路径，卡片立即隐藏', async () => {
    const trash = vi.fn(async () => ({ ok: true, removed: 1, bytes: 10, skipped: 0, trashId: 'x' }))
    ;(window.electronAPI as unknown as { artifact: unknown }).artifact = { trash }
    const onTrashed = vi.fn()
    const { rerender } = renderPanel({ onTrashed })

    fireEvent.click(card('a'), { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))

    await waitFor(() => expect(onTrashed).toHaveBeenCalledWith(['outputs/covers/a.png']))
    expect(screen.queryByText(/已选/)).toBeNull()

    // 父层把路径塞进 trashedPaths 后，历史 fileChanges 仍会派生它，但界面不该再显示
    rerender(
      <WorkspaceArtifactsPanel
        ledger={buildArtifactLedger(MESSAGES)}
        toAbsolutePath={toAbsolutePath}
        onSelect={vi.fn()}
        onTrashed={onTrashed}
        trashedPaths={new Set(['outputs/covers/a.png'])}
      />,
    )
    expect(screen.queryByText('a.png')).toBeNull()
    expect(screen.getByText('b.png')).toBeInTheDocument()
  })

  it('删除失败时报错且不清空选择（用户可以重试）', async () => {
    const trash = vi.fn(async () => ({
      ok: false,
      removed: 0,
      bytes: 0,
      skipped: 0,
      error: '被成品引用：outputs/covers/a.png',
    }))
    ;(window.electronAPI as unknown as { artifact: unknown }).artifact = { trash }
    renderPanel()

    fireEvent.click(card('a'), { ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: '移入回收站' }))

    await waitFor(() => expect(trash).toHaveBeenCalled())
    expect(screen.getByText('已选 1 项')).toBeInTheDocument()
  })
})
