/**
 * 窗口控制相关 IPC handlers
 */
import { ipcMain, screen, BrowserWindow, Notification } from 'electron'
import type { TrayManager } from '../tray-manager'

interface WindowIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getTrayManager: () => TrayManager | null
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

let deps: WindowIpcDeps | null = null

export function setWindowIpcDeps(d: WindowIpcDeps): void {
  deps = d
}

/**
 * 桌面任务通知：优先使用 Electron 系统通知；仅在不可用或失败时回退到托盘气球，避免同一事件出现两个弹窗。
 * 窗口未聚焦时仍任务栏闪烁。
 *
 * @param title - 通知标题
 * @param body - 正文（宜简短）
 */
function showDesktopTaskNotification(title: string, body: string): void {
  if (!deps) return

  const mainWindow = deps.getMainWindow()
  const trayManager = deps.getTrayManager()

  deps.log.info(`[DesktopNotify] title="${title}" body="${body.slice(0, 80)}"`)
  let usedElectron = false
  try {
    if (Notification.isSupported()) {
      const n = new Notification({
        title,
        body,
        silent: false,
        timeoutType: 'never',
        urgency: 'critical',
      })
      n.on('click', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.focus()
        }
      })
      n.show()
      usedElectron = true
    }
  } catch (err) {
    deps.log.warn('[DesktopNotify] Electron Notification 失败:', err)
  }
  if (!usedElectron) {
    trayManager?.showNotification(title, body)
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    trayManager?.flashWindow(mainWindow)
    mainWindow.once('focus', () => trayManager?.stopFlash(mainWindow!))
  }
}

export function registerWindowIpcHandlers(): void {
  if (!deps) throw new Error('WindowIpc deps not set')

  // === 窗口控制 ===
  ipcMain.on('window:minimize', () => deps!.getMainWindow()?.minimize())

  ipcMain.on('window:maximize', () => {
    const mainWindow = deps!.getMainWindow()
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.on('window:close', () => deps!.getMainWindow()?.hide())

  ipcMain.handle('window:isMaximized', () => deps!.getMainWindow()?.isMaximized() ?? false)

  /**
   * 光标相对内容区坐标（供边缘光效使用）。
   * 标题栏 `-webkit-app-region: drag` 会吞掉 DOM mousemove，必须走主进程 screen API。
   */
  ipcMain.handle('window:getCursorClientPos', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? deps!.getMainWindow()
    if (!win || win.isDestroyed()) return null
    const point = screen.getCursorScreenPoint()
    const bounds = win.getContentBounds()
    const x = point.x - bounds.x
    const y = point.y - bounds.y
    return {
      x,
      y,
      inside:
        point.x >= bounds.x
        && point.y >= bounds.y
        && point.x < bounds.x + bounds.width
        && point.y < bounds.y + bounds.height,
    }
  })

  /** 渲染进程请求桌面通知（如 Agent 回合结束且窗口在后台） */
  ipcMain.handle('notify:desktop', async (_event, payload: { title?: string; body?: string }) => {
    const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'MtBot'
    const body = typeof payload?.body === 'string' ? payload.body : ''
    showDesktopTaskNotification(title, body)
  })
}
