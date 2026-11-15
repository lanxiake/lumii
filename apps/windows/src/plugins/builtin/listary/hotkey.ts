/**
 * 唤起方式 — 双击 Ctrl（低层键盘钩子）+ 组合键兜底。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §3.3
 * P0 实测：`verify/listary-p0/hook-spike.cjs`（20 项全过）
 *
 * ## 为什么必须用钩子
 *
 * Electron 的 `globalShortcut` 注册的是**组合键**，捕获不了"Ctrl 被按了两次"这种时序模式。
 * 双击 Ctrl 只能走低层键盘钩子（Listary 也是这么做的：`Hooks\ListaryHook*.dll`）。
 *
 * ## 双击判定：为什么不是"两次 Ctrl 之间没别的键"
 *
 * `Ctrl+C` 的序列是 `Ctrl↓ C↓ C↑ Ctrl↑` —— C 夹在 **Ctrl 的按下与松开之间**，
 * 不在两次 Ctrl 的**松开**之间。若只看"两次松开之间"，`Ctrl+C` 收尾的 `Ctrl↑`
 * 会被当成一次干净点击，于是 100ms 内再按 `Ctrl`（例如紧接着 `Ctrl+V`）就会误弹启动器。
 *
 * P0 第一版就是这么写的，被实测打脸。正确判据是「**一次 Ctrl 按住期间没夹别的键**」。
 * 代价：`Ctrl+C` 之后必须重新连按两次才能唤起。这个代价可接受，误弹不可接受。
 *
 * ## 兜底
 *
 * 钩子是原生模块 + 会被安全软件盯上的技术特征，可能加载失败或被拦。
 * 故组合键（默认 `Ctrl+Shift+Space`）**同期实现**，二者收敛到同一个 `toggle()`。
 * 当前生效方式要能报给 UI —— 用户得知道为什么双击没反应。
 */

import { globalShortcut } from 'electron'

/** libuiohook 的键码（与 `UiohookKey.Ctrl`/`CtrlRight` 一致，P0 实测确认） */
const CTRL_CODES = new Set([29, 3613])

/** 双击间隔上限（ms）。超过就当成两次独立的单按。 */
export const DOUBLE_PRESS_MS = 400

/** 兜底组合键 */
export const FALLBACK_ACCELERATOR = 'Control+Shift+Space'

/** 当前生效的唤起方式 */
export type HotkeyMode = 'double-ctrl' | 'accelerator' | 'none'

export interface HotkeyStatus {
  mode: HotkeyMode
  /** 钩子为何不可用（mode 非 double-ctrl 时给出原因） */
  reason?: string
  /** 兜底组合键是否注册成功 */
  acceleratorOk: boolean
}

/**
 * 双击判定器。
 *
 * 学习期不需要追加状态就能工作：整个判定只依赖两个标志
 *（`ctrlHeld` / `heldDirty`）与上次松开的时刻。
 */
export function createDoubleCtrlDetector(options: {
  thresholdMs?: number
  now?: () => number
  onTrigger: () => void
}): { keydown: (code: number) => void; keyup: (code: number) => void; reset: () => void } {
  const threshold = options.thresholdMs ?? DOUBLE_PRESS_MS
  const now = options.now ?? (() => Date.now())

  let lastUpAt = 0
  let ctrlHeld = false
  let heldDirty = false

  return {
    keydown(code: number): void {
      if (CTRL_CODES.has(code)) {
        ctrlHeld = true
        heldDirty = false
      } else if (ctrlHeld) {
        // Ctrl 被当修饰键用了（Ctrl+C / Ctrl+V ...）
        heldDirty = true
      }
    },
    keyup(code: number): void {
      if (!CTRL_CODES.has(code)) return
      const t = now()
      if (heldDirty) {
        // 修饰键用法：作废待配对的点击，不把它当成"第一次"
        lastUpAt = 0
      } else if (lastUpAt !== 0 && t - lastUpAt < threshold) {
        lastUpAt = 0 // 触发后重置，三连击不会变成两次触发
        options.onTrigger()
      } else {
        lastUpAt = t
      }
      ctrlHeld = false
      heldDirty = false
    },
    reset(): void {
      lastUpAt = 0
      ctrlHeld = false
      heldDirty = false
    },
  }
}

interface UiohookModule {
  uIOhook: {
    on(event: 'keydown' | 'keyup', cb: (e: { keycode: number }) => void): void
    start(): void
    stop(): void
    removeAllListeners?(event?: string): void
  }
}

/** 当前挂上的钩子实例（用于 dispose） */
let activeHook: UiohookModule['uIOhook'] | null = null
let activeDetector: ReturnType<typeof createDoubleCtrlDetector> | null = null

/**
 * 启动唤起监听。
 *
 * 顺序：先试钩子；钩子失败则退回组合键。**两者不会同时生效**（同时生效会导致一次双击弹两次）。
 */
export function startHotkey(options: {
  onTrigger: () => void
  accelerator?: string
  logger?: { info(msg: string): void; warn(msg: string): void }
}): HotkeyStatus {
  const log = options.logger
  const onTrigger = options.onTrigger
  const accelerator = options.accelerator ?? FALLBACK_ACCELERATOR

  // ── 主路径：双击 Ctrl ──
  let hookReason: string | undefined
  try {
    // 动态 require：钩子是原生模块，加载失败要能被 catch 住而不是让整个插件挂掉
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('uiohook-napi') as UiohookModule
    const detector = createDoubleCtrlDetector({ onTrigger })
    mod.uIOhook.on('keydown', (e) => detector.keydown(e.keycode))
    mod.uIOhook.on('keyup', (e) => detector.keyup(e.keycode))
    mod.uIOhook.start()

    activeHook = mod.uIOhook
    activeDetector = detector
    log?.info(`唤起方式：双击 Ctrl（uiohook-napi 已启动）`)
    return { mode: 'double-ctrl', acceleratorOk: false }
  } catch (err) {
    hookReason = err instanceof Error ? err.message : String(err)
    log?.warn(`键盘钩子不可用，回退组合键：${hookReason}`)
  }

  // ── 兜底：组合键 ──
  let acceleratorOk = false
  try {
    acceleratorOk = globalShortcut.register(accelerator, onTrigger)
    if (acceleratorOk) log?.info(`唤起方式：${accelerator}（组合键兜底）`)
    else log?.warn(`${accelerator} 注册失败（可能被占用），启动器将无法唤起`)
  } catch (err) {
    log?.warn(`组合键注册异常：${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    mode: acceleratorOk ? 'accelerator' : 'none',
    reason: hookReason,
    acceleratorOk,
  }
}

/** 停止唤起监听并释放资源。插件被禁用/应用退出时调。 */
export function stopHotkey(): void {
  try {
    activeHook?.stop()
    activeHook?.removeAllListeners?.()
  } catch {
    /* 停不掉就算了，进程退出会一起没 */
  }
  activeHook = null
  activeDetector = null
  try {
    globalShortcut.unregister(FALLBACK_ACCELERATOR)
  } catch {
    /* 同上 */
  }
}

/** 测试用：拿到当前判定器 */
export function _activeDetector(): ReturnType<typeof createDoubleCtrlDetector> | null {
  return activeDetector
}
