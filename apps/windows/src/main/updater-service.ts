/**
 * UpdaterService - 自动更新服务
 *
 * 基于 electron-updater 实现应用自动更新功能
 * 支持检查更新、下载更新、安装更新
 */

import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater'
import { BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'events'

/**
 * 日志输出
 */
const log = {
  info: (...args: unknown[]) => console.log('[Updater]', ...args),
  error: (...args: unknown[]) => console.error('[Updater]', ...args),
  warn: (...args: unknown[]) => console.warn('[Updater]', ...args),
}

/**
 * 更新状态
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

/**
 * 更新信息
 */
export interface UpdateState {
  /** 当前状态 */
  status: UpdateStatus
  /** 当前版本 */
  currentVersion: string
  /** 可用的新版本 */
  availableVersion?: string
  /** 更新说明 */
  releaseNotes?: string
  /** 发布日期 */
  releaseDate?: string
  /** 下载进度 (0-100) */
  downloadProgress?: number
  /** 下载速度 (bytes/s) */
  downloadSpeed?: number
  /** 已下载大小 */
  downloadedBytes?: number
  /** 总大小 */
  totalBytes?: number
  /** 错误信息 */
  error?: string
  /** 最后检查时间 */
  lastCheckTime?: number
}

/**
 * 更新配置
 */
export interface UpdaterConfig {
  /** 是否自动检查更新 */
  autoCheck: boolean
  /** 自动检查间隔 (毫秒) */
  checkInterval: number
  /** 是否自动下载 */
  autoDownload: boolean
  /** 是否自动安装 */
  autoInstall: boolean
  /** 是否允许预发布版本 */
  allowPrerelease: boolean
}

/**
 * 默认更新配置
 */
const DEFAULT_CONFIG: UpdaterConfig = {
  autoCheck: false, // 开发阶段禁用自动检查
  checkInterval: 4 * 60 * 60 * 1000, // 4小时
  autoDownload: false,
  autoInstall: false,
  allowPrerelease: false,
}

/**
 * 自动更新服务类
 */
export class UpdaterService extends EventEmitter {
  private mainWindow: BrowserWindow | null = null
  private config: UpdaterConfig
  private state: UpdateState
  private checkTimer: NodeJS.Timeout | null = null

  constructor(config: Partial<UpdaterConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      status: 'idle',
      currentVersion: '',
    }

    this.setupAutoUpdater()
  }

  /**
   * 配置 autoUpdater
   */
  private setupAutoUpdater(): void {
    log.info('初始化自动更新服务')

    // 配置 autoUpdater
    autoUpdater.autoDownload = this.config.autoDownload
    autoUpdater.autoInstallOnAppQuit = this.config.autoInstall
    autoUpdater.allowPrerelease = this.config.allowPrerelease

    // 禁用自动下载，手动控制
    autoUpdater.autoDownload = false

    // 监听更新事件
    autoUpdater.on('checking-for-update', () => {
      log.info('正在检查更新...')
      this.updateState({ status: 'checking' })
    })

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      log.info('发现新版本:', info.version)
      this.updateState({
        status: 'available',
        availableVersion: info.version,
        releaseNotes: this.formatReleaseNotes(info.releaseNotes),
        releaseDate: info.releaseDate,
      })

      // 如果配置了自动下载，开始下载
      if (this.config.autoDownload) {
        this.downloadUpdate()
      }
    })

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      log.info('当前已是最新版本:', info.version)
      this.updateState({
        status: 'not-available',
        lastCheckTime: Date.now(),
      })
    })

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      log.info(`下载进度: ${progress.percent.toFixed(1)}%`)
      this.updateState({
        status: 'downloading',
        downloadProgress: progress.percent,
        downloadSpeed: progress.bytesPerSecond,
        downloadedBytes: progress.transferred,
        totalBytes: progress.total,
      })
    })

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      log.info('更新下载完成:', info.version)
      this.updateState({
        status: 'downloaded',
        downloadProgress: 100,
      })

      // 如果配置了自动安装，立即安装
      if (this.config.autoInstall) {
        this.installUpdate()
      }
    })

    autoUpdater.on('error', (error: Error) => {
      log.error('更新错误:', error.message)
      this.updateState({
        status: 'error',
        error: error.message,
      })
    })
  }

  /**
   * 格式化发布说明
   */
  private formatReleaseNotes(notes: string | { version?: string; note?: string | null }[] | null | undefined): string {
    if (!notes) {return ''}
    if (typeof notes === 'string') {return notes}
    // 如果是数组，合并所有说明（过滤掉 null）
    return notes.map((n) => n.note || '').filter(Boolean).join('\n\n')
  }

  /**
   * 更新状态并通知
   */
  private updateState(partial: Partial<UpdateState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('state-change', this.state)
    this.notifyRenderer()
  }

  /**
   * 通知渲染进程
   */
  private notifyRenderer(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('updater:state-change', this.state)
    }
  }

  /**
   * 设置主窗口引用
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * 获取当前状态
   */
  getState(): UpdateState {
    return { ...this.state }
  }

  /**
   * 获取配置
   */
  getConfig(): UpdaterConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<UpdaterConfig>): void {
    this.config = { ...this.config, ...config }
    autoUpdater.allowPrerelease = this.config.allowPrerelease

    // 重新设置定时检查
    if (this.config.autoCheck) {
      this.startAutoCheck()
    } else {
      this.stopAutoCheck()
    }

    log.info('更新配置已更新:', this.config)
  }

  /**
   * 检查更新
   */
  async checkForUpdates(): Promise<UpdateState> {
    log.info('手动检查更新')

    try {
      this.state.currentVersion = autoUpdater.currentVersion.version
      await autoUpdater.checkForUpdates()
      return this.getState()
    } catch (error) {
      const message = error instanceof Error ? error.message : '检查更新失败'
      log.error('检查更新失败:', message)
      this.updateState({ status: 'error', error: message })
      return this.getState()
    }
  }

  /**
   * 下载更新
   */
  async downloadUpdate(): Promise<void> {
    if (this.state.status !== 'available') {
      log.warn('没有可用的更新')
      return
    }

    log.info('开始下载更新')
    this.updateState({ status: 'downloading', downloadProgress: 0 })

    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载更新失败'
      log.error('下载更新失败:', message)
      this.updateState({ status: 'error', error: message })
    }
  }

  /**
   * 安装更新并重启
   */
  installUpdate(): void {
    if (this.state.status !== 'downloaded') {
      log.warn('更新尚未下载完成')
      return
    }

    log.info('安装更新并重启应用')
    autoUpdater.quitAndInstall(false, true)
  }

  /**
   * 启动自动检查
   */
  startAutoCheck(): void {
    this.stopAutoCheck()

    if (!this.config.autoCheck) {return}

    log.info(`启动自动检查，间隔: ${this.config.checkInterval}ms`)

    // 立即检查一次
    this.checkForUpdates()

    // 设置定时检查
    this.checkTimer = setInterval(() => {
      this.checkForUpdates()
    }, this.config.checkInterval)
  }

  /**
   * 停止自动检查
   */
  stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
      log.info('已停止自动检查')
    }
  }

  /**
   * 销毁服务
   */
  destroy(): void {
    this.stopAutoCheck()
    this.removeAllListeners()
    log.info('更新服务已销毁')
  }
}

/**
 * 发布说明信息类型
 */
interface ReleaseNoteInfo {
  version: string
  note: string
}

/**
 * 设置更新相关的 IPC 处理器
 */
export function setupUpdaterIpcHandlers(updaterService: UpdaterService): void {
  log.info('设置更新 IPC 处理器')

  // 获取更新状态
  ipcMain.handle('updater:getState', () => {
    return updaterService.getState()
  })

  // 获取更新配置
  ipcMain.handle('updater:getConfig', () => {
    return updaterService.getConfig()
  })

  // 更新配置
  ipcMain.handle('updater:updateConfig', (_event, config: Partial<UpdaterConfig>) => {
    updaterService.updateConfig(config)
    return updaterService.getConfig()
  })

  // 检查更新
  ipcMain.handle('updater:checkForUpdates', async () => {
    return updaterService.checkForUpdates()
  })

  // 下载更新
  ipcMain.handle('updater:downloadUpdate', async () => {
    await updaterService.downloadUpdate()
    return updaterService.getState()
  })

  // 安装更新
  ipcMain.handle('updater:installUpdate', () => {
    updaterService.installUpdate()
  })

  // 启动自动检查
  ipcMain.handle('updater:startAutoCheck', () => {
    updaterService.startAutoCheck()
  })

  // 停止自动检查
  ipcMain.handle('updater:stopAutoCheck', () => {
    updaterService.stopAutoCheck()
  })
}
