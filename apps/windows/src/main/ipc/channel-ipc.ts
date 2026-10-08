/**
 * 渠道相关 IPC handlers (微信、企业微信、飞书)
 */
import { ipcMain } from 'electron'
import { handleChannelList, handleChannelSend } from '../channel/channel-service-ipc'
import {
  getChannelFeatures,
  setChannelFeatures,
  type ChannelFeatureSettings,
} from '../channel/channel-feature-store'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import type { FeishuLoginService } from '../feishu-login-service'
import type { QbotLoginService } from '../qbot-login-service'
import type { ChannelHub } from '../channel/channel-hub-bootstrap'
import { getChannelPolicyStore } from '../channel/channel-policy-store'
import type { ChannelPolicy } from '../../shared/channel-policy'
import { loadWechatContacts, type WechatContactsResult } from '../channel/wechat-contacts'
import { PCWECHAT_CHANNEL, WECHAT_WATCH_MCP_SERVER } from '../agent-runtime/wechat-watch-tick'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'

interface ChannelIpcDeps {
  getWeixinLoginService: () => WeixinLoginService | null
  getWecomLoginService: () => WecomLoginService | null
  getFeishuLoginService: () => FeishuLoginService | null
  getQbotLoginService: () => QbotLoginService | null
  getChannelHub: () => ChannelHub | null
  /** 读本机微信会话（列候选名单用）；未就绪返回 null */
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
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

  // === QQ 机器人渠道 ===
  ipcMain.handle('qbot:startLogin', async () => {
    const qbotLoginService = deps!.getQbotLoginService()
    if (!qbotLoginService) throw new Error('QQ 机器人服务尚未就绪，请稍后再试')
    return qbotLoginService.startLogin()
  })

  ipcMain.handle('qbot:saveCredentials', async (_event, appId: string, appSecret: string) => {
    const qbotLoginService = deps!.getQbotLoginService()
    if (!qbotLoginService) throw new Error('QQ 机器人服务尚未就绪，请稍后再试')
    return qbotLoginService.saveCredentials(appId, appSecret)
  })

  ipcMain.handle('qbot:logout', async () => {
    const qbotLoginService = deps!.getQbotLoginService()
    if (!qbotLoginService) throw new Error('QQ 机器人服务尚未就绪，请稍后再试')
    return qbotLoginService.logout()
  })

  ipcMain.handle('qbot:getStatus', () => {
    return deps!.getQbotLoginService()?.getStatus() ?? 'idle'
  })

  ipcMain.handle('qbot:getSession', () => {
    return deps!.getQbotLoginService()?.getSessionPublic() ?? null
  })

  // === 渠道出站 Hub（与 Agent channel_list/channel_send 同源，仅供 Settings 面板只读展示/调试） ===
  ipcMain.handle('channel:list', async () => handleChannelList(deps!.getChannelHub()))
  ipcMain.handle('channel:send', async (_event, params: unknown) => handleChannelSend(deps!.getChannelHub(), params))

  // === 渠道实验性功能开关（§5.4 跨渠道接续） ===
  ipcMain.handle('channel:getFeatures', () => getChannelFeatures())
  ipcMain.handle('channel:setFeatures', (_event, patch: Partial<ChannelFeatureSettings>) =>
    setChannelFeatures(patch ?? {}),
  )

  // === 渠道绑定级回复策略（设置 → 渠道 里按 peer 配；盯梢循环每拍读同一份缓存） ===
  ipcMain.handle('channel:getPolicy', (_event, channel: unknown) =>
    getChannelPolicyStore().get(String(channel ?? '')),
  )
  ipcMain.handle('channel:setPolicy', (_event, channel: unknown, policy: unknown) =>
    getChannelPolicyStore().set(String(channel ?? ''), policy as ChannelPolicy),
  )
  // 本机微信「从微信里挑人」：候选 = 微信会话（真名 + wxid）∪ 已配过的条目
  ipcMain.handle(
    'channel:listWechatContacts',
    (): Promise<WechatContactsResult> =>
      loadWechatContacts({
        mcpServer: WECHAT_WATCH_MCP_SERVER,
        callMcpTool: (server, tool, args) => {
          const bridge = deps!.getAgentRuntimeBridge()
          if (!bridge) throw new Error('Agent Runtime 尚未就绪，读不了微信会话')
          return bridge.callMcpTool(server, tool, args)
        },
        getPolicy: () => getChannelPolicyStore().get(PCWECHAT_CHANNEL),
      }),
  )
}
