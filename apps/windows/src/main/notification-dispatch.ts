/**
 * 桌面通知分发（唯一的出口）
 *
 * 所有「要弹系统通知」的地方都走这里，避免两套免打扰/聚焦判断各说各话。
 * 具体策略见 `shared/notification-policy.ts`（纯函数，可单测）；
 * 这里只负责：取设置 → 判策略 → 去重 → 调 `showDesktopTaskNotification`。
 */

import {
  normalizeNotificationPrefs,
  shouldNotify,
  type DesktopNotificationType,
  type NotificationPrefs,
} from '../shared/notification-policy'
import { showDesktopTaskNotification } from './desktop-notify'

interface NotificationDispatchDeps {
  /** 当前通知设置（AppConfig.notifications，缺省用默认策略） */
  getPrefs: () => unknown
  /** 主窗口是否在前台 */
  isWindowFocused: () => boolean
  notify?: (title: string, body: string, convId?: string) => void
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

let deps: NotificationDispatchDeps | null = null

export function setNotificationDispatchDeps(next: NotificationDispatchDeps | null): void {
  deps = next
}

/** 同一个 requestId 只弹一次（审批事件可能重复投递） */
const DEDUPE_TTL_MS = 60_000
const seen = new Map<string, number>()

export function clearNotificationDedupeForTest(): void {
  seen.clear()
}

function shouldSkipByDedupe(key: string | undefined, now: number): boolean {
  if (!key) return false
  const last = seen.get(key)
  if (last !== undefined && now - last < DEDUPE_TTL_MS) return true
  seen.set(key, now)
  if (seen.size > 200) {
    for (const [k, at] of seen) if (now - at > DEDUPE_TTL_MS) seen.delete(k)
  }
  return false
}

export interface DispatchNotificationInput {
  type: DesktopNotificationType
  title: string
  body: string
  convId?: string
  /** 幂等键（如审批 requestId）；同一键 TTL 内只弹一次 */
  dedupeKey?: string
}

export function dispatchNotification(input: DispatchNotificationInput): boolean {
  if (!deps) return false
  let prefs: NotificationPrefs
  try {
    prefs = normalizeNotificationPrefs(deps.getPrefs())
  } catch {
    return false
  }

  const now = Date.now()
  if (shouldSkipByDedupe(input.dedupeKey, now)) return false

  let focused = false
  try {
    focused = deps.isWindowFocused()
  } catch {
    focused = false
  }

  if (!shouldNotify({ type: input.type, prefs, focused, now: new Date(now) })) {
    return false
  }

  const send = deps.notify ?? showDesktopTaskNotification
  try {
    send(input.title, input.body, input.convId)
    return true
  } catch (err) {
    deps.log?.warn?.('[NotificationDispatch] 发送失败', err)
    return false
  }
}
