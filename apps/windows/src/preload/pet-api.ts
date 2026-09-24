/**
 * Preload Pet API - 宠物模式 IPC 桥接
 *
 * 通过 contextBridge 安全地将 pet:* IPC 暴露给渲染进程。
 * 由 preload/index.ts 导入后挂载到 electronAPI.pet。
 */

import { ipcRenderer } from 'electron'
import {
  type AppMode,
  type PetElectronAPI,
  type PetHoverUpdate,
  type PetIdleEvent,
  type PetModeChangedEvent,
  type PetModelChangedEvent,
  type PetModePrepareEvent,
  type PetModeSwitchResult,
  type PetMainWindowFocusEvent,
  type PetMotionActionDTO,
  type PetPerchEvent,
  type PetPersonalityDTO,
  type PetTaskCreateResult,
  type PetTaskStateDTO,
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

  toggleForceIgnoreMouse: (): Promise<boolean> =>
    ipcRenderer.invoke(PET_IPC.toggleForceIgnoreMouse),

  notifyRendererReady: (targetMode: AppMode): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.rendererReady, targetMode),

  getCurrentModelId: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getCurrentModelId),

  getIdleStage: () => ipcRenderer.invoke(PET_IPC.getIdleStage),

  getPerchRect: () => ipcRenderer.invoke(PET_IPC.getPerchRect),

  setCurrentModelId: (modelId: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.setCurrentModelId, modelId),

  listModels: () => ipcRenderer.invoke(PET_IPC.listModels),

  getModelConfig: (modelId: string) =>
    ipcRenderer.invoke(PET_IPC.getModelConfig, modelId),

  setActiveSessionKey: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.setActiveSessionKey, sessionKey),

  getActiveSessionKey: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getActiveSessionKey),

  focusSession: (sessionKey: string): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.focusSession, sessionKey),

  focusNotice: (payload: { sessionKey: string; requestId?: string }): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.focusNotice, payload),

  getMouseIgnoreState: (): Promise<{ clickable: boolean; components: string[] }> =>
    ipcRenderer.invoke(PET_IPC.getMouseIgnoreState),

  getCubismCoreUrl: (): Promise<string> =>
    ipcRenderer.invoke(PET_IPC.getCubismCoreUrl),

  onModeChanged: (callback: (event: PetModeChangedEvent) => void): () => void =>
    createPetEventListener<PetModeChangedEvent>(PET_IPC.evtChanged, callback),

  onModePrepare: (callback: (event: PetModePrepareEvent) => void): () => void =>
    createPetEventListener<PetModePrepareEvent>(PET_IPC.evtPrepare, callback),

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

  getPetPersonality: (configId: string): Promise<PetPersonalityDTO | null> =>
    ipcRenderer.invoke(PET_IPC.getPetPersonality, configId),

  // ── 「让它去做」那条线（五期 T5.7/T5.8）─────────────────────────────
  // 受理判断全在主进程（见 PET_IPC.petTaskCreate 的注释），这里只是转发。
  petTaskCreate: (text: string): Promise<PetTaskCreateResult> =>
    ipcRenderer.invoke(PET_IPC.petTaskCreate, text),

  getPetTaskState: (): Promise<PetTaskStateDTO | null> =>
    ipcRenderer.invoke(PET_IPC.petTaskState),

  markPetTaskRead: (): Promise<void> => ipcRenderer.invoke(PET_IPC.petTaskMarkRead),

  handoffPetTaskToMain: (payload: { description: string; text: string }): Promise<void> =>
    ipcRenderer.invoke(PET_IPC.petHandoffToMain, payload),

  onModelChanged: (callback: (event: PetModelChangedEvent) => void): () => void =>
    createPetEventListener<PetModelChangedEvent>(PET_IPC.evtModelChanged, callback),

  onVhSettingsChanged: (callback: (event: PetVhSettingsChangedEvent) => void): () => void =>
    createPetEventListener<PetVhSettingsChangedEvent>(PET_IPC.evtVhSettingsChanged, callback),

  onIdle: (callback: (event: PetIdleEvent) => void): (() => void) =>
    createPetEventListener<PetIdleEvent>(PET_IPC.evtIdle, callback),

  onPerch: (callback: (event: PetPerchEvent) => void): (() => void) =>
    createPetEventListener<PetPerchEvent>(PET_IPC.evtPerch, callback),

  onMainWindowFocus: (callback: (event: PetMainWindowFocusEvent) => void): (() => void) =>
    createPetEventListener<PetMainWindowFocusEvent>(PET_IPC.evtMainWindowFocus, callback),

  getMainWindowFocus: (): Promise<boolean> => ipcRenderer.invoke(PET_IPC.getMainWindowFocus),
}
