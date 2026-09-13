/**
 * HandoffCard（F2 转交卡片）交互测试
 * - 提案就绪：摘要 + 确认按钮
 * - 点击确认：调用 confirmHandoff(handoffId)，成功后显示「去会话查看」并可跳转
 * - 确认失败：展示错误文案
 * - 工具运行中：显示准备提示，不出按钮
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { HandoffCard } from '../../renderer/pages/ChatPage/components/HandoffCard'
import {
  ChatMessageActionsProvider,
  type ChatMessageActions,
} from '../../renderer/pages/ChatPage/contexts/ChatMessageActionsContext'

const noop = vi.fn()

function makeActions(overrides: Partial<ChatMessageActions> = {}): ChatMessageActions {
  return {
    formatTime: () => '10:00',
    copyMessage: noop,
    editMessage: noop,
    deleteMessage: noop,
    regenerateMessage: noop,
    replayFromMessage: noop,
    reviewFileChanges: noop,
    confirmHandoff: vi.fn(async () => ({ ok: true, sessionKey: 'dev-sk-1', title: '订单页分页修复' })),
    openSession: noop,
    ...overrides,
  }
}

function renderCard(part: Parameters<typeof HandoffCard>[0]['part'], actions: ChatMessageActions) {
  return render(
    <ChatMessageActionsProvider value={actions}>
      <HandoffCard part={part} />
    </ChatMessageActionsProvider>,
  )
}

const readyPart = {
  id: 'p1',
  args: { summary: '订单页分页修复', task: '修 Pager off-by-one' },
  result: {
    content: [{ type: 'text', text: JSON.stringify({ status: 'proposed', handoffId: 'h-1' }) }],
  },
  status: 'done',
}

describe('HandoffCard（F2 转交卡片）', () => {
  it('提案就绪：展示摘要与确认按钮', () => {
    renderCard(readyPart, makeActions())
    expect(screen.getByText('订单页分页修复')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '交给灵栖开发' })).toBeInTheDocument()
  })

  it('点击确认：调用 confirmHandoff(handoffId)，成功后显示去会话查看并可跳转', async () => {
    const actions = makeActions()
    renderCard(readyPart, actions)
    fireEvent.click(screen.getByRole('button', { name: '交给灵栖开发' }))

    await waitFor(() => expect(actions.confirmHandoff).toHaveBeenCalledWith('h-1'))
    const openBtn = await screen.findByRole('button', { name: '去会话查看' })
    expect(screen.getByText(/已转交/)).toBeInTheDocument()

    fireEvent.click(openBtn)
    expect(actions.openSession).toHaveBeenCalledWith('dev-sk-1')
  })

  it('确认失败：展示错误文案', async () => {
    const actions = makeActions({
      confirmHandoff: vi.fn(async () => ({ ok: false, error: '转交执行失败：无可用实例' })),
    })
    renderCard(readyPart, actions)
    fireEvent.click(screen.getByRole('button', { name: '交给灵栖开发' }))
    await screen.findByText(/转交执行失败：无可用实例/)
  })

  it('工具运行中：显示准备提示，不出现确认按钮', () => {
    renderCard({ id: 'p2', args: { summary: 'x' }, status: 'running' }, makeActions())
    expect(screen.getByText('正在准备转交提案…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交给灵栖开发' })).not.toBeInTheDocument()
  })
})
