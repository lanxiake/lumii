/**
 * 桌面通知行为单测：验证不叠层、可自动消失、默认提醒人名称。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { NotificationMock, closeFns, showFns, handlerSets } = vi.hoisted(() => {
  const closeFns: Array<ReturnType<typeof vi.fn>> = []
  const showFns: Array<ReturnType<typeof vi.fn>> = []
  /**
   * 每次 `new Notification` 对应一份 `{事件名: 回调}`。
   *
   * 记下来是为了能**主动触发 click**——「点击通知回主窗口」这条验收（设计 §9）
   * 的判据全在 click 回调里（restore/focus/导航），而原先的 `on: vi.fn()`
   * 把它整个丢掉了，于是那条逻辑一直没有测试覆盖。
   */
  const handlerSets: Array<Record<string, () => void>> = []
  const NotificationMock = vi.fn().mockImplementation(() => {
    const close = vi.fn()
    const show = vi.fn()
    const handlers: Record<string, () => void> = {}
    closeFns.push(close)
    showFns.push(show)
    handlerSets.push(handlers)
    return {
      close,
      show,
      on: vi.fn((event: string, fn: () => void) => {
        handlers[event] = fn
      }),
    }
  })
  ;(NotificationMock as unknown as { isSupported: () => boolean }).isSupported = () => true
  return { NotificationMock, closeFns, showFns, handlerSets }
})

vi.mock('electron', () => ({
  Notification: NotificationMock,
}))

/**
 * 假主窗口：只实现会碰到的成员。
 *
 * `isFocused` 是 `showDesktopTaskNotification` 末尾那段
 * 「窗口未聚焦时闪烁任务栏」用的——click 回调本身不碰它，
 * 但弹通知时会调用，缺了它整条路径会抛。
 */
function fakeWindow(opts: { minimized?: boolean; destroyed?: boolean; focused?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => opts.destroyed ?? false),
    isMinimized: vi.fn(() => opts.minimized ?? false),
    isFocused: vi.fn(() => opts.focused ?? true),
    restore: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  }
}

describe('desktop-notify', () => {
  beforeEach(() => {
    closeFns.length = 0
    showFns.length = 0
    handlerSets.length = 0
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

/**
 * 点击通知 → 回到主窗口（设计 §9「桌面通知可点击回到主窗口」）。
 *
 * 这条一直列在 T7「未在本机验证」（需要人在图形会话里点一下）。
 * 但判据其实全在 click 回调里、且不依赖真实 Notification 对象——
 * 把回调抓出来直接调用，就能在单测里覆盖，不必等人工。
 *
 * 覆盖不到的是**平台是否真的把点击投递进来**（那属 Electron/D-Bus 的职责），
 * 这里锁的是我们自己的那段响应逻辑。
 */
describe('desktop-notify：点击回主窗口', () => {
  beforeEach(() => {
    closeFns.length = 0
    showFns.length = 0
    handlerSets.length = 0
    NotificationMock.mockClear()
    vi.resetModules()
  })

  /** 弹一条通知并取回它的 click 回调 */
  async function popAndGetClick(
    deps: import('./desktop-notify').DesktopNotifyDeps,
    convId?: string,
  ) {
    const { showDesktopTaskNotification } = await import('./desktop-notify')
    showDesktopTaskNotification('Lumii', '任务完成', convId, deps)
    const click = handlerSets.at(-1)?.['click']
    expect(click, '通知应注册 click 回调').toBeTypeOf('function')
    return click!
  }

  it('点击后聚焦主窗口', async () => {
    const win = fakeWindow()
    const click = await popAndGetClick({ getMainWindow: () => win as never })
    click()
    expect(win.focus).toHaveBeenCalledTimes(1)
    // 未最小化就不该 restore
    expect(win.restore).not.toHaveBeenCalled()
  })

  it('最小化时先 restore 再 focus（否则聚焦看不见的窗口）', async () => {
    const win = fakeWindow({ minimized: true })
    const click = await popAndGetClick({ getMainWindow: () => win as never })
    click()
    expect(win.restore).toHaveBeenCalledTimes(1)
    expect(win.focus).toHaveBeenCalledTimes(1)
    // 顺序：先恢复再聚焦
    expect(win.restore.mock.invocationCallOrder[0]!).toBeLessThan(
      win.focus.mock.invocationCallOrder[0]!,
    )
  })

  it('带 convId 时向渲染进程发导航事件', async () => {
    const win = fakeWindow()
    const click = await popAndGetClick({ getMainWindow: () => win as never }, 'conv-42')
    click()

    expect(win.webContents.send).toHaveBeenCalledWith('agent-runtime:event', {
      type: 'conversation:navigate',
      sessionKey: 'conv-42',
    })
  })

  it('不带 convId 时不发导航事件（只把窗口拉回来）', async () => {
    const win = fakeWindow()
    const click = await popAndGetClick({ getMainWindow: () => win as never })
    click()
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('窗口已销毁时静默返回，不碰已失效对象', async () => {
    const win = fakeWindow({ destroyed: true })
    const click = await popAndGetClick({ getMainWindow: () => win as never })
    expect(() => click()).not.toThrow()
    expect(win.focus).not.toHaveBeenCalled()
    expect(win.restore).not.toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('拿不到主窗口时不抛错（通知先于窗口出现/已关闭）', async () => {
    const click = await popAndGetClick({ getMainWindow: () => null })
    expect(() => click()).not.toThrow()
  })
})
