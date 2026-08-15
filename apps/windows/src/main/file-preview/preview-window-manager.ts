/**
 * PreviewWindowManager — 文件预览独立窗口
 *
 * 普通可拖动/缩放窗口（带系统标题栏），无 parent，可移出主窗口外。
 * 渲染入口：?mode=file-preview
 */

import { BrowserWindow, screen } from 'electron'
import type { FilePreviewWindowPayload } from '../../shared/file-preview-window'

const log = {
  info: (...args: unknown[]) => console.log('[PreviewWindow]', ...args),
  warn: (...args: unknown[]) => console.warn('[PreviewWindow]', ...args),
}

export interface PreviewWindowManagerDeps {
  getMainWindow: () => BrowserWindow | null
  preloadPath: string
  rendererUrl?: string
  indexHtmlPath: string
}

/**
 * 管理单个文件预览独立窗口的生命周期
 */
export class PreviewWindowManager {
  private win: BrowserWindow | null = null
  private payload: FilePreviewWindowPayload | null = null

  constructor(private readonly deps: PreviewWindowManagerDeps) {}

  /** 当前预览载荷（供预览窗 renderer 拉取） */
  getPayload(): FilePreviewWindowPayload | null {
    return this.payload
  }

  /**
   * 打开或聚焦预览窗并更新载荷
   */
  async open(payload: FilePreviewWindowPayload): Promise<void> {
    this.payload = payload
    const existing = this.getWindow()
    if (existing) {
      existing.setTitle(payload.fileName || '文件预览')
      existing.focus()
      // 通知已打开的预览窗刷新内容
      existing.webContents.send('file-preview:payload-updated', payload)
      return
    }
    await this.createWindow(payload)
  }

  /** 关闭预览窗 */
  close(): void {
    const w = this.getWindow()
    if (w) {
      w.close()
    }
    this.win = null
    this.payload = null
  }

  /** 取存活窗口 */
  getWindow(): BrowserWindow | null {
    if (!this.win || this.win.isDestroyed()) return null
    return this.win
  }

  /** 创建带系统边框的预览窗 */
  private async createWindow(payload: FilePreviewWindowPayload): Promise<void> {
    const main = this.deps.getMainWindow()
    const display = main
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay()
    const { width: dw, height: dh } = display.workAreaSize
    const width = Math.min(960, Math.floor(dw * 0.7))
    const height = Math.min(780, Math.floor(dh * 0.8))
    const x = display.workArea.x + Math.floor((display.workArea.width - width) / 2)
    const y = display.workArea.y + Math.floor((display.workArea.height - height) / 2)

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth: 480,
      minHeight: 360,
      title: payload.fileName || '文件预览',
      show: false,
      autoHideMenuBar: true,
      // 系统标题栏：便于拖出主窗、原生缩放
      frame: true,
      backgroundColor: '#f7f4ef',
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        // 独立预览窗不播开机动画（early-splash 亦按 mode=file-preview 跳过）
        additionalArguments: ['--skip-splash'],
      },
    })

    this.win = win
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.payload = null
      }
    })

    win.once('ready-to-show', () => {
      win.show()
      win.focus()
    })

    await this.loadPreviewPage(win)
    log.info(`opened file=${payload.fileName}`)
  }

  /** 加载 ?mode=file-preview 渲染页 */
  private async loadPreviewPage(win: BrowserWindow): Promise<void> {
    if (this.deps.rendererUrl) {
      const base = this.deps.rendererUrl.replace(/\/$/, '')
      const sep = base.includes('?') ? '&' : '?'
      await win.loadURL(`${base}${sep}mode=file-preview`)
      return
    }
    await win.loadFile(this.deps.indexHtmlPath, { query: { mode: 'file-preview' } })
  }
}
