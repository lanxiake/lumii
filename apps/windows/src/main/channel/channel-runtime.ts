/**
 * 渠道运行期装配：登录服务 + 适配器 + 出站 Provider 的创建与拆除。
 *
 * **为什么单独一个模块**：这四套东西原来都写死在 `index.ts` 的
 * `initChannelServices()` 里，一次装配、进程活多久就活多久——渠道插件也就只能
 * 「重启生效」。搬到插件里的 `apply()` 后，每个渠道的启停由插件作用域决定：
 * 停用 = 停监听 + 从 Hub 摘 Provider，启用 = 重新建一套。
 *
 * 归属这样切：
 * - **登录服务**（连微信/飞书服务器、扫码态）跟着渠道走，但停用时**不登出**——
 *   只停消息处理，重新启用不需要重新扫码；
 * - **适配器**（把消息转成 Agent 回合）随启停建/拆；
 * - **Hub** 是常驻的，Provider 加/摘由这里负责。
 */
import qrcode from 'qrcode'
import type { BrowserWindow } from 'electron'

import type { AgentRuntimeBridge } from '../agent-runtime'
import { setWeixinBindingManagerForIpc } from '../agent-runtime'
import type { VoiceCallService } from '../../plugins/builtin/voice/voice-service'
import { transcribeVoiceFile } from './media-pipeline'
import { WeixinLoginService } from '../weixin-login-service'
import { WeixinChannelAdapter } from './adapters/weixin-channel-adapter'
import { WecomLoginService } from '../wecom-login-service'
import { WecomChannelAdapter } from './adapters/wecom-channel-adapter'
import { FeishuLoginService } from '../feishu-login-service'
import { FeishuChannelAdapter } from './adapters/feishu-channel-adapter'
import { QbotLoginService } from '../qbot-login-service'
import { QbotChannelAdapter } from './adapters/qbot-channel-adapter'
import { AcpBackendManager } from './acp-backend-manager'
import { WeixinChannelProvider } from './providers/weixin-outbound-provider'
import { WecomChannelProvider } from './providers/wecom-outbound-provider'
import { FeishuChannelProvider } from './providers/feishu-outbound-provider'
import { QbotChannelProvider } from './providers/qbot-outbound-provider'
import { PcwechatChannelProvider } from './providers/pcwechat-outbound-provider'
import {
  createChannelHub,
  createChannelPeerStore,
  createWeixinReplyContextStore,
  type ChannelHub,
} from './channel-hub-bootstrap'
import { getChannelPolicyStore } from './channel-policy-store'
import { PCWECHAT_CHANNEL } from '../agent-runtime/wechat-watch-tick'
import { getWechatSidecar } from '../agent-runtime/wechat-sidecar-client'
import { resolveWindowsClientDataRoot } from '../client-data-root'

const log = {
  info: (...args: unknown[]) => console.log('[ChannelRuntime]', ...args),
  warn: (...args: unknown[]) => console.warn('[ChannelRuntime]', ...args),
}

export type ChannelId = 'weixin' | 'wecom' | 'feishu' | 'qbot'

export interface ChannelRuntimeDeps {
  getBridge: () => AgentRuntimeBridge | null
  getMainWindow: () => BrowserWindow | null
  /** 现取：语音插件可被运行期停用，闭包里抓实例会拿到已释放的服务 */
  getVoice: () => VoiceCallService | null
  isHeadless: boolean
}

// ── 常驻状态 ─────────────────────────────────────────────────────────────

let peerStore: ReturnType<typeof createChannelPeerStore> | null = null
let weixinStore: ReturnType<typeof createWeixinReplyContextStore> | null = null
let hub: ChannelHub | null = null

let weixinLoginService: WeixinLoginService | null = null
let wecomLoginService: WecomLoginService | null = null
let feishuLoginService: FeishuLoginService | null = null
let qbotLoginService: QbotLoginService | null = null

let weixinAdapter: WeixinChannelAdapter | null = null
let wecomAdapter: WecomChannelAdapter | null = null
let feishuAdapter: FeishuChannelAdapter | null = null
let qbotAdapter: QbotChannelAdapter | null = null

/** 创建出站 Hub（没有任何登录服务也能建：Provider 由各渠道装配时再注册）。 */
export function initChannelHub(): ChannelHub {
  if (hub) return hub
  peerStore = createChannelPeerStore(resolveWindowsClientDataRoot())
  weixinStore = createWeixinReplyContextStore(resolveWindowsClientDataRoot())
  hub = createChannelHub({
    dataRoot: resolveWindowsClientDataRoot(),
    weixinStore,
    peerStore,
  })
  return hub
}

/**
 * 装配本机微信渠道（注册出站 Provider）。
 *
 * 由 `com.lumii.pcwechat` 插件在 `apply` 里调用，停用即摘掉 Provider——与另外四个
 * 渠道同一套启停语义。`getBridge` **现取**：插件在 S1 激活，Agent Runtime 到 S7.4
 * 才建，闭包里抓实例会一直拿到 null。
 *
 * 没有登录服务：「在线」= 应用托管的 Python 侧车起来了，名单 = 渠道策略里配过的人。
 */
export function startPcwechat(
  hub: ChannelHub,
  getBridge: () => AgentRuntimeBridge | null,
): () => void {
  const provider = new PcwechatChannelProvider({
    getPolicy: () => getChannelPolicyStore().get(PCWECHAT_CHANNEL),
    // 「那双手在不在」= 应用托管的 Python 侧车起没起来（能力归内置扩展，不再看 MCP）
    isReady: () => getWechatSidecar().isReady(),
    // 侧车调的与 Agent 用的是同一批原生工具（`bridge-wechat-tools.ts`），
    // 只是这条不经 Agent 回合——出站 Provider 拿不到 tool 执行器。
    callTool: (tool, args) => getWechatSidecar().callText(tool, args),
    // 「此刻发不出去」（锁屏 / 窗口抢不到前台）：排队，盯梢回路下一拍自己补发
    onUndeliverable: (to, text, account) => {
      const bridge = getBridge()
      if (!bridge) throw new Error('Agent Runtime 尚未就绪，无法排队补发')
      bridge.enqueueWechatOutbox(to, text, account)
    },
  })
  hub.registry.register(provider)
  return () => hub.registry.unregister('pcwechat')
}

export function getChannelHub(): ChannelHub | null {
  return hub
}

export function getChannelLoginServices(): {
  weixin: WeixinLoginService | null
  wecom: WecomLoginService | null
  feishu: FeishuLoginService | null
  qbot: QbotLoginService | null
} {
  return {
    weixin: weixinLoginService,
    wecom: wecomLoginService,
    feishu: feishuLoginService,
    qbot: qbotLoginService,
  }
}

/** 无头模式下二维码打到终端而不是渲染进程。 */
async function printQrCodeToTerminal(content: string, serviceName: string): Promise<void> {
  try {
    const qr = await qrcode.toString(content, { type: 'terminal', small: true })
    console.log(`\n=== ${serviceName} 登录二维码 ===\n`)
    console.log(qr)
  } catch (err) {
    log.warn(`[QrCode] ${serviceName} 终端二维码生成失败:`, err)
  }
}

/** 主窗口 getter：每次事件现取（窗口可能被重建）。 */
let windowGetter: () => BrowserWindow | null = () => null

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const win = windowGetter()
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

// ── 各渠道装配 ───────────────────────────────────────────────────────────

/**
 * 装配一个渠道。返回 disposer（停监听 + 从 Hub 摘 Provider；**不登出**）。
 *
 * 幂等：已在跑就直接返回一个什么都不做的 disposer。
 */
export async function startChannel(
  id: ChannelId,
  deps: ChannelRuntimeDeps,
): Promise<() => void> {
  windowGetter = deps.getMainWindow
  const channelHub = initChannelHub()

  switch (id) {
    case 'weixin':
      return startWeixin(channelHub, deps)
    case 'wecom':
      return startWecom(channelHub, deps)
    case 'feishu':
      return startFeishu(channelHub, deps)
    case 'qbot':
      return startQbot(channelHub, deps)
  }
}

async function startWeixin(hub: ChannelHub, deps: ChannelRuntimeDeps): Promise<() => void> {
  if (weixinAdapter) return () => undefined
  try {
    weixinLoginService = new WeixinLoginService()
    await weixinLoginService.initialize()
    // 注入 SILK ASR 转录回调（现取语音服务：它可能被停用）
    weixinLoginService.silkAsrCallback = (samples, sampleRate) =>
      deps.getVoice()?.transcribePcm(samples, sampleRate) ?? Promise.resolve('')
  } catch (err) {
    log.warn('微信(iLink)服务初始化失败:', err instanceof Error ? err.message : err)
    weixinLoginService = null
  }
  if (!weixinLoginService) return () => undefined

  const bridge = deps.getBridge()
  if (!bridge) {
    log.warn('微信渠道：Agent Runtime 未就绪，暂不装配适配器')
    return () => undefined
  }

  const service = weixinLoginService
  const adapter = new WeixinChannelAdapter(
    service,
    bridge,
    new AcpBackendManager(),
    hub.weixinStore,
  )
  adapter.startListening()
  weixinAdapter = adapter
  hub.registry.register(new WeixinChannelProvider(service, hub.weixinStore))
  setWeixinBindingManagerForIpc(adapter.bindingManager)

  service.on('statusChange', (status: string, session?: unknown) => sendToRenderer('weixin:statusChange', status, session))
  service.on('qrcode', (dataUrl: string, rawUrl?: string) => {
    if (deps.isHeadless && rawUrl) void printQrCodeToTerminal(rawUrl, '微信')
    else sendToRenderer('weixin:qrcode', dataUrl)
  })
  service.on('error', (message: string) => sendToRenderer('weixin:error', message))
  log.info('微信(iLink)服务已初始化')

  return () => {
    adapter.stopListening()
    hub.registry.unregister('weixin')
    weixinAdapter = null
  }
}

async function startWecom(hub: ChannelHub, deps: ChannelRuntimeDeps): Promise<() => void> {
  if (wecomAdapter) return () => undefined
  const bridge = deps.getBridge()
  try {
    wecomLoginService = new WecomLoginService()
    await wecomLoginService.initialize()
    if (!bridge) throw new Error('Agent Runtime 未就绪')
    const adapter = new WecomChannelAdapter(wecomLoginService, bridge)
    adapter.startListening()
    wecomAdapter = adapter
    const provider = new WecomChannelProvider(wecomLoginService)
    hub.registry.register(provider)
    adapter.setChannelPeerStore(hub.peerStore, provider)

    wecomLoginService.on('statusChange', (status: string, session?: unknown) => sendToRenderer('wecom:statusChange', status, session))
    wecomLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
      if (deps.isHeadless && rawUrl) void printQrCodeToTerminal(rawUrl, '企业微信')
      else sendToRenderer('wecom:qrcode', dataUrl)
    })
    wecomLoginService.on('error', (message: string) => sendToRenderer('wecom:error', message))
    log.info('企业微信(AI Bot)服务已初始化')

    return () => {
      adapter.stopListening()
      hub.registry.unregister('wecom')
      wecomAdapter = null
    }
  } catch (err) {
    log.warn('企业微信(AI Bot)服务初始化失败:', err instanceof Error ? err.message : err)
    return () => undefined
  }
}

async function startFeishu(hub: ChannelHub, deps: ChannelRuntimeDeps): Promise<() => void> {
  if (feishuAdapter) return () => undefined
  const bridge = deps.getBridge()
  try {
    feishuLoginService = new FeishuLoginService()
    await feishuLoginService.initialize()
    feishuLoginService.asrCallback = async (absPath) => {
      try {
        const voice = deps.getVoice()
        if (!voice) return ''
        return await transcribeVoiceFile(absPath, (samples, sampleRate) =>
          voice.transcribePcm(samples, sampleRate),
        )
      } catch (e) {
        console.warn('[Feishu ASR] 转录失败（可能语音模型未下载）:', e instanceof Error ? e.message : String(e))
        return ''
      }
    }
    if (!bridge) throw new Error('Agent Runtime 未就绪')
    const adapter = new FeishuChannelAdapter(feishuLoginService, bridge)
    adapter.startListening()
    feishuAdapter = adapter
    hub.registry.register(new FeishuChannelProvider(feishuLoginService))

    feishuLoginService.on('statusChange', (status: string, session?: unknown) => sendToRenderer('feishu:statusChange', status, session))
    feishuLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
      if (deps.isHeadless && rawUrl) void printQrCodeToTerminal(rawUrl, '飞书')
      else sendToRenderer('feishu:qrcode', dataUrl)
    })
    feishuLoginService.on('error', (message: string) => sendToRenderer('feishu:error', message))
    log.info('飞书服务已初始化')

    return () => {
      adapter.stopListening()
      hub.registry.unregister('feishu')
      feishuAdapter = null
    }
  } catch (err) {
    log.warn('飞书服务初始化失败:', err instanceof Error ? err.message : err)
    return () => undefined
  }
}

async function startQbot(hub: ChannelHub, deps: ChannelRuntimeDeps): Promise<() => void> {
  if (qbotAdapter) return () => undefined
  const bridge = deps.getBridge()
  try {
    qbotLoginService = new QbotLoginService()
    await qbotLoginService.initialize()
    qbotLoginService.asrCallback = async (absPath) => {
      try {
        const voice = deps.getVoice()
        if (!voice) return ''
        return await transcribeVoiceFile(absPath, (samples, sampleRate) =>
          voice.transcribePcm(samples, sampleRate),
        )
      } catch (e) {
        console.warn('[Qbot ASR] 转录失败（silk-wasm 未加载或语音模型未下载）:', e instanceof Error ? e.message : String(e))
        return ''
      }
    }
    if (!bridge) throw new Error('Agent Runtime 未就绪')
    const adapter = new QbotChannelAdapter(qbotLoginService, bridge)
    adapter.startListening()
    qbotAdapter = adapter
    const provider = new QbotChannelProvider(qbotLoginService)
    hub.registry.register(provider)
    adapter.setChannelPeerStore(hub.peerStore, provider)

    qbotLoginService.on('statusChange', (status: string, session?: unknown) => sendToRenderer('qbot:statusChange', status, session))
    qbotLoginService.on('qrcode', (dataUrl: string, rawUrl?: string) => {
      if (deps.isHeadless && rawUrl) void printQrCodeToTerminal(rawUrl, 'QQ 机器人')
      else sendToRenderer('qbot:qrcode', dataUrl)
    })
    qbotLoginService.on('error', (message: string) => sendToRenderer('qbot:error', message))
    log.info('QQ 机器人服务已初始化')

    return () => {
      adapter.stopListening()
      hub.registry.unregister('qbot')
      qbotAdapter = null
    }
  } catch (err) {
    log.warn('QQ 机器人服务初始化失败:', err instanceof Error ? err.message : err)
    return () => undefined
  }
}

/** 进程退出：把微信登出（其它渠道没有会话要收）。 */
export function shutdownChannels(): void {
  try {
    weixinLoginService?.shutdown()
  } catch (err) {
    log.warn('微信登出清理失败:', err)
  }
}

