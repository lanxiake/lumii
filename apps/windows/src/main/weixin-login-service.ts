/**
 * WeixinLoginService - Manages WeChat Personal (iLink) login flow and message polling.
 *
 * API reference: https://github.com/pzx521521/openclaw-weixin-cli （第三方微信 iLink 协议实现）
 *
 * Key differences from the old ilink-bot.shab.cn API:
 * - Base URL: https://ilinkai.weixin.qq.com (host root — paths are /ilink/bot/..., not /api/ilink/...)
 * - Login returns bot_token + ilink_bot_id + dynamic baseurl
 * - All requests require Authorization: Bearer <bot_token>
 * - getUpdates is a POST with JSON body (not GET with query params)
 * - sendmessage uses nested item_list structure
 *
 * Events emitted:
 * - "statusChange"  (status: WeixinLoginStatus, session?: WeixinSession)
 * - "qrcode"        (dataUrl: string)
 * - "message"       (msg: WeixinNormalizedMessage)
 * - "error"         (message: string)
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'events'
import QRCode from 'qrcode'
import { WeixinSessionStore } from './weixin-session-store.js'
import type { WeixinSession } from './weixin-session-store.js'
import { resolveClientStateDir } from './paths.js'
import {
  WeixinAuthError,
  normalizeIlinkBaseUrl,
  buildMediaFallbackText,
  extractMediaFileKey,
  extractMediaCrypto,
  downloadAndSaveMediaItems,
  isQrLoginComplete,
  isQrScannedPendingConfirm,
  isQrExpiredStatus,
} from './weixin-message-utils.js'
import type { QRStatusResponse, WeixinRawMessage, GetUpdatesResponse } from './weixin-message-utils.js'
import { apiFetchQrCode, apiPollLoginStatus, apiGetUpdates } from './weixin-ilink-api.js'
import { sendMediaReply as sendMediaReplyImpl, apiSendTextChunk } from './weixin-media-reply.js'

const ILINK_DEFAULT_URL = 'https://ilinkai.weixin.qq.com'

// iLink 的 bot_type：用于指定 get_bot_qrcode 返回对应的登录二维码类型
// 参考公开资料：个人微信 ClawBot 场景 bot_type=3
const CHECK_LOGIN_INTERVAL_MS = 2_000
const POLL_RETRY_DELAY_MS = 5_000
const LONG_POLL_TIMEOUT_MS = 35_000

export type WeixinLoginStatus =
  | 'idle'
  | 'waiting_qrcode'
  | 'scanned'
  | 'confirmed'
  | 'logged_in'
  | 'error'

export interface WeixinNormalizedMessage {
  channel: 'weixin'
  channelUserId: string
  type: 'text' | 'media'
  text?: string
  mediaUrl?: string
  /**
   * 用户是否真的发了文字（含 iLink 回传的语音转录 voice_item.text / SILK ASR 结果）。
   * `text` 在纯媒体消息上会被填入 buildMediaFallbackText 占位描述，无法据此判断，
   * 下游（如渠道适配器判定"纯媒体缓存"）必须用这个字段。
   */
  hasUserText: boolean
  /** Structured media items extracted from item_list (type 2/3/4/5) */
  mediaItems?: Array<{
    type: 2 | 3 | 4 | 5
    fileKey: string
    fileName?: string
    encryptQueryParam?: string
    aesKey?: string
    /**
     * Windows 客户端预下载并保存到本地的文件路径（相对于设备工作空间根目录）。
     * 格式示例：uploads/20250129/工作清单.md
     * Gateway 通过 RFS 协议从设备节点读取此文件后传给 Agent。
     */
    localPath?: string
  }>
  raw: unknown
  timestamp: number
  accountId?: string
  /** iLink bot_token for sending replies (injected by Windows client). */
  botToken?: string
  /** iLink dynamic base URL for sending replies (injected by Windows client). */
  ilinkBaseUrl?: string
  /**
   * iLink context_token from the inbound message.
   * Required for reply delivery — server uses this for session routing.
   */
  contextToken?: string
}

export class WeixinLoginService extends EventEmitter {
  private sessionStore: WeixinSessionStore
  private status: WeixinLoginStatus = 'idle'
  /** 串行扫码状态轮询，避免 setInterval 叠加上一请求未结束又发新请求 */
  private checkLoginLoopRunning = false
  /** 最近一次 get_qrcode_status 返回的状态，用于降噪日志 */
  private lastLoginCheckStatus: string | null = null
  /** 取消当前扫码状态请求（重新登录 / 退出登录时） */
  private loginPollAbort: AbortController | null = null
  private pollingAbortController: AbortController | null = null
  private currentQrcode: string | null = null
  private baseUrl: string
  private accountId: string
  /** SILK ASR 转录回调，由外部注入（主进程注入 voiceCallService.transcribePcm） */
  silkAsrCallback: ((samples: Float32Array, sampleRate: number) => Promise<string>) | null = null

  constructor(opts?: { baseUrl?: string; accountId?: string }) {
    super()
    this.sessionStore = new WeixinSessionStore()
    const rawBase =
      opts?.baseUrl ?? process.env.MTBOT_WEIXIN_BASE_URL ?? ILINK_DEFAULT_URL
    this.baseUrl = normalizeIlinkBaseUrl(rawBase)
    this.accountId = opts?.accountId ?? 'default'
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    console.info('[WeixinLogin] Initializing')
    const savedSession = await this.sessionStore.loadSession()
    if (savedSession) {
      if (savedSession.baseUrl) this.baseUrl = normalizeIlinkBaseUrl(savedSession.baseUrl)
      // Verify the saved token is still valid with a quick probe before entering polling.
      // A 401/403 here means the token expired on the server side before our 30-day
      // client-side cutoff — clear the session so the UI prompts re-login immediately.
      const valid = await this.probeSession(savedSession)
      if (valid) {
        this.setStatus('logged_in', savedSession)
        this.startPolling(savedSession)
      } else {
        await this.sessionStore.clearSession()
        this.setStatus('idle')
        this.emit('error', 'session_expired')
      }
    } else {
      this.setStatus('idle')
    }
  }

  /**
   * Probe whether a saved session token is still accepted by the iLink server.
   * Sends a single getupdates request with a short timeout; returns false on
   * auth errors (401/403) and true on success or non-auth errors (network, 5xx).
   */
  private async probeSession(session: WeixinSession): Promise<boolean> {
    try {
      await this.apiGetUpdates(session, '', AbortSignal.timeout(8_000))
      return true
    } catch (err) {
      if (err instanceof WeixinAuthError) {
        console.warn('[WeixinLogin] Probe: session token rejected by server (', err.statusCode, '), need re-login')
        return false
      }
      // Network errors / timeouts: assume valid and let the poll loop handle it
      console.warn('[WeixinLogin] Probe: non-auth error, assuming valid:', err instanceof Error ? err.message : err)
      return true
    }
  }

  async startLogin(): Promise<string> {
    console.info('[WeixinLogin] Starting login flow')
    this.setStatus('waiting_qrcode')

    try {
      console.info('[WeixinLogin] Fetching iLink bot qrcode...')
      /** 获取扫码二维码的“扫码用key(qrcode)”与“二维码图片内容(qrcode_img_content)” */
      const { qrcode, qrcode_img_content } = await this.apiFetchQrCode()
      this.currentQrcode = qrcode

      /**
       * 生成弹窗里展示的二维码 data URL。
       * - `qrcode_img_content` 常为 https://liteapp.weixin.qq.com/... 短链：不能直接作 `<img src>`（Electron 内易跨域/鉴权失败导致裂图），应把**整段 URL**编码进二维码矩阵。
       * - 若为 data: 或裸 base64，则直接作为图片源。
       */
      let qrcodeImgSrc: string
      if (qrcode_img_content) {
        console.info('[WeixinLogin] Using qrcode_img_content, preview=', qrcode_img_content.slice(0, 40), 'len=', qrcode_img_content.length)
        if (qrcode_img_content.startsWith('data:')) {
          qrcodeImgSrc = qrcode_img_content
        } else if (qrcode_img_content.startsWith('http://') || qrcode_img_content.startsWith('https://')) {
          qrcodeImgSrc = await QRCode.toDataURL(qrcode_img_content, { width: 256, margin: 2 })
          console.info('[WeixinLogin] Encoded liteapp URL into QR matrix, dataUrl len=', qrcodeImgSrc.length)
        } else {
          qrcodeImgSrc = qrcode_img_content.startsWith('base64,')
            ? `data:image/png;${qrcode_img_content}`
            : `data:image/png;base64,${qrcode_img_content}`
        }
      } else {
        const fallbackDataUrl = await QRCode.toDataURL(qrcode, { width: 256, margin: 2 })
        console.warn('[WeixinLogin] Missing qrcode_img_content, fallback to encode qrcode key. len=', fallbackDataUrl?.length)
        qrcodeImgSrc = fallbackDataUrl
      }

      console.info('[WeixinLogin] Qrcode ready for UI, src length=', qrcodeImgSrc?.length)
      this.emit('qrcode', qrcodeImgSrc)
      this.setStatus('scanned')

      this.startCheckLoginLoop(qrcode)
      return qrcodeImgSrc
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[WeixinLogin] startLogin failed:', err)
      this.setStatus('error')
      this.emit('error', msg)
      throw err
    }
  }

  async logout(): Promise<void> {
    console.info('[WeixinLogin] Logging out')
    this.stopPolling()
    this.stopCheckLoginLoop()
    await this.sessionStore.clearSession()
    this.setStatus('idle')
  }

  /**
   * Gracefully stop background polling while preserving local session.
   * Used during app shutdown to avoid forcing QR login on next startup.
   */
  shutdown(): void {
    this.stopPolling()
    this.stopCheckLoginLoop()
  }

  getStatus(): WeixinLoginStatus {
    return this.status
  }

  async getSession(): Promise<WeixinSession | null> {
    return this.sessionStore.loadSession()
  }

  // ─── Private: Login flow ──────────────────────────────────────────────────

  /**
   * 串行轮询扫码状态：上一请求结束后再等待间隔发起下一次，避免并发 fetch 与过短超时叠加误判。
   */
  private startCheckLoginLoop(qrcode: string): void {
    this.stopCheckLoginLoop()
    const ac = new AbortController()
    this.loginPollAbort = ac
    this.checkLoginLoopRunning = true
    this.lastLoginCheckStatus = null
    console.info('[WeixinLogin] Start polling login status, baseUrl=', this.baseUrl)
    void this.runCheckLoginLoop(qrcode, ac.signal)
  }

  private async runCheckLoginLoop(qrcode: string, signal: AbortSignal): Promise<void> {
    let iter = 0
    while (this.checkLoginLoopRunning && !signal.aborted) {
      iter += 1
      try {
        console.info('[WeixinLogin] [loginStatus] attempt=', iter, 'qrcode=', qrcode.slice(0, 20) + '...')
        const result = await this.apiPollLoginStatus(qrcode, signal)
        if (!this.checkLoginLoopRunning) return
        if (result.status !== this.lastLoginCheckStatus) {
          console.info('[WeixinLogin] [loginStatus] status change:', {
            status: result.status,
            hasBotToken: !!result.bot_token,
            hasIlinkBotId: !!result.ilink_bot_id,
            baseUrl: this.baseUrl,
          })
          this.lastLoginCheckStatus = result.status
        }

        if (isQrExpiredStatus(result.status)) {
          this.checkLoginLoopRunning = false
          this.loginPollAbort = null
          console.warn('[WeixinLogin] [loginStatus] QR expired, stop polling')
          this.setStatus('error')
          this.emit('error', '二维码已过期，请重新点击「连接微信」获取新二维码')
          return
        }

        if (isQrScannedPendingConfirm(result.status)) {
          this.setStatus('confirmed')
        }

        if (isQrLoginComplete(result)) {
          this.checkLoginLoopRunning = false
          this.loginPollAbort = null
          console.info('[WeixinLogin] [loginStatus] login complete, calling handleLoginSuccess...')
          await this.handleLoginSuccess(result)
          return
        }
      } catch (err) {
        if (!this.checkLoginLoopRunning || signal.aborted) return
        const isAbort =
          (err instanceof Error && err.name === 'AbortError') ||
          (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError')
        if (isAbort) {
          console.warn('[WeixinLogin] Check login status timed out, retrying…')
        } else {
          console.error('[WeixinLogin] Check login status failed:', err)
        }
      }
      if (!this.checkLoginLoopRunning || signal.aborted) return
      await this.sleep(CHECK_LOGIN_INTERVAL_MS)
    }
    console.info('[WeixinLogin] Login status polling stopped')
  }

  private stopCheckLoginLoop(): void {
    this.checkLoginLoopRunning = false
    if (this.loginPollAbort) {
      console.info('[WeixinLogin] Stop checkLoginLoop: aborting in-flight request')
      this.loginPollAbort.abort()
      this.loginPollAbort = null
    }
  }

  private async handleLoginSuccess(result: QRStatusResponse): Promise<void> {
    // Use dynamic baseurl returned by server if provided
    const effectiveBaseUrl = normalizeIlinkBaseUrl(
      result.baseurl ? result.baseurl.replace(/\/$/, '') : this.baseUrl,
    )
    this.baseUrl = effectiveBaseUrl
    console.info('[WeixinLogin] handleLoginSuccess:', {
      userId: result.ilink_bot_id ? String(result.ilink_bot_id).slice(0, 24) + '...' : undefined,
      baseUrl: this.baseUrl,
    })

    const now = Date.now()
    const session: WeixinSession = {
      userId: result.ilink_bot_id!,
      botToken: result.bot_token!,
      baseUrl: effectiveBaseUrl,
      loginAt: now,
      // iLink does not publish an expiry; default to 30 days.
      // On any 401/403 the session is invalidated early regardless.
      expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    }
    await this.sessionStore.saveSession(session)
    this.setStatus('logged_in', session)
    this.startPolling(session)
  }

  // ─── Private: Polling ─────────────────────────────────────────────────────

  private startPolling(session: WeixinSession): void {
    this.stopPolling()
    console.info('[WeixinLogin] Starting message polling')
    this.pollingAbortController = new AbortController()
    void this.pollLoop(session, this.pollingAbortController.signal)
  }

  private stopPolling(): void {
    if (this.pollingAbortController) {
      console.info('[WeixinLogin] Stop message polling: aborting in-flight request')
      this.pollingAbortController.abort()
      this.pollingAbortController = null
    }
  }

  private async pollLoop(session: WeixinSession, signal: AbortSignal): Promise<void> {
    let getUpdatesBuf = ''
    let pollIndex = 0
    let longPollTimeoutMs = LONG_POLL_TIMEOUT_MS
    /** 连续认证失败次数；网络抖动可能引发偶发 401，需连续失败才判定 token 过期 */
    let authFailCount = 0
    const AUTH_FAIL_THRESHOLD = 2
    while (!signal.aborted && this.status === 'logged_in') {
      try {
        pollIndex += 1
        // 静默轮询，不打印任何日志（仅错误时打印）
        const result = await this.apiGetUpdates(session, getUpdatesBuf, signal, longPollTimeoutMs)
        if (signal.aborted) break
        // 成功后重置认证失败计数
        authFailCount = 0
        // Update buf for next poll
        if (result.get_updates_buf) getUpdatesBuf = result.get_updates_buf
        if (
          typeof result.longpolling_timeout_ms === 'number' &&
          Number.isFinite(result.longpolling_timeout_ms) &&
          result.longpolling_timeout_ms >= 5_000 &&
          result.longpolling_timeout_ms <= 120_000
        ) {
          longPollTimeoutMs = result.longpolling_timeout_ms
        }
        // 静默处理，仅在有消息时打印
        if ((result.msgs ?? []).length > 0) {
          console.info('[WeixinLogin] [getupdates] received messages:', (result.msgs ?? []).length)
        }
        for (const msg of result.msgs ?? []) {
          const normalized = this.normalizeMessage(msg, session)
          if (normalized) {
            if (normalized.mediaItems && normalized.mediaItems.length > 0) {
              const cdnBase = session.baseUrl ?? this.baseUrl
              normalized.mediaItems = await downloadAndSaveMediaItems(normalized.mediaItems, cdnBase)
              // 将下载成功的文件路径注入消息文本，让 Agent 知道文件保存位置
              const downloadedPaths = normalized.mediaItems
                .filter((item) => item.localPath)
                .map((item) => `[media attached: ${item.localPath}${item.fileName ? ` (${item.fileName})` : ''}]`)
              if (downloadedPaths.length > 0) {
                normalized.text = normalized.text
                  ? `${normalized.text}\n${downloadedPaths.join('\n')}`
                  : downloadedPaths.join('\n')
              }

              // SILK 语音消息 ASR 转录
              if (this.silkAsrCallback) {
                const workspaceDir =
                  process.env['MTBOT_WORKSPACE_DIR']?.trim() ||
                  path.join(resolveClientStateDir(), 'workspace')
                for (const item of normalized.mediaItems) {
                  if (!item.localPath?.endsWith('.silk')) continue
                  const absPath = path.join(workspaceDir, item.localPath)
                  try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    const silk = require('silk-sdk')
                    const silkBuf = fs.readFileSync(absPath)
                    // decode 返回 Buffer，16-bit PCM at 24000Hz；传入 {fsHz:16000} 直接重采样
                    const pcmBuf: Buffer = silk.decode(silkBuf, { fsHz: 16000 })
                    const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2)
                    const float32 = new Float32Array(int16.length)
                    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768
                    const transcript = await this.silkAsrCallback(float32, 16000)
                    if (transcript) {
                      normalized.text = normalized.text
                        ? `${normalized.text}\n[语音转录: ${transcript}]`
                        : `[语音转录: ${transcript}]`
                      normalized.hasUserText = true
                      console.info(`[WeixinLogin] SILK 转录成功: "${transcript}"`)
                    }
                  } catch (e) {
                    console.warn(`[WeixinLogin] SILK ASR 转录失败: ${e instanceof Error ? e.message : String(e)}`)
                  }
                }
              }
            }
            this.emit('message', normalized)
          }
        }
      } catch (err) {
        if (signal.aborted) break
        // 认证失败：连续达到阈值才判定 token 过期（避免网络抖动误判）
        if (err instanceof WeixinAuthError) {
          authFailCount += 1
          console.warn('[WeixinLogin] Auth error, authFailCount=', authFailCount, '/', AUTH_FAIL_THRESHOLD, err.message)
          if (authFailCount >= AUTH_FAIL_THRESHOLD) {
            console.warn('[WeixinLogin] Session expired after consecutive auth failures, clearing session')
            await this.sessionStore.clearSession()
            this.setStatus('error')
            this.emit('error', 'session_expired')
            return
          }
          // 未达阈值：短暂等待后重试
          await this.sleep(POLL_RETRY_DELAY_MS)
          continue
        }
        console.error('[WeixinLogin] Polling failed:', err)
        await this.sleep(POLL_RETRY_DELAY_MS)
      }
    }
    console.info('[WeixinLogin] Poll loop exited')
  }

  private normalizeMessage(raw: WeixinRawMessage, session?: WeixinSession): WeixinNormalizedMessage | null {
    if (!raw.from_user_id) return null
    const items = raw.item_list ?? []

    // 记录原始 item_list 结构，便于调试媒体类型映射
    if (items.length > 0) {
      const itemsSummary = items.map((it) => ({
        type: it.type,
        hasText: Boolean(it.text_item?.text),
        hasImage: Boolean(it.image_item),
        hasVoice: Boolean(it.voice_item),
        hasVideo: Boolean(it.video_item),
        hasFile: Boolean(it.file_item),
        fileName: it.file_item?.file_name,
        hasMediaEncrypt: Boolean(
          it.image_item?.media?.encrypt_query_param ??
          it.voice_item?.media?.encrypt_query_param ??
          it.video_item?.media?.encrypt_query_param ??
          it.file_item?.media?.encrypt_query_param
        ),
      }))
      console.info(`[WeixinLogin] [normalizeMessage] from=${raw.from_user_id} items=${items.length} detail=${JSON.stringify(itemsSummary)}`)
    }

    const textParts = items
      .map((it) => (it.type === 1 ? it.text_item?.text : it.voice_item?.text))
      .filter((v): v is string => Boolean(v && v.trim()))
    const text = textParts.join('\n').trim()

    // Extract structured media items (type 2/3/4/5)
    const mediaItems = items
      .filter((it) => it.type >= 2 && it.type <= 5)
      .map((it) => {
        const fileKey = extractMediaFileKey(it)
        const crypto = extractMediaCrypto(it)
        return {
          type: it.type as 2 | 3 | 4 | 5,
          fileKey,
          ...(it.file_item?.file_name ? { fileName: it.file_item.file_name } : {}),
          ...crypto,
        }
      })
      .filter((it) => it.fileKey || it.encryptQueryParam)

    const hasMediaType = items.some((it) => it.type >= 2 && it.type <= 5)
    const isMedia = hasMediaType || mediaItems.length > 0

    return {
      channel: 'weixin',
      channelUserId: raw.from_user_id,
      type: isMedia ? 'media' : 'text',
      text: text || (isMedia ? buildMediaFallbackText(items) : ''),
      hasUserText: Boolean(text),
      ...(mediaItems.length > 0 ? { mediaItems } : {}),
      raw,
      timestamp: raw.create_time_ms ?? Date.now(),
      accountId: this.accountId,
      // Inject session credentials so the Gateway can send replies without needing a separate auth flow
      botToken: session?.botToken,
      ilinkBaseUrl: session?.baseUrl ?? this.baseUrl,
      // context_token is required for reply delivery (iLink session routing)
      contextToken: raw.context_token,
    }
  }

  // ─── Public: send reply via iLink API ────────────────────────────────────

  /**
   * 向指定微信用户发送文本回复（本地直接调用 iLink API，无需经过 Gateway）。
   *
   * @param toUserId     接收者的微信用户 ID（WeixinNormalizedMessage.channelUserId）
   * @param text         回复文本
   * @param contextToken 来自入站消息的 context_token（iLink 会话路由必需）
   * @param botToken     来自 session 的 bot_token，不传则使用当前 session
   * @param ilinkBaseUrl 来自 session 的 baseUrl，不传则使用当前 session
   */
  async sendTextReply(
    toUserId: string,
    text: string,
    contextToken: string,
    botToken?: string,
    ilinkBaseUrl?: string,
  ): Promise<boolean> {
    const session = await this.sessionStore.loadSession()
    const token = botToken ?? session?.botToken
    const baseUrl = ilinkBaseUrl ?? session?.baseUrl ?? this.baseUrl

    if (!token) {
      console.warn('[WeixinLogin] [sendTextReply] 缺少 bot_token，无法发送回复')
      return false
    }
    if (!contextToken) {
      console.warn('[WeixinLogin] [sendTextReply] 缺少 context_token，无法发送回复')
      return false
    }

    const CHUNK = 2000
    const url = `${baseUrl}/ilink/bot/sendmessage`
    let allOk = true

    for (let i = 0; i < text.length; i += CHUNK) {
      const chunk = text.slice(i, i + CHUNK)
      const ok = await apiSendTextChunk(url, toUserId, chunk, token, contextToken)
      if (!ok) {
        allOk = false
        console.error(`[WeixinLogin] [sendTextReply] 发送第 ${Math.floor(i / CHUNK) + 1} 段失败`)
        break
      }
    }

    return allOk
  }

  /**
   * 向指定微信用户发送文件或图片（通过 iLink CDN 上传后发送）。
   * 支持图片(jpg/png/gif/webp)、文档(pdf/docx/xlsx/pptx/txt/md)等文件类型。
   *
   * @param toUserId     接收者的微信用户 ID
   * @param filePath     本地文件绝对路径
   * @param fileName     文件名（可选，默认从 filePath 提取）
   * @param contextToken 来自入站消息的 context_token
   * @param botToken     来自 session 的 bot_token
   * @param ilinkBaseUrl 来自 session 的 baseUrl
   */
  async sendMediaReply(
    toUserId: string,
    filePath: string,
    fileName: string | undefined,
    contextToken: string,
    botToken?: string,
    ilinkBaseUrl?: string,
  ): Promise<boolean> {
    const session = await this.sessionStore.loadSession()
    const token = botToken ?? session?.botToken
    const baseUrl = ilinkBaseUrl ?? session?.baseUrl ?? this.baseUrl

    if (!token) {
      console.warn('[WeixinLogin] [sendMediaReply] 缺少 bot_token，无法发送文件')
      return false
    }
    if (!contextToken) {
      console.warn('[WeixinLogin] [sendMediaReply] 缺少 context_token，无法发送文件')
      return false
    }

    return sendMediaReplyImpl(baseUrl, token, toUserId, filePath, fileName, contextToken)
  }

  // ─── Private: iLink HTTP API ──────────────────────────────────────────────

  private async apiFetchQrCode(): Promise<{ qrcode: string; qrcode_img_content?: string }> {
    return apiFetchQrCode(this.baseUrl)
  }

  /**
   * 查询扫码状态；可与外层 signal 合并以便退出登录时立即中止挂起的请求。
   */
  private async apiPollLoginStatus(qrcode: string, outerSignal?: AbortSignal): Promise<QRStatusResponse> {
    return apiPollLoginStatus(this.baseUrl, qrcode, outerSignal)
  }

  private async apiGetUpdates(
    session: WeixinSession,
    getUpdatesBuf: string,
    signal: AbortSignal,
    timeoutMs = LONG_POLL_TIMEOUT_MS,
  ): Promise<GetUpdatesResponse> {
    return apiGetUpdates(this.baseUrl, session, getUpdatesBuf, signal, timeoutMs)
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private setStatus(status: WeixinLoginStatus, session?: WeixinSession): void {
    this.status = status
    this.emit('statusChange', status, session)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
