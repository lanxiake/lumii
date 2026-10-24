import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

  it('运行中常驻已用、本步等待与预计剩余', () => {
    render(
      <TaskProgressBar
        progress={50}
        startTime={0}
        stepWaitStart={10_000}
        status="running"
        now={20_000}
      />,
    )
    expect(screen.getByText(/已用/)).toBeTruthy()
    expect(screen.getByText(/本步/)).toBeTruthy()
    expect(screen.getByText(/预计 20秒/)).toBeTruthy()
  })

  it('进度为 0 时显示排队/未开始计时，仍给出预计占位', () => {
    render(
      <TaskProgressBar progress={0} startTime={0} status="running" now={5_000} />,
    )
    expect(screen.getByText('进行中（排队/未开始计时）')).toBeTruthy()
    expect(screen.getByText(/预计 —/)).toBeTruthy()
  })

  it('已完成不再估计剩余时间', () => {
    render(
      <TaskProgressBar progress={100} startTime={0} status="succeeded" now={20_000} />,
    )
    expect(screen.getByText('已完成 (100%)')).toBeTruthy()
    expect(screen.queryByText(/预计/)).toBeNull()
  })

  it('点击进度区触发 onActivate', () => {
    const onActivate = vi.fn()
    render(
      <TaskProgressBar
        progress={40}
        startTime={0}
        status="running"
        now={1_000}
        onActivate={onActivate}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '展开或收起任务详情' }))
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('格式化剩余时间', () => {
    expect(formatRemainingSeconds(12)).toBe('12秒')
    expect(formatRemainingSeconds(90)).toBe('2分钟')
    expect(estimateRemainingSeconds(0, 0, 10_000)).toBeNull()
    expect(estimateRemainingSeconds(0, 25, 10_000)).toBe(30)
  })
})
