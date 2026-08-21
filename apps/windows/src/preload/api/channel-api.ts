/**
 * 渠道相关 API (微信/企业微信/飞书)
 */
import { ipcRenderer } from 'electron'

export const weixinApi = {
  startLogin: () => ipcRenderer.invoke('weixin:startLogin'),
  logout: () => ipcRenderer.invoke('weixin:logout'),
  getStatus: () => ipcRenderer.invoke('weixin:getStatus'),
  getSession: () => ipcRenderer.invoke('weixin:getSession'),
  onStatusChange: (callback: (status: unknown) => void) => {
    ipcRenderer.on('weixin:status', (_event, status) => callback(status))
  },
  onQrCode: (callback: (qrCode: unknown) => void) => {
    ipcRenderer.on('weixin:qrcode', (_event, qrCode) => callback(qrCode))
  },
}

export const wecomApi = {
  startLogin: () => ipcRenderer.invoke('wecom:startLogin'),
  logout: () => ipcRenderer.invoke('wecom:logout'),
  getStatus: () => ipcRenderer.invoke('wecom:getStatus'),
  getSession: () => ipcRenderer.invoke('wecom:getSession'),
  onStatusChange: (callback: (status: unknown) => void) => {
    ipcRenderer.on('wecom:status', (_event, status) => callback(status))
  },
  onQrCode: (callback: (qrCode: unknown) => void) => {
    ipcRenderer.on('wecom:qrcode', (_event, qrCode) => callback(qrCode))
  },
}

export const feishuApi = {
  startLogin: () => ipcRenderer.invoke('feishu:startLogin'),
  logout: () => ipcRenderer.invoke('feishu:logout'),
  getStatus: () => ipcRenderer.invoke('feishu:getStatus'),
  getSession: () => ipcRenderer.invoke('feishu:getSession'),
  onStatusChange: (callback: (status: unknown) => void) => {
    ipcRenderer.on('feishu:status', (_event, status) => callback(status))
  },
  onQrCode: (callback: (qrCode: unknown) => void) => {
    ipcRenderer.on('feishu:qrcode', (_event, qrCode) => callback(qrCode))
  },
}

export const channelApi = {
  list: () => ipcRenderer.invoke('channel:list'),
  send: (params: unknown) => ipcRenderer.invoke('channel:send', params),
}
