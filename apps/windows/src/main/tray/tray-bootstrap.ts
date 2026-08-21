import { app, type BrowserWindow } from 'electron'
import { TrayManager } from '../tray-manager'
import type { ScreenRecordService } from '../screen-record'
import { isPetMode, switchPetMode, isPetForceIgnore, disablePetForceIgnore } from '../pet/pet-mode-ipc'

export interface TrayLogger {
  info: (...args: unknown[]) => void
}

export interface TrayBootstrapOptions {
  logger: TrayLogger
  getMainWindow: () => BrowserWindow | null
  getScreenRecordService: () => ScreenRecordService | null
  setTrayManager: (manager: TrayManager) => void
  setQuitting: () => void
}

/**
 * 初始化系统托盘
 */
export function initializeTray(options: TrayBootstrapOptions): void {
  const { logger, getMainWindow, setTrayManager, setQuitting, getScreenRecordService } = options
  logger.info('初始化系统托盘')

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

