/**
 * 系统操作相关 API
 */
import { ipcRenderer } from 'electron'

export const systemApi = {
  getInfo: () => ipcRenderer.invoke('system:getInfo'),
  getDiskInfo: () => ipcRenderer.invoke('system:getDiskInfo'),
  getProcessList: () => ipcRenderer.invoke('system:getProcessList'),
  killProcess: (pid: number) => ipcRenderer.invoke('system:killProcess', pid),
  launchApp: (appPath: string, args?: string[]) =>
    ipcRenderer.invoke('system:launchApp', appPath, args),
  executeCommand: (command: string) => ipcRenderer.invoke('system:executeCommand', command),
  getUserPaths: () => ipcRenderer.invoke('system:getUserPaths'),
}
