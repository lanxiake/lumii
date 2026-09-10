/**
 * QbotLoginService - QQ 机器人扫码建应用 + Gateway WebSocket 长连接。
 *
 * 凭证 = AppID + AppSecret（创建于 q.qq.com）。扫码建应用走 QbotAppRegistration.liteCreateApp，
 * 失败降级凭证表单（saveCredentials 收尾）。长连接为 Discord 式 Gateway WS，不引停更的官方 SDK。
 *
 * Events: statusChange / qrcode / message / error
 */

import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { QbotSessionStore, type QbotSession } from './qbot-session-store.js'
import { liteCreateApp } from './qbot-app-registration.js'
import { saveInboundMedia } from './channel/media-pipeline.js'

const API_BASE = 'https://api.sgroup.qq.com'
const GATEWAY_PATH = '/gateway'
const ACCESS_TOKEN_PATH = '/app/getAppAccessToken'

export type QbotLoginStatus = 'idle' | 'waiting_qrcode' | 'waiting_credential' | 'connected' | 'error'

/** 渲染进程可见摘要（不含 appSecret） */
export interface QbotSessionPublic {
  appId: string
  appIdMasked: string
  loginAt: number
}

export interface QbotNormalizedMessage {
  channel: 'qbot'
  channelUserId: string
  chatId: string
  chatType: 'p2p' | 'group'
  type: 'text' | 'image' | 'file' | 'voice'
  text?: string
  mediaPath?: string
  fileName?: string
  msgId: string
  timestamp: number
  rawEvent: unknown
}

const log = {
  info: (...args: unknown[]) => console.log('[QbotLoginService]', ...args),
  warn: (...args: unknown[]) => console.warn('[QbotLoginService]', ...args),
  error: (...args: unknown[]) => console.error('[QbotLoginService]', ...args),
}

function maskAppId(appId: string): string {
  if (appId.length <= 10) return `${appId.slice(0, 4)}…`
  return `${appId.slice(0, 8)}…${appId.slice(-4)}`
}

/**
 * QQ 机器人扫码建应用 + 长连接服务。
 */
export class QbotLoginService extends EventEmitter {
  private store = new QbotSessionStore()
  private status: QbotLoginStatus = 'idle'
  private session: QbotSession | null = null
  private accessToken: string | null = null
  private ws: WebSocket | null = null
  private seq: number | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private stopping = false

  /** 语音转文字回调（主进程注入，QQ 语音消息转文字） */
  asrCallback: ((absPath: string) => Promise<string>) | null = null

  /** 启动时恢复本地会话并重连。 */
  async initialize(): Promise<void> {
    const saved = await this.store.loadSession()
    if (!saved) {
      this.setStatus('idle')
      return
    }
    this.session = saved
    log.info('Restored session, connecting gateway…', maskAppId(saved.appId))
    await this.startGateway(saved)
  }

  getStatus(): QbotLoginStatus {
    return this.status
  }

  getSessionPublic(): QbotSessionPublic | null {
    if (!this.session) return null
    return {
      appId: this.session.appId,
      appIdMasked: maskAppId(this.session.appId),
      loginAt: this.session.loginAt,
    }
  }

  /**
   * 扫码建应用（可选加速路径）。失败降级凭证表单。
   */
  async startLogin(): Promise<void> {
    this.stopping = false
    this.setStatus('waiting_qrcode')
    try {
      const { appId, appSecret } = await liteCreateApp(randomUUID())
      await this.finishCredentials(appId, appSecret)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('扫码建应用不可用，降级凭证表单:', msg)
      this.setStatus('waiting_credential')
      this.emit('error', '扫码建应用不可用，请去 q.qq.com 手动创建机器人并填写 AppID/AppSecret')
    }
  }

  /**
   * 凭证表单收尾（用户手填 AppID/AppSecret）。
   */
  async saveCredentials(appId: string, appSecret: string): Promise<void> {
    const id = appId.trim()
    const secret = appSecret.trim()
    if (!id || !secret) {
      this.setStatus('error')
      this.emit('error', 'AppID/AppSecret 不能为空')
      return
    }
    await this.finishCredentials(id, secret)
  }

  private async finishCredentials(appId: string, appSecret: string): Promise<void> {
    const session: QbotSession = { appId, appSecret, loginAt: Date.now() }
    this.session = session
    await this.store.saveSession(session)
    log.info('QQ 机器人凭证已保存', maskAppId(appId))
    await this.startGateway(session)
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.disconnect()
    await this.store.clearSession()
    this.session = null
    this.accessToken = null
    this.setStatus('idle')
  }

  /**
   * 回复文本：单聊 POST /v2/users/{openid}/messages；群聊 POST /v2/groups/{group_openid}/messages。
   */
  async replyText(
    chatId: string,
    text: string,
    chatType: 'p2p' | 'group' = 'p2p',
  ): Promise<boolean> {
    if (!this.accessToken) {
      log.warn('replyText: no access token')
      return false
    }
    const base = chatType === 'group' ? `/v2/groups/${chatId}` : `/v2/users/${chatId}`
    try {
      const resp = await fetch(`${API_BASE}${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify({
          content: text,
          msg_type: 0,
          msg_id: randomUUID(),
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (resp.ok) return true
      log.error('replyText failed:', resp.status, await resp.text().catch(() => ''))
      return false
    } catch (err) {
      log.error('replyText threw:', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * 换取 Access Token 并建立 Gateway 长连接。
   */
  private async startGateway(session: QbotSession): Promise<void> {
    this.disconnect()
    try {
      const tokenRes = await fetch(`${API_BASE}${ACCESS_TOKEN_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: session.appId, clientSecret: session.appSecret }),
        signal: AbortSignal.timeout(10_000),
      })
      const tokenPayload = (await tokenRes.json()) as {
        access_token?: string
        token?: string
        code?: number
      }
      const token = tokenPayload.access_token ?? tokenPayload.token
      if (!token) {
        throw new Error(`获取 Access Token 失败 (code=${tokenPayload.code ?? 'unknown'})`)
      }
      this.accessToken = token

      const gwRes = await fetch(`${API_BASE}${GATEWAY_PATH}`, {
        headers: { Authorization: `QQBot ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      const gwPayload = (await gwRes.json()) as { url?: string }
      if (!gwPayload.url) throw new Error('获取 Gateway 地址失败')
      this.connectWs(gwPayload.url, token)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('startGateway failed:', msg)
      this.setStatus('error')
      this.emit('error', msg)
    }
  }

  private connectWs(url: string, token: string): void {
    if (this.stopping) return
    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      if (this.stopping) return
      // Identify：op=2，token=`QQBot {AccessToken}` + intents（0=全部）
      ws.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: 0,
            shard: [0, 1],
          },
        }),
      )
    })

    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as {
          op?: number
          s?: number
          t?: string
          d?: unknown
        }
        this.handleFrame(frame)
      } catch (err) {
        log.warn('parse frame failed:', err instanceof Error ? err.message : String(err))
      }
    })

    ws.on('close', () => {
      if (this.stopping) return
      this.stopHeartbeat()
      log.warn('WS closed')
      this.setStatus('error')
    })

    ws.on('error', (err) => {
      if (this.stopping) return
      log.error('WS error:', err.message)
    })
  }

  private handleFrame(frame: { op?: number; s?: number; t?: string; d?: unknown }): void {
    if (frame.s != null) this.seq = frame.s
    switch (frame.op) {
      case 10: {
        // Hello：按服务端间隔心跳
        const interval = (frame.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41250
        this.stopHeartbeat()
        this.heartbeatTimer = setInterval(() => {
          this.ws?.send(JSON.stringify({ op: 1, d: this.seq }))
        }, interval)
        break
      }
      case 11:
        // 心跳 ACK，无动作
        break
      case 0: {
        // Dispatch：就绪或消息
        if (frame.t === 'READY') {
          this.setStatus('connected', this.getSessionPublic() ?? undefined)
          log.info('Gateway READY')
          return
        }
        const normalized = this.normalizeEvent(frame.t, frame.d)
        if (normalized) this.emit('message', normalized)
        break
      }
      case 7:
        // Reconnect：服务端要求重连
        this.ws?.close()
        break
      default:
        break
    }
  }

  /**
   * 归一化 AT_MESSAGE_CREATE（群/频道）与 C2C_MESSAGE_CREATE（单聊）。
   * 文本直接取 content；富媒体（attachments）下载落盘。
   */
  private async normalizeEvent(t: string | undefined, d: unknown): Promise<QbotNormalizedMessage | null> {
    if (t !== 'AT_MESSAGE_CREATE' && t !== 'C2C_MESSAGE_CREATE' && t !== 'DIRECT_MESSAGE_CREATE') return null
    const data = d as {
      id?: string
      timestamp?: string
      author?: { id?: string; user_openid?: string }
      content?: string
      msg_id?: string
      openid?: string
      group_openid?: string
      attachments?: Array<{ content_type?: string; url?: string; filename?: string }>
    }

    const openId = data.author?.user_openid ?? data.openid ?? data.author?.id
    if (!openId) return null
    const chatType: 'p2p' | 'group' = t === 'C2C_MESSAGE_CREATE' || t === 'DIRECT_MESSAGE_CREATE' ? 'p2p' : 'group'
    const chatId = data.group_openid ?? openId
    const timestamp = data.timestamp ? Number(data.timestamp) : Date.now()
    const msgId = data.msg_id ?? data.id ?? `qbot-${Date.now()}`
    const base = {
      channel: 'qbot' as const,
      channelUserId: openId,
      chatId,
      chatType,
      msgId,
      timestamp: timestamp < 1e12 ? timestamp * 1000 : timestamp,
      rawEvent: d,
    }

    const text = (data.content ?? '').trim()
    const attachment = data.attachments?.[0]
    if (!attachment) {
      if (!text) return null
      return { ...base, type: 'text', text }
    }

    // 富媒体：下载 URL 落盘；语音再转文字
    try {
      const resp = await fetch(attachment.url!, { signal: AbortSignal.timeout(60_000) })
      if (!resp.ok) return null
      const buffer = Buffer.from(await resp.arrayBuffer())
      const fileName = attachment.filename ?? `qbot_${Date.now()}`
      const localPath = await saveInboundMedia(fileName, buffer)
      const ct = attachment.content_type ?? ''
      if (ct.startsWith('image/')) return { ...base, type: 'image', mediaPath: localPath, fileName, text }
      if (ct.startsWith('audio/') || ct.startsWith('voice')) {
        // 语音：转文字（无 asr 时降级为媒体行）
        return { ...base, type: 'voice', mediaPath: localPath, fileName, text: text || undefined }
      }
      return { ...base, type: 'file', mediaPath: localPath, fileName, text }
    } catch (err) {
      log.warn('attachment download failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private disconnect(): void {
    this.stopHeartbeat()
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
  }

  private setStatus(status: QbotLoginStatus, session?: QbotSessionPublic): void {
    this.status = status
    this.emit('statusChange', status, session ?? this.getSessionPublic())
  }
}
