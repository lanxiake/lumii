/**
 * 窗口控制相关 API
 */
import { ipcRenderer } from 'electron'

export const windowApi = {
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  getCursorClientPos: () => ipcRenderer.invoke('window:getCursorClientPos'),
}

export const notifyApi = {
  desktop: (payload: { title?: string; body?: string }) =>
    ipcRenderer.invoke('notify:desktop', payload),
}
