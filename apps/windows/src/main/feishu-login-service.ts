/**
 * FeishuLoginService - 飞书扫码新建机器人 + WebSocket 长连接收消息。
 *
 * 扫码：accounts.feishu.cn/oauth/v1/app/registration（init/begin/poll）
 * 连接：@larksuiteoapi/node-sdk WSClient + EventDispatcher
 *
 * Events: statusChange / qrcode / message / error
 */

import { EventEmitter } from 'events'
import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import * as Lark from '@larksuiteoapi/node-sdk'
import {
  beginAppRegistration,
  initAppRegistration,
  pollAppRegistrationOnce,
  type FeishuDomain,
} from './feishu-app-registration.js'
import { FeishuSessionStore, type FeishuSession } from './feishu-session-store.js'

export type FeishuLoginStatus =
  | 'idle'
  | 'waiting_qrcode'
  | 'scanned'
  | 'connected'
  | 'error'

/** 渲染进程可见摘要（不含 appSecret） */
export interface FeishuSessionPublic {
  appId: string
  appIdMasked: string
  domain: FeishuDomain
  openId?: string
  loginAt: number
}

export interface FeishuNormalizedMessage {
  channel: 'feishu'
  channelUserId: string
  chatId: string
  chatType: 'p2p' | 'group'
  type: 'text'
  text: string
  msgId: string
  timestamp: number
}

/** 走 im.image 上传并以 msg_type=image 发送的扩展名 */
const FEISHU_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

/** 飞书 im.file 支持的素材类型 */
type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

/** 扩展名 → 飞书 im.file file_type；未命中回落 stream */
const FEISHU_FILE_TYPES: Record<string, FeishuFileType> = {
  '.opus': 'opus',
  '.mp4': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
}

/**
 * 上传 file_type → 发送 msg_type。
 *
 * 飞书要求两者严格匹配：mp4 素材只能作为视频（media）发送、opus 只能作为语音（audio）
 * 发送，混用会返回 HTTP 400 / code 230055「文件上传时选择的类型与发送的消息类型不匹配」。
 */
const FEISHU_MSG_TYPE_BY_FILE_TYPE: Record<FeishuFileType, 'media' | 'audio' | 'file'> = {
  mp4: 'media',
  opus: 'audio',
  pdf: 'file',
  doc: 'file',
  xls: 'file',
  ppt: 'file',
  stream: 'file',
}

const log = {
  info: (...args: unknown[]) => console.log('[FeishuLoginService]', ...args),
  warn: (...args: unknown[]) => console.warn('[FeishuLoginService]', ...args),
  error: (...args: unknown[]) => console.error('[FeishuLoginService]', ...args),
}

/**
 * 脱敏 appId。
 */
function maskAppId(appId: string): string {
  if (appId.length <= 10) return `${appId.slice(0, 4)}…`
  return `${appId.slice(0, 8)}…${appId.slice(-4)}`
}

/**
 * 飞书扫码登录与长连接服务。
 */
export class FeishuLoginService extends EventEmitter {
  private store = new FeishuSessionStore()
  private status: FeishuLoginStatus = 'idle'
  private session: FeishuSession | null = null
  private httpClient: Lark.Client | null = null
  private wsClient: Lark.WSClient | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private pollAbort = false
  private stopping = false

  /**
   * 启动时恢复本地会话并重连。
   */
  async initialize(): Promise<void> {
    const saved = await this.store.loadSession()
    if (!saved) {
      this.setStatus('idle')
      return
    }
    this.session = saved
    log.info('Restored session, connecting WS…', maskAppId(saved.appId))
    await this.startClients(saved)
  }

  /**
   * 当前状态。
   */
  getStatus(): FeishuLoginStatus {
    return this.status
  }

  /**
   * 渲染进程可见会话摘要。
   */
  getSessionPublic(): FeishuSessionPublic | null {
    if (!this.session) return null
    return {
      appId: this.session.appId,
      appIdMasked: maskAppId(this.session.appId),
      domain: this.session.domain,
      openId: this.session.openId,
      loginAt: this.session.loginAt,
    }
  }

  /**
   * 发起扫码新建机器人。
   */
  async startLogin(): Promise<void> {
    this.stopPolling()
    this.pollAbort = false
    this.stopping = false
    this.setStatus('waiting_qrcode')

    try {
      await initAppRegistration('feishu')
      const begin = await beginAppRegistration('feishu')
      const dataUrl = await QRCode.toDataURL(begin.qrUrl, { width: 256, margin: 1 })
      this.emit('qrcode', dataUrl)
      void this.runPollLoop({
        deviceCode: begin.deviceCode,
        intervalSec: begin.interval,
        expireInSec: begin.expireIn,
        domain: 'feishu',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('startLogin failed:', msg)
      this.setStatus('error')
      this.emit('error', msg)
    }
  }

  /**
   * 断开并清除本地凭证。
   */
  async logout(): Promise<void> {
    this.stopping = true
    this.stopPolling()
    this.disconnectClients()
    await this.store.clearSession()
    this.session = null
    this.setStatus('idle')
  }

  /**
   * 回复文本消息（优先 reply，失败则 create）。
   */
  async replyText(msgId: string, chatId: string, _chatType: 'p2p' | 'group', text: string): Promise<boolean> {
    if (!this.httpClient) {
      log.warn('replyText: HTTP client not ready')
      return false
    }
    const content = JSON.stringify({ text })
    try {
      const replyRes = await this.httpClient.im.message.reply({
        path: { message_id: msgId },
        data: { content, msg_type: 'text' },
      })
      if (replyRes.code === 0) return true
      log.warn('reply failed, fallback create:', replyRes.code, replyRes.msg)
    } catch (err) {
      log.warn('reply threw, fallback create:', err instanceof Error ? err.message : String(err))
    }

    try {
      const createRes = await this.httpClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content, msg_type: 'text' },
      })
      if (createRes.code === 0) return true
      log.error('create message failed:', createRes.code, createRes.msg)
      return false
    } catch (err) {
      log.error('create message threw:', err instanceof Error ? err.message : String(err))
      return false
    }
  }

  /**
   * 主动推送文本（无需入站消息）。
   *
   * @param text 文本内容
   * @param to 可选收件人 open_id；缺省为登录会话的 openId
   */
  async pushText(text: string, to?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.httpClient) return { ok: false, error: '飞书未连接' }
    const receiveId = (to?.trim() || this.session?.openId || '').trim()
    if (!receiveId) return { ok: false, error: '飞书会话缺少 openId，请重新扫码登录' }
    try {
      const res = await this.httpClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: { receive_id: receiveId, content: JSON.stringify({ text }), msg_type: 'text' },
      })
      if (res.code === 0) return { ok: true }
      log.error('pushText failed:', res.code, res.msg)
      return { ok: false, error: `飞书返回 ${res.code}: ${res.msg}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('pushText threw:', msg)
      return { ok: false, error: msg }
    }
  }

  /**
   * 主动推送本地文件：图片走 im.image + msg_type=image；其余走 im.file，
   * 并按上传的 file_type 选择匹配的 msg_type（mp4→media、opus→audio、其余→file）。
   *
   * @param filePath 本地绝对路径
   * @param to 可选收件人 open_id；缺省为登录会话的 openId
   * @param fileName 展示文件名，缺省取 basename
   */
  async pushMedia(
    filePath: string,
    to?: string,
    fileName?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.httpClient) return { ok: false, error: '飞书未连接' }
    const receiveId = (to?.trim() || this.session?.openId || '').trim()
    if (!receiveId) return { ok: false, error: '飞书会话缺少 openId，请重新扫码登录' }

    const name = fileName?.trim() || path.basename(filePath)
    const ext = path.extname(name).toLowerCase()
    const isImage = FEISHU_IMAGE_EXTS.has(ext)
    const fileType = FEISHU_FILE_TYPES[ext] ?? 'stream'
    try {
      const uploaded = isImage
        ? await this.uploadImage(filePath)
        : await this.uploadFile(filePath, name, fileType)
      if (!uploaded.ok) return uploaded

      const res = await this.httpClient.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: receiveId,
          msg_type: isImage ? 'image' : FEISHU_MSG_TYPE_BY_FILE_TYPE[fileType],
          content: JSON.stringify(
            isImage ? { image_key: uploaded.key } : { file_key: uploaded.key },
          ),
        },
      })
      if (res.code === 0) return { ok: true }
      log.error('pushMedia send failed:', res.code, res.msg)
      return { ok: false, error: `飞书返回 ${res.code}: ${res.msg}` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('pushMedia threw:', msg)
      return { ok: false, error: msg }
    }
  }

  /**
   * 上传图片素材，返回 image_key。
   */
  private async uploadImage(
    filePath: string,
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    const res = (await this.httpClient!.im.image.create({
      data: { image_type: 'message', image: fs.createReadStream(filePath) },
    })) as {
      code?: number
      msg?: string
      data?: { image_key?: string }
      image_key?: string
    } | null
    const key = res?.data?.image_key ?? res?.image_key
    if (res && (res.code === undefined || res.code === 0) && key) return { ok: true, key }
    log.error('uploadImage failed:', res?.code, res?.msg)
    return { ok: false, error: `飞书图片上传失败 ${res?.code ?? 'unknown'}: ${res?.msg ?? '缺少 image_key'}` }
  }

  /**
   * 上传文件素材，返回 file_key。
   */
  private async uploadFile(
    filePath: string,
    fileName: string,
    fileType: FeishuFileType,
  ): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
    const res = (await this.httpClient!.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fs.createReadStream(filePath),
      },
    })) as {
      code?: number
      msg?: string
      data?: { file_key?: string }
      file_key?: string
    } | null
    const key = res?.data?.file_key ?? res?.file_key
    if (res && (res.code === undefined || res.code === 0) && key) return { ok: true, key }
    log.error('uploadFile failed:', res?.code, res?.msg)
    return { ok: false, error: `飞书文件上传失败 ${res?.code ?? 'unknown'}: ${res?.msg ?? '缺少 file_key'}` }
  }

  /**
   * 轮询扫码结果直至成功/拒绝/过期。
   */
  private async runPollLoop(params: {
    deviceCode: string
    intervalSec: number
    expireInSec: number
    domain: FeishuDomain
  }): Promise<void> {
    let intervalSec = Math.max(params.intervalSec, 3)
    let domain = params.domain
    const deadline = Date.now() + params.expireInSec * 1000

    const tick = async () => {
      if (this.pollAbort || this.stopping) return
      if (Date.now() > deadline) {
        this.setStatus('error')
        this.emit('error', '二维码已过期，请重新获取')
        return
      }

      const outcome = await pollAppRegistrationOnce({
        deviceCode: params.deviceCode,
        domain,
      })

      if (outcome.domain && outcome.domain !== domain) {
        domain = outcome.domain
      }

      if (outcome.status === 'success') {
        const { appId, appSecret, openId } = outcome.result
        const session: FeishuSession = {
          appId,
          appSecret,
          domain: outcome.result.domain,
          openId,
          loginAt: Date.now(),
        }
        this.session = session
        await this.store.saveSession(session)
        log.info('QR bind success, starting WS…', maskAppId(appId))
        await this.startClients(session)
        return
      }

      if (outcome.status === 'access_denied') {
        this.setStatus('error')
        this.emit('error', '用户在飞书端拒绝了授权')
        return
      }
      if (outcome.status === 'expired') {
        this.setStatus('error')
        this.emit('error', '二维码已过期，请重新获取')
        return
      }
      if (outcome.status === 'error' && outcome.message && !outcome.message.includes('fetch')) {
        // 非瞬时错误
        this.setStatus('error')
        this.emit('error', outcome.message)
        return
      }

      // pending / 瞬时网络错误：继续轮询
      if (this.status === 'waiting_qrcode') {
        // 飞书无单独 scanned 状态；保持 waiting 即可
      }
      this.pollTimer = setTimeout(() => {
        void tick()
      }, intervalSec * 1000)
    }

    this.pollTimer = setTimeout(() => {
      void tick()
    }, intervalSec * 1000)
  }

  /**
   * 启动 HTTP Client + WSClient。
   */
  private async startClients(session: FeishuSession): Promise<void> {
    this.disconnectClients()

    const domain =
      session.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu

    this.httpClient = new Lark.Client({
      appId: session.appId,
      appSecret: session.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
    })

    const dispatcher = new Lark.EventDispatcher({})
    dispatcher.register({
      'im.message.receive_v1': async (data) => {
        const normalized = this.normalizeMessageEvent(data)
        if (normalized) this.emit('message', normalized)
      },
    })

    this.wsClient = new Lark.WSClient({
      appId: session.appId,
      appSecret: session.appSecret,
      domain,
      loggerLevel: Lark.LoggerLevel.info,
    })

    try {
      void this.wsClient.start({ eventDispatcher: dispatcher })
      if (!this.stopping) {
        this.setStatus('connected', this.getSessionPublic() ?? undefined)
        log.info('WS started')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('WS start failed:', msg)
      this.setStatus('error')
      this.emit('error', msg)
    }
  }

  /**
   * 将飞书消息事件规范化。
   */
  private normalizeMessageEvent(data: unknown): FeishuNormalizedMessage | null {
    const event = data as {
      sender?: { sender_id?: { open_id?: string }; sender_type?: string }
      message?: {
        message_id?: string
        chat_id?: string
        chat_type?: string
        message_type?: string
        content?: string
        create_time?: string
      }
    }

    const msg = event?.message
    if (!msg?.message_id || !msg.chat_id) return null
    if (event.sender?.sender_type === 'bot') return null

    const openId = event.sender?.sender_id?.open_id
    if (!openId) return null

    if (msg.message_type !== 'text') {
      log.info('Skip non-text message:', msg.message_type)
      return null
    }

    let text = ''
    try {
      const parsed = JSON.parse(msg.content ?? '{}') as { text?: string }
      text = (parsed.text ?? '').trim()
    } catch {
      return null
    }
    if (!text) return null

    const chatType = msg.chat_type === 'group' ? 'group' : 'p2p'
    const createMs = msg.create_time ? Number(msg.create_time) : Date.now()

    return {
      channel: 'feishu',
      channelUserId: openId,
      chatId: msg.chat_id,
      chatType,
      type: 'text',
      text,
      msgId: msg.message_id,
      timestamp: createMs < 1e12 ? createMs * 1000 : createMs,
    }
  }

  /**
   * 停止轮询。
   */
  private stopPolling(): void {
    this.pollAbort = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 断开 WS / HTTP 客户端。
   */
  private disconnectClients(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close()
      } catch {
        // ignore
      }
      this.wsClient = null
    }
    this.httpClient = null
  }

  /**
   * 更新状态并通知渲染进程。
   */
  private setStatus(status: FeishuLoginStatus, session?: FeishuSessionPublic): void {
    this.status = status
    this.emit('statusChange', status, session ?? this.getSessionPublic())
  }
}
