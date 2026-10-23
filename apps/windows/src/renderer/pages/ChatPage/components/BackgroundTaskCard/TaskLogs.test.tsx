import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TaskLog } from '../../../../../shared/agent-runtime-events'
import { TaskLogs, serializeLogs, visibleLogRange } from './TaskLogs'

function makeLogs(count: number): TaskLog[] {
  return Array.from({ length: count }, (_, index) => ({
    level: index % 10 === 0 ? 'error' : 'info',
    message: `log-${index}`,
    timestamp: 1_700_000_000_000 + index * 1000,
  }))
}

describe('TaskLogs', () => {
  it('默认收起，展开后过滤并复制 JSON', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const logs = makeLogs(3)
    logs[1] = { ...logs[1]!, level: 'error', message: 'boom' }
    render(<TaskLogs logs={logs} />)

    expect(screen.queryByText('boom')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /日志/ }))
    expect(screen.getByText('boom')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /error/ }))
    expect(screen.getByText('boom')).toBeTruthy()
    expect(screen.queryByText('log-2')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '复制' }))
    const copied = writeText.mock.calls[0]?.[0] as string
    expect(JSON.parse(copied)).toEqual([
      expect.objectContaining({ level: 'error', message: 'log-0' }),
      expect.objectContaining({ level: 'error', message: 'boom' }),
    ])
  })

  it('上百条日志只挂载可视窗口', () => {
    render(<TaskLogs logs={makeLogs(120)} maxHeight={200} />)
    fireEvent.click(screen.getByRole('button', { name: /日志/ }))
    const rows = document.querySelectorAll('.entry')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.length).toBeLessThan(120)
  })

  it('过滤后没有匹配项时显示空状态', () => {
    render(<TaskLogs logs={[{ level: 'info', message: 'only', timestamp: 1 }]} />)
    fireEvent.click(screen.getByRole('button', { name: /日志/ }))
    fireEvent.click(screen.getByRole('button', { name: /debug/ }))
    expect(screen.getByText('无日志')).toBeTruthy()
  })

  it('序列化和窗口范围', () => {
    const logs: TaskLog[] = [{ level: 'info', message: 'a', timestamp: 1 }]
    expect(JSON.parse(serializeLogs(logs))).toEqual(logs)
    expect(visibleLogRange(100, 0, 200).start).toBe(0)
    expect(visibleLogRange(100, 0, 200).end).toBeLessThan(100)
  })
})
