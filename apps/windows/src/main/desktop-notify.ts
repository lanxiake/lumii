/**
 * 桌面任务通知（Electron Notification）
 *
 * 抽取自 index.ts / window-ipc.ts，统一：
 * - 弹出前关闭上一条，避免相同提醒叠两个常驻弹窗
 * - timeoutType 用 never + 定时关闭：Windows 原生 default 只有约 5 秒（用户看不清），
 *   而 never 单用会让通知一直挂着、多次触发堆一排。两者组合既保证足够的阅读时长，
 *   又能在超时后自动收起。
 * - 主动消息 system 渠道的默认提醒人标题为 Lumii
 */

import { Notification, type BrowserWindow } from 'electron'

/** 主动消息（outreach）走 system 渠道时的通知标题 / 提醒人 */
export const OUTREACH_SYSTEM_NOTIFY_TITLE = 'Lumii'

/** 桌面通知展示时长（毫秒）：到时自动关闭，保证用户能读完 */
export const DESKTOP_NOTIFY_DURATION_MS = 30_000

export interface DesktopNotifyDeps {
  /** 写日志；缺省静默 */
  log?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
  /** 托盘气球回退 */
  showTrayBalloon?: (title: string, body: string) => void
  /** 窗口未聚焦时闪烁任务栏 */
  flashUnfocusedWindow?: (mainWindow: BrowserWindow) => void
  getMainWindow?: () => BrowserWindow | null
}

let activeNotification: Notification | null = null
/** 当前通知的自动关闭定时器；与 activeNotification 同生命周期 */
let activeNotificationTimer: ReturnType<typeof setTimeout> | null = null

/** 清掉自动关闭定时器（通知已被用户或新通知关掉时调用） */
function clearActiveNotificationTimer(): void {
  if (!activeNotificationTimer) return
  clearTimeout(activeNotificationTimer)
  activeNotificationTimer = null
}

/**
 * 关闭当前仍挂着的系统通知（若有），避免叠层。
 */
function dismissActiveNotification(): void {
  clearActiveNotificationTimer()
  if (!activeNotification) return
  try {
    activeNotification.close()
  } catch {
    /* 已关闭或平台不支持 close 时忽略 */
  }
  activeNotification = null
}

/**
 * 显示一条桌面任务通知。
 * 优先 Electron 系统通知；不可用或失败时回退托盘气球。
 *
 * @param title - 通知标题（提醒人）
 * @param body - 正文（宜简短）
 * @param convId - 可选；点击通知时导航到该会话
 * @param deps - 可选依赖（日志 / 托盘 / 主窗口）
 */
export function showDesktopTaskNotification(
  title: string,
  body: string,
  convId?: string,
  deps?: DesktopNotifyDeps,
): void {
  deps?.log?.info(`[DesktopNotify] title="${title}" body="${body.slice(0, 80)}" convId="${convId ?? ''}"`)

  // 先关掉上一条，再弹新的 —— 否则短时间内连发仍可能并排显示
  dismissActiveNotification()

  let usedElectron = false
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: false,
        // never：通知不随系统默认时长（Windows 约 5 秒）消失，
        // 由下面的定时器在 DESKTOP_NOTIFY_DURATION_MS 后主动关闭。
        timeoutType: 'never',
        urgency: 'normal',
      })
      n.on('click', () => {
        const mainWindow = deps?.getMainWindow?.()
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.focus()
          if (convId) {
            mainWindow.webContents.send('agent-runtime:event', {
              type: 'conversation:navigate',
              sessionKey: convId,
            })
          }
        }
      })
      n.on('close', () => {
        // 用户手动关掉（或系统收起）时清定时器，避免旧定时器误关后来的通知
        if (activeNotification === n) {
          activeNotification = null
          clearActiveNotificationTimer()
        }
      })
      n.show()
      activeNotification = n
      activeNotificationTimer = setTimeout(() => {
        if (activeNotification === n) dismissActiveNotification()
      }, DESKTOP_NOTIFY_DURATION_MS)
      // 不因这条定时器拖住主进程退出
      activeNotificationTimer.unref?.()
      usedElectron = true
    }
  } catch (err) {
    deps?.log?.warn('[DesktopNotify] Electron Notification 失败:', err)
  }

  if (!usedElectron) {
    deps?.showTrayBalloon?.(title, body)
  }

  const mainWindow = deps?.getMainWindow?.()
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    deps?.flashUnfocusedWindow?.(mainWindow)
  }
}
