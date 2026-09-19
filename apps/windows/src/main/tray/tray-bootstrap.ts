import { app, type BrowserWindow } from 'electron'
import { TrayManager } from '../tray-manager'
import type { ScreenRecordService } from '../screen-record'
import { isPetMode, switchPetMode, isPetForceIgnore, disablePetForceIgnore } from '../pet/pet-mode-ipc'

export interface TrayLogger {
  info: (...args: unknown[]) => void
  /** 托盘在 Linux 上可能不可用（GNOME 无 AppIndicator），失败时要能记一笔 */
  warn: (...args: unknown[]) => void
}

export interface TrayBootstrapOptions {
  logger: TrayLogger
  getMainWindow: () => BrowserWindow | null
  getScreenRecordService: () => ScreenRecordService | null
  setTrayManager: (manager: TrayManager) => void
  setQuitting: () => void
}

/**
 * 初始化系统托盘。
 *
 * **Linux 上托盘不是必然可用的**：GNOME 默认不带 StatusNotifierItem 支持，
 * 需要扩展（如 AppIndicator）或 `libayatana-appindicator3-1` 才能显示。此时
 * `new Tray()` 会抛异常——**不能让它冒泡出去**：调用点 `index.ts` 在启动序列里
 * 裸调本函数，异常会中断后续初始化（系统服务、录屏、云同步全都起不来），
 * 而托盘只是个可选入口。
 *
 * 失败时仅 warn 并继续：主窗口保留「切换模式 / 退出 / 设置」等入口（设计 §6.1
 * 的「不把托盘作为唯一入口」），应用功能完整。
 *
 * @returns 托盘是否创建成功（调用方可用它决定是否还有别的入口需要保留）
 */
export function initializeTray(options: TrayBootstrapOptions): boolean {
  const { logger } = options
  logger.info('初始化系统托盘')

  try {
    createTrayManager(options)
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn(
      `创建系统托盘失败，应用继续运行（主窗口仍有完整入口）：${msg}`,
    )
    if (process.platform === 'linux') {
      logger.warn(
        '提示：GNOME 默认不显示托盘图标，需要 AppIndicator 扩展；' +
          '或安装 libayatana-appindicator3-1 后重试。',
      )
    }
    return false
  }
}

function createTrayManager(options: TrayBootstrapOptions): void {
  const { getMainWindow, setTrayManager, setQuitting, getScreenRecordService } = options

  const trayManager = new TrayManager({
    onShowWindow: () => {
      getMainWindow()?.show()
      getMainWindow()?.focus()
    },
    onQuit: () => {
      setQuitting()
      app.quit()
    },
    onOpenSettings: () => {
      // 显示并聚焦主窗口
      getMainWindow()?.show()
      getMainWindow()?.focus()
      // 通过 IPC 通知渲染进程导航到设置页面
      getMainWindow()?.webContents.send('navigate-to-settings')
    },
    onTogglePetMode: () => {
      const next = isPetMode() ? 'desktop' : 'pet'
      // 托盘/设置页状态同步由 onModeChanged 统一处理，无需在此重复
      void switchPetMode(next)
    },
    onDisableForceIgnore: () => {
      disablePetForceIgnore()
      trayManager?.updateForceIgnore(isPetForceIgnore())
    },
    onStartScreenRecord: () => {
      getMainWindow()?.show()
      getMainWindow()?.focus()
      // 无预选源：打开轻量面板，不静默 start（设计 §4.1）
      getMainWindow()?.webContents.send('screen-record:open-panel')
    },
    onStopScreenRecord: () => {
      void getScreenRecordService()?.stop()
    },
    onPauseScreenRecord: () => {
      void getScreenRecordService()?.pause()
    },
    onResumeScreenRecord: () => {
      void getScreenRecordService()?.resume()
    },
  })
  setTrayManager(trayManager)
}

