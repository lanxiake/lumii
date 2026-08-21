/**
 * 对话框和剪贴板相关 API
 */
import { ipcRenderer } from 'electron'
import type { OpenDialogOptions, SaveDialogOptions, MessageBoxOptions } from 'electron'

export const dialogApi = {
  showOpenDialog: (options: OpenDialogOptions) =>
    ipcRenderer.invoke('dialog:showOpenDialog', options),
  showSaveDialog: (options: SaveDialogOptions) =>
    ipcRenderer.invoke('dialog:showSaveDialog', options),
  showMessageBox: (options: MessageBoxOptions) =>
    ipcRenderer.invoke('dialog:showMessageBox', options),
}

export const clipboardApi = {
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  writeText: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),
  writeFiles: (filePaths: string[]) => ipcRenderer.invoke('clipboard:writeFiles', filePaths),
}
