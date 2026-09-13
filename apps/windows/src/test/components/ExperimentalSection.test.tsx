/**
 * ExperimentalSection：列表入口 + 提示词风格详情栈导航测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ExperimentalSection } from '../../renderer/pages/SettingsPage/components/ExperimentalSection'

vi.mock('../../renderer/pages/AutonomousPage/AutonomousPage', () => ({
  AutonomousPage: () => <div data-testid="autonomous-page" />,
}))

const updatePromptStyle = vi.fn(async () => {})
const getStatus = vi.fn(async () => ({
  enabled: false,
  pendingGoalsCount: 0,
  satisfaction: {
    overall: 0.76,
    trend: 'stable' as const,
    breakdown: { taskCompletion: 0, userFeedback: 0, efficiency: 0, knowledgeGrowth: 0 },
  },
}))

beforeEach(() => {
  localStorage.clear()
  updatePromptStyle.mockClear()
  getStatus.mockClear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    settings: { updatePromptStyle },
    autonomous: { getStatus },
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('ExperimentalSection — 列表与栈导航', () => {
  it('默认渲染实验功能列表，不展开详情', async () => {
    render(<ExperimentalSection />)
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /提示词风格（实验）/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /自主进化/ })).toBeInTheDocument()
    expect(screen.queryByTestId('autonomous-page')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: '系统提示词风格' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('状态：已禁用')).toBeInTheDocument()
    })
  })

  it('进入提示词风格详情后可切换简要并返回列表', async () => {
    render(<ExperimentalSection />)
    fireEvent.click(screen.getByRole('button', { name: /提示词风格（实验）/ }))

    expect(screen.getByRole('heading', { name: '提示词风格（实验）' })).toBeInTheDocument()
    const detailedBtn = screen.getByRole('radio', { name: '详细' })
    const terseBtn = screen.getByRole('radio', { name: '简要' })
    expect(detailedBtn).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(terseBtn)
    expect(updatePromptStyle).toHaveBeenCalledWith({ style: 'terse' })
    const stored = JSON.parse(localStorage.getItem('mtbot-assistant-settings') ?? '{}')
    expect(stored.promptStyle).toEqual({ style: 'terse' })

    fireEvent.click(screen.getByRole('button', { name: '返回实验功能列表' }))
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('当前：简要')).toBeInTheDocument()
    })
  })

  it('重复点击当前档位不触发写入', () => {
    render(<ExperimentalSection />)
    fireEvent.click(screen.getByRole('button', { name: /提示词风格（实验）/ }))
    updatePromptStyle.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '详细' }))
    expect(updatePromptStyle).not.toHaveBeenCalled()
  })

  it('进入自主进化详情并返回', () => {
    render(<ExperimentalSection />)
    fireEvent.click(screen.getByRole('button', { name: /自主进化/ }))
    expect(screen.getByRole('heading', { name: '自主进化' })).toBeInTheDocument()
    expect(screen.getByTestId('autonomous-page')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '返回实验功能列表' }))
    expect(screen.getByRole('heading', { name: '实验功能' })).toBeInTheDocument()
    expect(screen.queryByTestId('autonomous-page')).not.toBeInTheDocument()
  })

  it('不渲染提示词段清单表格', () => {
    render(<ExperimentalSection />)
    fireEvent.click(screen.getByRole('button', { name: /提示词风格（实验）/ }))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByText('段 ID')).not.toBeInTheDocument()
  })
})
