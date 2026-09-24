/**
 * pet-mode-ipc - 宠物模式 IPC 注册
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/03-接口与协议设计.md §2
 *
 * 注册 pet:* 命名空间的所有 handler，转发到 PetWindowManager。
 * 切换耗时计入可观测性指标 pet_mode_switch_duration_ms，并打印
 *   [pet] mode:switch desktop→pet durationMs=xxx 日志（验收项）。
 */

import { ipcMain, globalShortcut, powerMonitor, type BrowserWindow } from 'electron'
import {
  type AppMode,
  type PetHoverUpdate,
  type PetIdleEvent,
  type PetModeSwitchResult,
  type PetPerchEvent,
  PET_IPC,
} from '../../shared/pet-mode'
import { PetWindowManager, type PetWindowManagerDeps } from './pet-window-manager'
import { startPerchTracking, stopPerchTracking, getCurrentPerchRect } from './pet-perch-tracker'
import { startIdleWatching, stopIdleWatching, getCurrentIdleStage } from './idle-watcher'
import {
  getStoredModelId,
  getVirtualHumanSettings,
  setVirtualHumanSettings,
} from './pet-mode-store'
import type { VirtualHumanSettingsDTO } from '../../shared/virtual-human'

const log = {
  info: (...args: unknown[]) => console.log('[pet]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet]', ...args),
  error: (...args: unknown[]) => console.error('[pet]', ...args),
}

/** 全局快捷键：切换宠物/桌面模式 */
const SHORTCUT_TOGGLE_PET_MODE = 'CommandOrControl+Shift+P'
/** 全局快捷键：切换强制穿透（穿透开启时无法用鼠标点按钮，必须用此快捷键关闭） */
const SHORTCUT_TOGGLE_FORCE_IGNORE = 'CommandOrControl+Shift+I'

let petWindowManager: PetWindowManager | null = null

/** 虚拟人设置变更监听器集合（供 agent-runtime 等模块响应 proactiveCare* 变更，避免循环依赖） */
const vhSettingsChangeListeners = new Set<
  (settings: VirtualHumanSettingsDTO, patch: Partial<VirtualHumanSettingsDTO>) => void
>()

/**
 * 订阅虚拟人设置变更（每次 setVirtualHumanSettings 成功后触发）
 * @returns 取消订阅函数
 */
export function onVirtualHumanSettingsChanged(
  listener: (settings: VirtualHumanSettingsDTO, patch: Partial<VirtualHumanSettingsDTO>) => void,
): () => void {
  vhSettingsChangeListeners.add(listener)
  return () => vhSettingsChangeListeners.delete(listener)
}

/** 暴露给主进程其他模块（托盘菜单/快捷键）触发切换 */
export function getPetWindowManager(): PetWindowManager | null {
  return petWindowManager
}

/** 关闭强制穿透（托盘菜单用） */
export function disablePetForceIgnore(): void {
  petWindowManager?.disableForceIgnoreMouse()
}

/** 当前是否处于强制穿透 */
export function isPetForceIgnore(): boolean {
  return petWindowManager?.isForceIgnore() ?? false
}

/**
 * 执行模式切换并计时。供 IPC handler、托盘菜单、全局快捷键共用。
 */
export async function switchPetMode(
  mode: AppMode,
  modelId?: string,
): Promise<PetModeSwitchResult> {
  if (!petWindowManager) {
    return { success: false, mode, error: 'PetWindowManager 未初始化', durationMs: 0 }
  }

  const from = petWindowManager.getMode()
  if (from === mode) {
    // 已经在目标模式里，但**顺手换个模型**要放行：否则「宠物模式下切换模型」会静默
    // 什么都不做（只有 durationMs: 0，零日志），CLI / 智能体调过来会以为成功了。
    if (mode === 'pet' && modelId && modelId !== petWindowManager.getCurrentModelId()) {
      const startedAt = Date.now()
      petWindowManager.setCurrentModelId(modelId, true)
      const durationMs = Date.now() - startedAt
      log.info(`model:switch ${modelId} durationMs=${durationMs}（已在宠物模式，只换模型）`)
      return { success: true, mode, durationMs }
    }
    return { success: true, mode, durationMs: 0 }
  }

  const startedAt = Date.now()
  try {
    if (mode === 'pet') {
      await petWindowManager.enterPetMode(modelId)
      startIdleWatchingIfNeeded()
      startPerchTrackingIfNeeded()
    } else {
      await petWindowManager.exitPetMode()
      // 退出就停：闲置感知、攀附目标只在宠物模式里有意义，别让它们白跑
      stopIdleWatching()
      stopPerchTracking()
    }
    const durationMs = Date.now() - startedAt
    log.info(`mode:switch ${from}→${mode} durationMs=${durationMs}`)
    return { success: true, mode, durationMs }
  } catch (err) {
    const durationMs = Date.now() - startedAt
    const message = err instanceof Error ? err.message : String(err)
    log.error(`mode:switch ${from}→${mode} 失败: ${message}`)
    return { success: false, mode: from, error: message, durationMs }
  }
}

/**
 * 启动攀附目标追踪（主窗口矩形）。
 *
 * 与光标/闲置两条链路不同，这条**没有开关**：它不是"感知用户"而是"知道有什么东西可爬"，
 * 关掉它就只是让宠物少一种行为，没有隐私或打扰上的收益。模型没有 Climb/Crawl 组时，
 * 渲染层自己会忽略这个矩形（见 `perch` 的能力探测）。
 */
function startPerchTrackingIfNeeded(): void {
  startPerchTracking({
    getMainWindow: () => petWindowManager?.getMainWindow() ?? null,
    getPetWindowOrigin: () => {
      const win = petWindowManager?.getPetBrowserWindow()
      if (!win || win.isDestroyed()) return null
      const b = win.getBounds()
      return { x: b.x, y: b.y }
    },
    send: (rect) => {
      const win = petWindowManager?.getPetBrowserWindow()
      if (!win || win.isDestroyed()) return
      const evt: PetPerchEvent = { type: 'pet:perch', rect }
      win.webContents.send(PET_IPC.evtPerch, evt)
    },
  })
}

/**
 * 启动闲置轮询（打盹/睡着）。
 *
 * 与光标轮询同一套约定：`isEnabled` 每轮现读设置（开关改了不必重启轮询），
 * 退出宠物模式即整个停掉。
 *
 * 闲置秒数走**注入**而不是在 watcher 里 import `powerMonitor`：那样 watcher 就是
 * 纯计时逻辑，单测不必 mock Electron（真值只有这一处读）。
 */
function startIdleWatchingIfNeeded(): void {
  startIdleWatching({
    getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    isEnabled: () => getVirtualHumanSettings().enableIdleAwareness,
    send: (stage) => {
      const win = petWindowManager?.getPetBrowserWindow()
      if (!win || win.isDestroyed()) return
      const evt: PetIdleEvent = { type: 'pet:idle', stage }
      win.webContents.send(PET_IPC.evtIdle, evt)
    },
  })
}

/**
 * 注册宠物模式 IPC + 全局快捷键。
 * 在 main/index.ts 的 createWindow() 之后调用。
 *
 * **Linux 上直接不注册**（D13：宠物模式屏蔽，后续以精灵图形态重写）。
 * 按设计 §7「屏蔽必须发生在入口层，被屏蔽功能的主进程初始化代码直接不执行」——
 * 若只把 UI 置灰而这里照常建 PetWindowManager，会留下半初始化状态
 * （窗口创建到一半、全局快捷键已占用、托盘监听残留），将来重写精灵图版时
 * 还要先清理这些。**入口层屏蔽 + 命令层兜底**（switchPetMode 会报
 * 「PetWindowManager 未初始化」）两层都保留。
 */
/**
 * 已经挂了 focus/blur 的主窗。用 WeakSet 去重：本函数只在注册时调一次，
 * 但主窗重建时会拿到新对象——那时应该重新挂。
 */
const focusBoundWindows = new WeakSet<BrowserWindow>()

/**
 * 把主窗的焦点变化转给宠物窗口（`PET_IPC.evtMainWindowFocus`）。
 *
 * **为什么宠物窗自己问不到**：它常驻置顶、覆盖整个工作区，`document.hasFocus()`
 * 回答的是**它自己**的焦点，与"用户有没有在看那个会话"完全是两回事。
 *
 * 用在通知（R6）的两条判据上：`turn:end` 的「用户发起后走开了」升级为 `report`、
 * `file-changes` 的「主窗失焦且用户没参与」才补一句。
 *
 * 挂在注册时（而不是主窗创建处）：`createMainWindow` 在 `registerPetModeIpc` 之前跑，
 * 这里一定拿得到主窗。没拿到就安静跳过——通知会退化成"少叫两次"，不会出错。
 */
function startMainWindowFocusBroadcast(): void {
  const mainWin = petWindowManager?.getMainWindow()
  if (!mainWin || mainWin.isDestroyed()) {
    log.warn('[mainWindowFocus] 拿不到主窗口，焦点广播未启用（通知的 report 档会少两条判据）')
    return
  }
  if (focusBoundWindows.has(mainWin)) return
  focusBoundWindows.add(mainWin)

  const send = (focused: boolean): void => {
    const petWin = petWindowManager?.getPetBrowserWindow()
    if (!petWin || petWin.isDestroyed()) return
    try {
      petWin.webContents.send(PET_IPC.evtMainWindowFocus, {
        type: 'pet:main-window-focus',
        focused,
      })
    } catch {
      /* 窗口正在销毁：丢掉这一帧，下次状态变化还会推 */
    }
  }
  mainWin.on('focus', () => send(true))
  mainWin.on('blur', () => send(false))
  log.info('[mainWindowFocus] 已开始把主窗焦点变化转给宠物窗口')
}

export function registerPetModeIpc(deps: PetWindowManagerDeps): void {
  if (process.platform === 'linux') {
    log.info('Linux 平台不注册宠物模式（D13：后续以精灵图形态重写）')
    return
  }

  if (petWindowManager) {
    log.warn('registerPetModeIpc 已注册，跳过')
    return
  }
  petWindowManager = new PetWindowManager(deps)
  startMainWindowFocusBroadcast()
  // 从 store 恢复持久化的模型 ID（重启后保留选择）
  const storedModelId = getStoredModelId()
  if (storedModelId) petWindowManager.setCurrentModelId(storedModelId)
  log.info(`PetWindowManager 已创建，恢复模型 ID=${storedModelId || '(默认)'}`)

  // 切换模式
  ipcMain.handle(PET_IPC.switchMode, async (_evt, mode: AppMode, modelId?: string) => {
    return switchPetMode(mode, modelId)
  })

  // 获取当前模式
  ipcMain.handle(PET_IPC.getMode, () => petWindowManager?.getMode() ?? 'desktop')

  // 渲染就绪握手
  ipcMain.handle(PET_IPC.rendererReady, (_evt, targetMode: AppMode) => {
    petWindowManager?.notifyRendererReady(targetMode)
  })

  // hover 报告（遗留）
  ipcMain.on(PET_IPC.reportHover, (_evt, update: PetHoverUpdate) => {
    petWindowManager?.reportHover(update)
  })

  // 强制穿透切换
  ipcMain.handle(PET_IPC.toggleForceIgnoreMouse, () => {
    return petWindowManager?.toggleForceIgnoreMouse() ?? false
  })

  // 模型 ID 读写（同步持久化到 store，重启后保留）
  ipcMain.handle(PET_IPC.getCurrentModelId, () => petWindowManager?.getCurrentModelId() ?? '')
  ipcMain.handle(PET_IPC.setCurrentModelId, (_evt, modelId: string) => {
    petWindowManager?.setCurrentModelId(modelId, true)
  })

  // 当前闲置阶段（渲染层挂载时补问一次，见 idle-watcher 的 getCurrentIdleStage）
  ipcMain.handle(PET_IPC.getIdleStage, () => getCurrentIdleStage() ?? 'awake')

  // 当前可攀附矩形（渲染层挂载时补问一次，见 pet-perch-tracker 的 getCurrentPerchRect）
  ipcMain.handle(PET_IPC.getPerchRect, () => getCurrentPerchRect())

  // 模型注册表
  ipcMain.handle(PET_IPC.listModels, async () => {
    const { loadPetModelRegistry } = await import('./pet-model-resolver')
    const { models } = await loadPetModelRegistry()
    return models
  })
  ipcMain.handle(PET_IPC.getModelConfig, async (_evt, modelId: string) => {
    const { getPetModelConfig } = await import('./pet-model-resolver')
    return getPetModelConfig(modelId)
  })

  // 会话跟随：主窗口同步 currentSessionKey，宠物窗口读取
  ipcMain.handle(PET_IPC.setActiveSessionKey, (_evt, sessionKey: string) => {
    petWindowManager?.setActiveSessionKey(sessionKey)
  })
  ipcMain.handle(PET_IPC.getActiveSessionKey, () => petWindowManager?.getActiveSessionKey() ?? '')

  /**
   * 宠物窗口请主窗口切到某个会话（控制坞的多会话清单点一条）。
   *
   * 会话状态在主窗口的 agent-runtime 里，宠物窗自己切不了，所以这里只做两件事：
   * 把主窗带到前台 + 把 `app-ui:goto`（带 sessionKey）发过去。
   * **不在这里直接改会话**——主进程没有会话状态，硬改就是两份真相。
   */
  ipcMain.handle(PET_IPC.focusSession, (_evt, sessionKey: string) => {
    const win = petWindowManager?.getMainWindow()
    if (!win || win.isDestroyed() || !sessionKey) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents.send('app-ui:goto', { view: 'chat', sessionKey })
  })

  /**
   * 宠物窗口请主窗**聚焦到某条待办**（通知气泡 / 控制坞条目上的按钮）。
   *
   * 与 `focusSession` 同样只做转发：**主进程不持有通知状态**（会话与待办的真相都在
   * 渲染层），它只多带一个 `requestId`，让主窗把那张审批卡滚进视野并高亮。
   * 卡不在了（用户刚在主窗处置过）由渲染层安静降级为"只切会话"。
   */
  ipcMain.handle(
    PET_IPC.focusNotice,
    (_evt, payload: { sessionKey?: string; requestId?: string } | undefined) => {
      const win = petWindowManager?.getMainWindow()
      const sessionKey = payload?.sessionKey
      if (!win || win.isDestroyed() || !sessionKey) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      win.webContents.send('app-ui:goto', {
        view: 'chat',
        sessionKey,
        ...(payload?.requestId ? { focusPermissionRequestId: payload.requestId } : {}),
      })
    },
  )

  // 读当前实际生效的穿透状态（诊断/验证用，见 PET_IPC.getMouseIgnoreState 的注释）
  ipcMain.handle(PET_IPC.getMouseIgnoreState, () =>
    petWindowManager?.getMouseIgnoreState() ?? { clickable: false, components: [] },
  )

  /**
   * 补问一次主窗焦点（挂载时用）。
   *
   * 与 `getIdleStage` / `getPerchRect` / `getCurrentModelId` 同一族问题：
   * 主进程只在**变化时**推，而宠物窗口挂载的那一刻主窗可能早就失焦了——那次推送是丢的。
   * 不补问的话，"用户走开了"这个判据会一直按"在看"算。
   */
  ipcMain.handle(PET_IPC.getMainWindowFocus, () => {
    const win = petWindowManager?.getMainWindow()
    return Boolean(win && !win.isDestroyed() && win.isFocused())
  })

  ipcMain.handle(PET_IPC.getCubismCoreUrl, async () => {
    const { resolveCubismCoreUrl } = await import('./pet-model-resolver')
    return resolveCubismCoreUrl()
  })

  // 虚拟人设置持久化（主进程 store ↔ 渲染层设置页）
  ipcMain.handle(PET_IPC.getVirtualHumanSettings, () => getVirtualHumanSettings())
  ipcMain.handle(
    PET_IPC.setVirtualHumanSettings,
    (_evt, patch: Partial<import('../../shared/virtual-human').VirtualHumanSettingsDTO>) => {
      const merged = setVirtualHumanSettings(patch)
      // 穿透默认值变更：宠物模式运行中时立即生效（setForceIgnoreMouse 已含持久化，此处不重复写）
      if (
        patch.forceIgnoreMouse !== undefined
        && petWindowManager?.getMode() === 'pet'
      ) {
        petWindowManager.setForceIgnoreMouse(patch.forceIgnoreMouse, false)
      }
      // 其他设置变更（待机动作/点击控制/声音等）：推送宠物窗口即时生效，无需重启宠物模式
      if (petWindowManager?.getMode() === 'pet') {
        petWindowManager.broadcastVhSettingsChanged(patch)
      }
      // 通知订阅者（如主动联系 cron job 同步），避免 pet-mode-ipc 直接依赖 agent-runtime
      for (const listener of vhSettingsChangeListeners) {
        try {
          listener(merged, patch)
        } catch (err) {
          log.warn(`vhSettings 变更监听器执行失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return merged
    },
  )

  // 文字输入聚焦/失焦时临时切换窗口键盘焦点
  ipcMain.handle(PET_IPC.setFocusable, (_evt, focusable: boolean) => {
    petWindowManager?.setFocusable(focusable)
  })

  // 激活会话的虚拟人 Prompt 上下文（文字发送前调用，确保表情/persona 注入；语音 startCall 已自带激活）
  ipcMain.handle(PET_IPC.activateVirtualHumanContext, async (_evt, sessionKey: string) => {
    const { activateVirtualHumanContextForSession } = await import('./virtual-human-context')
    await activateVirtualHumanContextForSession(sessionKey)
  })

  // 渲染层获取模型可触发动作映射（tag → 动作组/index），用于播放 [motion:tag]
  ipcMain.handle(PET_IPC.getModelMotionActions, async (_evt, modelId: string) => {
    const { getPetModelConfig, resolveModelMotionActions } = await import('./pet-model-resolver')
    const config = await getPetModelConfig(modelId)
    if (!config) return []
    const actions = await resolveModelMotionActions(config)
    return actions.map((a) => ({ tag: a.tag, group: a.group, index: a.index }))
  })

  /**
   * 宠物人格标签。**首次调用 = 出生抽签**（惰性初始化在 PersonalityTracker 里），
   * 抽签结果落 `personality_state['pet:<模型ID>']`，此后不再重掷。
   *
   * 惰性 import agent-runtime：pet 这一层不该在启动期就拽起整个运行时，
   * 而且 bridge 未就绪时它会返回 null，渲染层按「暂时读不到」处理。
   */
  ipcMain.handle(PET_IPC.getPetPersonality, async (_evt, configId: string) => {
    try {
      const { getPetPersonalityLabel } = await import('../agent-runtime/pet-personality')
      return await getPetPersonalityLabel(configId)
    } catch (err) {
      log.warn(`getPetPersonality 失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  /**
   * 「让它去做」这三条（五期 T5.1/T5.7/T5.8）与人格那条同一手法：**惰性 import**
   * agent-runtime。理由也一样——pet 这一层不该在启动期就把整个运行时拽起来，
   * 而且 bridge 未就绪时它们返回 `null` / 一句"还没准备好"，渲染层照常显示，
   * 不必为一个可能永远用不上的功能付启动成本。
   *
   * ⚠ 受理判断（单飞锁 / 日闸门 / 能力边界）**全在主进程做**，渲染层只负责把
   * 用户那句话递进来、把 `reason` 说出来。判断只能有一份——两份迟早漂移，
   * 而漂移的后果是"按钮说可以、派发侧说不行"。
   */
  ipcMain.handle(PET_IPC.petTaskCreate, async (_evt, text: string) => {
    try {
      const { createPetTask } = await import('../agent-runtime/pet-task-service')
      return await createPetTask(typeof text === 'string' ? text : '')
    } catch (err) {
      log.warn(`petTaskCreate 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, reason: '我这边出了点岔子，等一下再试？' }
    }
  })

  ipcMain.handle(PET_IPC.petTaskState, async () => {
    try {
      const { getPetTaskState } = await import('../agent-runtime/pet-task-service')
      return getPetTaskState()
    } catch (err) {
      log.warn(`petTaskState 失败: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  })

  ipcMain.handle(PET_IPC.petTaskMarkRead, async () => {
    try {
      const { markPetTaskRead } = await import('../agent-runtime/pet-task-service')
      markPetTaskRead()
    } catch (err) {
      log.warn(`petTaskMarkRead 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  /**
   * 「转给主助手」（五期 T5.8）。
   *
   * 主进程只做两件事：把那段话**拼成句**、发给主窗。**真正送出去的是主窗**——
   * 会话状态与 agent-runtime 都在渲染层那一侧，主进程没有会话，
   * 硬发就是两份真相（与 `focusSession` 同一条纪律）。
   *
   * 与 `focusSession` / `focusNotice` 的差别只有载荷：那两条送的是"去哪"，
   * 这条送的是"说什么"。三者都带主窗到前台，因为用户按的是一个"请你处理"的按钮。
   */
  ipcMain.handle(
    PET_IPC.petHandoffToMain,
    async (_evt, payload: { description?: string; text?: string } | undefined) => {
      const win = petWindowManager?.getMainWindow()
      const text = payload?.text?.trim()
      if (!win || win.isDestroyed() || !text) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      const { buildPetHandoffText } = await import('../agent-runtime/pet-task-service')
      const composed = buildPetHandoffText({ description: payload?.description?.trim() || '一件事', text })
      log.info(`[petHandoffToMain] 交给主助手: ${composed.slice(0, 60)}`)
      win.webContents.send(PET_IPC.evtMainHandoff, composed)
    },
  )

  // 全局快捷键：Ctrl+Shift+P 切换宠物/桌面模式
  try {
    const okPet = globalShortcut.register(SHORTCUT_TOGGLE_PET_MODE, () => {
      const next: AppMode = petWindowManager?.getMode() === 'pet' ? 'desktop' : 'pet'
      void switchPetMode(next)
    })
    if (!okPet) log.warn(`全局快捷键 ${SHORTCUT_TOGGLE_PET_MODE} 注册失败（可能被占用）`)
    else log.info(`全局快捷键 ${SHORTCUT_TOGGLE_PET_MODE} 已注册`)
  } catch (err) {
    log.warn(`全局快捷键注册异常: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 全局快捷键：Ctrl+Shift+I 切换强制穿透（穿透模式下无法用鼠标操作按钮时的兜底）
  try {
    const okIgnore = globalShortcut.register(SHORTCUT_TOGGLE_FORCE_IGNORE, () => {
      if (petWindowManager?.getMode() !== 'pet') return
      petWindowManager.toggleForceIgnoreMouse()
    })
    if (!okIgnore) log.warn(`全局快捷键 ${SHORTCUT_TOGGLE_FORCE_IGNORE} 注册失败（可能被占用）`)
    else log.info(`全局快捷键 ${SHORTCUT_TOGGLE_FORCE_IGNORE} 已注册`)
  } catch (err) {
    log.warn(`强制穿透快捷键注册异常: ${err instanceof Error ? err.message : String(err)}`)
  }

  log.info('宠物模式 IPC 已注册')
}

/** 应用退出时清理（注销快捷键 + 停轮询 + 销毁宠物窗口） */
export function disposePetModeIpc(): void {
  try {
    globalShortcut.unregister(SHORTCUT_TOGGLE_PET_MODE)
    globalShortcut.unregister(SHORTCUT_TOGGLE_FORCE_IGNORE)
  } catch {
    // 忽略
  }
  // 轮询都停掉：进程退出时会一起没，但这里是文档化的清理入口，
  // 将来若有别的调用方（如重载宠物子系统）复用它会指望这里收干净。
  stopIdleWatching()
  stopPerchTracking()
  petWindowManager?.dispose()
  petWindowManager = null
}

/** 供托盘菜单显示当前状态用 */
export function isPetMode(): boolean {
  return petWindowManager?.getMode() === 'pet'
}
