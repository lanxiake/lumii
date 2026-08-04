/**
 * WeixinLoginService - Manages WeChat Personal (iLink) login flow and message polling.
 *
 * API reference: https://github.com/pzx521521/openclaw-weixin-cli
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

import { createCipheriv, createHash, randomBytes, createDecipheriv } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'events'
import QRCode from 'qrcode'
import { WeixinSessionStore } from './weixin-session-store.js'
import type { WeixinSession } from './weixin-session-store.js'
import { resolveClientStateDir } from './paths.js'

const ILINK_DEFAULT_URL = 'https://ilinkai.weixin.qq.com'

/**
 * iLink 认证失败（401/403），表示 bot_token 已过期或被吊销，需要重新扫码登录。
 * 与普通网络错误区分，便于 pollLoop 做不同的恢复策略。
 */
class WeixinAuthError extends Error {
  readonly statusCode: number
  constructor(statusCode: number) {
    super(`iLink 认证失败 (${statusCode})，session 已过期，请重新扫码登录`)
    this.name = 'WeixinAuthError'
    this.statusCode = statusCode
  }
}
// iLink 的 bot_type：用于指定 get_bot_qrcode 返回对应的登录二维码类型
// 参考公开资料：个人微信 ClawBot 场景 bot_type=3
const DEFAULT_BOT_TYPE = 3
const CHECK_LOGIN_INTERVAL_MS = 2_000
const POLL_RETRY_DELAY_MS = 5_000
/** 扫码后轮询状态：服务端可能长时间挂起等待确认，过短会 AbortError；与消息长轮询同量级 */
const QR_CHECK_TIMEOUT_MS = 60_000
const LONG_POLL_TIMEOUT_MS = 35_000

/**
 * 与 openclaw-weixin-cli 一致：接口路径挂在域名根下（/ilink/bot/...）。
 * 旧默认曾误用 `.../api`，会导致 404。仍支持通过环境变量传入带 `/api` 的官方域名并自动纠正。
 */
function normalizeIlinkBaseUrl(url: string): string {
  let u = url.trim().replace(/\/$/, '')
  if (u.endsWith('/api') && u.includes('ilinkai.weixin.qq.com')) {
    u = u.slice(0, -4)
  }
  return u
}

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

// ─── iLink API types (matching openclaw-weixin-cli) ────────────────────────

interface QRCodeResponse {
  qrcode: string
  qrcode_img_content?: string
}

interface QRStatusResponse {
  /**
   * 线上常见：wait（等待扫码/确认）、expired（过期）、confirmed（成功，常伴随 token）
   * 文档/旧版亦可能：QRCODE_SCAN_NEVER | QRCODE_SCAN_ING | QRCODE_SCAN_SUCC
   */
  status: string
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
}

interface CdnMediaRef {
  file_key?: string
  encrypt_query_param?: string
  aes_key?: string
  aeskey?: string
}

interface MessageItem {
  // iLink MessageItemType: 1=text, 2=image, 3=voice, 4=file, 5=video
  // (confirmed per @tencent-weixin/openclaw-weixin protocol spec)
  type: number
  text_item?: { text: string }
  voice_item?: (CdnMediaRef & { text?: string; media?: CdnMediaRef })
  image_item?: (CdnMediaRef & { media?: CdnMediaRef })
  video_item?: (CdnMediaRef & { media?: CdnMediaRef })
  file_item?: (CdnMediaRef & { file_name?: string; media?: CdnMediaRef })
}

interface WeixinRawMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  message_type?: number
  context_token?: string
  item_list?: MessageItem[]
}

interface GetUpdatesResponse {
  ret: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinRawMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

/**
 * Build a readable fallback text for media-only iLink messages.
 * This guarantees downstream pipelines that rely on text presence do not
 * treat media messages as empty input.
 */
function buildMediaFallbackText(items: MessageItem[]): string {
  const mediaItems = items.filter((it) => it.type >= 2 && it.type <= 5)
  if (mediaItems.length === 0) {
    return '用户发送了一条媒体消息。'
  }

  const kindMap: Record<number, string> = {
    2: '图片',
    3: '语音',
    4: '文件',
    5: '视频',
  }
  const lines = mediaItems.map((it, idx) => {
    const fileKey =
      it.image_item?.file_key ??
      it.voice_item?.file_key ??
      it.video_item?.file_key ??
      it.file_item?.file_key ??
      ''
    const fileName = it.file_item?.file_name ? `，文件名: ${it.file_item.file_name}` : ''
    const keyPart = fileKey ? `，file_key: ${fileKey}` : ''
    return `${idx + 1}. 类型: ${kindMap[it.type] ?? '媒体'}${keyPart}${fileName}`
  })
  return `用户发送了媒体消息（共 ${mediaItems.length} 个）：\n${lines.join('\n')}`
}

/**
 * Extract an iLink media stable identifier from item payload.
 * Prefer file_key; fall back to encrypt_query_param for newer CDN-style messages.
 */
function extractMediaFileKey(item: MessageItem): string {
  return (
    item.image_item?.media?.file_key ??
    item.voice_item?.media?.file_key ??
    item.video_item?.media?.file_key ??
    item.file_item?.media?.file_key ??
    item.image_item?.file_key ??
    item.voice_item?.file_key ??
    item.video_item?.file_key ??
    item.file_item?.file_key ??
    item.image_item?.media?.encrypt_query_param ??
    item.voice_item?.media?.encrypt_query_param ??
    item.video_item?.media?.encrypt_query_param ??
    item.file_item?.media?.encrypt_query_param ??
    item.image_item?.encrypt_query_param ??
    item.voice_item?.encrypt_query_param ??
    item.video_item?.encrypt_query_param ??
    item.file_item?.encrypt_query_param ??
    ''
  )
}

/**
 * Extract CDN crypto fields for inbound media downloads.
 */
function extractMediaCrypto(item: MessageItem): { encryptQueryParam?: string; aesKey?: string } {
  const encryptQueryParam =
    item.image_item?.media?.encrypt_query_param ??
    item.voice_item?.media?.encrypt_query_param ??
    item.video_item?.media?.encrypt_query_param ??
    item.file_item?.media?.encrypt_query_param ??
    item.image_item?.encrypt_query_param ??
    item.voice_item?.encrypt_query_param ??
    item.video_item?.encrypt_query_param ??
    item.file_item?.encrypt_query_param

  const aesKey =
    item.image_item?.media?.aes_key ??
    item.voice_item?.media?.aes_key ??
    item.video_item?.media?.aes_key ??
    item.file_item?.media?.aes_key ??
    item.image_item?.aeskey ??
    item.image_item?.aes_key ??
    item.voice_item?.aes_key ??
    item.video_item?.aes_key ??
    item.file_item?.aes_key

  return {
    ...(encryptQueryParam ? { encryptQueryParam } : {}),
    ...(aesKey ? { aesKey } : {}),
  }
}

/** CDN 下载超时 */
const CLIENT_MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000

/** Parse iLink aes key：hex-32 字符串或 raw-16-bytes base64。 */
function parseAesKeyLocal(aesKey: string): Buffer | undefined {
  const raw = aesKey.trim()
  if (!raw) return undefined
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  try {
    const decoded = Buffer.from(raw, 'base64')
    if (decoded.length === 16) return decoded
    const ascii = decoded.toString('ascii')
    if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) {
      return Buffer.from(ascii, 'hex')
    }
  } catch {}
  return undefined
}

/**
 * 与 extensions/weixin cdn-upload 一致：入站文件在微信 CDN（novac2c），
 * 仅用 iLink 域名构建下载 URL 会得到 404，无法写入 workspace/uploads。
 */
const DEFAULT_WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/**
 * 组装 CDN 主机列表：始终包含微信默认 CDN；再追加 MTBOT_WEIXIN_CDN_BASE_URL（若与默认不同）、最后 iLink base。
 * 避免环境变量误设为 iLink 时只打 iLink、跳过 novac2c。
 */
function collectWeixinCdnHosts(ilinkBaseUrl: string): string[] {
  const base = ilinkBaseUrl.replace(/\/+$/, '')
  const fromEnv = process.env['MTBOT_WEIXIN_CDN_BASE_URL']?.trim()?.replace(/\/+$/, '')
  const seen = new Set<string>()
  const hosts: string[] = []
  const push = (h: string | undefined): void => {
    if (!h || seen.has(h)) return
    seen.add(h)
    hosts.push(h)
  }
  push(DEFAULT_WEIXIN_CDN_BASE_URL)
  if (fromEnv) push(fromEnv)
  push(base)
  return hosts
}

/**
 * 构建 CDN 下载候选 URL（与网关 channel 的 buildCdnDownloadCandidates 语义对齐）。
 */
function buildCdnCandidates(encryptedQueryParam: string, ilinkBaseUrl: string): string[] {
  const enc = encodeURIComponent(encryptedQueryParam)
  return collectWeixinCdnHosts(ilinkBaseUrl).flatMap((host) => [
    `${host}/download?encrypted_query_param=${enc}`,
    `${host}/ilink/cdn/download?encrypted_query_param=${enc}`,
  ])
}

/** MessageItemType → 文件扩展名映射（IMAGE=2, VOICE=3, FILE=4, VIDEO=5） */
function mapItemTypeToExt(type: 2 | 3 | 4 | 5): string {
  switch (type) {
    case 2: return '.jpg'
    case 3: return '.silk'
    case 4: return ''
    case 5: return '.mp4'
  }
}

type MediaItemShape = {
  type: 2 | 3 | 4 | 5
  fileKey: string
  fileName?: string
  encryptQueryParam?: string
  aesKey?: string
  localPath?: string
}

/**
 * 对消息中的每个媒体 item 执行 CDN 下载、AES 解密，保存到本地 workspace/uploads/{YYYYMMDD}/。
 * 下载失败时跳过（不设 localPath），Gateway 将回退到自身 CDN 下载。
 */
async function downloadAndSaveMediaItems(
  mediaItems: MediaItemShape[],
  baseUrl: string,
): Promise<MediaItemShape[]> {
  const workspaceDir =
    process.env['MTBOT_WORKSPACE_DIR']?.trim() ||
    path.join(resolveClientStateDir(), 'workspace')
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD
  const uploadDir = path.join(workspaceDir, 'uploads', dateStr)

  const result: MediaItemShape[] = []
  for (const item of mediaItems) {
    if (!item.encryptQueryParam) {
      result.push(item)
      continue
    }
    try {
      const candidates = buildCdnCandidates(item.encryptQueryParam, baseUrl)
      let downloaded: Buffer | undefined
      for (const url of candidates) {
        try {
          console.info(`[downloadMedia] 尝试下载 type=${item.type} url=${url.slice(0, 80)}`)
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), CLIENT_MEDIA_DOWNLOAD_TIMEOUT_MS)
          let res: Response
          try {
            res = await fetch(url, { signal: controller.signal })
          } finally {
            clearTimeout(timer)
          }
          if (!res.ok) {
            console.warn(`[downloadMedia] 下载返回 ${res.status}，尝试下一候选`)
            continue
          }
          downloaded = Buffer.from(await res.arrayBuffer())
          console.info(`[downloadMedia] 下载成功 type=${item.type} size=${downloaded.length}`)
          break
        } catch (err) {
          console.warn(`[downloadMedia] 候选 URL 下载失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (!downloaded) {
        console.warn(`[downloadMedia] 所有候选 URL 均失败，跳过 type=${item.type}`)
        result.push(item)
        continue
      }
      const aesKeyBuf = item.aesKey ? parseAesKeyLocal(item.aesKey) : undefined
      const plaintext = aesKeyBuf
        ? (() => {
            const decipher = createDecipheriv('aes-128-ecb', aesKeyBuf, null)
            return Buffer.concat([decipher.update(downloaded), decipher.final()])
          })()
        : downloaded
      // 生成文件名
      const ext = mapItemTypeToExt(item.type)
      const fileName = item.fileName ?? `weixin_${item.type}_${Date.now()}${ext}`
      await fsPromises.mkdir(uploadDir, { recursive: true })
      const filePath = path.join(uploadDir, fileName)
      await fsPromises.writeFile(filePath, plaintext)
      const localPath = `uploads/${dateStr}/${fileName}`
      console.info(`[downloadMedia] 已保存 type=${item.type} path=${filePath} size=${plaintext.length} localPath=${localPath}`)
      result.push({ ...item, localPath })
    } catch (err) {
      console.warn(`[downloadMedia] 处理失败，跳过 type=${item.type}: ${err instanceof Error ? err.message : String(err)}`)
      result.push(item)
    }
  }
  return result
}

/**
 * 判断扫码登录是否已完成：优先以 token 字段为准（与线上 wait/expired 字符串兼容）。
 */
function isQrLoginComplete(r: QRStatusResponse): boolean {
  if (r.bot_token && r.ilink_bot_id) return true
  const s = (r.status || '').toLowerCase()
  return (
    s === 'qrcode_scan_succ' ||
    s === 'confirmed' ||
    s === 'success' ||
    s === 'succ'
  )
}

/**
 * 将服务端 status 映射为 UI 阶段（手机已扫、待确认）。
 */
function isQrScannedPendingConfirm(status: string): boolean {
  const s = (status || '').toLowerCase()
  return (
    s === 'wait' ||
    s === 'scaned' ||
    s === 'scanned' ||
    s === 'qrcode_scan_ing'
  )
}

/**
 * 二维码是否已失效。
 */
function isQrExpiredStatus(status: string): boolean {
  const s = (status || '').toLowerCase()
  return s === 'expired' || s === 'timeout' || s === 'invalid'
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
      const ok = await this.apiSendTextChunk(url, toUserId, chunk, token, contextToken)
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

    try {
      const fileBuffer = await fsPromises.readFile(filePath)
      const name = fileName ?? path.basename(filePath)
      const mimeType = this.guessMimeType(name)

      console.log(`[WeixinLogin] [sendMediaReply] 开始上传文件: ${name} (${fileBuffer.length} bytes, ${mimeType})`)

      // Step 1: 上传文件到 iLink CDN
      const mediaInfo = await this.uploadMediaToIlink(baseUrl, token, fileBuffer, mimeType, toUserId)

      // Step 2: 构建 item_list 并发送消息
      const itemList = this.buildMediaItemList(name, mimeType, mediaInfo, fileBuffer.length)
      const ok = await this.apiSendMessageWithItems(baseUrl, toUserId, contextToken, token, itemList)

      console.log(`[WeixinLogin] [sendMediaReply] 文件发送 ${ok ? '成功' : '失败'}: ${name}`)
      return ok
    } catch (err) {
      console.error(`[WeixinLogin] [sendMediaReply] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /** 根据文件名推断 MIME 类型 */
  private guessMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
      '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
      '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
      '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
    }
    return mimeMap[ext] ?? 'application/octet-stream'
  }

  /** 将 MIME 类型映射到 iLink UploadMediaType（getuploadurl 接口字段） */
  private mimeToUploadMediaType(mimeType: string): number {
    const m = mimeType.toLowerCase()
    if (m.startsWith('image/')) return 1  // IMAGE
    if (m.startsWith('video/')) return 2  // VIDEO
    if (m.startsWith('audio/')) return 4  // VOICE
    return 3  // FILE
  }

  /** 将 MIME 类型映射到 iLink MessageItemType（sendmessage item_list[].type 字段） */
  private mimeToMessageItemType(mimeType: string): 2 | 3 | 4 | 5 {
    const m = mimeType.toLowerCase()
    if (m.startsWith('image/')) return 2   // IMAGE
    if (m.startsWith('audio/')) return 3   // VOICE
    if (m.startsWith('video/')) return 5   // VIDEO
    return 4                               // FILE
  }

  /** AES-128-ECB 加密（PKCS7 填充） */
  private encryptAesEcb(data: Buffer, key: Buffer): Buffer {
    const cipher = createCipheriv('aes-128-ecb', key, null)
    return Buffer.concat([cipher.update(data), cipher.final()])
  }

  /** 计算 AES-128-ECB 密文大小（PKCS7 填充到 16 字节边界） */
  private aesEcbPaddedSize(plaintextSize: number): number {
    return Math.ceil((plaintextSize + 1) / 16) * 16
  }

  /** 上传文件到 iLink CDN，返回下载加密参数和 AES key */
  private async uploadMediaToIlink(
    ilinkUrl: string,
    botToken: string,
    fileBuffer: Buffer,
    mimeType: string,
    toUserId: string,
  ): Promise<{ downloadEncryptedQueryParam: string; aeskeyHex: string; fileSizeCiphertext: number }> {
    // 生成随机密钥
    const filekey = randomBytes(16).toString('hex')
    const aeskey = randomBytes(16)
    const aeskeyHex = aeskey.toString('hex')

    const rawsize = fileBuffer.length
    const rawfilemd5 = createHash('md5').update(fileBuffer).digest('hex')
    const filesize = this.aesEcbPaddedSize(rawsize)
    const mediaType = this.mimeToUploadMediaType(mimeType)

    // Step 1: 获取上传 URL
    const getUrlBody = JSON.stringify({
      filekey, media_type: mediaType, to_user_id: toUserId,
      rawsize, rawfilemd5, filesize, no_need_thumb: true,
      aeskey: aeskeyHex, base_info: { channel_version: '1.0.2' },
    })
    const getUrlBodyBuf = Buffer.from(getUrlBody, 'utf8')
    console.log(`[WeixinLogin] [uploadMedia] getuploadurl 请求: url=${ilinkUrl}/ilink/bot/getuploadurl mediaType=${mediaType} rawsize=${rawsize} filesize=${filesize} toUserId=${toUserId}`)
    const getUrlRes = await fetch(`${ilinkUrl}/ilink/bot/getuploadurl`, {
      method: 'POST',
      headers: this.buildHeadersWithLength(botToken, getUrlBodyBuf),
      body: getUrlBodyBuf,
    })
    if (!getUrlRes.ok) {
      throw new Error(`getuploadurl HTTP ${getUrlRes.status}`)
    }
    const urlData = await getUrlRes.json() as { upload_full_url?: string; upload_param?: string; ret?: number; errmsg?: string }
    console.log(`[WeixinLogin] [uploadMedia] getuploadurl 响应: ret=${urlData.ret} errmsg=${urlData.errmsg ?? ''} keys=${Object.keys(urlData).join(',')} upload_full_url=${urlData.upload_full_url ? '有' : '无'} upload_param=${urlData.upload_param ? '有' : '无'}`)
    if (urlData.ret !== undefined && urlData.ret !== 0) {
      throw new Error(`getuploadurl 错误: ret=${urlData.ret} ${urlData.errmsg}`)
    }

    // Step 2: 加密文件并上传到 CDN
    const ciphertext = this.encryptAesEcb(fileBuffer, aeskey)
    const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
    const cdnUrl = urlData.upload_full_url?.trim() ??
      (urlData.upload_param
        ? `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(urlData.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : null)
    if (!cdnUrl) throw new Error('getuploadurl 未返回有效上传 URL')

    const timeoutMs = Math.min(30_000 + Math.ceil(ciphertext.length / (1024 * 1024)) * 5_000, 120_000)
    let downloadParam: string | undefined
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      try {
        const cdnRes = await fetch(cdnUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          signal: ctrl.signal,
        })
        clearTimeout(t)
        if (!cdnRes.ok) throw new Error(`CDN 上传错误 ${cdnRes.status}`)
        downloadParam = cdnRes.headers.get('x-encrypted-param') ?? undefined
        console.log(`[WeixinLogin] [uploadMedia] CDN 上传完成: status=${cdnRes.status} x-encrypted-param=${downloadParam ? '有' : '无'}`)
        if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param')
        break
      } catch (err) {
        clearTimeout(t)
        if (attempt === 3) throw err
        console.warn(`[WeixinLogin] CDN 上传第 ${attempt} 次失败，重试中: ${String(err)}`)
      }
    }

    return { downloadEncryptedQueryParam: downloadParam!, aeskeyHex, fileSizeCiphertext: filesize }
  }

  /** 根据 MIME 类型构建 iLink item_list 媒体消息项 */
  private buildMediaItemList(
    fileName: string,
    mimeType: string,
    mediaInfo: { downloadEncryptedQueryParam: string; aeskeyHex: string; fileSizeCiphertext: number },
    fileSize: number,
  ): Record<string, unknown>[] {
    const itemType = this.mimeToMessageItemType(mimeType)
    // aes_key 编码：将 hex 字符串的 ASCII 字节做 base64（与 openclaw-weixin send.ts 一致）
    // 接收端 parseAesKeyLocal: base64 decode → hex 字符串 → hex decode → 16 bytes key
    const cdnMedia = {
      encrypt_query_param: mediaInfo.downloadEncryptedQueryParam,
      aes_key: Buffer.from(mediaInfo.aeskeyHex).toString('base64'),
      encrypt_type: 1,
    }
    if (itemType === 2) {
      // 图片
      return [{ type: 2, image_item: { media: cdnMedia, mid_size: mediaInfo.fileSizeCiphertext } }]
    }
    if (itemType === 3) {
      // 语音
      return [{ type: 3, voice_item: { media: cdnMedia } }]
    }
    if (itemType === 5) {
      // 视频
      return [{ type: 5, video_item: { media: cdnMedia, video_size: mediaInfo.fileSizeCiphertext } }]
    }
    // 文件（默认）：len 用原始文件大小（plaintext），与 ilink-client.ts buildMediaItem 一致
    return [{ type: 4, file_item: { media: cdnMedia, file_name: fileName, len: String(fileSize) } }]
  }

  /** 发送包含 item_list 的消息 */
  private async apiSendMessageWithItems(
    ilinkUrl: string,
    toUserId: string,
    contextToken: string,
    botToken: string,
    itemList: Record<string, unknown>[],
  ): Promise<boolean> {
    const generateClientId = (): string => {
      const hex = Array.from(randomBytes(8)).map((b) => b.toString(16).padStart(2, '0')).join('')
      return `bot-${hex}`
    }
    const bodyObj = {
      msg: {
        from_user_id: '', to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2, message_state: 2,
        context_token: contextToken,
        item_list: itemList,
      },
      base_info: { channel_version: '1.0.3' },
    }
    const bodyBytes = Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const url = `${ilinkUrl}/ilink/bot/sendmessage`
    console.log(`[WeixinLogin] [sendMessageWithItems] 发送: url=${url} toUserId=${toUserId} itemTypes=${itemList.map((i) => i.type).join(',')} bodyLen=${bodyBytes.length}`)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.buildHeadersWithLength(botToken, bodyBytes),
        body: bodyBytes,
      })
      if (!res.ok) {
        console.error('[WeixinLogin] [sendMessageWithItems] HTTP error:', res.status)
        return false
      }
      const rawText = await res.text().catch(() => '')
      console.log(`[WeixinLogin] [sendMessageWithItems] 响应: status=${res.status} body=${rawText.slice(0, 200)}`)
      if (!rawText || rawText.trim() === '{}') return true
      const data = JSON.parse(rawText) as { ret?: number; errmsg?: string }
      if (typeof data.ret === 'number' && data.ret !== 0) {
        console.error('[WeixinLogin] [sendMessageWithItems] ret!=0:', data.ret, data.errmsg)
        return false
      }
      return true
    } catch (err) {
      console.error('[WeixinLogin] [sendMessageWithItems] 异常:', err)
      return false
    }
  }

  private async apiSendTextChunk(
    url: string,
    toUserId: string,
    text: string,
    botToken: string,
    contextToken: string,
  ): Promise<boolean> {
    const generateClientId = (): string => {
      const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
      return `bot-${hex}`
    }

    const bodyObj = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      },
      base_info: { channel_version: '1.0.3' },
    }
    const bodyBytes = Buffer.from(JSON.stringify(bodyObj), 'utf8')

    const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${botToken}`,
      'X-WECHAT-UIN': uin,
      'Content-Length': String(bodyBytes.length),
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    try {
      console.info('[WeixinLogin] [apiSendTextChunk] →', url, 'to=', toUserId, 'len=', text.length)
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: bodyBytes,
      })
      if (!res.ok) {
        console.error('[WeixinLogin] [apiSendTextChunk] HTTP error:', res.status)
        return false
      }
      const rawText = await res.text().catch(() => '')
      if (!rawText || rawText.trim() === '{}') return true
      const data = JSON.parse(rawText) as { ret?: number; errmsg?: string }
      if (typeof data.ret === 'number' && data.ret !== 0) {
        console.error('[WeixinLogin] [apiSendTextChunk] ret!=0:', data.ret, data.errmsg)
        return false
      }
      return true
    } catch (err) {
      console.error('[WeixinLogin] [apiSendTextChunk] 异常:', err)
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── Private: iLink HTTP API ──────────────────────────────────────────────

  private buildHeaders(botToken?: string): Record<string, string> {
    // X-WECHAT-UIN: base64(random uint32 as decimal string)
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': uin,
    }
    if (botToken) {
      headers['Authorization'] = `Bearer ${botToken}`
    }
    return headers
  }

  /** 构建带 Content-Length 的请求头（iLink 必需字段，否则静默丢消息） */
  private buildHeadersWithLength(botToken: string, bodyBytes: Buffer): Record<string, string> {
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64')
    return {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Authorization': `Bearer ${botToken}`,
      'X-WECHAT-UIN': uin,
      'Content-Length': String(bodyBytes.length),
    }
  }

  private async apiFetchQrCode(): Promise<QRCodeResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const url = `${this.baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`
      const res = await fetch(url, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const hint =
          res.status >= 520 && res.status <= 530
            ? ' (iLink 服务暂时不可用，请稍后重试)'
            : res.status >= 502 && res.status <= 504
            ? ' (iLink 服务维护中，请稍后重试)'
            : body ? `: ${body.slice(0, 100)}` : ''
        throw new Error(`iLink 服务返回错误 ${res.status}${hint}`)
      }
      return (await res.json()) as QRCodeResponse
    } catch (err) {
      if ((err as NodeJS.ErrnoException).name === 'AbortError') {
        throw new Error('连接 iLink 服务超时，请检查网络后重试')
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 查询扫码状态；可与外层 signal 合并以便退出登录时立即中止挂起的请求。
   */
  private async apiPollLoginStatus(qrcode: string, outerSignal?: AbortSignal): Promise<QRStatusResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), QR_CHECK_TIMEOUT_MS)
    const onOuterAbort = (): void => controller.abort()
    if (outerSignal) {
      if (outerSignal.aborted) {
        clearTimeout(timer)
        throw new DOMException('Aborted', 'AbortError')
      }
      outerSignal.addEventListener('abort', onOuterAbort, { once: true })
    }
    try {
      const url = `${this.baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
      console.info('[WeixinLogin] [get_qrcode_status] fetching url host=', this.baseUrl, 'timeoutMs=', QR_CHECK_TIMEOUT_MS)
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.buildHeaders(),
          'iLink-App-ClientVersion': '1',
        },
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`get_qrcode_status: ${res.status}`)
      const json = (await res.json()) as QRStatusResponse
      // 只打印必要字段，避免日志里泄露敏感 token
      console.info('[WeixinLogin] [get_qrcode_status] resp:', {
        status: json.status,
        hasBotToken: !!json.bot_token,
        hasIlinkBotId: !!json.ilink_bot_id,
        hasBaseUrl: !!json.baseurl,
      })
      return json
    } finally {
      clearTimeout(timer)
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort)
    }
  }

  private async apiGetUpdates(
    session: WeixinSession,
    getUpdatesBuf: string,
    signal: AbortSignal,
    timeoutMs = LONG_POLL_TIMEOUT_MS,
  ): Promise<GetUpdatesResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    signal.addEventListener('abort', () => controller.abort())
    try {
      // 静默请求，不打印任何日志（仅错误时打印）
      const body = JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: '' },
      })
      const effectiveBase = session.baseUrl ?? this.baseUrl
      const res = await fetch(`${effectiveBase}/ilink/bot/getupdates`, {
        method: 'POST',
        headers: this.buildHeaders(session.botToken),
        body,
        signal: controller.signal,
      })
      if (res.status === 401 || res.status === 403) {
        throw new WeixinAuthError(res.status)
      }
      if (!res.ok) throw new Error(`getupdates: ${res.status}`)
      const json = (await res.json()) as GetUpdatesResponse
      return json
    } finally {
      clearTimeout(timer)
    }
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
