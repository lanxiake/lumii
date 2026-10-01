/**
 * StatusBar 网络延迟指标：自适应取值、离线降级、tooltip 明细（中位/最低/抖动）
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { PingReport, PingResult } from '../../../../shared/net-latency-types'

const pingMock = vi.fn<() => Promise<PingReport>>()

vi.mock('../../../hooks/business/useAgentRuntime', () => ({
  useAgentRuntimeState: (selector: (s: unknown) => unknown) =>
    selector({ messages: [], currentLlmModelId: 'gpt-4o' }),
}))

vi.mock('../../../services/usage-service', () => ({
  getUsageLatency: vi.fn().mockResolvedValue({ success: true, data: { medianMs: 120, isLocal: false } }),
}))

vi.mock('../../../services/net-service', () => ({
  pingNetwork: () => pingMock(),
}))

import { StatusBar } from './StatusBar'

beforeEach(() => {
  pingMock.mockReset()
})

function ok(group: PingResult['group'], ms: number, minMs: number, jitterMs: number): PingResult {
  return { group, ok: true, ms, minMs, jitterMs, samples: 3 }
}

const offline = (group: PingResult['group'], error: string): PingResult => ({ group, ok: false, error })

describe('StatusBar 网络指标', () => {
  it('自适应取可达且最快的那组，并标注状态点', async () => {
    pingMock.mockResolvedValue({
      domestic: ok('domestic', 23, 20, 3),
      international: ok('international', 187, 150, 40),
      best: 'domestic',
    })
    render(<StatusBar />)

    const item = await screen.findByTitle(/网络延迟/)
    await waitFor(() => expect(item.textContent).toContain('23'))
    expect(item.querySelector('[data-state]')?.getAttribute('data-state')).toBe('ok')
  })

  it('tooltip 列出两组的中位/最低/抖动', async () => {
    pingMock.mockResolvedValue({
      domestic: ok('domestic', 23, 20, 3),
      international: ok('international', 187, 150, 40),
      best: 'domestic',
    })
    render(<StatusBar />)

    const item = await screen.findByTitle(/网络延迟/)
    await waitFor(() => expect(item.getAttribute('title')).toContain('国内 中位 23 ms · 最低 20 ms · 抖动 3 ms'))
    expect(item.getAttribute('title')).toContain('国外 中位 187 ms · 最低 150 ms · 抖动 40 ms')
  })

  it('两组都不通时显示「—」且状态点转为离线', async () => {
    pingMock.mockResolvedValue({
      domestic: offline('domestic', 'timeout'),
      international: offline('international', 'offline'),
      best: null,
    })
    render(<StatusBar />)

    const item = await screen.findByTitle(/网络延迟/)
    await waitFor(() =>
      expect(item.querySelector('[data-state]')?.getAttribute('data-state')).toBe('off'),
    )
    expect(item.textContent).toContain('—')
    expect(item.getAttribute('title')).toContain('离线')
  })

  it('探测抛错时降级为离线，不留「探测中」状态', async () => {
    pingMock.mockRejectedValue(new Error('ipc error'))
    render(<StatusBar />)

    const item = await screen.findByTitle(/网络延迟/)
    await waitFor(() =>
      expect(item.querySelector('[data-state]')?.getAttribute('data-state')).toBe('off'),
    )
    expect(item.textContent).toContain('—')
  })
})
