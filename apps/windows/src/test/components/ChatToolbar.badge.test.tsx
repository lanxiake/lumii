/**
 * 工具栏角标：有未查看产出时显示数字（>99 显示 99+），0 时不出现。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ChatToolbar } from '../../renderer/pages/ChatPage/layout/ChatToolbar'

function renderToolbar(workbenchBadge?: number) {
  render(
    <ChatToolbar
      title="测试"
      pageZoom={1}
      autoApprove={false}
      readAloudActive={false}
      readAloudSpeaking={false}
      workbenchOpen={false}
      {...(workbenchBadge !== undefined ? { workbenchBadge } : {})}
      onToggleSidebar={vi.fn()}
      onResetZoom={vi.fn()}
      onToggleAutoApprove={vi.fn()}
      onToggleReadAloud={vi.fn()}
      onToggleWorkbench={vi.fn()}
    />,
  )
}

describe('ChatToolbar 工作台角标', () => {
  it('有数量时显示数字并进 aria-label', () => {
    renderToolbar(3)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /工作空间文件（3 个新产出）/ })).toBeInTheDocument()
  })

  it('超过 99 显示 99+', () => {
    renderToolbar(120)
    expect(screen.getByText('99+')).toBeInTheDocument()
  })

  it('0 或未传时不显示角标', () => {
    renderToolbar(0)
    expect(screen.queryByText('0')).toBeNull()
  })
})
