/**
 * ExperimentalSection「提示词风格（实验）」只读段清单面板测试（P0-T5）
 * 验证：面板渲染、行数与 PROMPT_SECTIONS 一致、抽行核对元数据、无死开关
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { PROMPT_SECTIONS } from '@mtbot/agent-runtime/browser'
import { ExperimentalSection } from '../../renderer/pages/SettingsPage/components/ExperimentalSection'

vi.mock('../../renderer/pages/AutonomousPage/AutonomousPage', () => ({
  AutonomousPage: () => <div data-testid="autonomous-page" />,
}))

describe('ExperimentalSection — 提示词风格（实验）面板', () => {
  it('渲染只读段清单，行数与 PROMPT_SECTIONS 一致', () => {
    render(<ExperimentalSection />)
    expect(screen.getByText('提示词风格（实验）')).toBeInTheDocument()
    // 1 行表头 + 每段 1 行
    expect(screen.getAllByRole('row')).toHaveLength(PROMPT_SECTIONS.length + 1)
  })

  it('抽行核对元数据（id / 分组 / 分区 / 索引化 / 展开方式）', () => {
    render(<ExperimentalSection />)
    const row = screen.getByText('operatingPrinciples').closest('tr')
    expect(row).not.toBeNull()
    expect(within(row!).getByText('规则')).toBeInTheDocument()
    expect(within(row!).getByText('静态')).toBeInTheDocument()
    // P0 阶段所有段 terse=false 且无 expandVia → 两列均为「—」
    expect(within(row!).getAllByText('—')).toHaveLength(2)
  })

  it('P0 阶段无风格开关（避免可点但不生效的死开关）', () => {
    render(<ExperimentalSection />)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
  })
})
