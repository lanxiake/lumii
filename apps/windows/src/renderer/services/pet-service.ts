/**
 * 宠物模式服务 — 封装 window.electronAPI.pet 的薄层
 *
 * 读取类接口失败时返回兜底值（原调用点均为「静默降级」）；
 * 切换模式保留结果对象让调用方处理错误提示。
 */
import type { AppMode, PetModeSwitchResult, PetModelConfigDTO } from '../../shared/pet-mode'

/** 获取虚拟人模型列表（主进程已规范化配置）；失败返回空列表 */
export async function listPetModels(): Promise<readonly PetModelConfigDTO[]> {
  const api = window.electronAPI?.pet
  if (!api) return []
  try {
    return await api.listModels()
  } catch {
    return []
  }
}

/** 获取当前模型 ID；失败返回空串 */
export async function getCurrentPetModelId(): Promise<string> {
  const api = window.electronAPI?.pet
  if (!api) return ''
  try {
    return await api.getCurrentModelId()
  } catch {
    return ''
  }
}

/** 获取当前应用模式；失败返回 null（调用方跳过状态更新） */
export async function getPetMode(): Promise<AppMode | null> {
  const api = window.electronAPI?.pet
  if (!api) return null
  try {
    return await api.getMode()
  } catch {
    return null
  }
}

/** 切换应用模式；接口不可用返回 null，其余结果原样返回由调用方判定 */
export async function switchPetMode(mode: AppMode, modelId?: string): Promise<PetModeSwitchResult | null> {
  const api = window.electronAPI?.pet
  if (!api) return null
  return api.switchMode(mode, modelId)
}

/** 订阅模式变更广播（托盘 / 快捷键 / 控制坞触发），返回取消订阅函数 */
export function subscribePetModeChanged(handler: (mode: unknown) => void): () => void {
  if (!window.electronAPI?.pet) return () => {}
  window.electronAPI.on('pet-mode-changed', handler)
  return () => window.electronAPI.off('pet-mode-changed', handler)
}
