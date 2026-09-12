/**
 * 应用内外链兜底浏览器
 *
 * 外链默认交给系统默认浏览器（shell.openExternal）。但 Windows 上默认浏览器
 * 被卸载 / 协议关联失效时，ShellExecute 会以「找不到应用程序 (0x800401F5)」
 * 拒绝，用户点击外链毫无反应。此时退回应用内浏览器窗口，保证链接始终可打开。
 */
import { BrowserWindow, shell } from 'electron'

let fallbackWindow: BrowserWindow | null = null

/** 在应用内浏览器窗口中打开 URL（单例复用，页面内新开链接就地导航） */
export function openInAppBrowser(url: string): void {
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    void fallbackWindow.loadURL(url)
    fallbackWindow.show()
    fallbackWindow.focus()
    return
  }

  fallbackWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    autoHideMenuBar: true,
    title: '浏览器',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })

  // 页面内 target=_blank / window.open 的链接就地打开，避免弹出权限不同的子窗口
  fallbackWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void fallbackWindow?.loadURL(target)
    return { action: 'deny' }
  })
  // 鼠标侧键前进/后退（Windows 的 app-command 事件）
  fallbackWindow.on('app-command', (_event, command) => {
    if (command === 'browser-backward') fallbackWindow?.webContents.goBack()
    else if (command === 'browser-forward') fallbackWindow?.webContents.goForward()
  })
  fallbackWindow.on('closed', () => {
    fallbackWindow = null
  })

  void fallbackWindow.loadURL(url)
}

/**
 * 打开 http(s) 外链：系统默认浏览器优先，失败退回应用内浏览器窗口。
 * `warn` 由调用方传入各自的 logger，用于记录降级原因。
 */
export async function openExternalWithFallback(
  url: string,
  warn?: (message: string) => void,
): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (err) {
    warn?.(
      `[openExternal] 系统浏览器打开失败，改用应用内窗口: ${err instanceof Error ? err.message : String(err)}`,
    )
    openInAppBrowser(url)
  }
}
