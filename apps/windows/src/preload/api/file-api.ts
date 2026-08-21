/**
 * 文件操作相关 API
 */
import { ipcRenderer } from 'electron'

export const fileApi = {
  list: (dirPath: string) => ipcRenderer.invoke('file:list', dirPath),
  read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  readAsBase64: (filePath: string) => ipcRenderer.invoke('file:readAsBase64', filePath),
  write: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
  move: (sourcePath: string, destPath: string) =>
    ipcRenderer.invoke('file:move', sourcePath, destPath),
  copy: (sourcePath: string, destPath: string) =>
    ipcRenderer.invoke('file:copy', sourcePath, destPath),
  delete: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
  createDir: (dirPath: string) => ipcRenderer.invoke('file:createDir', dirPath),
  exists: (filePath: string) => ipcRenderer.invoke('file:exists', filePath),
  getInfo: (filePath: string) => ipcRenderer.invoke('file:getInfo', filePath),
  search: (dirPath: string, pattern: string, options?: unknown) =>
    ipcRenderer.invoke('file:search', dirPath, pattern, options),
}
