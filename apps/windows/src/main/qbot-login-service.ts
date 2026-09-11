/**
 * QbotLoginService - QQ 机器人扫码绑定 + Gateway WebSocket 长连接。
 *
 * 凭证 = AppID + AppSecret。扫码绑定走腾讯官方 @tencent-connect/qqbot-connector：
 * 用户用手机 QQ 扫码后 SDK 直接回吐凭证，无需手抄；失败降级凭证表单（saveCredentials 收尾）。
 * 长连接为 Discord 式 Gateway WS，不引停更的官方 SDK。
 *
 * Events: statusChange / qrcode / message / error
 */

import { EventEmitter } from 'events'
import QRCode from 'qrcode'
import WebSocket from 'ws'
import { startQrConnect } from '@tencent-connect/qqbot-connector'
import path from 'node:path'
import { QbotSessionStore, type QbotSession } from './qbot-session-store.js'
import {
  saveInboundMedia,
  transcriptLine,
  looksLikeAudio,
  describeHead,
} from './channel/media-pipeline.js'
import { resolveActiveWorkspaceDir } from './workspace-paths.js'

const API_BASE = 'https://api.bot.qq.com'
const GATEWAY_PATH = '/gateway'
const ACCESS_TOKEN_PATH = '/app/getAppAccessToken'

/**
 * 扫码页展示的接入方标识。留空时腾讯扫码页统一显示「第三方机器人」。
 * 想显示「Lumii」需先向 qq_bot_api@tencent.com 报备并拿到分配的 source，
 * 未报备的值不会生效，故这里保持留空。
 */
const QR_CONNECT_SOURCE = ''

/**
 * QQ Bot Gateway Intents 位图。
 *
 * 官方文档：https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 *
 * | intents 位            | 位    | 覆盖事件                                        |
 * |-----------------------|-------|------------------------------------------------|
 * | GUILDS                | 1<<0  | 频道/子频道增删改                               |
 * | GUILD_MEMBERS         | 1<<1  | 频道成员增删改                                  |
 * | GUILD_MESSAGES        | 1<<9  | 频道全量消息 —— 仅「私域」机器人可设，普通机器人设了会被拒 |
 * | DIRECT_MESSAGE        | 1<<12 | 频道私信                                        |
 * | GROUP_AND_C2C         | 1<<25 | C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE 等 |
 * | INTERACTION           | 1<<26 | 按钮回调                                        |
 * | PUBLIC_GUILD_MESSAGES | 1<<30 | 频道 @ 消息（公域）                             |
 *
 * 取值与官方 SDK @tencent-connect/qqbot-nodejs 的 FULL_INTENTS 对齐。
 * 注意不要加 1<<9：那是私域专属位，普通机器人带上它 Identify 会被
 * Gateway 以 op=9 + close 4014「disallowed intents」直接拒绝。
 */
const GATEWAY_INTENTS =
  (1 << 0) |   // GUILDS
  (1 << 1) |   // GUILD_MEMBERS
  (1 << 12) |  // DIRECT_MESSAGE（频道私信）
  (1 << 25) |  // GROUP_AND_C2C（QQ 单聊 + 群聊 @）
  (1 << 26) |  // INTERACTION
  (1 << 30)    // PUBLIC_GUILD_MESSAGES（公域频道 @ 消息）

/**
 * 降级 intents：只保留 QQ 单聊 + 群聊，这是本产品的核心场景。
 * 机器人未开通频道能力时，完整掩码会被拒（4014），此时用它重试一次。
 */
const GATEWAY_INTENTS_MINIMAL = 1 << 25

/** 被动回复窗口：QQ 规定入站消息 5 分钟内可免费回复 */
const PASSIVE_REPLY_WINDOW_MS = 5 * 60 * 1000

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
  /** 扫码轮询的中止句柄，由 startQrConnect 返回 */
  private qrDispose: (() => void) | null = null
  /** 本次连接使用的 intents，被 4014 拒绝后会降级（见 ws close 处理） */
  private intents = GATEWAY_INTENTS
  /** chatId -> 最近入站消息，供被动回复回带 msg_id + 递增 msg_seq */
  private lastInbound = new Map<string, { msgId: string; at: number; seq: number }>()

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
   * 扫码绑定：手机 QQ 扫码后由官方 connector 直接回吐 AppID/AppSecret。
   *
   * 二维码过期由 SDK 内部自动重建任务并再次触发 onQrDisplayed，无需外部续期。
   * 前提是该 QQ 账号下已在 q.qq.com 创建过机器人，扫码时选择要绑定的那只。
   * 任何失败都降级到凭证表单，保留手填通路。
   */
  async startLogin(): Promise<void> {
    this.stopping = false
    this.cancelQrLogin()
    this.setStatus('waiting_qrcode')

    this.qrDispose = startQrConnect(
      {
        onQrDisplayed: (url) => {
          void QRCode.toDataURL(url, { width: 256, margin: 1 })
            .then((dataUrl) => this.emit('qrcode', dataUrl))
            .catch((err) => {
              log.warn('二维码渲染失败:', err instanceof Error ? err.message : String(err))
            })
        },
        onSuccess: (credentials) => {
          this.qrDispose = null
          // 当前扫码固定返回单个机器人，数组形态是官方为后续多绑预留的
          const bound = credentials[0]
          if (!bound) {
            this.setStatus('waiting_credential')
            this.emit('error', '扫码未返回机器人凭证，请改用 AppID/AppSecret 手动接入')
            return
          }
          log.info('扫码绑定成功', maskAppId(bound.appId))
          void this.finishCredentials(bound.appId, bound.appSecret).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            log.error('扫码凭证落盘失败:', msg)
            this.setStatus('error')
            this.emit('error', msg)
          })
        },
        onFailure: (err) => {
          this.qrDispose = null
          if (this.stopping) return
          log.warn('扫码绑定失败，降级凭证表单:', err.message)
          this.setStatus('waiting_credential')
          this.emit('error', `扫码绑定失败（${err.message}），可去 q.qq.com 获取 AppID/AppSecret 手动接入`)
        },
        onQrExpired: () => {
          log.info('二维码已过期，SDK 正在自动刷新')
        },
      },
      { displayQrCodeToConsole: false, source: QR_CONNECT_SOURCE },
    )
  }

  /** 中止进行中的扫码轮询（重新扫码或登出时调用）。 */
  private cancelQrLogin(): void {
    if (!this.qrDispose) return
    try {
      this.qrDispose()
    } catch {
      // ignore
    }
    this.qrDispose = null
  }

  /**
   * 凭证表单收尾（用户手填 AppID/AppSecret）。
   */
  async saveCredentials(appId: string, appSecret: string): Promise<void> {
    // 用户选了手填通路，停掉可能还在轮询的扫码任务
    this.cancelQrLogin()
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
    // 换了机器人，能力可能不同，intents 回到完整掩码重新探测
    this.intents = GATEWAY_INTENTS
    await this.store.saveSession(session)
    log.info('QQ 机器人凭证已保存', maskAppId(appId))
    await this.startGateway(session)
  }

  async logout(): Promise<void> {
    this.stopping = true
    this.cancelQrLogin()
    this.disconnect()
    await this.store.clearSession()
    this.session = null
    this.accessToken = null
    this.setStatus('idle')
  }

  /**
   * 回复文本：单聊 POST /v2/users/{openid}/messages；群聊 POST /v2/groups/{group_openid}/messages。
   *
   * QQ 的回复分两种：
   * - 被动回复：回带入站消息的 msg_id，免费，窗口 5 分钟、每条最多 5 条回复。
   *   同一 msg_id 发多条必须递增 msg_seq，否则服务端按重复消息拒掉。
   * - 主动推送：不带 msg_id，需要用户开启主动消息且有配额，容易失败。
   *
   * 所以优先走被动回复；只有窗口过期才退化成主动推送。
   * 注意别塞随机 msg_id —— 那既不是被动也不是主动，服务端会直接拒。
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
    const body: Record<string, unknown> = { content: text, msg_type: 0 }

    const inbound = this.lastInbound.get(chatId)
    if (inbound && Date.now() - inbound.at < PASSIVE_REPLY_WINDOW_MS) {
      inbound.seq += 1
      body.msg_id = inbound.msgId
      body.msg_seq = inbound.seq
    } else {
      log.warn(`replyText: 被动回复窗口已过期，改为主动推送 chatId=${chatId}`)
    }

    try {
      const resp = await fetch(`${API_BASE}${base}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `QQBot ${this.accessToken}`,
        },
        body: JSON.stringify(body),
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

  /** 记录入站消息，供被动回复回带 msg_id。 */
  private rememberInbound(msg: QbotNormalizedMessage): void {
    this.lastInbound.set(msg.chatId, { msgId: msg.msgId, at: Date.now(), seq: 0 })
    // 防止长期运行下无界增长：清掉过期条目
    if (this.lastInbound.size > 200) {
      const cutoff = Date.now() - PASSIVE_REPLY_WINDOW_MS
      for (const [key, val] of this.lastInbound) {
        if (val.at < cutoff) this.lastInbound.delete(key)
      }
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
      // Identify：op=2，token=`QQBot {AccessToken}` + intents
      const identify = {
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [0, 1],
          properties: {
            $os: process.platform,
            $browser: 'lumii',
            $device: 'lumii',
          },
        },
      }
      log.info('WS open, sending Identify intents=' + this.intents)
      ws.send(JSON.stringify(identify))
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

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.stopping) return
      this.stopHeartbeat()
      log.warn(`WS closed code=${code} reason="${reason?.toString() ?? ''}"`)

      // 4014 = disallowed intents：这只机器人没开通我们申请的某些能力
      // （典型是未开通频道）。降级到「仅单聊 + 群聊」重试一次，保住核心场景。
      if (code === 4014 && this.intents !== GATEWAY_INTENTS_MINIMAL && this.session) {
        this.intents = GATEWAY_INTENTS_MINIMAL
        log.warn(`intents 被拒，降级为仅 QQ 单聊/群聊 (${GATEWAY_INTENTS_MINIMAL}) 重试`)
        void this.startGateway(this.session)
        return
      }

      this.setStatus('error')
      if (code === 4014) {
        this.emit('error', '机器人未开通所需能力（intents 被拒），请在 q.qq.com 检查机器人配置')
      } else if (code === 4004 || code === 4003) {
        this.emit('error', 'Gateway 鉴权失败，请检查 AppID/AppSecret 是否正确')
      } else {
        this.emit('error', `Gateway 连接断开 (code=${code})`)
      }
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
        // normalizeEvent 是 async（富媒体要下载落盘），必须等它 resolve 再 emit。
        // 直接 emit 返回值会把 Promise 当消息发出去，下游拿到的字段全是 undefined。
        void this.normalizeEvent(frame.t, frame.d)
          .then((normalized) => {
            if (!normalized) return
            // 先记下 msg_id，回复走被动回复才免费
            this.rememberInbound(normalized)
            this.emit('message', normalized)
          })
          .catch((err) => {
            log.warn('normalizeEvent failed:', err instanceof Error ? err.message : String(err))
          })
        break
      }
      case 7:
        // Reconnect：服务端要求重连
        log.warn('Gateway 要求重连 (op=7)')
        this.ws?.close()
        break
      case 9: {
        // Invalid Session：Identify 被拒绝或 session 不可恢复
        const canResume = (frame.d as boolean) ?? false
        log.warn(`Invalid Session (op=9), canResume=${canResume}`)
        if (!canResume) {
          // 不可恢复，停止心跳。具体原因交给紧随其后的 close 事件判断：
          // 4014 是 intents 被拒（可降级重试），4004 才是凭证问题。
          // 这里不抢先 emit，否则 intents 问题会被误报成 AppID/AppSecret 错误。
          this.stopHeartbeat()
        }
        break
      }
      default:
        break
    }
  }

  /**
   * 归一化四类入站消息：
   * - C2C_MESSAGE_CREATE      QQ 单聊（author.user_openid）
   * - GROUP_AT_MESSAGE_CREATE QQ 群里 @ 机器人（author.member_openid + group_openid）
   * - AT_MESSAGE_CREATE       频道 @ 消息
   * - DIRECT_MESSAGE_CREATE   频道私信
   *
   * 文本直接取 content；富媒体（attachments）下载落盘。
   */
  private async normalizeEvent(t: string | undefined, d: unknown): Promise<QbotNormalizedMessage | null> {
    const P2P_EVENTS = ['C2C_MESSAGE_CREATE', 'DIRECT_MESSAGE_CREATE']
    const GROUP_EVENTS = ['GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE']
    if (!t || (!P2P_EVENTS.includes(t) && !GROUP_EVENTS.includes(t))) return null
    const data = d as {
      id?: string
      timestamp?: string
      author?: { id?: string; user_openid?: string; member_openid?: string }
      content?: string
      msg_id?: string
      openid?: string
      group_openid?: string
      attachments?: Array<{ content_type?: string; url?: string; filename?: string }>
    }

    // 群聊用 member_openid，单聊用 user_openid
    const openId =
      data.author?.user_openid ?? data.author?.member_openid ?? data.openid ?? data.author?.id
    if (!openId) return null
    const chatType: 'p2p' | 'group' = P2P_EVENTS.includes(t) ? 'p2p' : 'group'
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
      log.info(`纯文本消息 t=${t} textLen=${text.length}`)
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

      // QQ 的 content_type / filename 都不可靠，最终以 buffer 魔数为准
      const isVoice =
        ct.startsWith('audio/') ||
        ct.startsWith('voice') ||
        /\.(silk|amr|slk)$/i.test(fileName) ||
        looksLikeAudio(buffer)
      log.info(
        `附件: content_type="${ct}" filename="${fileName}" size=${buffer.length} ` +
          `${describeHead(buffer)} -> ${isVoice ? 'voice' : 'file'}`,
      )
      if (isVoice) {
        // 语音转文字：QQ 是 SILK，由 media-pipeline 嗅探格式后走 silk-sdk
        const absPath = path.join(resolveActiveWorkspaceDir(), localPath)
        const transcript = this.asrCallback ? await this.asrCallback(absPath) : ''
        if (!transcript) {
          log.warn('语音转录为空，降级为媒体行交给 Agent')
        }
        // 转录成功则把文字并进 text，Agent 才拿得到语音内容；失败保持原样只留媒体行
        const merged = [text, transcript ? transcriptLine(transcript) : '']
          .filter(Boolean)
          .join('\n')
        return { ...base, type: 'voice', mediaPath: localPath, fileName, text: merged || undefined }
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
