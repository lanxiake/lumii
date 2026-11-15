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
import { BrowserWindow, screen } from 'electron'

import { forceForeground } from './foreground.js'

const WIDTH = 720
const HEIGHT = 480

/** 窗口显示时推给渲染层的事件名。与 `ipc.ts` 的 `LISTARY_EVENT.shown` 同值 —— */
/** 这里是反方向（主进程主动推），故不复用那个常量表以免循环依赖。 */
const LISTARY_SHOWN_EVENT = 'ext:com.lumii.listary:shown'

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
   * ## 抢焦点：Windows 前台锁不吃 Electron 的那套
   *
   * 用户 2026-11-15 实测：「输入框中有光标，但是键盘输入还在原来其他窗口上。」
   * 这是 DOM 焦点与 OS 前台焦点不一致 —— `win.focus()` 只保证前者。
   *
   * 实测（`verify/listary-p3/probe-focus-win32.cjs`，msedge 持前台时）：
   * ```
   * show() + focus()                → ❌ 前台仍是 msedge
   * setAlwaysOnTop('screen-saver')  → ❌ 前台仍是 msedge
   * app.focus({ steal: true })      → ❌ 前台仍是 msedge（该选项标注 @platform darwin）
   * ```
   *
   * 有效的是 `forceForeground()`：先用 keybd_event 敲一下 Alt 拿到"最近输入"的所有权，
   * 再 `SetForegroundWindow`（见 `foreground.ts` 顶部说明）。
   *
   * 顺序：先 show（让窗口存在且可见），再抢前台，最后通知渲染层聚焦输入框。
   * 抢失败不阻断后续步骤 —— 至少窗口能显示、鼠标能点。
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

    // 真抢前台。HWND 是 64 位，用 BigInt 读出再转十进制字符串传给 PowerShell。
    const buf = win.getNativeWindowHandle()
    const hwnd = (buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString()
    const stole = await forceForeground(hwnd)

    if (!stole) {
      // Windows 抢不到时的最低保障：至少让它压在别人上面，鼠标能点到
      win.setAlwaysOnTop(true, 'screen-saver')
    }

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
