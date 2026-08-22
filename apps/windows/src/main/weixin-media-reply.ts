/**
 * WeixinLoginService 发送回复逻辑：文本分段发送、媒体文件上传到 iLink CDN 后发送。
 * 均以显式参数接收 baseUrl/botToken（调用方从 session 或 this.baseUrl 解析后传入），
 * 不持有跨调用的共享状态。
 */

import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { buildHeaders, buildHeadersWithLength } from './weixin-ilink-api.js'

/** 根据文件名推断 MIME 类型 */
function guessMimeType(fileName: string): string {
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
function mimeToUploadMediaType(mimeType: string): number {
  const m = mimeType.toLowerCase()
  if (m.startsWith('image/')) return 1  // IMAGE
  if (m.startsWith('video/')) return 2  // VIDEO
  if (m.startsWith('audio/')) return 4  // VOICE
  return 3  // FILE
}

/** 将 MIME 类型映射到 iLink MessageItemType（sendmessage item_list[].type 字段） */
function mimeToMessageItemType(mimeType: string): 2 | 3 | 4 | 5 {
  const m = mimeType.toLowerCase()
  if (m.startsWith('image/')) return 2   // IMAGE
  if (m.startsWith('audio/')) return 3   // VOICE
  if (m.startsWith('video/')) return 5   // VIDEO
  return 4                               // FILE
}

/** AES-128-ECB 加密（PKCS7 填充） */
function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

/** 计算 AES-128-ECB 密文大小（PKCS7 填充到 16 字节边界） */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16
}

/** 上传文件到 iLink CDN，返回下载加密参数和 AES key */
async function uploadMediaToIlink(
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
  const filesize = aesEcbPaddedSize(rawsize)
  const mediaType = mimeToUploadMediaType(mimeType)

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
    headers: buildHeadersWithLength(botToken, getUrlBodyBuf),
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
  const ciphertext = encryptAesEcb(fileBuffer, aeskey)
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
function buildMediaItemList(
  fileName: string,
  mimeType: string,
  mediaInfo: { downloadEncryptedQueryParam: string; aeskeyHex: string; fileSizeCiphertext: number },
  fileSize: number,
): Record<string, unknown>[] {
  const itemType = mimeToMessageItemType(mimeType)
  // aes_key 编码：将 hex 字符串的 ASCII 字节做 base64（与上游 weixin send.ts 一致）
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
async function apiSendMessageWithItems(
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
      headers: buildHeadersWithLength(botToken, bodyBytes),
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

/**
 * 向指定微信用户发送文件或图片（通过 iLink CDN 上传后发送）。
 * 支持图片(jpg/png/gif/webp)、文档(pdf/docx/xlsx/pptx/txt/md)等文件类型。
 *
 * @param baseUrl      已解析的 iLink base URL（调用方从 session 或当前 baseUrl 解析后传入）
 * @param botToken     已解析的 bot_token
 * @param toUserId     接收者的微信用户 ID
 * @param filePath     本地文件绝对路径
 * @param fileName     文件名（可选，默认从 filePath 提取）
 * @param contextToken 来自入站消息的 context_token
 */
export async function sendMediaReply(
  baseUrl: string,
  botToken: string,
  toUserId: string,
  filePath: string,
  fileName: string | undefined,
  contextToken: string,
): Promise<boolean> {
  try {
    const fileBuffer = await fsPromises.readFile(filePath)
    const name = fileName ?? path.basename(filePath)
    const mimeType = guessMimeType(name)

    console.log(`[WeixinLogin] [sendMediaReply] 开始上传文件: ${name} (${fileBuffer.length} bytes, ${mimeType})`)

    // Step 1: 上传文件到 iLink CDN
    const mediaInfo = await uploadMediaToIlink(baseUrl, botToken, fileBuffer, mimeType, toUserId)

    // Step 2: 构建 item_list 并发送消息
    const itemList = buildMediaItemList(name, mimeType, mediaInfo, fileBuffer.length)
    const ok = await apiSendMessageWithItems(baseUrl, toUserId, contextToken, botToken, itemList)

    console.log(`[WeixinLogin] [sendMediaReply] 文件发送 ${ok ? '成功' : '失败'}: ${name}`)
    return ok
  } catch (err) {
    console.error(`[WeixinLogin] [sendMediaReply] 发送失败: ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

/** 发送单段文本消息（sendTextReply 按 2000 字符分段调用） */
export async function apiSendTextChunk(
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

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    console.info('[WeixinLogin] [apiSendTextChunk] →', url, 'to=', toUserId, 'len=', text.length)
    // 勿手动设 Content-Length：新版 undici/fetch 会判为 invalid content-length（UND_ERR_INVALID_ARG）
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(botToken),
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
