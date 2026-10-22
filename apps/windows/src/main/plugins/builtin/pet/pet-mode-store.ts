/**
 * pet-mode-store - 宠物模式持久化存储（主进程）
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/06-宠物模式设置与Prompt注入设计.md §8.1
 *           07 号计划 §2.1 (4.5)、08 号 B-5
 *
 * 持久化 currentModelId + 虚拟人设置到 userData/pet-mode-store.json。
 * 渲染层设置页通过 IPC get/setVirtualHumanSettings 读写，避免仅 localStorage
 * 与主进程模型 ID 不同步（B-5）。同步读写（数据量极小），失败容错为默认值。
 */

import { app } from 'electron'
import { join } from 'node:path'
import fs from 'node:fs'
import {
  type VirtualHumanSettingsDTO,
  DEFAULT_VH_SETTINGS,
} from '../../shared/virtual-human'

const log = {
  info: (...args: unknown[]) => console.log('[pet-mode-store]', ...args),
  warn: (...args: unknown[]) => console.warn('[pet-mode-store]', ...args),
}

interface PetModeStoreData {
  /** 当前虚拟人模型 ID（空表示用 registry 默认） */
  currentModelId: string
  /** 虚拟人设置 */
  vhSettings: VirtualHumanSettingsDTO
}

const DEFAULT_DATA: PetModeStoreData = {
  currentModelId: '',
  vhSettings: { ...DEFAULT_VH_SETTINGS },
}

let cache: PetModeStoreData | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'pet-mode-store.json')
}

/** 读取存储（带内存缓存 + 默认值容错） */
function load(): PetModeStoreData {
  if (cache) {
    return cache
  }
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PetModeStoreData>
    cache = {
      currentModelId: parsed.currentModelId ?? '',
      vhSettings: { ...DEFAULT_VH_SETTINGS, ...parsed.vhSettings },
    }
  } catch {
    cache = { ...DEFAULT_DATA, vhSettings: { ...DEFAULT_VH_SETTINGS } }
  }
  return cache
}

/** 写回磁盘（同步，数据极小） */
function persist(data: PetModeStoreData): void {
  cache = data
  try {
    fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    log.warn(`[persist] 写入失败: ${err instanceof Error ? err.message : err}`)
  }
}

/** 读取持久化的当前模型 ID（空表示用 registry 默认） */
export function getStoredModelId(): string {
  return load().currentModelId
}

/** 持久化当前模型 ID */
export function setStoredModelId(modelId: string): void {
  const data = load()
  if (data.currentModelId === modelId) {
    return
  }
  log.info(`[setStoredModelId] ${data.currentModelId || '(空)'} → ${modelId}`)
  persist({ ...data, currentModelId: modelId })
}

/** 读取虚拟人设置 */
export function getVirtualHumanSettings(): VirtualHumanSettingsDTO {
  return { ...load().vhSettings }
}

/** 合并写入虚拟人设置（patch） */
export function setVirtualHumanSettings(
  patch: Partial<VirtualHumanSettingsDTO>,
): VirtualHumanSettingsDTO {
  const data = load()
  const merged: VirtualHumanSettingsDTO = { ...data.vhSettings, ...patch }
  persist({ ...data, vhSettings: merged })
  log.info(`[setVirtualHumanSettings] 已更新: ${JSON.stringify(patch)}`)
  return merged
}
