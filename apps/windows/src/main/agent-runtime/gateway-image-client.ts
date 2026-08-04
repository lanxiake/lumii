/**
 * 经 Gateway HTTP 同步生图（POST /v1/image/generate）
 *
 * Gateway 侧统一走流式上游，避免 Cloudflare 60s 超时；客户端只接收 JSON 结果。
 */

import { agentRuntimeLog as log } from './bridge-utils'

/** Gateway 生图响应体 */
export interface GatewayImageGenerateResponse {
  imageBase64: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  revisedPrompt: string
}

/** Gateway 生图错误体 */
interface GatewayImageErrorBody {
  code?: string
  message?: string
  error?: { message?: string }
}

const GATEWAY_IMAGE_FETCH_TIMEOUT_MS = 11 * 60 * 1000

/**
 * 拼接 Gateway 生图 URL（兼容 ws(s):// 与生产 /ws 前缀）。
 */
export function buildGatewayImageGenerateUrl(gatewayUrl: string): string {
  const root = gatewayUrl.replace(/\/+$/, '')
  return `${root}/v1/image/generate`
}

/**
 * 通过 Gateway 同步生图；需要有效设备 JWT。
 */
export async function generateImageViaGateway(options: {
  gatewayUrl: string
  getAuthToken: () => Promise<string>
  getDeviceId?: () => string | undefined
  prompt: string
  modelId: string
  width?: number
  height?: number
  signal?: AbortSignal
}): Promise<GatewayImageGenerateResponse & { effectiveModelId: string }> {
  const token = await options.getAuthToken()
  if (!token.trim()) {
    throw Object.assign(new Error('Gateway 生图需要设备认证 token，请先完成设备配对'), {
      code: 'AUTH_REQUIRED',
    })
  }

  const url = buildGatewayImageGenerateUrl(options.gatewayUrl)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), GATEWAY_IMAGE_FETCH_TIMEOUT_MS)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  const deviceId = options.getDeviceId?.()
  if (deviceId) {
    headers['X-Device-Id'] = deviceId
  }

  log.info(
    `[gatewayImage] POST ${url} model=${options.modelId} prompt="${options.prompt.slice(0, 60)}..."`,
  )

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: options.prompt,
        modelId: options.modelId,
        width: options.width ?? 1024,
        height: options.height ?? 1024,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (options.signal?.aborted || (err as Error).name === 'AbortError') {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }
    throw Object.assign(
      new Error(`Gateway 生图网络错误: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'GATEWAY_NETWORK_ERROR' },
    )
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', onAbort)
  }

  const bodyText = await resp.text()
  let parsed: unknown = {}
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {}
  } catch {
    parsed = {}
  }

  if (!resp.ok) {
    const errBody = parsed as GatewayImageErrorBody
    const message =
      errBody.message ??
      errBody.error?.message ??
      bodyText.slice(0, 300) ??
      `Gateway 生图失败 (${resp.status})`
    throw Object.assign(new Error(message), {
      code: errBody.code ?? 'PROVIDER_ERROR',
    })
  }

  const data = parsed as GatewayImageGenerateResponse
  if (!data.imageBase64?.trim()) {
    throw Object.assign(new Error('Gateway 生图返回空图片数据'), { code: 'PROVIDER_ERROR' })
  }

  return {
    ...data,
    effectiveModelId: options.modelId,
  }
}
