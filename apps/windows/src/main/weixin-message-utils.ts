/**
 * WeixinLoginService 纯函数工具集：QR 状态判断、媒体解析、CDN 下载、消息类型映射。
 * 全部函数不依赖 class 实例状态（无 this），可独立测试。
 */

import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createDecipheriv } from 'node:crypto'
import { resolveClientStateDir } from './paths.js'

/**
 * iLink 认证失败（401/403），表示 bot_token 已过期或被吊销，需要重新扫码登录。
 * 与普通网络错误区分，便于 pollLoop 做不同的恢复策略。
 */
export class WeixinAuthError extends Error {
  readonly statusCode: number
  constructor(statusCode: number) {
    super(`iLink 认证失败 (${statusCode})，session 已过期，请重新扫码登录`)
    this.name = 'WeixinAuthError'
    this.statusCode = statusCode
  }
}

/**
 * 与上游微信 CLI 实现一致：接口路径挂在域名根下（/ilink/bot/...）。
 * 旧默认曾误用 `.../api`，会导致 404。仍支持通过环境变量传入带 `/api` 的官方域名并自动纠正。
 */
export function normalizeIlinkBaseUrl(url: string): string {
  let u = url.trim().replace(/\/$/, '')
  if (u.endsWith('/api') && u.includes('ilinkai.weixin.qq.com')) {
    u = u.slice(0, -4)
  }
  return u
}

// ─── iLink API types (matching upstream weixin-cli) ────────────────────────

export interface QRCodeResponse {
  qrcode: string
  qrcode_img_content?: string
}

export interface QRStatusResponse {
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

export interface CdnMediaRef {
  file_key?: string
  encrypt_query_param?: string
  aes_key?: string
  aeskey?: string
}

export interface MessageItem {
  // iLink MessageItemType: 1=text, 2=image, 3=voice, 4=file, 5=video
  // (confirmed per @tencent-weixin upstream protocol spec)
  type: number
  text_item?: { text: string }
  voice_item?: (CdnMediaRef & { text?: string; media?: CdnMediaRef })
  image_item?: (CdnMediaRef & { media?: CdnMediaRef })
  video_item?: (CdnMediaRef & { media?: CdnMediaRef })
  file_item?: (CdnMediaRef & { file_name?: string; media?: CdnMediaRef })
}

export interface WeixinRawMessage {
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

export interface GetUpdatesResponse {
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
export function buildMediaFallbackText(items: MessageItem[]): string {
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
export function extractMediaFileKey(item: MessageItem): string {
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
export function extractMediaCrypto(item: MessageItem): { encryptQueryParam?: string; aesKey?: string } {
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
export function parseAesKeyLocal(aesKey: string): Buffer | undefined {
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
export function collectWeixinCdnHosts(ilinkBaseUrl: string): string[] {
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
export function buildCdnCandidates(encryptedQueryParam: string, ilinkBaseUrl: string): string[] {
  const enc = encodeURIComponent(encryptedQueryParam)
  return collectWeixinCdnHosts(ilinkBaseUrl).flatMap((host) => [
    `${host}/download?encrypted_query_param=${enc}`,
    `${host}/ilink/cdn/download?encrypted_query_param=${enc}`,
  ])
}

/** 消息文本中由客户端注入的媒体附件行（downloadAndSaveMediaItems 之后追加） */
export function extractMediaAttachmentLines(text: string): string[] {
  return text.split('\n').filter((l) => /^\[media attached:/.test(l.trim()))
}

/**
 * 判定「纯媒体消息」：用户只发了附件、一个字都没写。
 *
 * 仅此情形才该把附件缓存起来、回复"请发送文字说明"。只要用户带了文字
 * （含 iLink 回传的语音转录 voice_item.text、图片/文件的说明文字），
 * 就必须直接派发给 Agent，否则消息会被静默吞掉、用户等不到回复。
 *
 * 注意不能用 `text` 是否为空判断：纯媒体消息的 text 会被填入
 * buildMediaFallbackText 的占位描述，永远非空。
 */
export function isPureMediaMessage(msg: {
  type: 'text' | 'media'
  text?: string
  hasUserText: boolean
}): boolean {
  if (msg.type !== 'media' || msg.hasUserText) return false
  return extractMediaAttachmentLines(msg.text ?? '').length > 0
}

/** MessageItemType → 文件扩展名映射（IMAGE=2, VOICE=3, FILE=4, VIDEO=5） */
export function mapItemTypeToExt(type: 2 | 3 | 4 | 5): string {
  switch (type) {
    case 2: return '.jpg'
    case 3: return '.silk'
    case 4: return ''
    case 5: return '.mp4'
  }
}

export type MediaItemShape = {
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
export async function downloadAndSaveMediaItems(
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
export function isQrLoginComplete(r: QRStatusResponse): boolean {
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
export function isQrScannedPendingConfirm(status: string): boolean {
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
export function isQrExpiredStatus(status: string): boolean {
  const s = (status || '').toLowerCase()
  return s === 'expired' || s === 'timeout' || s === 'invalid'
}
