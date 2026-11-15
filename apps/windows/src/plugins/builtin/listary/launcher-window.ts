/**
 * LauncherWindow — 启动器悬浮窗。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.5
 *
 * 与宠物窗的关键差别：**不要** `setIgnoreMouseEvents` —— 那是点击穿透，宠物窗需要，
 * 启动器窗必须接收鼠标（要能点结果、滚动列表）。
 *
 * 交互约定（对齐启动器惯例）：
 * - 唤起 → 显示 + 居中到**光标所在屏** + 抢焦点
 * - 失焦 → 自动隐藏（不销毁，下次复用；重建窗口会让输入框丢焦点、闪一下）
 * - Esc → 隐藏
 */

import { join } from 'node:path'
import { app, BrowserWindow, screen } from 'electron'

const WIDTH = 720
const HEIGHT = 480

/** 窗口显示时推给渲染层的事件名。与 `ipc.ts` 的 `LISTARY_EVENT.shown` 同值 —— */
/** 这里是反方向（主进程主动推），故不复用那个常量表以免循环依赖。 */
const LISTARY_SHOWN_EVENT = 'ext:com.lumii.listary:shown'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface LauncherWindowDeps {
  preloadPath: string
  rendererUrl?: string
  indexHtmlPath: string
  onVisibilityChange?: (visible: boolean) => void
}

export class LauncherWindow {
  private win: BrowserWindow | null = null
  private ready: Promise<void> | null = null

  constructor(private readonly deps: LauncherWindowDeps) {}

  /** 当前窗口（未创建/已销毁时 null） */
  getWindow(): BrowserWindow | null {
    if (!this.win || this.win.isDestroyed()) return null
    return this.win
  }

  isVisible(): boolean {
    const w = this.getWindow()
    return !!w && w.isVisible()
  }

  /**
   * 显示并聚焦。
   *
   * 居中到**光标所在屏**：多显示器下用户在哪块屏幕干活，启动器就该在哪块弹出来
   *（Listary 也记 `LauncherPositionX/Y`，但那是固定坐标，不如跟随光标合理）。
   *
   * ## 抢焦点为什么要三重兜底
   *
   * Windows 的前台锁定策略（ForegroundLockTimeout）**不允许**后台进程随意抢焦点：
   * - 用户当前光标在别的窗口的输入框里时，`win.focus()` 可能只是让窗口显示但不给焦点，
   *   于是"双击 Ctrl 后没法直接打字"（用户 2026-11-15 实测报的正是这个）
   * - Listary 自己的日志里也有 `ForceForegroundWindow failed`，同一根因
   *
   * 三层依次尝试，任一层成功即止：
   * 1. `show() + focus()`
   * 2. `setAlwaysOnTop(true, 'screen-saver')` 拉高层级后再 focus（能突破部分锁定）
   * 3. `app.focus({ steal: true })`（Electron 给的显式抢焦点开关）
   *
   * 最后再让渲染层自己 `input.focus()`（见 `LauncherApp`），因为**窗口有焦点 ≠ 输入框有焦点**。
   */
  async show(): Promise<void> {
    const win = await this.ensureWindow()
    if (!win || win.isDestroyed()) return

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { x, y, width, height } = display.workArea
    win.setBounds({
      x: x + Math.floor((width - WIDTH) / 2),
      y: y + Math.floor((height - HEIGHT) / 3), // 略偏上，视觉重心更像 Listary
      width: WIDTH,
      height: HEIGHT,
    })

    win.show()
    win.focus()

    if (!win.isFocused()) {
      // 第 2 层：拉高层级
      win.setAlwaysOnTop(true, 'screen-saver')
      win.focus()
      await sleep(60)
    }

    if (!win.isFocused()) {
      // 第 3 层：显式抢焦点
      try {
        app.focus({ steal: true })
        win.focus()
        await sleep(60)
      } catch {
        /* 老版本 Electron 没有 steal，忽略 */
      }
    }

    // 第 2 层拉高了层级，恢复成普通置顶（否则会压住某些全屏应用）
    if (win.isFocused()) win.setAlwaysOnTop(true)
    else win.setAlwaysOnTop(true, 'screen-saver')

    // 让渲染层把焦点放进输入框（窗口有焦点 ≠ 输入框有焦点）
    win.webContents.send(LISTARY_SHOWN_EVENT)

    this.deps.onVisibilityChange?.(true)
  }

  hide(): void {
    const win = this.getWindow()
    if (!win || !win.isVisible()) return
    win.hide()
    this.deps.onVisibilityChange?.(false)
  }

  toggle(): void {
    if (this.isVisible()) this.hide()
    else void this.show()
  }

  dispose(): void {
    const win = this.getWindow()
    this.win = null
    this.ready = null
    if (win) {
      try {
        win.destroy()
      } catch {
        /* 已销毁 */
      }
    }
  }

  private async ensureWindow(): Promise<BrowserWindow | null> {
    const existing = this.getWindow()
    if (existing) return existing
    if (this.ready) {
      await this.ready
      return this.getWindow()
    }
    this.ready = this.create()
    await this.ready
    return this.getWindow()
  }

  private async create(): Promise<void> {
    const win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不透明：启动器要显示列表和文字，透明窗在 Windows 上还会带来"点击穿过空白区"的坑
      transparent: false,
      backgroundColor: '#1f1d1a',
      // 启动器不该有系统菜单（Alt 键会唤出）
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: ['--skip-splash'],
      },
    })

    this.win = win

    // 失焦自动隐藏：启动器的核心交互约定
    win.on('blur', () => {
      if (this.win === win) this.hide()
    })
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null
        this.ready = null
      }
    })

    await this.loadPage(win)
  }

  private async loadPage(win: BrowserWindow): Promise<void> {
    if (this.deps.rendererUrl) {
      const base = this.deps.rendererUrl.replace(/\/$/, '')
      const sep = base.includes('?') ? '&' : '?'
      await win.loadURL(`${base}${sep}mode=listary-launcher`)
      return
    }
    await win.loadFile(this.deps.indexHtmlPath, { query: { mode: 'listary-launcher' } })
  }
}

/** 给启动器窗用的路径辅助（与 file-preview 同源约定） */
export function launcherWindowPaths(): { preloadPath: string; indexHtmlPath: string } {
  return {
    preloadPath: join(__dirname, '../../../preload/index.js'),
    indexHtmlPath: join(__dirname, '../../../renderer/index.html'),
  }
}
