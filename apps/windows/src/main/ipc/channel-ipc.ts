/**
 * 渠道相关 IPC handlers (微信、企业微信、飞书)
 */
import { ipcMain } from 'electron'
import { handleChannelList, handleChannelSend } from '../channel/channel-service-ipc'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import type { FeishuLoginService } from '../feishu-login-service'
import type { ChannelHub } from '../channel/channel-hub-bootstrap'

interface ChannelIpcDeps {
  getWeixinLoginService: () => WeixinLoginService | null
  getWecomLoginService: () => WecomLoginService | null
  getFeishuLoginService: () => FeishuLoginService | null
  getChannelHub: () => ChannelHub | null
}

let deps: ChannelIpcDeps | null = null

export function setChannelIpcDeps(d: ChannelIpcDeps): void {
  deps = d
}

export function registerChannelIpcHandlers(): void {
  if (!deps) throw new Error('ChannelIpc deps not set')

  // === 微信(iLink)渠道 ===
  ipcMain.handle('weixin:startLogin', async () => {
    const weixinLoginService = deps!.getWeixinLoginService()
    if (!weixinLoginService) return null
    return weixinLoginService.startLogin()
  })

  ipcMain.handle('weixin:logout', async () => {
    const weixinLoginService = deps!.getWeixinLoginService()
    if (!weixinLoginService) return
    return weixinLoginService.logout()
  })

  ipcMain.handle('weixin:getStatus', () => {
    return deps!.getWeixinLoginService()?.getStatus() ?? 'idle'
  })

  ipcMain.handle('weixin:getSession', async () => {
    return deps!.getWeixinLoginService()?.getSession() ?? null
  })

  // === 企业微信(AI Bot)渠道 ===
  ipcMain.handle('wecom:startLogin', async () => {
    const wecomLoginService = deps!.getWecomLoginService()
    if (!wecomLoginService) return null
    return wecomLoginService.startLogin()
  })

  ipcMain.handle('wecom:logout', async () => {
    const wecomLoginService = deps!.getWecomLoginService()
    if (!wecomLoginService) return
    return wecomLoginService.logout()
  })

  ipcMain.handle('wecom:getStatus', () => {
    return deps!.getWecomLoginService()?.getStatus() ?? 'idle'
  })

  ipcMain.handle('wecom:getSession', () => {
    return deps!.getWecomLoginService()?.getSessionPublic() ?? null
  })

  // === 飞书渠道 ===
  ipcMain.handle('feishu:startLogin', async () => {
    const feishuLoginService = deps!.getFeishuLoginService()
    if (!feishuLoginService) return null
    return feishuLoginService.startLogin()
  })

  ipcMain.handle('feishu:logout', async () => {
    const feishuLoginService = deps!.getFeishuLoginService()
    if (!feishuLoginService) return
    return feishuLoginService.logout()
  })

  ipcMain.handle('feishu:getStatus', () => {
    return deps!.getFeishuLoginService()?.getStatus() ?? 'idle'
  })

  ipcMain.handle('feishu:getSession', () => {
    return deps!.getFeishuLoginService()?.getSessionPublic() ?? null
  })

  // === 渠道出站 Hub（与 Agent channel_list/channel_send 同源，仅供 Settings 面板只读展示/调试） ===
  ipcMain.handle('channel:list', async () => handleChannelList(deps!.getChannelHub()))
  ipcMain.handle('channel:send', async (_event, params: unknown) => handleChannelSend(deps!.getChannelHub(), params))
}
