/**
 * 桌面任务通知（Electron Notification）
 *
 * 抽取自 index.ts / window-ipc.ts，统一：
 * - 弹出前关闭上一条，避免相同提醒叠两个常驻弹窗
 * - timeoutType 用 default（never 会一直挂着，多次触发就堆一排相同内容）
 * - 主动消息 system 渠道的默认提醒人标题为 Lumii
 */

import { Notification, type BrowserWindow } from 'electron'

/** 主动消息（outreach）走 system 渠道时的通知标题 / 提醒人 */
export const OUTREACH_SYSTEM_NOTIFY_TITLE = 'Lumii'

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

/**
 * 关闭当前仍挂着的系统通知（若有），避免叠层。
 */
function dismissActiveNotification(): void {
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

  // 先关掉上一条，再弹新的 —— 否则 timeoutType 即使用 default，短时间内连发仍可能并排显示
  dismissActiveNotification()

  let usedElectron = false
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: false,
        timeoutType: 'default',
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
      n.on('closed', () => {
        if (activeNotification === n) activeNotification = null
      })
      n.show()
      activeNotification = n
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

/**
 * 测试/关闭用：清空模块内活动通知引用。
 */
export function resetDesktopNotifyForTests(): void {
  dismissActiveNotification()
}
