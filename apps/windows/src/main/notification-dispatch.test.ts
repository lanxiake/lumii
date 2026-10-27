/**
 * 通知分发：策略/聚焦/免打扰走 shared 纯函数，这里只验「接线与去重」。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  clearNotificationDedupeForTest,
  dispatchNotification,
  setNotificationDispatchDeps,
} from './notification-dispatch'

type NotifyFn = (title: string, body: string, convId?: string) => void

function setup(opts: { focused?: boolean; prefs?: unknown } = {}): NotifyFn {
  const notify = vi.fn()
  setNotificationDispatchDeps({
    getPrefs: () => opts.prefs,
    isWindowFocused: () => opts.focused ?? false,
    notify: notify as unknown as NotifyFn,
  })
  return notify as unknown as NotifyFn
}

describe('dispatchNotification', () => {
  beforeEach(() => {
    clearNotificationDedupeForTest()
    setNotificationDispatchDeps(null)
  })

  it('未注入 deps 时安全返回 false（启动早期/测试环境）', () => {
    expect(
      dispatchNotification({ type: 'approval', title: 't', body: 'b' }),
    ).toBe(false)
  })

  it('聚焦时不发；approval 默认策略下会发', () => {
    const focusedNotify = setup({ focused: true })
    expect(dispatchNotification({ type: 'approval', title: 't', body: 'b' })).toBe(false)
    expect(focusedNotify).not.toHaveBeenCalled()

    const notify = setup({ focused: false })
    expect(dispatchNotification({ type: 'approval', title: '等你拍板', body: 'bash', convId: 'c1' })).toBe(true)
    expect(notify).toHaveBeenCalledWith('等你拍板', 'bash', 'c1')
  })

  it('completed 默认关闭（D5：默认只提醒等你拍板）', () => {
    const notify = setup({ focused: false })
    expect(dispatchNotification({ type: 'completed', title: 't', body: 'b' })).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('显式打开 completed 后白天会发，免打扰时段不发', () => {
    const notify = setup({ focused: false, prefs: { completed: true, quietStart: 22, quietEnd: 8 } })
    const now = new Date()
    const hour = now.getHours()
    const expected = !(hour >= 22 || hour < 8)
    expect(dispatchNotification({ type: 'completed', title: 't', body: 'b' })).toBe(expected)
    expect(notify).toHaveBeenCalledTimes(expected ? 1 : 0)
  })

  it('同一 dedupeKey 只发一次', () => {
    const notify = setup({ focused: false })
    const input = { type: 'approval' as const, title: 't', body: 'b', dedupeKey: 'req-1' }
    expect(dispatchNotification(input)).toBe(true)
    expect(dispatchNotification(input)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)

    expect(dispatchNotification({ ...input, dedupeKey: 'req-2' })).toBe(true)
  })

  it('配置读取抛错时不发（不让坏配置炸到调用方）', () => {
    const notify = vi.fn()
    setNotificationDispatchDeps({
      getPrefs: () => {
        throw new Error('config broken')
      },
      isWindowFocused: () => false,
      notify,
    })
    expect(dispatchNotification({ type: 'approval', title: 't', body: 'b' })).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })
})
