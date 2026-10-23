import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskMilestones, formatMilestoneDuration } from './TaskMilestones'

describe('TaskMilestones', () => {
  it('按顺序显示状态、耗时和错误', () => {
    render(
      <TaskMilestones
        milestones={[
          { step: '入队', status: 'completed', duration: 1500 },
          { step: '渲染', status: 'failed', error: '显存不足' },
          { step: '保存结果', status: 'pending' },
        ]}
      />,
    )
    const items = screen.getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('入队'),
      expect.stringContaining('渲染'),
      expect.stringContaining('保存结果'),
    ])
    expect(screen.getByText('里程碑 (1/3)')).toBeTruthy()
    expect(screen.getByText('1.5s')).toBeTruthy()
    expect(screen.getByText('显存不足')).toBeTruthy()
    expect(screen.getByText('✓')).toBeTruthy()
    expect(screen.getByText('❌')).toBeTruthy()
    expect(screen.getByText('⏳')).toBeTruthy()
  })

  it('没有里程碑时不渲染', () => {
    const { container } = render(<TaskMilestones milestones={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('耗时格式化为秒', () => {
    expect(formatMilestoneDuration(2340)).toBe('2.3s')
  })
})
