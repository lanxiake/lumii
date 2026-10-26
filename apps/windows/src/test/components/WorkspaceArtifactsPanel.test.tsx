/**
 * WorkspaceArtifactsPanel 组件测试
 * 验证：空态、任务分组、成品卡选中、筛选/搜索、中间产物折叠、进行中进度条。
 */

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { WorkspaceArtifactsPanel } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel'
import {
  buildArtifactLedger,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

const toAbsolutePath = (relativePath: string): string => `/ws/${relativePath}`

function assistant(
  id: string,
  timestamp: number,
  fileChanges: FileChangeEntry[],
): LedgerMessageLike {
  return { id, role: 'assistant', timestamp, fileChanges }
}

const MESSAGES: LedgerMessageLike[] = [
  { id: 'u1', role: 'user', timestamp: new Date(2026, 9, 19, 10, 0).getTime(), text: '做一组封面' },
  assistant('t1', new Date(2026, 9, 19, 10, 30).getTime(), [
    { path: 'uploads/short/a.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/pet-demo/sprite.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/script.txt', status: 'added', confidence: 'exact' },
  ]),
  assistant('t2', new Date(2026, 9, 19, 11, 5).getTime(), [
    { path: 'uploads/short/b.jpg', status: 'modified', confidence: 'unattributed' },
    { path: 'src/old.ts', status: 'deleted', confidence: 'exact' },
  ]),
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

describe('WorkspaceArtifactsPanel', () => {
  it('空会话显示空态与零统计', () => {
    renderPanel({ ledger: buildArtifactLedger([]) })
    expect(screen.getByText('0', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/这个会话还没有产出/)).toBeInTheDocument()
  })

  it('按任务分组显示成品卡，未归属与删除不出现', () => {
    renderPanel()
    expect(screen.getByText('3', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getAllByText('做一组封面').length).toBeGreaterThan(0)
    expect(screen.getByText('a.png')).toBeInTheDocument()
    expect(screen.getByText('sprite.png')).toBeInTheDocument()
    expect(screen.getByText('script.txt')).toBeInTheDocument()
    expect(screen.queryByText('b.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('old.ts')).not.toBeInTheDocument()
  })

  it('点卡片选中（不改弹 Modal）；选中态可读', () => {
    const onSelect = vi.fn()
    renderPanel({ onSelect, selectedPath: 'uploads/short/a.png' })
    const card = screen.getByRole('button', { name: /a\.png/ })
    expect(card).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(card)
    expect(onSelect).toHaveBeenCalledWith('uploads/short/a.png')
  })

  it('筛选与搜索只保留命中项', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /图片/ }))
    expect(screen.queryByText('script.txt')).not.toBeInTheDocument()
    expect(screen.getByText('a.png')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /全部/ }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索产物路径' }), {
      target: { value: 'sprite' },
    })
    expect(screen.getByText('sprite.png')).toBeInTheDocument()
    expect(screen.queryByText('script.txt')).not.toBeInTheDocument()
  })

  it('中间产物折叠成一行，展开后出网格并提示用途', () => {
    const intermediates: FileChangeEntry[] = Array.from({ length: 25 }, (_, index) => ({
      path: `outputs/x/cut-${index}.png`,
      status: 'added',
      confidence: 'exact',
    }))
    const ledger = buildArtifactLedger([
      { id: 'u', role: 'user', timestamp: 50, text: '切图' },
      assistant('t', 100, [
        { path: 'outputs/x/final.png', status: 'added', confidence: 'exact' },
        ...intermediates,
      ]),
    ])
    const onCleanup = vi.fn()
    renderPanel({ ledger, onCleanup })

    expect(screen.getByText(/中间产物 25 个/)).toBeInTheDocument()
    expect(screen.getByText('final.png')).toBeInTheDocument()
    expect(screen.queryByText('cut-0.png')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /中间产物 25 个/ }))
    expect(screen.getByText('cut-0.png')).toBeInTheDocument()
    expect(screen.getByText(/这些是过程文件/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /清理…/ }))
    expect(onCleanup).toHaveBeenCalled()
  })

  it('进行中：阶段 + 已完成/总数 + 中断', () => {
    const onAbort = vi.fn()
    renderPanel({
      progress: { toolName: 'image_generate', done: 1, total: 4, startedAt: Date.now() - 3000 },
      onAbort,
    })
    expect(screen.getByText('生成图片')).toBeInTheDocument()
    expect(screen.getByText(/1\/4/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '中断' }))
    expect(onAbort).toHaveBeenCalled()
  })
})
