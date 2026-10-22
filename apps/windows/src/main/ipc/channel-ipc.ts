/**
 * 渠道相关 IPC handlers (微信、企业微信、飞书)
 */
import { ipcMain } from 'electron'
import { handleChannelList, handleChannelSend } from '../channel/channel-service-ipc'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import type { FeishuLoginService } from '../feishu-login-service'
import type { QbotLoginService } from '../qbot-login-service'
import type { ChannelHub } from '../channel/channel-hub-bootstrap'
import { getChannelPolicyStore } from '../channel/channel-policy-store'
import type { ChannelPolicy } from '../../shared/channel-policy'
import { loadWechatContacts, type WechatContactsResult } from '../channel/wechat-contacts'
import { repairWechatEnv, runWechatSelfcheck } from '../channel/wechat-selfcheck'
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

  // 渠道实验性功能开关（跨渠道接续）已插件化：
  // channel:getFeatures / channel:setFeatures 由 com.lumii.channel-continuity 在
  // 自己的作用域里注册，停用时随作用域摘掉。

  // === 渠道绑定级回复策略（设置 → 渠道 里按 peer 配；盯梢循环每拍读同一份缓存） ===
  ipcMain.handle('channel:getPolicy', (_event, channel: unknown) =>
    getChannelPolicyStore().get(String(channel ?? '')),
  )
  ipcMain.handle('channel:setPolicy', (_event, channel: unknown, policy: unknown) =>
    getChannelPolicyStore().set(String(channel ?? ''), policy as ChannelPolicy),
  )
  // 本机微信「从微信里挑人」：候选 = 微信会话（真名 + wxid）∪ 已配过的条目。
  // `account` 限定读哪个号——多开时每个号的会话列表不一样。
  ipcMain.handle(
    'channel:listWechatContacts',
    (_event, account?: unknown): Promise<WechatContactsResult> =>
      loadWechatContacts(
        {
          mcpServer: WECHAT_WATCH_MCP_SERVER,
          callMcpTool: (server, tool, args) => {
            const bridge = deps!.getAgentRuntimeBridge()
            if (!bridge) throw new Error('Agent Runtime 尚未就绪，读不了微信会话')
            return bridge.callMcpTool(server, tool, args)
          },
          getPolicy: () => getChannelPolicyStore().get(PCWECHAT_CHANNEL),
        },
        typeof account === 'string' && account.trim() ? account.trim() : undefined,
      ),
  )

  // 多开：设置页的账号页签要列出本机有哪些号（含没在跑的）。读不到就空表 + 原因，
  // 界面退回「只配默认」——不能因为 MCP 没连上就让策略页打不开。
  ipcMain.handle('channel:listWechatAccounts', async () => {
    const bridge = deps!.getAgentRuntimeBridge()
    if (!bridge) return { accounts: [], error: 'Agent Runtime 尚未就绪' }
    try {
      const raw = await bridge.callMcpTool(WECHAT_WATCH_MCP_SERVER, 'list_accounts', {})
      const parsed = JSON.parse(raw) as { active?: unknown; accounts?: unknown }
      const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : [])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => typeof a.wxid === 'string' && a.wxid.trim().length > 0)
        .map((a) => ({
          wxid: String(a.wxid),
          running: a.running !== false,
          ...(typeof a.pid === 'number' ? { pid: a.pid } : {}),
        }))
      return {
        ...(typeof parsed.active === 'string' && parsed.active ? { active: parsed.active } : {}),
        accounts,
      }
    } catch (err) {
      return {
        accounts: [],
        error: `读微信账号失败：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })

  // === 本机微信环境自检（确定性：check_env + locate_db；不叫模型） ===
  const withBridge =
    <T>(fn: (call: (s: string, t: string, a: Record<string, unknown>) => Promise<string>) => Promise<T>) =>
    async (): Promise<T | null> => {
      const bridge = deps!.getAgentRuntimeBridge()
      if (!bridge) return null
      return fn((s, t, a) => bridge.callMcpTool(s, t, a))
    }
  ipcMain.handle('wechat:selfcheck', withBridge((call) => runWechatSelfcheck(call)))
  ipcMain.handle('wechat:repair', withBridge((call) => repairWechatEnv(call)))
}
