/**
 * CommentsPanel（P2 T8）：列表、选区/整篇新增、删除、只预填不发送。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { CommentsPanel } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/CommentsPanel'
import type { ArtifactComment } from '../../shared/workbench-comment-types'

const COMMENTS: ArtifactComment[] = [
  {
    id: 'cm-1111',
    path: 'outputs/x/doc.md',
    text: '太啰嗦，压缩一下',
    createdAt: new Date(2026, 9, 27, 18, 10).getTime(),
    anchor: { type: 'text-range', start: 10, end: 20, quote: '原文片段' },
  },
  {
    id: 'cm-2222',
    path: 'outputs/x/deck.pptx',
    text: '第二页换个说法',
    createdAt: new Date(2026, 9, 27, 18, 12).getTime(),
    anchor: { type: 'slide', index: 1, quote: '第二页标题' },
    sentAt: 100,
  },
  {
    id: 'cm-3333',
    path: 'outputs/x/doc.md',
    text: '整体再短一些',
    createdAt: new Date(2026, 9, 27, 18, 15).getTime(),
  },
]

function install(list = COMMENTS) {
  const api = {
    commentsList: vi.fn(async () => ({ ok: true, comments: list })),
    commentsSave: vi.fn(async (_input: { anchor?: unknown; text?: string }) => ({
      ok: true,
      comment: { ...COMMENTS[0], id: 'cm-new' },
    })),
    commentsDelete: vi.fn(async () => ({ ok: true })),
    commentsCompose: vi.fn(async () => ({
      ok: true,
      text: '请根据以下修改意见…',
      ids: ['cm-1111', 'cm-3333'],
      count: 2,
    })),
    commentsMarkSent: vi.fn(),
  }
  ;(window.electronAPI as any).artifact = api
  return api
}

function renderPanel(props: Partial<React.ComponentProps<typeof CommentsPanel>> = {}) {
  return render(
    <CommentsPanel sessionKey="conv-1" artifactPath="outputs/x/doc.md" {...props} />,
  )
}

describe('CommentsPanel', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).artifact = undefined
  })

  it('列出评论：锚点标签、引用、已发送、未发送计数', async () => {
    install()
    renderPanel()
    await waitFor(() => expect(screen.getByText(/3 条/)).toBeInTheDocument())
    expect(screen.getByText('选中片段')).toBeInTheDocument()
    expect(screen.getByText('第 2 页')).toBeInTheDocument()
    expect(screen.getByText('整篇')).toBeInTheDocument()
    expect(screen.getByText('已发送')).toBeInTheDocument()
    expect(screen.getByText('“原文片段”')).toBeInTheDocument()
    expect(screen.getByText(/未发送 2/)).toBeInTheDocument()
  })

  it('选区草稿：保存时带锚点，保存后清掉草稿并刷新', async () => {
    const api = install()
    const onDraftConsumed = vi.fn()
    renderPanel({
      draft: { anchor: { type: 'text-range', start: 4, end: 9, quote: '第二行' } },
      onDraftConsumed,
    })
    await waitFor(() => expect(screen.getByLabelText('评论内容')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('评论内容'), { target: { value: '改成更正式' } })
    fireEvent.click(screen.getByRole('button', { name: '保存评论' }))
    await waitFor(() =>
      expect(api.commentsSave).toHaveBeenCalledWith({
        sessionKey: 'conv-1',
        path: 'outputs/x/doc.md',
        text: '改成更正式',
        anchor: { type: 'text-range', start: 4, end: 9, quote: '第二行' },
      }),
    )
    expect(onDraftConsumed).toHaveBeenCalled()
    expect(api.commentsList).toHaveBeenCalledTimes(2)
  })

  it('「评论整篇」打开编辑器且保存时不带锚点', async () => {
    const api = install()
    renderPanel()
    await waitFor(() => expect(screen.getByText(/3 条/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '评论整篇' }))
    const textarea = screen.getByLabelText('评论内容')
    fireEvent.change(textarea, { target: { value: '整体再精简' } })
    fireEvent.click(screen.getByRole('button', { name: '保存评论' }))
    await waitFor(() => expect(api.commentsSave).toHaveBeenCalled())
    expect(api.commentsSave.mock.calls[0]![0]).toMatchObject({
      text: '整体再精简',
    })
    expect(api.commentsSave.mock.calls[0]![0].anchor).toBeUndefined()
  })

  it('删除评论走 IPC 并刷新', async () => {
    const api = install()
    renderPanel()
    await waitFor(() => expect(screen.getAllByRole('button', { name: '删除评论' })).toHaveLength(3))
    fireEvent.click(screen.getAllByRole('button', { name: '删除评论' })[0]!)
    await waitFor(() =>
      expect(api.commentsDelete).toHaveBeenCalledWith({ sessionKey: 'conv-1', id: 'cm-1111' }),
    )
  })

  it('带着评论继续：只预填（不发送），提示条数', async () => {
    const api = install()
    const onPrefill = vi.fn()
    const onToast = vi.fn()
    renderPanel({ onPrefill, onToast })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '带着 2 条评论继续' })).toBeEnabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: '带着 2 条评论继续' }))
    await waitFor(() => expect(onPrefill).toHaveBeenCalledWith('请根据以下修改意见…', ['cm-1111', 'cm-3333']))
    expect(api.commentsCompose).toHaveBeenCalledWith({
      sessionKey: 'conv-1',
      path: 'outputs/x/doc.md',
      ids: ['cm-1111', 'cm-3333'],
    })
    expect(onToast).toHaveBeenCalledWith('已把评论预填到输入框（未发送）', 'success')
    // 只预填：没有触发任何发送相关 IPC
    expect(api.commentsMarkSent).not.toHaveBeenCalled()
  })

  it('全部已发送时按钮禁用', async () => {
    install([{ ...COMMENTS[1]!, sentAt: 5 }])
    renderPanel()
    await waitFor(() => expect(screen.getByText(/1 条/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: '带着 0 条评论继续' })).toBeDisabled()
  })
})
