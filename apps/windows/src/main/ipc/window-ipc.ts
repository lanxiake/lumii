/**
 * 窗口控制相关 IPC handlers
 */
import { ipcMain, screen, BrowserWindow } from 'electron'
import type { TrayManager } from '../tray-manager'
import { showDesktopTaskNotification as showDesktopNotify } from '../desktop-notify'

interface WindowIpcDeps {
  getMainWindow: () => BrowserWindow | null
  getTrayManager: () => TrayManager | null
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

let deps: WindowIpcDeps | null = null

/** 注入窗口 IPC 依赖（主窗口 / 托盘 / 日志） */
export function setWindowIpcDeps(d: WindowIpcDeps): void {
  deps = d
}

/**
 * 桌面任务通知：统一走 desktop-notify（关上一条、default 超时，避免相同提醒叠层）。
 *
 * @param title - 通知标题
 * @param body - 正文（宜简短）
 */
function showDesktopTaskNotification(title: string, body: string): void {
  if (!deps) return

  const trayManager = deps.getTrayManager()
  showDesktopNotify(title, body, undefined, {
    log: deps.log,
    getMainWindow: deps.getMainWindow,
    showTrayBalloon: (t, b) => trayManager?.showNotification(t, b),
    flashUnfocusedWindow: (win) => {
      trayManager?.flashWindow(win)
      win.once('focus', () => trayManager?.stopFlash(win))
    },
  })
}

/** 注册窗口控制与桌面通知相关 IPC */
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
    const title = typeof payload?.title === 'string' && payload.title.trim() ? payload.title.trim() : 'Lumii'
    const body = typeof payload?.body === 'string' ? payload.body : ''
    showDesktopTaskNotification(title, body)
  })
}
