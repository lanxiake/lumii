/**
 * pet-mode-ipc - 宠物模式 IPC 注册
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/03-接口与协议设计.md §2
 *
 * 注册 pet:* 命名空间的所有 handler，转发到 PetWindowManager。
 * 切换耗时计入可观测性指标 pet_mode_switch_duration_ms，并打印
 *   [pet] mode:switch desktop→pet durationMs=xxx 日志（验收项）。
 */

import { ipcMain, globalShortcut } from 'electron'
import {
  type AppMode,
  type PetClickRegion,
  type PetHoverUpdate,
  type PetModeSwitchResult,
  PET_IPC,
} from '../../shared/pet-mode'
import { PetWindowManager, type PetWindowManagerDeps } from './pet-window-manager'
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
    return { success: true, mode, durationMs: 0 }
  }

  const startedAt = Date.now()
  try {
    if (mode === 'pet') {
      await petWindowManager.enterPetMode(modelId)
    } else {
      await petWindowManager.exitPetMode()
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
 * 注册宠物模式 IPC + 全局快捷键。
 * 在 main/index.ts 的 createWindow() 之后调用。
 */
export function registerPetModeIpc(deps: PetWindowManagerDeps): void {
  if (petWindowManager) {
    log.warn('registerPetModeIpc 已注册，跳过')
    return
  }
  petWindowManager = new PetWindowManager(deps)
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

  // 可点击区域矩形（setShape 区域穿透）
  ipcMain.on(PET_IPC.updateClickRegion, (_evt, region: PetClickRegion) => {
    petWindowManager?.updateClickRegion(region)
  })

  // 强制穿透切换 / 查询
  ipcMain.handle(PET_IPC.toggleForceIgnoreMouse, () => {
    return petWindowManager?.toggleForceIgnoreMouse() ?? false
  })
  ipcMain.handle(PET_IPC.getForceIgnoreMouse, () => {
    return petWindowManager?.isForceIgnore() ?? false
  })

  // 模型 ID 读写（同步持久化到 store，重启后保留）
  ipcMain.handle(PET_IPC.getCurrentModelId, () => petWindowManager?.getCurrentModelId() ?? '')
  ipcMain.handle(PET_IPC.setCurrentModelId, (_evt, modelId: string) => {
    petWindowManager?.setCurrentModelId(modelId, true)
  })

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

/** 应用退出时清理（注销快捷键 + 销毁宠物窗口） */
export function disposePetModeIpc(): void {
  try {
    globalShortcut.unregister(SHORTCUT_TOGGLE_PET_MODE)
    globalShortcut.unregister(SHORTCUT_TOGGLE_FORCE_IGNORE)
  } catch {
    // 忽略
  }
  petWindowManager?.dispose()
  petWindowManager = null
}

/** 供托盘菜单显示当前状态用 */
export function isPetMode(): boolean {
  return petWindowManager?.getMode() === 'pet'
}
