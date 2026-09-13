/**
 * ExperimentalSection「提示词风格（实验）」面板测试
 * P0-T5：只读段清单渲染；P1-T3：二选一开关启用（写 localStorage + IPC 同步）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PROMPT_SECTIONS } from '@mtbot/agent-runtime/browser'
import { ExperimentalSection } from '../../renderer/pages/SettingsPage/components/ExperimentalSection'

vi.mock('../../renderer/pages/AutonomousPage/AutonomousPage', () => ({
  AutonomousPage: () => <div data-testid="autonomous-page" />,
}))

const updatePromptStyle = vi.fn(async () => {})

beforeEach(() => {
  localStorage.clear()
  updatePromptStyle.mockClear()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    settings: { updatePromptStyle },
  }
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('ExperimentalSection — 提示词风格（实验）面板', () => {
  it('渲染只读段清单，行数与 PROMPT_SECTIONS 一致', () => {
    render(<ExperimentalSection />)
    expect(screen.getByText('提示词风格（实验）')).toBeInTheDocument()
    // 1 行表头 + 每段 1 行
    expect(screen.getAllByRole('row')).toHaveLength(PROMPT_SECTIONS.length + 1)
  })

  it('抽行核对元数据（terse 段显示 ✓ + 展开方式；红线段显示 —）', () => {
    render(<ExperimentalSection />)

    const terseRow = screen.getByText('operatingPrinciples').closest('tr')
    expect(terseRow).not.toBeNull()
    expect(within(terseRow!).getByText('规则')).toBeInTheDocument()
    expect(within(terseRow!).getByText('静态')).toBeInTheDocument()
    expect(within(terseRow!).getByText('✓')).toBeInTheDocument()
    expect(within(terseRow!).getByText('prompt_guide')).toBeInTheDocument()

    const redLineRow = screen.getByText('verification').closest('tr')
    expect(redLineRow).not.toBeNull()
    expect(within(redLineRow!).getAllByText('—')).toHaveLength(2)
  })

  it('默认详细档；点击「简要」写入 localStorage 并经 IPC 同步主进程', () => {
    render(<ExperimentalSection />)

    const detailedBtn = screen.getByRole('radio', { name: '详细' })
    const terseBtn = screen.getByRole('radio', { name: '简要' })
    expect(detailedBtn).toHaveAttribute('aria-checked', 'true')
    expect(terseBtn).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(terseBtn)

    expect(updatePromptStyle).toHaveBeenCalledWith({ style: 'terse' })
    const stored = JSON.parse(localStorage.getItem('mtbot-assistant-settings') ?? '{}')
    expect(stored.promptStyle).toEqual({ style: 'terse' })
  })

  it('重复点击当前档位不触发写入', () => {
    render(<ExperimentalSection />)
    // 扣掉 useSettings 挂载时的初始同步调用
    updatePromptStyle.mockClear()
    fireEvent.click(screen.getByRole('radio', { name: '详细' }))
    expect(updatePromptStyle).not.toHaveBeenCalled()
  })
})
