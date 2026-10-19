/**
 * WorkspaceChangesPanel 组件测试
 * 验证：概要统计、按轮分组、状态筛选、产物网格与预览、空态。
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { WorkspaceChangesPanel } from '../../renderer/pages/ChatPage/components/WorkspaceChangesPanel'
import {
  buildChangeLedger,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceChangesPanel/ledger'

vi.mock('../../renderer/components/FilePreviewModal', () => ({
  FilePreviewModal: ({ fileName }: { fileName?: string }) => (
    <div data-testid="preview">{fileName}</div>
  ),
}))

const toAbsolutePath = (relativePath: string): string => `/ws/${relativePath}`

function message(
  id: string,
  timestamp: number,
  fileChanges: FileChangeEntry[],
): LedgerMessageLike {
  return { id, role: 'assistant', timestamp, fileChanges }
}

const MESSAGES: LedgerMessageLike[] = [
  message('t1', new Date(2026, 9, 19, 10, 30).getTime(), [
    { path: 'uploads/short/a.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/script.txt', status: 'added', confidence: 'exact' },
  ]),
  message('t2', new Date(2026, 9, 19, 11, 5).getTime(), [
    { path: 'uploads/short/b.jpg', status: 'modified', confidence: 'unattributed' },
    { path: 'src/old.ts', status: 'deleted', confidence: 'exact' },
  ]),
]

describe('WorkspaceChangesPanel', () => {
  it('空会话显示空态与零统计', () => {
    render(
      <WorkspaceChangesPanel ledger={buildChangeLedger([])} toAbsolutePath={toAbsolutePath} />,
    )
    expect(screen.getByText('0', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText(/本会话还没有文件变更/)).toBeInTheDocument()
  })

  it('概要统计按路径去重，未归属条目被过滤', () => {
    render(
      <WorkspaceChangesPanel ledger={buildChangeLedger(MESSAGES)} toAbsolutePath={toAbsolutePath} />,
    )
    expect(screen.getByText('3', { selector: 'strong' })).toBeInTheDocument()
    expect(screen.getByText('新增 2')).toBeInTheDocument()
    expect(screen.getByText('修改 0')).toBeInTheDocument()
    expect(screen.getByText('删除 1')).toBeInTheDocument()
    expect(screen.queryByText(/未归属/)).not.toBeInTheDocument()

    expect(screen.getByText('uploads/short/a.png')).toBeInTheDocument()
    expect(screen.getByText('outputs/script.txt')).toBeInTheDocument()
    expect(screen.getByText('src/old.ts')).toBeInTheDocument()
    expect(screen.queryByText('uploads/short/b.jpg')).not.toBeInTheDocument()
  })

  it('轮次可折叠', () => {
    render(
      <WorkspaceChangesPanel ledger={buildChangeLedger(MESSAGES)} toAbsolutePath={toAbsolutePath} />,
    )
    const headers = screen.getAllByRole('button', { name: /个文件/ })
    expect(headers).toHaveLength(2)
    fireEvent.click(headers[0]!)
    expect(screen.queryByText('src/old.ts')).not.toBeInTheDocument()
    expect(screen.getByText('uploads/short/a.png')).toBeInTheDocument()
  })

  it('状态筛选与搜索只保留命中项', () => {
    render(
      <WorkspaceChangesPanel ledger={buildChangeLedger(MESSAGES)} toAbsolutePath={toAbsolutePath} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(screen.getByText('src/old.ts')).toBeInTheDocument()
    expect(screen.queryByText('uploads/short/a.png')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索文件路径' }), {
      target: { value: 'script' },
    })
    expect(screen.getByText('outputs/script.txt')).toBeInTheDocument()
    expect(screen.queryByText('src/old.ts')).not.toBeInTheDocument()
  })

  it('删除行不可点击预览', () => {
    render(
      <WorkspaceChangesPanel ledger={buildChangeLedger(MESSAGES)} toAbsolutePath={toAbsolutePath} />,
    )
    expect(screen.getByRole('button', { name: /src\/old\.ts/ })).toBeDisabled()
  })

  it('产物视图按目录分批，图片走 lumii-local 并点击打开预览', () => {
    const { container } = render(
      <WorkspaceChangesPanel ledger={buildChangeLedger(MESSAGES)} toAbsolutePath={toAbsolutePath} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /产物/ }))

    expect(screen.getByText('uploads/short')).toBeInTheDocument()
    const images = container.querySelectorAll('img')
    expect(images).toHaveLength(1)
    expect(images[0]?.getAttribute('src')).toBe(
      'lumii-local://media/?path=%2Fws%2Fuploads%2Fshort%2Fa.png',
    )
    expect(images[0]?.getAttribute('loading')).toBe('lazy')

    fireEvent.click(screen.getByRole('button', { name: /a\.png/ }))
    expect(screen.getByTestId('preview')).toHaveTextContent('a.png')
  })

  it('没有媒体产物时给出对应空态', () => {
    const ledger = buildChangeLedger([
      message('t', 100, [{ path: 'src/a.ts', status: 'added' }]),
    ])
    render(<WorkspaceChangesPanel ledger={ledger} toAbsolutePath={toAbsolutePath} />)
    fireEvent.click(screen.getByRole('button', { name: /产物/ }))
    expect(screen.getByText(/本会话还没有生成图片\/视频\/音频产物/)).toBeInTheDocument()
  })
})
