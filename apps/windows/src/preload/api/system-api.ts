/**
 * 系统操作相关 API
 */
import { ipcRenderer } from 'electron'

export const systemApi = {
  getInfo: () => ipcRenderer.invoke('system:getInfo'),
  getDiskInfo: () => ipcRenderer.invoke('system:getDiskInfo'),
  getUserPaths: () => ipcRenderer.invoke('system:getUserPaths'),
}
