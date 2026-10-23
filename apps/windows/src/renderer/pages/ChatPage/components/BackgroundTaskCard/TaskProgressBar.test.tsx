import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskProgressBar, estimateRemainingSeconds, formatRemainingSeconds } from './TaskProgressBar'

describe('TaskProgressBar', () => {
  it('显示百分比和当前步骤', () => {
    render(
      <TaskProgressBar progress={40} currentStep="渲染" startTime={1_000} status="running" now={1_000} />,
    )
    expect(screen.getByText('进行中 (40%)')).toBeTruthy()
    expect(screen.getByText('渲染')).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: '任务进度' })).toBeTruthy()
  })

  it('运行中且剩余超过 5 秒时显示估计时间', () => {
    render(
      <TaskProgressBar progress={50} startTime={0} status="running" now={20_000} />,
    )
    expect(screen.getByText('预计 20秒')).toBeTruthy()
  })

  it('已完成不再估计剩余时间', () => {
    render(
      <TaskProgressBar progress={100} startTime={0} status="succeeded" now={20_000} />,
    )
    expect(screen.getByText('已完成 (100%)')).toBeTruthy()
    expect(screen.queryByText(/预计/)).toBeNull()
  })

  it('格式化剩余时间', () => {
    expect(formatRemainingSeconds(12)).toBe('12秒')
    expect(formatRemainingSeconds(90)).toBe('2分钟')
    expect(estimateRemainingSeconds(0, 0, 10_000)).toBeNull()
    expect(estimateRemainingSeconds(0, 25, 10_000)).toBe(30)
  })
})
