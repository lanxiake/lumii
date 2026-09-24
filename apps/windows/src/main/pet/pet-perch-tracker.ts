/**
 * pet-perch-tracker — 主窗口矩形推送（主进程）
 *
 * 宠物要"爬到程序主窗口上"，就得知道那个窗口此刻在屏幕上的哪块地方。
 *
 * ## 为什么用窗口事件，而不用轮询
 *
 * 光标追踪（`pet-cursor-tracker`）用的是 33ms 轮询，那是因为**光标不在窗口里时
 * 窗口收不到 mousemove**，只能问系统。窗口位置没有这个问题——Electron 直接给事件。
 *
 * 更关键的是**跟手**：用户拖动主窗口时，宠物应当跟着一起走。250ms 的轮询会让它
 * 一跳一跳地追，而 `move` 事件在拖动期间是连续触发的。
 *
 * ## 推送的是宠物窗口局部坐标
 *
 * 屏幕坐标减去宠物窗口原点。换算放在主进程做，是因为**两边都只有主进程知道**；
 * 留给渲染层换算的话，"宠物窗口在哪"这个知识就要同时存在于主进程和渲染层两处。
 *
 * 与 `pet-cursor-tracker` 同一套约定：进入宠物模式启动、退出即停，
 * 位置没变不发（窗口静止时零流量）。
 */

import type { BrowserWindow } from 'electron'

const log = {
  info: (...args: unknown[]) => console.log('[pet-perch-tracker]', ...args),
}

/** 宠物窗口局部坐标下的矩形 */
export interface PerchRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PerchTrackerDeps {
  /** 推送当前可攀附的矩形；null = 当前没有可爬的目标 */
  send: (rect: PerchRect | null) => void
  getMainWindow: () => BrowserWindow | null
  /** 宠物窗口当前的屏幕原点；返回 null 表示窗口不可用 */
  getPetWindowOrigin: () => { x: number; y: number } | null
}

/**
 * 订阅的事件名。`moved`/`resized` 只在结束时触发一次，拖动过程要 `move`/`resize`。
 *
 * 显式逐个 on/off 而不是遍历数组：Electron 的 `BrowserWindow.on` 是按事件名重载的，
 * 传一个联合类型进去 TypeScript 解不出来（报 "not assignable to will-resize"）。
 */
function bind(win: BrowserWindow, emit: () => void): () => void {
  win.on('move', emit)
  win.on('resize', emit)
  win.on('show', emit)
  win.on('hide', emit)
  win.on('minimize', emit)
  win.on('restore', emit)
  return () => {
    if (win.isDestroyed()) return
    win.removeListener('move', emit)
    win.removeListener('resize', emit)
    win.removeListener('show', emit)
    win.removeListener('hide', emit)
    win.removeListener('minimize', emit)
    win.removeListener('restore', emit)
  }
}

let dispose: (() => void) | null = null
/** 上一次推送出去的内容（或 'none'）。**去重用**，窗口静止时不产生任何流量 */
let lastKey = ''
/** 当前生效的依赖，供 `getCurrentPerchRect` 现算（见该函数的注释） */
let activeDeps: PerchTrackerDeps | null = null

/** 计算当前应当推送的矩形；不可见/最小化时返回 null */
function currentRect(deps: PerchTrackerDeps): PerchRect | null {
  const win = deps.getMainWindow()
  const origin = deps.getPetWindowOrigin()
  if (!win || win.isDestroyed() || !origin) return null
  // 隐藏或最小化的窗口不该是攀附目标：宠物爬上去会显得"浮在空气里"，
  // 因为那块屏幕上并没有东西
  if (!win.isVisible() || win.isMinimized()) return null
  const b = win.getBounds()
  return { x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height }
}

/**
 * 启动推送。重复调用是幂等的（先停旧的再启新的）。
 *
 * 启动时立即推一次——宠物可能是在窗口已经打开着的时候进入宠物模式的，
 * 等下一次 move 才推的话，「主窗口一直没动」就永远收不到。
 */
export function startPerchTracking(deps: PerchTrackerDeps): void {
  stopPerchTracking()

  const emit = (): void => {
    try {
      const rect = currentRect(deps)
      const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : 'none'
      if (key === lastKey) return
      lastKey = key
      deps.send(rect)
    } catch {
      // 推送里抛异常会静默打断后续事件；这里是锦上添花的功能，
      // 不该因为它让宠物窗口或主窗口出问题
    }
  }

  const win = deps.getMainWindow()
  if (!win || win.isDestroyed()) {
    log.info('主窗口不可用，攀附追踪未启动')
    return
  }
  const unbind = bind(win, emit)

  activeDeps = deps
  dispose = () => {
    unbind()
    dispose = null
    activeDeps = null
  }

  emit()
  const r = currentRect(deps)
  log.info(
    `已启动攀附追踪：主窗口 ${r ? `${r.width}×${r.height}@(${Math.round(r.x)},${Math.round(r.y)})` : '(当前不可见，已推 null)'}`,
  )
}

/** 停止推送（退出宠物模式、窗口销毁时调用） */
export function stopPerchTracking(): void {
  dispose?.()
  dispose = null
  activeDeps = null
  lastKey = ''
}

/**
 * 现算一次当前矩形，供渲染层挂载时补问（`PET_IPC.getPerchRect`）。
 *
 * **现算而不是复用 `lastKey` 缓存的那份**：缓存只说明"上次推的是什么"，
 * 而渲染层问的是"现在是什么"。主窗口在这两步之间被拖走的话，回缓存会给出错的位置。
 * 没在推（不在宠物模式）时返回 null。
 */
export function getCurrentPerchRect(): PerchRect | null {
  if (!activeDeps) return null
  try {
    return currentRect(activeDeps)
  } catch {
    return null
  }
}
