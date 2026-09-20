/**
 * pet-cursor-tracker — 全局光标位置轮询（主进程）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-20-宠物自制系统P2-b实施计划.md §3.1 / §3.2
 *
 * ## 为什么必须由主进程轮询
 *
 * 宠物窗口是**全屏透明 + 主进程 setIgnoreMouseEvents 控制穿透**的。光标在角色以外的区域时，
 * 窗口收不到 `mousemove`——而那恰好是"宠物该看向你"的多数时刻。
 *
 * `screen.getCursorScreenPoint()` 拿到的是**光标位置**，不含任何按键内容，
 * 也就不存在"聊天应用偷看输入"的问题（这也是本轮不引全局键盘钩子的理由）。
 *
 * ## 只在需要时跑
 *
 * 30Hz（33ms）是视觉上够用、又不至于持续付 IPC 成本的下限；位置没变时**不发**——
 * 用户不动鼠标时不该有任何流量。退出宠物模式或关掉开关时整个停掉。
 */

import { screen } from 'electron'

const log = {
  info: (...args: unknown[]) => console.log('[pet-cursor-tracker]', ...args),
}

/** 轮询间隔（ms）。33ms ≈ 30Hz */
export const CURSOR_POLL_INTERVAL_MS = 33

export interface CursorTrackerDeps {
  /** 把**宠物窗口内**的 CSS 坐标推给渲染层 */
  send: (x: number, y: number) => void
  /** 宠物窗口当前的屏幕矩形；返回 null 表示窗口不可用（应跳过本轮） */
  getWindowBounds: () => { x: number; y: number } | null
  /** 是否启用（设置项）。返回 false 时停发，但保留定时器——开关随时可能被改回来 */
  isEnabled: () => boolean
}

let timer: ReturnType<typeof setInterval> | null = null
let sentOnce = false
let lastX = Number.NaN
let lastY = Number.NaN

/**
 * 启动轮询。重复调用是幂等的（已在跑就不重开）。
 *
 * 启动时把上次位置清掉：窗口可能刚被移动过，沿用旧坐标会让渲染层拿到一次错位的数据。
 */
export function startCursorTracking(deps: CursorTrackerDeps): void {
  if (timer) return
  sentOnce = false
  lastX = Number.NaN
  lastY = Number.NaN

  timer = setInterval(() => {
    try {
      if (!deps.isEnabled()) return
      const bounds = deps.getWindowBounds()
      if (!bounds) return

      const pt = screen.getCursorScreenPoint()
      // 位置没变不发：用户不动鼠标时不该有任何流量
      if (pt.x === lastX && pt.y === lastY) return
      lastX = pt.x
      lastY = pt.y

      const localX = pt.x - bounds.x
      const localY = pt.y - bounds.y
      if (!sentOnce) {
        sentOnce = true
        log.info(`首条光标事件已推送：屏幕(${pt.x},${pt.y}) → 窗口内(${localX},${localY})，bounds=${bounds.x},${bounds.y}`)
      }
      deps.send(localX, localY)
    } catch {
      // 轮询里抛异常会打断整个定时器；这里吞掉并继续——
      // 注视是锦上添花的功能，绝不该因为它让宠物窗口出问题
    }
  }, CURSOR_POLL_INTERVAL_MS)

  log.info(`已启动光标轮询（${CURSOR_POLL_INTERVAL_MS}ms/次，位置不变时不发）`)
}

/** 停止轮询（退出宠物模式、窗口销毁时调用）。 */
export function stopCursorTracking(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('已停止光标轮询')
  }
  lastX = Number.NaN
  lastY = Number.NaN
}

/** 供测试/诊断：当前是否在跑 */
export function isCursorTracking(): boolean {
  return timer !== null
}

/** 供测试：重置模块状态 */
export function _resetCursorTrackerForTest(): void {
  stopCursorTracking()
}
