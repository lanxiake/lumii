/**
 * 通知策略：三档策略 × 聚焦 × 免打扰（含跨午夜）。
 * 只测纯函数——真正的系统通知由 `desktop-notify` 自己测。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_NOTIFICATION_PREFS,
  isQuietHour,
  normalizeNotificationPrefs,
  shouldNotify,
  type NotificationPrefs,
} from './notification-policy'

const PREFS: NotificationPrefs = { approval: true, completed: true, quietStart: 22, quietEnd: 8 }

function at(hour: number, minute = 0): Date {
  const date = new Date(2026, 9, 27, hour, minute, 0)
  return date
}

describe('isQuietHour', () => {
  it('跨午夜：22:00–07:59 属于免打扰，08:00 起恢复', () => {
    expect(isQuietHour(at(21, 59), PREFS)).toBe(false)
    expect(isQuietHour(at(22, 0), PREFS)).toBe(true)
    expect(isQuietHour(at(3, 30), PREFS)).toBe(true)
    expect(isQuietHour(at(7, 59), PREFS)).toBe(true)
    expect(isQuietHour(at(8, 0), PREFS)).toBe(false)
  })

  it('不跨午夜：13–15 只压这一段', () => {
    const prefs: NotificationPrefs = { ...PREFS, quietStart: 13, quietEnd: 15 }
    expect(isQuietHour(at(12, 59), prefs)).toBe(false)
    expect(isQuietHour(at(14, 0), prefs)).toBe(true)
    expect(isQuietHour(at(15, 0), prefs)).toBe(false)
  })

  it('起止相同视为没有免打扰', () => {
    const prefs: NotificationPrefs = { ...PREFS, quietStart: 9, quietEnd: 9 }
    expect(isQuietHour(at(9, 0), prefs)).toBe(false)
  })
})

describe('shouldNotify', () => {
  it('窗口聚焦时两类都不弹', () => {
    expect(shouldNotify({ type: 'approval', prefs: PREFS, focused: true, now: at(14) })).toBe(false)
    expect(shouldNotify({ type: 'completed', prefs: PREFS, focused: true, now: at(14) })).toBe(false)
  })

  it('策略关闭时对应类型不弹', () => {
    expect(
      shouldNotify({ type: 'approval', prefs: { ...PREFS, approval: false }, focused: false }),
    ).toBe(false)
    expect(
      shouldNotify({ type: 'completed', prefs: { ...PREFS, completed: false }, focused: false }),
    ).toBe(false)
  })

  it('免打扰只压「已完成」，不压「等你拍板」', () => {
    expect(shouldNotify({ type: 'completed', prefs: PREFS, focused: false, now: at(23) })).toBe(false)
    expect(shouldNotify({ type: 'approval', prefs: PREFS, focused: false, now: at(23) })).toBe(true)
  })

  it('白天未聚焦时「已完成」会弹', () => {
    expect(shouldNotify({ type: 'completed', prefs: PREFS, focused: false, now: at(14) })).toBe(true)
  })
})

describe('normalizeNotificationPrefs', () => {
  it('缺省走默认（只提醒等你拍板，22–08 免打扰）', () => {
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS)
    expect(DEFAULT_NOTIFICATION_PREFS).toMatchObject({ approval: true, completed: false })
  })

  it('脏值不该把通知永久关死：非法小时回到默认', () => {
    const prefs = normalizeNotificationPrefs({ approval: 'yes', quietStart: 99, quietEnd: null })
    expect(prefs.approval).toBe(DEFAULT_NOTIFICATION_PREFS.approval)
    expect(prefs.quietStart).toBe(DEFAULT_NOTIFICATION_PREFS.quietStart)
    expect(prefs.quietEnd).toBe(DEFAULT_NOTIFICATION_PREFS.quietEnd)
  })

  it('合法字段照用', () => {
    expect(
      normalizeNotificationPrefs({ approval: false, completed: true, quietStart: 0, quietEnd: 6 }),
    ).toEqual({ approval: false, completed: true, quietStart: 0, quietEnd: 6 })
  })
})
