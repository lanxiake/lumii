/**
 * TurnFileChangesCard 组件测试
 * 验证：仅展示新增/修改/删除、无行数、无上传、空数组不渲染、查看回调透传首文件路径
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { TurnFileChangesCard } from '../../renderer/pages/ChatPage/components/TurnFileChangesCard'

const CHANGES: FileChangeEntry[] = [
  { path: 'src/a.ts', status: 'added' },
  { path: 'src/b.ts', status: 'modified' },
  { path: 'src/c.ts', status: 'deleted' },
]

describe('TurnFileChangesCard', () => {
  it('空数组时不渲染', () => {
    const { container } = render(<TurnFileChangesCard changes={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('渲染标题与新增/修改/删除三种标签', () => {
    render(<TurnFileChangesCard changes={CHANGES} />)
    expect(screen.getByText('3 个文件变更')).toBeInTheDocument()
    expect(screen.getByText('新增')).toBeInTheDocument()
    expect(screen.getByText('修改')).toBeInTheDocument()
    expect(screen.getByText('删除')).toBeInTheDocument()
  })

  it('展示每个文件路径', () => {
    render(<TurnFileChangesCard changes={CHANGES} />)
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('src/b.ts')).toBeInTheDocument()
    expect(screen.getByText('src/c.ts')).toBeInTheDocument()
  })

  it('不出现 +/- 行数节点', () => {
    const { container } = render(<TurnFileChangesCard changes={CHANGES} />)
    expect(container.textContent).not.toMatch(/[+-]\d/)
  })

  it('不出现上传标签', () => {
    render(<TurnFileChangesCard changes={CHANGES} />)
    expect(screen.queryByText('上传')).not.toBeInTheDocument()
  })

  it('点击查看时回调透传首个文件路径', () => {
    const onReview = vi.fn()
    render(<TurnFileChangesCard changes={CHANGES} onReview={onReview} />)
    fireEvent.click(screen.getByRole('button', { name: /查看/ }))
    expect(onReview).toHaveBeenCalledWith('src/a.ts')
  })
})
