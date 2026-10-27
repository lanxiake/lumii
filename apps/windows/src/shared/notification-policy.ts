/**
 * 桌面通知策略（纯函数）
 *
 * 两类通知：`approval`（等你拍板，可打断）与 `completed`（已完成，可延后）。
 * 设计取舍（D5）：
 * - 默认只提醒「等你拍板」——完成通知默认关，避免每轮都弹；
 * - 窗口聚焦时**两类都不弹**：用户就在窗口前，弹窗只是噪音；
 * - 免打扰时段只压「已完成」，不压「等你拍板」——卡住的活儿该把人叫回来。
 */

export type DesktopNotificationType = 'approval' | 'completed'

export interface NotificationPrefs {
  /** 「等你拍板」是否弹 */
  approval: boolean
  /** 「已完成」是否弹 */
  completed: boolean
  /** 免打扰起止（本地时区小时，0–23）；start > end 表示跨午夜 */
  quietStart: number
  quietEnd: number
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  approval: true,
  completed: false,
  quietStart: 22,
  quietEnd: 8,
}

function isValidHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
}

/** 从配置里读策略；缺字段/脏值一律回默认（不让坏配置把通知永久关死） */
export function normalizeNotificationPrefs(raw: unknown): NotificationPrefs {
  if (!raw || typeof raw !== 'object') return DEFAULT_NOTIFICATION_PREFS
  const value = raw as Record<string, unknown>
  return {
    approval:
      typeof value.approval === 'boolean' ? value.approval : DEFAULT_NOTIFICATION_PREFS.approval,
    completed:
      typeof value.completed === 'boolean' ? value.completed : DEFAULT_NOTIFICATION_PREFS.completed,
    quietStart: isValidHour(value.quietStart)
      ? value.quietStart
      : DEFAULT_NOTIFICATION_PREFS.quietStart,
    quietEnd: isValidHour(value.quietEnd) ? value.quietEnd : DEFAULT_NOTIFICATION_PREFS.quietEnd,
  }
}

/** 本地时区小时是否落在免打扰时段（支持跨午夜，如 22 → 8） */
export function isQuietHour(now: Date, prefs: NotificationPrefs): boolean {
  const hour = now.getHours()
  const { quietStart, quietEnd } = prefs
  if (quietStart === quietEnd) return false
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd
  return hour >= quietStart || hour < quietEnd
}

export interface ShouldNotifyInput {
  type: DesktopNotificationType
  prefs: NotificationPrefs
  /** 主窗口是否在前台 */
  focused: boolean
  now?: Date
}

export function shouldNotify(input: ShouldNotifyInput): boolean {
  const { type, prefs, focused } = input
  const now = input.now ?? new Date()
  if (focused) return false
  if (type === 'approval') return prefs.approval
  if (!prefs.completed) return false
  return !isQuietHour(now, prefs)
}
