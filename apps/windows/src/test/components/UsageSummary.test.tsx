/**
 * UsageSummary（概览页「用量」）冒烟。
 *
 * 守住两件容易悄悄坏掉的事：
 * - 三个关键数字能从 UsageView 正确映射出来（调用 / Tokens 合计 / 花费）；
 * - 有未计价调用时必须标出来 —— 否则花费看着「偏低」而没人知道原因。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const queryUsage = vi.fn()

vi.mock('../../renderer/services/usage-service', () => ({
  queryUsage: (...args: unknown[]) => queryUsage(...args),
}))

const { UsageSummary } = await import('../../renderer/pages/DashboardPage/components/UsageSummary')

const baseUsage = {
  totalCalls: 1284,
  totalPromptTokens: 900_000,
  totalCompletionTokens: 100_000,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalCostYuan: 12.4,
  unpricedCalls: 0,
  buckets: [],
  byModel: [],
  groupBy: 'day' as const,
}

describe('UsageSummary', () => {
  beforeEach(() => {
    queryUsage.mockReset().mockResolvedValue(baseUsage)
  })

  it('渲染近 7 天的调用数 / Tokens / 花费', async () => {
    render(<UsageSummary />)

    expect(screen.getByText('用量')).toBeInTheDocument()
    expect(screen.getByText('近 7 天')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('1,284')).toBeInTheDocument())
    expect(screen.getByText('1.00M')).toBeInTheDocument()
    expect(screen.getByText('12.40 元')).toBeInTheDocument()
    expect(screen.queryByText('部分调用未计价')).not.toBeInTheDocument()
  })

  it('有未计价调用时标出「部分调用未计价」', async () => {
    queryUsage.mockResolvedValue({ ...baseUsage, unpricedCalls: 7 })
    render(<UsageSummary />)

    await waitFor(() => expect(screen.getByText('部分调用未计价')).toBeInTheDocument())
  })
})
