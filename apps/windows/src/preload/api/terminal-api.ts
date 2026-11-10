/**
 * 本地终端 API（工作台「终端」页）
 *
 * 数据与退出事件走 `terminal:data` / `terminal:exit` 推送，带上终端 id；
 * 面板只处理属于自己那条的帧。
 */
import { ipcRenderer } from 'electron'

export interface TerminalCreateResult {
  id: string
  /** 该终端已有的输出尾部（重试/重开时接着写） */
  tail: string
  pid: number
}

export const terminalApi = {
  create: (
    cwd: string,
    size?: { cols: number; rows: number },
  ): Promise<TerminalCreateResult> => ipcRenderer.invoke('terminal:create', cwd, size),
  write: (id: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number): Promise<boolean> =>
    ipcRenderer.invoke('terminal:resize', id, cols, rows),
  kill: (id: string): Promise<boolean> => ipcRenderer.invoke('terminal:kill', id),
  onData: (callback: (payload: { id: string; data: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
      callback(payload)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onExit: (callback: (payload: { id: string; exitCode: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; exitCode: number }) =>
      callback(payload)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
}
