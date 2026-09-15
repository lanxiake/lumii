/**
 * HandoffCard（F2 转交卡片）交互测试
 * - 提案就绪：摘要 + 确认按钮
 * - 目标项目：结果显示项目名（09-P2）；无项目名时回落通用文案
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

  it('结果带 projectName 时头部显示项目名（确认前可见目标项目）', () => {
    renderCard(
      {
        ...readyPart,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'proposed', handoffId: 'h-2', projectName: 'lumii' }),
            },
          ],
        },
      },
      makeActions(),
    )
    expect(screen.getByText('灵栖开发 · lumii')).toBeInTheDocument()
  })

  it('结果无 projectName 时回落到通用文案（兼容改动前落库的历史消息）', () => {
    renderCard(readyPart, makeActions())
    expect(screen.getByText('灵栖开发 · 绑定项目会话')).toBeInTheDocument()
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

  it('自动执行（status=started）：展示已交给灵栖开发 + 去会话查看，不出确认按钮', () => {
    const actions = makeActions()
    renderCard(
      {
        ...readyPart,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'started',
                handoffId: 'h-2',
                projectName: 'lumii',
                devSessionKey: 'dev-1',
                title: '评审方案',
              }),
            },
          ],
        },
      },
      actions,
    )
    expect(screen.getByText('已交给灵栖开发 · 评审方案')).toBeInTheDocument()
    expect(screen.getByText('灵栖开发 · lumii')).toBeInTheDocument()
    // 不再要求用户确认
    expect(screen.queryByRole('button', { name: '交给灵栖开发' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '去会话查看' }))
    expect(actions.openSession).toHaveBeenCalledWith('dev-1')
  })

  it('自动执行失败（status=error）：展示失败文案，不出确认按钮', () => {
    renderCard(
      {
        ...readyPart,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'error', handoffId: 'h-3', message: '未绑定编码工具' }),
            },
          ],
        },
      },
      makeActions(),
    )
    expect(screen.getByText(/转交未能发起/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交给灵栖开发' })).not.toBeInTheDocument()
  })

  it('工具运行中：显示准备提示，不出现确认按钮', () => {
    renderCard({ id: 'p2', args: { summary: 'x' }, status: 'running' }, makeActions())
    expect(screen.getByText('正在准备转交提案…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '交给灵栖开发' })).not.toBeInTheDocument()
  })
})
