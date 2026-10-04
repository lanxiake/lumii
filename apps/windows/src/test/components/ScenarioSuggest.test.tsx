/**
 * ScenarioSuggest（概览页「场景推荐」）交互测试。
 *
 * 守住那条**唯一的**接线：点击场景 = 开新会话 + 把该场景 prompt 预填进输入框。
 * 走的是与 NewsFeed「解读资讯」同一条 `mtbot:chat-draft-request` 通道，
 * `newSession: true` 不能丢 —— 丢了就会把场景塞进用户正在进行的对话里。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const { ScenarioSuggest } = await import('../../renderer/pages/DashboardPage/components/ScenarioSuggest')

describe('ScenarioSuggest', () => {
  let received: CustomEvent[]

  beforeEach(() => {
    received = []
    window.addEventListener('mtbot:chat-draft-request', (e) => {
      received.push(e as CustomEvent)
    })
  })

  it('点击场景：开新会话（newSession=true）+ 预填该场景 prompt + 切到对话页', () => {
    const onViewChange = vi.fn()
    render(<ScenarioSuggest onViewChange={onViewChange} />)

    expect(screen.getByText('场景推荐')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /设置定时提醒/ }))

    expect(received).toHaveLength(1)
    const detail = received[0]!.detail as { text: string; newSession: boolean }
    expect(detail.newSession).toBe(true)
    expect(detail.text).toContain('/cron')
    expect(onViewChange).toHaveBeenCalledWith('chat')
  })
})
