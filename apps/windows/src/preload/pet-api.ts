/**
 * Preload Pet API - 宠物模式 IPC 桥接
 *
 * 通过 contextBridge 安全地将 pet:* IPC 暴露给渲染进程。
 * 由 preload/index.ts 导入后挂载到 electronAPI.pet。
 */

import { ipcRenderer } from 'electron'
import {
  type AppMode,
  type PetClickRegion,
  type PetElectronAPI,
  type PetForceIgnoreChangedEvent,
  type PetHoverUpdate,
  type PetModeChangedEvent,
  type PetModelChangedEvent,
  type PetModePrepareEvent,
  type PetModeSwitchResult,
  type PetMotionActionDTO,
  type PetVhSettingsChangedEvent,
  type VirtualHumanSettingsDTO,
  PET_IPC,
} from '../shared/pet-mode'

function createPetEventListener<T>(
  channel: string,
  callback: (data: T) => void,
): () => void {
  const listener = (_evt: Electron.IpcRendererEvent, data: T) => callback(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const petApi: PetElectronAPI = {
  switchMode: (mode: AppMode, modelId?: string): Promise<PetModeSwitchResult> =>
    ipcRenderer.invoke(PET_IPC.switchMode, mode, modelId),

  getMode: (): Promise<AppMode> =>
    ipcRenderer.invoke(PET_IPC.getMode),

  reportHover: (update: PetHoverUpdate): void => {
    ipcRenderer.send(PET_IPC.reportHover, update)
  },

  updateClickRegion: (region: PetClickRegion): void => {
    ipcRenderer.send(PET_IPC.updateClickRegion, region)
  },

  toggleForceIgnoreMouse: (): Promise<boolean> =>
    ipcRenderer.invoke(PET_IPC.toggleForceIgnoreMouse),

  getForceIgnoreMouse: (): Promise<boolean> =>
    ipcRenderer.invoke(PET_IPC.getForceIgnoreMouse),

  notifyRendererReady: (targetMode: AppMode): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.rendererReady, targetMode),

  getCurrentModelId: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getCurrentModelId),

  setCurrentModelId: (modelId: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.setCurrentModelId, modelId),

  listModels: () => ipcRenderer.invoke(PET_IPC.listModels),

  getModelConfig: (modelId: string) =>
    ipcRenderer.invoke(PET_IPC.getModelConfig, modelId),

  setActiveSessionKey: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.setActiveSessionKey, sessionKey),

  getActiveSessionKey: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getActiveSessionKey),

  getCubismCoreUrl: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getCubismCoreUrl),

  onModeChanged: (callback: (event: PetModeChangedEvent) => void): () => void =>
    createPetEventListener<PetModeChangedEvent>(PET_IPC.evtChanged, callback),

  onModePrepare: (callback: (event: PetModePrepareEvent) => void): () => void =>
    createPetEventListener<PetModePrepareEvent>(PET_IPC.evtPrepare, callback),

  onForceIgnoreChanged: (callback: (event: PetForceIgnoreChangedEvent) => void): () => void =>
    createPetEventListener<PetForceIgnoreChangedEvent>(PET_IPC.evtForceIgnoreChanged, callback),

  getVirtualHumanSettings: (): Promise<VirtualHumanSettingsDTO> =>
    ipcRenderer.invoke(PET_IPC.getVirtualHumanSettings),

  setVirtualHumanSettings: (patch: Partial<VirtualHumanSettingsDTO>): Promise<VirtualHumanSettingsDTO> =>
    ipcRenderer.invoke(PET_IPC.setVirtualHumanSettings, patch),

  setFocusable: (focusable: boolean): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.setFocusable, focusable),

  activateVirtualHumanContext: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.activateVirtualHumanContext, sessionKey),

  getModelMotionActions: (modelId: string): Promise<PetMotionActionDTO[]> =>
    ipcRenderer.invoke(PET_IPC.getModelMotionActions, modelId),

  onModelChanged: (callback: (event: PetModelChangedEvent) => void): () => void =>
    createPetEventListener<PetModelChangedEvent>(PET_IPC.evtModelChanged, callback),

  onVhSettingsChanged: (callback: (event: PetVhSettingsChangedEvent) => void): () => void =>
    createPetEventListener<PetVhSettingsChangedEvent>(PET_IPC.evtVhSettingsChanged, callback),
}
