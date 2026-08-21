/**
 * 渠道相关 API (微信/企业微信/飞书)
 */
import { ipcRenderer } from 'electron'

function makeChannelApi(prefix: 'weixin' | 'wecom' | 'feishu') {
  return {
    startLogin: (): Promise<string> => ipcRenderer.invoke(`${prefix}:startLogin`),
    logout: (): Promise<void> => ipcRenderer.invoke(`${prefix}:logout`),
    getStatus: (): Promise<string> => ipcRenderer.invoke(`${prefix}:getStatus`),
    getSession: (): Promise<unknown> => ipcRenderer.invoke(`${prefix}:getSession`),
    onStatusChange: (callback: (status: string, session?: unknown) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: string, session: unknown) =>
        callback(status, session)
      ipcRenderer.on(`${prefix}:statusChange`, handler)
      return () => ipcRenderer.removeListener(`${prefix}:statusChange`, handler)
    },
    onQrcode: (callback: (dataUrl: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
      ipcRenderer.on(`${prefix}:qrcode`, handler)
      return () => ipcRenderer.removeListener(`${prefix}:qrcode`, handler)
    },
    onError: (callback: (message: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: string) => callback(message)
      ipcRenderer.on(`${prefix}:error`, handler)
      return () => ipcRenderer.removeListener(`${prefix}:error`, handler)
    },
  }
}

export const weixinApi = {
  ...makeChannelApi('weixin'),
  /** 移除指定通道的所有监听器 */
  removeAllListeners: (channel: string): void => {
    ipcRenderer.removeAllListeners(`weixin:${channel}`)
  },
}

export const wecomApi = makeChannelApi('wecom')

export const feishuApi = makeChannelApi('feishu')

export const channelApi = {
  /** 列出已注册渠道快照（含未连接渠道） */
  list: (): Promise<{ channels: unknown[] }> => ipcRenderer.invoke('channel:list'),
  /** 向指定 channel + to 发送文本/富媒体；仅供调试，非 Agent 主路径 */
  send: (params: {
    channel: 'feishu' | 'weixin' | 'wecom'
    to: string
    text: string
    mediaPath?: string
    fileName?: string
  }): Promise<unknown> => ipcRenderer.invoke('channel:send', params),
}
