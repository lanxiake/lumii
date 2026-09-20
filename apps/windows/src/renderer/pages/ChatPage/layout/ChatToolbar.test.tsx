/**
 * ChatToolbar：宠物模式入口在屏蔽平台上的置灰（设计 D4）
 *
 * 判据是 `disabled` + `title` 里的原因，**不是**「点了会不会报错」——
 * 屏蔽平台上 main 侧根本没注册 `pet:switch-mode`，真点下去是未处理的 Promise 拒绝，
 * 那种缺陷在用例里表现为「没断言到」，不像置灰这样能直接锁住。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatToolbar } from './ChatToolbar'

const getFeatureAvailability = vi.fn()

/** Linux 快照：petMode 因平台屏蔽，并带了给用户看的原因 */
const LINUX_SNAPSHOT = {
  features: { petMode: { available: false, reason: 'platform-unsupported' as const } },
  messages: { petMode: { 'platform-unsupported': 'Linux 版暂不支持宠物模式，后续将以精灵图形态回归。' } },
}

const WIN_SNAPSHOT = { features: { petMode: { available: true } }, messages: {} }

function renderToolbar(onEnterPetMode = vi.fn()) {
  render(
    <ChatToolbar
      title="AI 助手对话"
      pageZoom={1}
      autoApprove={false}
      readAloudActive={false}
      readAloudSpeaking={false}
      workbenchOpen={false}
      onToggleSidebar={vi.fn()}
      onResetZoom={vi.fn()}
      onToggleAutoApprove={vi.fn()}
      onToggleReadAloud={vi.fn()}
      onToggleWorkbench={vi.fn()}
      onEnterPetMode={onEnterPetMode}
    />,
  )
  return onEnterPetMode
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    app: { getFeatureAvailability },
  }
})

describe('ChatToolbar 的宠物模式入口', () => {
  it('屏蔽平台上置灰并给出原因（D4：不能静默可用）', async () => {
    getFeatureAvailability.mockResolvedValue(LINUX_SNAPSHOT)
    renderToolbar()

    const btn = screen.getByRole('button', { name: 'Enter pet mode' })
    await waitFor(() => expect(btn).toBeDisabled())
    expect(btn).toHaveAttribute('title', expect.stringContaining('宠物模式'))
  })

  it('可用平台上保持可点（置灰只针对屏蔽平台）', async () => {
    getFeatureAvailability.mockResolvedValue(WIN_SNAPSHOT)
    renderToolbar()

    const btn = screen.getByRole('button', { name: 'Enter pet mode' })
    // 等矩阵落地，确认不是「还没判就亮着」
    await waitFor(() => expect(getFeatureAvailability).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(btn).toBeEnabled()
  })
})
