/**
 * 桌面通知行为单测：验证不叠层、可自动消失、默认提醒人名称。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { NotificationMock, closeFns, showFns } = vi.hoisted(() => {
  const closeFns: Array<ReturnType<typeof vi.fn>> = []
  const showFns: Array<ReturnType<typeof vi.fn>> = []
  const NotificationMock = vi.fn().mockImplementation(() => {
    const close = vi.fn()
    const show = vi.fn()
    closeFns.push(close)
    showFns.push(show)
    return { close, show, on: vi.fn() }
  })
  ;(NotificationMock as unknown as { isSupported: () => boolean }).isSupported = () => true
  return { NotificationMock, closeFns, showFns }
})

vi.mock('electron', () => ({
  Notification: NotificationMock,
}))

describe('desktop-notify', () => {
  beforeEach(() => {
    closeFns.length = 0
    showFns.length = 0
    NotificationMock.mockClear()
    vi.resetModules()
  })

  it('新通知弹出前关闭上一条，避免相同内容叠两个弹窗', async () => {
    const { showDesktopTaskNotification } = await import('./desktop-notify')
    showDesktopTaskNotification('Lumii', '提醒用户休息')
    showDesktopTaskNotification('Lumii', '提醒用户休息')
    expect(closeFns[0]).toHaveBeenCalledTimes(1)
    expect(showFns).toHaveLength(2)
    expect(showFns.every((s) => s.mock.calls.length === 1)).toBe(true)
  })

  it('使用 never + 定时关闭：不随系统默认时长消失，也不会一直挂着', async () => {
    const { showDesktopTaskNotification } = await import('./desktop-notify')
    showDesktopTaskNotification('Lumii', '提醒用户休息')
    expect(NotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Lumii',
        body: '提醒用户休息',
        timeoutType: 'never',
      }),
    )
    const opts = NotificationMock.mock.calls[0]![0] as { urgency?: string }
    expect(opts.urgency).not.toBe('critical')
  })

  it('展示 30 秒后自动关闭（系统 default 约 5 秒，用户看不清）', async () => {
    vi.useFakeTimers()
    try {
      const { showDesktopTaskNotification, DESKTOP_NOTIFY_DURATION_MS } = await import('./desktop-notify')
      expect(DESKTOP_NOTIFY_DURATION_MS).toBe(30_000)
      showDesktopTaskNotification('Lumii', '提醒用户休息')
      vi.advanceTimersByTime(DESKTOP_NOTIFY_DURATION_MS - 1)
      expect(closeFns[0]).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(closeFns[0]).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('新通知顶掉旧通知后，旧定时器不会误关新通知', async () => {
    vi.useFakeTimers()
    try {
      const { showDesktopTaskNotification, DESKTOP_NOTIFY_DURATION_MS } = await import('./desktop-notify')
      showDesktopTaskNotification('Lumii', '第一条')
      vi.advanceTimersByTime(10_000)
      showDesktopTaskNotification('Lumii', '第二条')
      // 弹出新通知时旧通知被立即关闭
      expect(closeFns[0]).toHaveBeenCalledTimes(1)
      // 走到旧定时器的原定到期时刻（t=30s），新通知仍在 —— 旧定时器已被清掉
      vi.advanceTimersByTime(DESKTOP_NOTIFY_DURATION_MS - 10_000)
      expect(closeFns[1]).not.toHaveBeenCalled()
      // 再走到新通知自己的到期时刻（t=40s）才关闭
      vi.advanceTimersByTime(10_000)
      expect(closeFns[1]).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('主动消息默认提醒人标题为 Lumii', async () => {
    const { OUTREACH_SYSTEM_NOTIFY_TITLE } = await import('./desktop-notify')
    expect(OUTREACH_SYSTEM_NOTIFY_TITLE).toBe('Lumii')
  })
})
