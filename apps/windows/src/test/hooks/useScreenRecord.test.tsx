/**
 * useScreenRecord Hook 测试
 *
 * 重点回归：确认弹窗期间刷新窗口后，从 status() 回读恢复 pendingConfirm
 * （主进程确认态与定时器仍在，此前渲染侧忽略该回读导致弹窗消失）。
 */

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  onEvent: vi.fn(),
  status: vi.fn(),
  respondConfirm: vi.fn(),
  listSources: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('../../renderer/services/screen-record-api', () => api)

async function renderScreenRecordHook() {
  const { useScreenRecord } = await import('../../renderer/hooks/useScreenRecord')
  return renderHook(() => useScreenRecord())
}

describe('useScreenRecord', () => {
  beforeEach(() => {
    vi.resetModules()
    api.onEvent.mockReset().mockReturnValue(() => undefined)
    api.status.mockReset()
    api.respondConfirm.mockReset()
  })

  it('刷新后从 status 恢复待确认弹窗（剩余秒 + 恢复时刻）', async () => {
    api.status.mockResolvedValue({
      ok: true,
      status: 'pending_confirm',
      sessionId: 'sess-1',
      sourceId: 'window:42:0',
      sourceName: '无标题 - 记事本',
      sourceType: 'window',
      pendingConfirm: true,
      confirmTimeoutSec: 90,
      confirmStartedAt: Date.now() - 30_000,
      purpose: 'record',
    })

    const { result } = await renderScreenRecordHook()

    await waitFor(() => expect(result.current.pendingConfirm).not.toBeNull())
    expect(result.current.pendingConfirm).toMatchObject({
      sessionId: 'sess-1',
      sourceName: '无标题 - 记事本',
      sourceType: 'window',
      sourceId: 'window:42:0',
      timeoutSec: 90,
      purpose: 'record',
    })
    // startedAt 为恢复时刻（Dialog 以 timeoutSec-(now-startedAt) 得与主进程一致的剩余倒计时）
    expect(Date.now() - (result.current.pendingConfirm?.startedAt ?? 0)).toBeLessThan(1000)
    expect(result.current.status).toBe('pending_confirm')
  })

  it('非确认态 status 不产生弹窗', async () => {
    api.status.mockResolvedValue({ ok: true, status: 'idle' })

    const { result } = await renderScreenRecordHook()

    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(result.current.pendingConfirm).toBeNull()
  })
})
