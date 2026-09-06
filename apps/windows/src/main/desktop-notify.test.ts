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

  it('使用 default 超时，不常驻屏幕（never 会导致历史通知叠层）', async () => {
    const { showDesktopTaskNotification } = await import('./desktop-notify')
    showDesktopTaskNotification('Lumii', '提醒用户休息')
    expect(NotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Lumii',
        body: '提醒用户休息',
        timeoutType: 'default',
      }),
    )
    const opts = NotificationMock.mock.calls[0]![0] as { urgency?: string }
    expect(opts.urgency).not.toBe('critical')
  })

  it('主动消息默认提醒人标题为 Lumii', async () => {
    const { OUTREACH_SYSTEM_NOTIFY_TITLE } = await import('./desktop-notify')
    expect(OUTREACH_SYSTEM_NOTIFY_TITLE).toBe('Lumii')
  })
})
