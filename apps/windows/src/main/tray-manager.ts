/**
 * TrayManager - 系统托盘管理
 *
 * 管理 Windows 系统托盘图标和菜单。
 * 独立版不依赖 Gateway，托盘仅保留窗口/宠物/设置/退出。
 */

import { Tray, Menu, nativeImage, BrowserWindow } from 'electron'
import { getTrayIconPath } from './asset-paths'

// 日志输出
const log = {
  info: (...args: unknown[]) => console.log('[TrayManager]', ...args),
  error: (...args: unknown[]) => console.error('[TrayManager]', ...args),
}

/**
 * 托盘管理器配置
 */
export interface TrayManagerConfig {
  /** 显示窗口回调 */
  onShowWindow: () => void
  /** 退出应用回调 */
  onQuit: () => void
  /** 打开设置窗口回调 */
  onOpenSettings: () => void
  /** 切换宠物模式回调（进入/退出由 TrayManager 当前状态决定） */
  onTogglePetMode?: () => void
  /** 关闭强制穿透（仅宠物模式 + 穿透开启时可用） */
  onDisableForceIgnore?: () => void
  /** 开始录屏（无预选源时应打开面板） */
  onStartScreenRecord?: () => void
  /** 停止录屏 */
  onStopScreenRecord?: () => void
  /** 暂停录屏 */
  onPauseScreenRecord?: () => void
  /** 继续录屏 */
  onResumeScreenRecord?: () => void
}

/**
 * 托盘管理器类
 */
export class TrayManager {
  private tray: Tray | null = null
  private config: TrayManagerConfig
  private petModeActive = false
  private forceIgnoreActive = false
  private screenRecording = false
  private screenRecordPaused = false
  private screenRecordElapsedMs = 0

  constructor(config: TrayManagerConfig) {
    this.config = config
    this.createTray()
  }

  /**
   * 创建系统托盘
   */
  private createTray(): void {
    log.info('创建系统托盘')

    // 托盘图标与产品 Logo 一致（tray-icon.png 由 logo.png 生成）
    const iconPath = getTrayIconPath()
    let icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      log.error('托盘图标加载失败:', iconPath)
    } else {
      // Windows 托盘约 16px；保留清晰缩略
      const size = icon.getSize()
      if (size.width > 16 || size.height > 16) {
        icon = icon.resize({ width: 16, height: 16, quality: 'best' })
      }
    }

    this.tray = new Tray(icon)
    this.tray.setToolTip('灵栖 Lumii')

    // 设置右键菜单
    this.updateContextMenu()

    // 点击托盘图标显示窗口
    this.tray.on('click', () => {
      this.config.onShowWindow()
    })

    // 双击也显示窗口
    this.tray.on('double-click', () => {
      this.config.onShowWindow()
    })
  }

  /**
   * @deprecated 保留兼容；实际路径见 getTrayIconPath
   */
  private getIconPath(): string {
    return getTrayIconPath()
  }

  /**
   * 更新右键菜单
   */
  private updateContextMenu(): void {
    const elapsedSec = Math.floor(this.screenRecordElapsedMs / 1000)
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, '0')
    const ss = String(elapsedSec % 60).padStart(2, '0')
    const active = this.screenRecording || this.screenRecordPaused
    const recordItems =
      this.config.onStartScreenRecord || this.config.onStopScreenRecord
        ? [
            ...(active
              ? [
                  ...(this.screenRecording && this.config.onPauseScreenRecord
                    ? [
                        {
                          label: `暂停录屏（${mm}:${ss}）`,
                          click: () => this.config.onPauseScreenRecord?.(),
                        },
                      ]
                    : []),
                  ...(this.screenRecordPaused && this.config.onResumeScreenRecord
                    ? [
                        {
                          label: `继续录屏（${mm}:${ss}）`,
                          click: () => this.config.onResumeScreenRecord?.(),
                        },
                      ]
                    : []),
                  {
                    label: `停止录屏（${mm}:${ss}）`,
                    click: () => this.config.onStopScreenRecord?.(),
                  },
                ]
              : [
                  {
                    label: '开始录屏',
                    click: () => this.config.onStartScreenRecord?.(),
                  },
                ]),
            { type: 'separator' as const },
          ]
        : []

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示窗口',
        click: () => this.config.onShowWindow(),
      },
      { type: 'separator' },
      ...(this.config.onTogglePetMode
        ? [
            {
              label: this.petModeActive ? '退出宠物模式' : '进入宠物模式',
              click: () => this.config.onTogglePetMode!(),
            },
            ...(this.petModeActive && this.forceIgnoreActive && this.config.onDisableForceIgnore
              ? [
                  {
                    label: '退出穿透（恢复点击）',
                    click: () => this.config.onDisableForceIgnore!(),
                  },
                ]
              : []),
            { type: 'separator' as const },
          ]
        : []),
      ...recordItems,
      {
        label: '设置',
        click: () => {
          this.config.onOpenSettings()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => this.config.onQuit(),
      },
    ])

    this.tray?.setContextMenu(contextMenu)
  }

  /**
   * 更新宠物模式状态，刷新托盘菜单文案
   */
  updatePetMode(active: boolean): void {
    this.petModeActive = active
    if (!active) this.forceIgnoreActive = false
    this.updateContextMenu()
  }

  /** 更新强制穿透状态（托盘显示「退出穿透」入口） */
  updateForceIgnore(active: boolean): void {
    this.forceIgnoreActive = active
    this.updateContextMenu()
  }

  /**
   * 更新录屏状态（recording / paused 时显示停止与暂停/继续）。
   */
  updateScreenRecordState(
    isRecording: boolean,
    elapsedMs = 0,
    isPaused = false,
  ): void {
    this.screenRecording = isRecording
    this.screenRecordPaused = isPaused
    this.screenRecordElapsedMs = elapsedMs
    this.updateContextMenu()
  }

  /**
   * 显示通知（托盘气球，Windows 专用）
   */
  showNotification(title: string, body: string): void {
    if (this.tray) {
      this.tray.displayBalloon({
        title,
        content: body,
        iconType: 'info',
      })
    }
  }

  /**
   * 闪烁任务栏/托盘图标以提醒用户
   */
  flashWindow(window: BrowserWindow): void {
    window.flashFrame(true)
  }

  /**
   * 停止闪烁任务栏/托盘图标
   */
  stopFlash(window: BrowserWindow): void {
    window.flashFrame(false)
  }

  /**
   * 销毁托盘
   */
  destroy(): void {
    log.info('销毁系统托盘')
    this.tray?.destroy()
    this.tray = null
  }
}
