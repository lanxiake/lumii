/**
 * 生图直连客户端（Windows Agent Runtime）
 *
 * 与 Gateway image-generate-http 对齐：所有模型统一走流式
 * POST /v1/chat/completions?stream=true，避免 Cloudflare 60s 与非流式连接被重置。
 *
 * 上游选择（planImageDispatch）：
 *   gpt-image-*     → IMAGE_UPSTREAM（llm-link）优先，否则 Right Code Draw
 *   nano-banana 系列 → 有独立 DRAW Key 时走 Draw，否则映射 gpt-image-2 @ IMAGE_UPSTREAM
 *
 * 环境变量见 draw-config.ts（MTBOT_DRAW_* / MTBOT_IMAGE_UPSTREAM_*）。
 */

import {
  loadDrawConfig,
  DEFAULT_DRAW_API_BASE_URL,
  DEFAULT_IMAGE_UPSTREAM_BASE_URL,
} from '../draw-config.js'
import { agentRuntimeLog as log } from './bridge-utils'

/** @deprecated 使用 DEFAULT_DRAW_API_BASE_URL（来自 draw-config 模块） */
export { DEFAULT_DRAW_API_BASE_URL }

/** nano-banana 系列（Right Code Draw 原生支持） */
const CHAT_COMPLETIONS_IMAGE_MODELS = new Set([
  'nano-banana',
  'nano-banana-2',
  'nano-banana-pro',
])

/** 走 OpenAI Images API（/v1/images/generations，返回 b64_json）的模型 */
const OPENAI_IMAGE_MODELS = new Set(['gpt-image-2', 'gpt-image-2-vip'])

/** 生图直连上游（与 Gateway resolveImageUpstreamConfig 字段对齐） */
interface ImageUpstreamConfig {
  baseUrl: string
  apiKey: string
  drawBaseUrl: string
  drawApiKey: string
}

/** 单次上游 HTTP 路由计划 */
interface ImageDispatchPlan {
  baseUrl: string
  apiKey: string
  effectiveModelId: string
  modelNote?: string
}

/** 中转站常按 UA 拦截非 curl 客户端 */
const DRAW_UPSTREAM_USER_AGENT = 'curl/8.4.0'

/** 单次上游请求超时（ms） */
const FETCH_TIMEOUT_MS = 11 * 60 * 1000

export interface DrawImageRequest {
  prompt: string
  modelId: string
  width?: number
  height?: number
  signal?: AbortSignal
}

export interface DrawImageResult {
  imageBase64: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  revisedPrompt: string
  effectiveModelId: string
}

/**
 * 解析 IMAGE_UPSTREAM 配置（llm-link 等）；未配置时返回 null。
 */
function resolveImageUpstreamConfig(): ImageUpstreamConfig | null {
  const apiKey = process.env.MTBOT_IMAGE_UPSTREAM_API_KEY?.trim() ?? ''
  if (!apiKey) return null

  const baseUrl = (
    process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL?.trim() || DEFAULT_IMAGE_UPSTREAM_BASE_URL
  ).replace(/\/+$/, '')

  const drawBaseUrl = (
    process.env.MTBOT_DRAW_API_BASE_URL?.trim() || DEFAULT_DRAW_API_BASE_URL
  ).replace(/\/+$/, '')

  const drawApiKey = process.env.MTBOT_DRAW_API_KEY?.trim() || apiKey

  return { baseUrl, apiKey, drawBaseUrl, drawApiKey }
}

/**
 * 解析 Right Code Draw 配置（需先经 loadDrawConfig 注入环境变量）。
 */
export function resolveDrawApiConfig(): { baseUrl: string; apiKey: string } {
  const apiKey = process.env.MTBOT_DRAW_API_KEY?.trim() ?? ''
  const baseUrl = (
    process.env.MTBOT_DRAW_API_BASE_URL?.trim() || DEFAULT_DRAW_API_BASE_URL
  ).replace(/\/+$/, '')
  if (!apiKey) {
    throw Object.assign(
      new Error(
        '未配置生图 API Key：请在 config/draw-config.json 设置 drawApiKey 或 imageUpstreamApiKey',
      ),
      { code: 'DRAW_API_KEY_MISSING' },
    )
  }
  return { baseUrl, apiKey }
}

/**
 * 解析生图上游路由（与 Gateway planImageDispatch 逻辑对齐，均走流式 chat）。
 */
function planImageDispatch(requestedModelId: string): ImageDispatchPlan {
  const upstream = resolveImageUpstreamConfig()
  const hasDedicatedDrawKey = Boolean(
    process.env.MTBOT_DRAW_API_KEY?.trim() &&
      (!upstream || upstream.drawApiKey !== upstream.apiKey),
  )

  if (CHAT_COMPLETIONS_IMAGE_MODELS.has(requestedModelId)) {
    if (upstream && hasDedicatedDrawKey) {
      return {
        baseUrl: upstream.drawBaseUrl,
        apiKey: upstream.drawApiKey,
        effectiveModelId: requestedModelId,
      }
    }
    if (upstream) {
      return {
        baseUrl: upstream.baseUrl,
        apiKey: upstream.apiKey,
        effectiveModelId: 'gpt-image-2',
        modelNote:
          requestedModelId !== 'gpt-image-2'
            ? `${requestedModelId} 需配置 drawApiKey；本次已映射为 gpt-image-2（流式单次请求）`
            : undefined,
      }
    }
    const draw = resolveDrawApiConfig()
    return {
      baseUrl: draw.baseUrl,
      apiKey: draw.apiKey,
      effectiveModelId: requestedModelId,
    }
  }

  if (upstream) {
    return {
      baseUrl: upstream.baseUrl,
      apiKey: upstream.apiKey,
      effectiveModelId: requestedModelId,
    }
  }

  const draw = resolveDrawApiConfig()
  return {
    baseUrl: draw.baseUrl,
    apiKey: draw.apiKey,
    effectiveModelId: requestedModelId,
  }
}

/**
 * 拼接 OpenAI 兼容路径（baseUrl 可能已含 /v1 或不含）。
 */
function buildOpenAiCompatUrl(baseUrl: string, subPath: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  const path = subPath.replace(/^\//, '')
  if (root.endsWith('/v1')) {
    return `${root}/${path}`
  }
  return `${root}/v1/${path}`
}

/**
 * 标准化 OpenAI Images API 尺寸档位。
 */
function normalizeOpenAiSize(w: number, h: number): string {
  if (w === h) return '1024x1024'
  if (w > h) return '1536x1024'
  return '1024x1536'
}

/**
 * 从 Chat Completions 文本或错误体中提取图片 URL / data URL。
 */
function extractImageUrlFromText(content: string): string | null {
  const markdown = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[^)]+)\)/i)
  if (markdown?.[1]) return markdown[1]
  const plainUrl = content.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp)(?:\?\S*)?/i)
  if (plainUrl?.[0]) return plainUrl[0]
  const dataUrl = content.match(/data:image\/[a-z0-9+.-]+;base64,[A-Za-z0-9+/=]+/i)
  if (dataUrl?.[0]) return dataUrl[0]
  return null
}

/**
 * 将图片 URL 或 data URL 转为 base64。
 */
async function resolveImageBase64FromUrl(
  imageUrl: string,
): Promise<{ imageBase64: string; mimeType: DrawImageResult['mimeType'] }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i)
    if (!match) {
      throw Object.assign(new Error('无法解析 data URL 图片'), { code: 'PROVIDER_ERROR' })
    }
    const mime = match[1].toLowerCase()
    const allowed = ['image/png', 'image/jpeg', 'image/webp'] as const
    const mimeType = (allowed.includes(mime as (typeof allowed)[number]) ? mime : 'image/png') as DrawImageResult['mimeType']
    return { imageBase64: match[2], mimeType }
  }

  const imgResp = await fetch(imageUrl)
  if (!imgResp.ok) {
    throw Object.assign(new Error(`下载图片失败 ${imgResp.status}`), { code: 'PROVIDER_ERROR' })
  }
  const buf = Buffer.from(await imgResp.arrayBuffer())
  const contentType = imgResp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const mimeType: DrawImageResult['mimeType'] =
    contentType === 'image/jpeg' || contentType === 'image/webp' ? contentType : 'image/png'
  return { imageBase64: buf.toString('base64'), mimeType }
}

/**
 * 消费 SSE 流式 Chat Completions，拼接 content。
 */
async function collectSseChatContent(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''

  try {
    while (true) {
      if (signal?.aborted) {
        throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>
          }
          const delta = chunk.choices?.[0]?.delta?.content
          if (typeof delta === 'string') content += delta
          const msgContent = chunk.choices?.[0]?.message?.content
          if (typeof msgContent === 'string') content += msgContent
        } catch {
          // 跳过无法解析的 SSE 分片
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  return content
}

/**
 * 解析 OpenAI Images API 错误消息。
 */
function parseProviderErrorMessage(status: number, errText: string): string {
  let msg = `Draw API error ${status}`
  try {
    const err = JSON.parse(errText) as Record<string, unknown>
    const errObj = (err.error ?? err) as Record<string, unknown>
    if (typeof errObj.message === 'string') msg = errObj.message
    else if (typeof err.message === 'string') msg = err.message
    else if (errText) msg = errText.slice(0, 500)
  } catch {
    if (errText) msg = errText.slice(0, 500)
  }
  return msg
}

/**
 * 上游 HTTP 错误时，若错误体含图片 URL 则抢救。
 */
async function trySalvageFromErrorText(
  errText: string,
  req: DrawImageRequest,
): Promise<DrawImageResult | null> {
  const imageUrl = extractImageUrlFromText(errText)
  if (!imageUrl) return null
  try {
    const { imageBase64, mimeType } = await resolveImageBase64FromUrl(imageUrl)
    const size = normalizeOpenAiSize(req.width ?? 1024, req.height ?? 1024)
    const [w, h] = size.split('x').map(Number) as [number, number]
    return {
      imageBase64,
      mimeType,
      width: w,
      height: h,
      revisedPrompt: req.prompt,
      effectiveModelId: req.modelId,
    }
  } catch {
    return null
  }
}

/**
 * 通过流式 POST /v1/chat/completions 生成图片。
 */
async function generateWithChatCompletionsStream(
  req: DrawImageRequest,
  apiKey: string,
  baseUrl: string,
): Promise<DrawImageResult> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let resp: Response
  try {
    resp = await fetch(buildOpenAiCompatUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        'User-Agent': DRAW_UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify({
        model: req.modelId,
        stream: true,
        messages: [{ role: 'user', content: req.prompt }],
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if (req.signal?.aborted || (err as Error).name === 'AbortError') {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }
    throw Object.assign(
      new Error(`图片生成网络错误: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'PROVIDER_ERROR' },
    )
  } finally {
    clearTimeout(timeout)
    req.signal?.removeEventListener('abort', onAbort)
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    const salvaged = await trySalvageFromErrorText(errText, req)
    if (salvaged) return salvaged
    const msg = parseProviderErrorMessage(resp.status, errText)
    throw Object.assign(new Error(msg), { code: 'PROVIDER_ERROR' })
  }

  const content = await collectSseChatContent(resp.body, req.signal)
  const imageUrl = extractImageUrlFromText(content)
  if (!imageUrl) {
    throw Object.assign(
      new Error(
        `响应中未找到图片链接（model=${req.modelId}）。原文片段: ${content.slice(0, 200)}`,
      ),
      { code: 'PROVIDER_ERROR' },
    )
  }

  const { imageBase64, mimeType } = await resolveImageBase64FromUrl(imageUrl)
  return {
    imageBase64,
    mimeType,
    width: req.width ?? 1024,
    height: req.height ?? 1024,
    revisedPrompt: req.prompt,
    effectiveModelId: req.modelId,
  }
}

/**
 * 通过 OpenAI Images API（POST /v1/images/generations）生成图片。
 * gpt-image-2 系列上游不支持流式 chat（只回 "Progressing... %" 进度文本），必须走此接口。
 */
async function generateWithOpenAiImages(
  req: DrawImageRequest,
  apiKey: string,
  baseUrl: string,
): Promise<DrawImageResult> {
  const size = normalizeOpenAiSize(req.width ?? 1024, req.height ?? 1024)
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  req.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let resp: Response
  try {
    resp = await fetch(buildOpenAiCompatUrl(baseUrl, 'images/generations'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': DRAW_UPSTREAM_USER_AGENT,
      },
      // gpt-image 系列默认返回 b64_json，不传 response_format（部分上游不识别）
      body: JSON.stringify({ model: req.modelId, prompt: req.prompt, size, n: 1 }),
      signal: controller.signal,
    })
  } catch (err) {
    if (req.signal?.aborted || (err as Error).name === 'AbortError') {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }
    throw Object.assign(
      new Error(`图片生成网络错误: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'PROVIDER_ERROR' },
    )
  } finally {
    clearTimeout(timeout)
    req.signal?.removeEventListener('abort', onAbort)
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    const salvaged = await trySalvageFromErrorText(errText, req)
    if (salvaged) return salvaged
    throw Object.assign(new Error(parseProviderErrorMessage(resp.status, errText)), {
      code: 'PROVIDER_ERROR',
    })
  }

  const data = (await resp.json().catch(() => ({}))) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  }
  const item = data.data?.[0]
  if (!item) {
    throw Object.assign(new Error('上游返回的图片数据为空'), { code: 'PROVIDER_ERROR' })
  }

  let imageBase64 = item.b64_json ?? ''
  let mimeType: DrawImageResult['mimeType'] = 'image/png'
  // 部分上游只返回 url，需要下载转 base64
  if (!imageBase64 && item.url) {
    const resolved = await resolveImageBase64FromUrl(item.url)
    imageBase64 = resolved.imageBase64
    mimeType = resolved.mimeType
  }
  if (!imageBase64) {
    throw Object.assign(new Error('上游返回的图片数据为空'), { code: 'PROVIDER_ERROR' })
  }

  const [w, h] = size.split('x').map(Number) as [number, number]
  return {
    imageBase64,
    mimeType,
    width: w,
    height: h,
    revisedPrompt: item.revised_prompt ?? req.prompt,
    effectiveModelId: req.modelId,
  }
}

/**
 * 直连上游生图（单次 HTTP，按模型选择接口）。
 */
export async function generateImageViaRightCodesDraw(req: DrawImageRequest): Promise<DrawImageResult> {
  await loadDrawConfig()
  const plan = planImageDispatch(req.modelId)
  // 按 effectiveModelId 选接口：gpt-image-2 系列走 OpenAI Images API，nano-banana 走流式 chat。
  const useOpenAiImages = OPENAI_IMAGE_MODELS.has(plan.effectiveModelId)
  log.info(
    `[rightCodesDraw] model=${req.modelId} effective=${plan.effectiveModelId} ` +
      `route=${useOpenAiImages ? 'images/generations' : 'chat/stream'} ` +
      `baseUrl=${plan.baseUrl} prompt="${req.prompt.slice(0, 60)}..."`,
  )

  const upstreamReq: DrawImageRequest = { ...req, modelId: plan.effectiveModelId }
  const result = useOpenAiImages
    ? await generateWithOpenAiImages(upstreamReq, plan.apiKey, plan.baseUrl)
    : await generateWithChatCompletionsStream(upstreamReq, plan.apiKey, plan.baseUrl)

  if (plan.modelNote) {
    return {
      ...result,
      revisedPrompt: `${req.prompt}\n\n[系统注：${plan.modelNote}]`,
    }
  }
  return result
}
