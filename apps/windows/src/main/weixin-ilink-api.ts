/**
 * WeixinLoginService iLink HTTP API 封装：QR 码获取、扫码状态查询、消息拉取。
 * 全部函数以参数注入 baseUrl/botToken，不依赖 class 实例（this.baseUrl 可能动态变化，
 * 调用方必须每次传入最新值，不能缓存）。
 */

import type { WeixinSession } from './weixin-session-store.js'
import { WeixinAuthError, type QRCodeResponse, type QRStatusResponse, type GetUpdatesResponse } from './weixin-message-utils.js'

const DEFAULT_BOT_TYPE = 3
/** 扫码后轮询状态：服务端可能长时间挂起等待确认，过短会 AbortError；与消息长轮询同量级 */
const QR_CHECK_TIMEOUT_MS = 60_000
const LONG_POLL_TIMEOUT_MS = 35_000

export function buildHeaders(botToken?: string): Record<string, string> {
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

/**
 * 构建 POST 请求头。
 * 不设置 Content-Length：fetch 会按 body 自动计算；手动设置会与新版 undici 冲突，
 * 抛出 InvalidArgumentError: invalid content-length header（微信发送失败）。
 */
export function buildHeadersWithLength(botToken: string, _bodyBytes?: Buffer): Record<string, string> {
  return buildHeaders(botToken)
}

export async function apiFetchQrCode(baseUrl: string): Promise<QRCodeResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(),
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
export async function apiPollLoginStatus(baseUrl: string, qrcode: string, outerSignal?: AbortSignal): Promise<QRStatusResponse> {
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
    const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`
    console.info('[WeixinLogin] [get_qrcode_status] fetching url host=', baseUrl, 'timeoutMs=', QR_CHECK_TIMEOUT_MS)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...buildHeaders(),
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

export async function apiGetUpdates(
  baseUrl: string,
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
    const effectiveBase = session.baseUrl ?? baseUrl
    const res = await fetch(`${effectiveBase}/ilink/bot/getupdates`, {
      method: 'POST',
      headers: buildHeaders(session.botToken),
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
