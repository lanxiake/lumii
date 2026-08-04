/**
 * WecomLoginService - 企业微信 AI Bot 扫码接入 + WebSocket 长连接。
 *
 * 扫码链路（与 @wecom/wecom-openclaw-cli / Clawith 一致）：
 * 1. GET https://work.weixin.qq.com/ai/qc/generate → {scode, auth_url}
 * 2. 前端用 auth_url 渲染二维码；主进程每 3s 轮询 query_result
 * 3. status=success 时拿到 botid/secret，落盘并启动 WSClient
 *
 * Events:
 * - "statusChange" (status, sessionPublic?)
 * - "qrcode" (dataUrl)
 * - "message" (normalized)
 * - "error" (message)
 */

import { EventEmitter } from 'events'
import QRCode from 'qrcode'
import { WSClient, generateReqId, MessageType } from '@wecom/aibot-node-sdk'
import { WecomSessionStore, type WecomSession } from './wecom-session-store.js'

const QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
const QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
/** 来源标识；官方 CLI 可用 wecom-cli，本客户端用 mtbot */
const QR_SOURCE = 'mtbot'
/** plat: darwin=1 / win32=2 / linux=3，仅来源标识 */
const QR_PLAT = process.platform === 'darwin' ? 1 : process.platform === 'win32' ? 2 : 3
const POLL_INTERVAL_MS = 3_000
const QR_TIMEOUT_MS = 5 * 60 * 1000

export type WecomLoginStatus =
  | 'idle'
  | 'waiting_qrcode'
  | 'scanned'
  | 'connected'
  | 'error'

/** 渲染进程可见的会话摘要（不含 secret） */
export interface WecomSessionPublic {
  botId: string
  loginAt: number
  /** 脱敏后的 botId 展示 */
  botIdMasked: string
}

export interface WecomNormalizedMessage {
  channel: 'wecom'
  channelUserId: string
  chatId: string
  chatType: 'single' | 'group'
  type: 'text' | 'voice' | 'other'
  text?: string
  msgId: string
  timestamp: number
  /** 原始 WS 帧，回复时需带上 headers */
  rawFrame: unknown
}

const log = {
  info: (...args: unknown[]) => console.log('[WecomLoginService]', ...args),
  warn: (...args: unknown[]) => console.warn('[WecomLoginService]', ...args),
  error: (...args: unknown[]) => console.error('[WecomLoginService]', ...args),
}

/**
 * 将 botId 脱敏为前缀 + … + 后缀。
 */
function maskBotId(botId: string): string {
  if (botId.length <= 10) return `${botId.slice(0, 4)}…`
  return `${botId.slice(0, 8)}…${botId.slice(-4)}`
}

/**
 * 企业微信 AI Bot 扫码登录与长连接服务。
 */
export class WecomLoginService extends EventEmitter {
  private store = new WecomSessionStore()
  private status: WecomLoginStatus = 'idle'
  private session: WecomSession | null = null
  private client: WSClient | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollDeadline = 0
  private currentScode: string | null = null
  private stopping = false

  /**
   * 启动时恢复本地会话并尝试重连。
   */
  async initialize(): Promise<void> {
    const saved = await this.store.loadSession()
    if (!saved) {
      this.setStatus('idle')
      return
    }
    this.session = saved
    log.info('Restored session, connecting WS…', maskBotId(saved.botId))
    await this.startWsClient(saved.botId, saved.secret)
  }

  /**
   * 返回当前状态。
   */
  getStatus(): WecomLoginStatus {
    return this.status
  }

  /**
   * 返回渲染进程可见的会话摘要（不含 secret）。
   */
  getSessionPublic(): WecomSessionPublic | null {
    if (!this.session) return null
    return {
      botId: this.session.botId,
      loginAt: this.session.loginAt,
      botIdMasked: maskBotId(this.session.botId),
    }
  }

  /**
   * 发起扫码接入：拉官方二维码并开始轮询。
   */
  async startLogin(): Promise<void> {
    this.stopPolling()
    this.stopping = false
    this.setStatus('waiting_qrcode')

    try {
      const { scode, auth_url } = await this.generateQrcode()
      this.currentScode = scode
      const dataUrl = await QRCode.toDataURL(auth_url, { width: 256, margin: 1 })
      this.emit('qrcode', dataUrl)
      this.pollDeadline = Date.now() + QR_TIMEOUT_MS
      this.pollTimer = setInterval(() => {
        void this.pollOnce()
      }, POLL_INTERVAL_MS)
      // 立刻轮询一次，避免最多等待 3s 才感知已扫
      void this.pollOnce()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('startLogin failed:', msg)
      this.setStatus('error')
      this.emit('error', msg)
    }
  }

  /**
   * 断开连接并清除本地凭证。
   */
  async logout(): Promise<void> {
    this.stopping = true
    this.stopPolling()
    this.disconnectWs()
    await this.store.clearSession()
    this.session = null
    this.currentScode = null
    this.setStatus('idle')
  }

  /**
   * 通过 WS 流式回复文本（finish=true 一次性发完）。
   */
  async replyText(rawFrame: unknown, text: string): Promise<boolean> {
    if (!this.client?.isConnected) {
      log.warn('replyText: WS not connected')
      return false
    }
    try {
      const streamId = generateReqId('stream')
      await this.client.replyStream(
        rawFrame as { headers: { req_id: string } },
        streamId,
        text,
        true,
      )
      return true
    } catch (err) {
      log.error('replyText failed:', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * 调官方发码接口。
   */
  private async generateQrcode(): Promise<{ scode: string; auth_url: string }> {
    const url = new URL(QR_GENERATE_URL)
    url.searchParams.set('source', QR_SOURCE)
    url.searchParams.set('plat', String(QR_PLAT))
    const resp = await fetch(url.toString(), { method: 'GET' })
    if (!resp.ok) {
      throw new Error(`获取企业微信二维码失败 (HTTP ${resp.status})`)
    }
    const payload = (await resp.json()) as {
      data?: { scode?: string; auth_url?: string }
    }
    const scode = payload.data?.scode
    const auth_url = payload.data?.auth_url
    if (!scode || !auth_url) {
      throw new Error('企业微信二维码响应格式异常')
    }
    return { scode, auth_url }
  }

  /**
   * 单次轮询扫码结果。
   */
  private async pollOnce(): Promise<void> {
    if (!this.currentScode) return
    if (Date.now() > this.pollDeadline) {
      this.stopPolling()
      this.setStatus('error')
      this.emit('error', '二维码已过期，请重新获取')
      return
    }
    try {
      const url = new URL(QR_QUERY_URL)
      url.searchParams.set('scode', this.currentScode)
      const resp = await fetch(url.toString(), { method: 'GET' })
      if (!resp.ok) return
      const payload = (await resp.json()) as {
        data?: {
          status?: string
          bot_info?: { botid?: string; secret?: string }
        }
      }
      const status = payload.data?.status ?? 'init'
      if (status === 'scanned' && this.status === 'waiting_qrcode') {
        this.setStatus('scanned')
      }
      if (status === 'expired') {
        this.stopPolling()
        this.setStatus('error')
        this.emit('error', '二维码已过期，请重新获取')
        return
      }
      if (status === 'success') {
        const botid = payload.data?.bot_info?.botid
        const secret = payload.data?.bot_info?.secret
        if (!botid || !secret) {
          this.stopPolling()
          this.setStatus('error')
          this.emit('error', '扫码成功但未获取到 Bot 信息')
          return
        }
        this.stopPolling()
        const session: WecomSession = {
          botId: botid,
          secret,
          loginAt: Date.now(),
        }
        this.session = session
        await this.store.saveSession(session)
        log.info('QR bind success, starting WS…', maskBotId(botid))
        await this.startWsClient(botid, secret)
      }
    } catch (err) {
      // 单次失败忽略，等下次轮询
      log.warn('pollOnce error:', err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 启动 AI Bot WebSocket 客户端。
   */
  private async startWsClient(botId: string, secret: string): Promise<void> {
    this.disconnectWs()
    const client = new WSClient({
      botId,
      secret,
      maxReconnectAttempts: -1,
      heartbeatInterval: 30_000,
      logger: {
        debug: (m, ...a) => log.info('[WS]', m, ...a),
        info: (m, ...a) => log.info('[WS]', m, ...a),
        warn: (m, ...a) => log.warn('[WS]', m, ...a),
        error: (m, ...a) => log.error('[WS]', m, ...a),
      },
    })
    this.client = client

    client.on('connected', () => {
      if (this.stopping) return
      log.info('WS connected')
      this.setStatus('connected', this.getSessionPublic() ?? undefined)
    })
    client.on('disconnected', (reason: string) => {
      if (this.stopping) return
      log.warn('WS disconnected:', reason)
      // 保持 connected 语义上的「已配置」；重连由 SDK 处理
    })
    client.on('error', (err: Error) => {
      if (this.stopping) return
      log.error('WS error:', err?.message ?? err)
      this.emit('error', err?.message ?? String(err))
    })

    const handleInbound = (frame: unknown) => {
      const normalized = this.normalizeFrame(frame)
      if (normalized) this.emit('message', normalized)
    }
    client.on('message.text', handleInbound)
    client.on('message.voice', handleInbound)
    client.on('message.mixed', handleInbound)

    client.connect()
  }

  /**
   * 将 WS 帧规范化为 Channel 层可用的消息。
   */
  private normalizeFrame(frame: unknown): WecomNormalizedMessage | null {
    const f = frame as {
      body?: {
        msgid?: string
        chatid?: string
        chattype?: string
        msgtype?: string
        from?: { userid?: string; user_id?: string }
        text?: { content?: string }
        voice?: { content?: string }
        mixed?: { msg_item?: Array<{ msgtype?: string; text?: { content?: string } }> }
        create_time?: number
      }
    }
    const body = f?.body
    if (!body) return null

    const userId = body.from?.userid || body.from?.user_id || ''
    if (!userId) return null

    let text = ''
    const msgtype = body.msgtype ?? ''
    if (msgtype === MessageType.Text || msgtype === 'text') {
      text = body.text?.content?.trim() ?? ''
    } else if (msgtype === MessageType.Voice || msgtype === 'voice') {
      text = body.voice?.content?.trim() ?? ''
    } else if (msgtype === MessageType.Mixed || msgtype === 'mixed') {
      text =
        body.mixed?.msg_item
          ?.filter((i) => i.msgtype === 'text')
          .map((i) => i.text?.content ?? '')
          .join('\n')
          .trim() ?? ''
    }

    if (!text) return null

    const chatType = body.chattype === 'group' ? 'group' : 'single'
    const chatId = body.chatid || userId
    const createTime = body.create_time
    const timestamp =
      typeof createTime === 'number'
        ? createTime < 1e12
          ? createTime * 1000
          : createTime
        : Date.now()

    return {
      channel: 'wecom',
      channelUserId: userId,
      chatId,
      chatType,
      type: msgtype === 'voice' ? 'voice' : 'text',
      text,
      msgId: body.msgid ?? `wecom-${Date.now()}`,
      timestamp,
      rawFrame: frame,
    }
  }

  /**
   * 停止扫码轮询。
   */
  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.currentScode = null
  }

  /**
   * 断开 WS（不清除会话文件）。
   */
  private disconnectWs(): void {
    if (this.client) {
      try {
        this.client.disconnect()
      } catch {
        // ignore
      }
      this.client = null
    }
  }

  /**
   * 更新状态并通知渲染进程。
   */
  private setStatus(status: WecomLoginStatus, session?: WecomSessionPublic): void {
    this.status = status
    this.emit('statusChange', status, session ?? this.getSessionPublic())
  }
}
