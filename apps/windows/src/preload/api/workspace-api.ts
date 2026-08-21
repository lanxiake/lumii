/**
 * 工作空间相关 API
 */
import { ipcRenderer } from 'electron'

export const workspaceApi = {
  getDir: () => ipcRenderer.invoke('workspace:getDir'),
  setDir: (dirPath: string) => ipcRenderer.invoke('workspace:setDir', dirPath),
  notifyChanged: (newDirPath?: string) => ipcRenderer.invoke('workspace:notifyChanged', newDirPath),
  selectDir: (currentPath?: string) => ipcRenderer.invoke('workspace:selectDir', currentPath),
  ensureDir: (dirPath: string) => ipcRenderer.invoke('workspace:ensureDir', dirPath),
  sessionRenamed: (threadId: string, newTitle: string) =>
    ipcRenderer.invoke('workspace:sessionRenamed', threadId, newTitle),
  ensureThreadDir: (threadId: string) => ipcRenderer.invoke('workspace:ensureThreadDir', threadId),
}
