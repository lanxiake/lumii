/**
 * RightAPI 异步生图客户端
 *
 * 与 right-codes-draw-client（同步/流式）不同，RightAPI 统一走异步任务模式：
 *   1. POST {base}/images/generations，请求体固定带 "async": true，立即返回 task_id
 *   2. 轮询 GET {siteRoot}/v1/tasks/{task_id}，直到 status=completed
 *   3. 从结果里取图片 URL 或 base64，下载落盘
 *
 * 任务查询是站点级接口，不带 /draw 前缀：
 *   绘图地址 https://www.rightapi.ai/draw/v1/images/generations
 *   查询地址 https://www.rightapi.ai/v1/tasks/{task_id}
 *
 * 支持参考图：image 字段传 data URL 数组（data:image/png;base64,...）。
 *
 * 接口文档见 docs/temp/绘图接口.md
 */

import { agentRuntimeLog as log } from './bridge-utils'

/** RightAPI 默认绘图基础地址（含 /draw/v1） */
export const DEFAULT_RIGHTAPI_BASE_URL = 'https://www.rightapi.ai/draw/v1'

/** 轮询起始间隔（ms） */
const POLL_INTERVAL_START_MS = 1500

/** 轮询最大间隔（ms） */
const POLL_INTERVAL_MAX_MS = 5000

/** 轮询间隔递增系数 */
const POLL_BACKOFF_FACTOR = 1.3

/** 整体等待上限（ms），超时视为失败 */
const POLL_TOTAL_TIMEOUT_MS = 11 * 60 * 1000

/** 单次 HTTP 超时（ms），异步接口应秒回，给足冗余即可 */
const HTTP_TIMEOUT_MS = 60 * 1000

/** 中转站常按 UA 拦截非 curl 客户端 */
const UPSTREAM_USER_AGENT = 'curl/8.4.0'

export interface RightApiImageRequest {
  prompt: string
  modelId: string
  baseUrl: string
  apiKey: string
  width?: number
  height?: number
  /** 参考图 data URL 数组（data:image/png;base64,...） */
  referenceImageDataUrls?: string[]
  signal?: AbortSignal
}

export interface RightApiImageResult {
  imageBase64: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  revisedPrompt: string
  effectiveModelId: string
}

/** 提交任务响应（只关心 task_id / 直接完成两种情况） */
interface SubmitTaskResponse {
  task_id?: string
  taskId?: string
  id?: string
  status?: string
  message?: string
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
}

/** 任务查询响应（Images 形状 / Gemini 形状 / 状态体三合一） */
interface TaskQueryResponse {
  task_id?: string
  status?: string
  progress?: number
  error?: { message?: string; code?: string }
  message?: string
  created?: number
  data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> }
  }>
}

/**
 * 拼接 RightAPI 绘图端点（baseUrl 形如 https://host/draw/v1）。
 */
export function buildRightApiGenerationsUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '')
  if (/\/images\/generations$/i.test(root)) return root
  if (/\/v1$/i.test(root)) return `${root}/images/generations`
  // 用户可能只填到 /draw，补全 /v1
  return `${root}/v1/images/generations`
}

/**
 * 从绘图 baseUrl 推导站点级任务查询地址。
 *
 * https://host/draw/v1        → https://host/v1/tasks/{id}
 * https://host/prefix/draw/v1 → https://host/prefix/v1/tasks/{id}
 */
export function buildRightApiTaskUrl(baseUrl: string, taskId: string): string {
  const url = new URL(baseUrl)
  // 去掉尾部的 /v1、/images/generations、/draw，剩下的即站点根路径
  const siteRoot = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/images\/generations$/i, '')
    .replace(/\/v1$/i, '')
    .replace(/\/draw$/i, '')
  url.pathname = `${siteRoot}/v1/tasks/${encodeURIComponent(taskId)}`
  url.search = ''
  return url.toString()
}

/**
 * 归一化尺寸为 RightAPI 的 size（像素串）与 imageSize（清晰度档位）。
 * imageSize 仅 1K/2K/4K 合法，且只有 nano-banana / gpt-image vip 系列可用；
 * 1K 为缺省值，不下发以避免上游拒绝。
 */
export function normalizeRightApiSize(
  width?: number,
  height?: number,
): { size: string; imageSize?: '2K' | '4K' } {
  const w = width && width > 0 ? width : 1024
  const h = height && height > 0 ? height : 1024
  const longEdge = Math.max(w, h)
  const imageSize = longEdge > 2048 ? '4K' : longEdge > 1024 ? '2K' : undefined
  return { size: `${w}x${h}`, imageSize }
}

/**
 * 解析上游错误体中的可读信息。
 */
function parseUpstreamErrorMessage(status: number, errText: string): string {
  try {
    const err = JSON.parse(errText) as Record<string, unknown>
    const errObj = (err.error ?? err) as Record<string, unknown>
    if (typeof errObj.message === 'string' && errObj.message) return errObj.message
    if (typeof err.message === 'string' && err.message) return err.message
  } catch {
    /* 非 JSON（如 Cloudflare HTML 错误页），走下面的截断 */
  }
  const plain = errText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return plain ? `HTTP ${status}: ${plain.slice(0, 300)}` : `RightAPI 请求失败 (HTTP ${status})`
}

/**
 * 带超时与中断的 fetch 包装。
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    if (signal?.aborted || (err as Error).name === 'AbortError') {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }
    throw Object.assign(
      new Error(`RightAPI 网络错误: ${err instanceof Error ? err.message : String(err)}`),
      { code: 'PROVIDER_ERROR' },
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 允许的落盘 MIME 类型 */
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const

/**
 * 把图片 URL 或 data URL 下载为 base64（异步任务结果通常是 CDN URL，必须及时下载）。
 */
export async function downloadRightApiImage(
  imageUrl: string,
  signal?: AbortSignal,
): Promise<{ imageBase64: string; mimeType: RightApiImageResult['mimeType'] }> {
  if (imageUrl.startsWith('data:')) {
    const match = imageUrl.match(/^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i)
    if (!match) {
      throw Object.assign(new Error('无法解析 data URL 图片'), { code: 'PROVIDER_ERROR' })
    }
    const mime = match[1].toLowerCase()
    const mimeType = (ALLOWED_MIME as readonly string[]).includes(mime)
      ? (mime as RightApiImageResult['mimeType'])
      : 'image/png'
    return { imageBase64: match[2], mimeType }
  }

  const resp = await fetchWithTimeout(imageUrl, {}, signal, HTTP_TIMEOUT_MS)
  if (!resp.ok) {
    throw Object.assign(new Error(`下载生成图片失败 HTTP ${resp.status}`), {
      code: 'PROVIDER_ERROR',
    })
  }
  const buf = Buffer.from(await resp.arrayBuffer())
  const contentType = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  const mimeType: RightApiImageResult['mimeType'] =
    contentType === 'image/jpeg' || contentType === 'image/webp' ? contentType : 'image/png'
  return { imageBase64: buf.toString('base64'), mimeType }
}

/** 任务结果里提取到的图片载荷 */
export interface ExtractedImagePayload {
  /** 直接可用的 base64（inlineData / b64_json） */
  imageBase64?: string
  mimeType?: RightApiImageResult['mimeType']
  /** 需要下载的 URL */
  imageUrl?: string
  revisedPrompt?: string
}

/**
 * 从任务结果里提取图片（兼容 Images 形状与 Gemini 形状）。
 * 提取不到返回 null，表示任务尚未产出结果。
 */
export function extractRightApiImagePayload(
  body: TaskQueryResponse | SubmitTaskResponse,
): ExtractedImagePayload | null {
  // Images 形状：{ created, data: [{ url | b64_json }] }
  const item = body.data?.[0]
  if (item?.b64_json?.trim()) {
    return { imageBase64: item.b64_json, revisedPrompt: item.revised_prompt }
  }
  if (item?.url?.trim()) {
    return { imageUrl: item.url, revisedPrompt: item.revised_prompt }
  }

  // Gemini 形状：{ candidates: [{ content: { parts: [{ text | inlineData }] } }] }
  const parts = (body as TaskQueryResponse).candidates?.[0]?.content?.parts ?? []
  for (const part of parts) {
    const inline = part.inlineData
    if (inline?.data?.trim()) {
      const mime = inline.mimeType?.toLowerCase()
      return {
        imageBase64: inline.data,
        mimeType: (ALLOWED_MIME as readonly string[]).includes(mime ?? '')
          ? (mime as RightApiImageResult['mimeType'])
          : 'image/png',
      }
    }
    const text = part.text?.trim()
    if (!text) continue
    const url = text.match(/https?:\/\/\S+/)?.[0] ?? text.match(/data:image\/[^\s"')]+/)?.[0]
    if (url) return { imageUrl: url }
  }

  return null
}

/**
 * 提交异步生图任务，返回 task_id；若上游直接回了结果则返回 payload。
 */
async function submitRightApiTask(
  req: RightApiImageRequest,
): Promise<{ taskId?: string; payload?: ExtractedImagePayload }> {
  const url = buildRightApiGenerationsUrl(req.baseUrl)
  const { size, imageSize } = normalizeRightApiSize(req.width, req.height)
  const refs = req.referenceImageDataUrls?.filter((u) => u.trim().length > 0) ?? []

  const body: Record<string, unknown> = {
    model: req.modelId,
    prompt: req.prompt,
    n: 1,
    size,
    async: true,
  }
  if (imageSize) body.imageSize = imageSize
  if (refs.length > 0) body.image = refs

  log.info(
    `[rightapi] 提交任务 POST ${url} model=${req.modelId} size=${size}` +
      `${imageSize ? ` imageSize=${imageSize}` : ''} refs=${refs.length} ` +
      `prompt="${req.prompt.slice(0, 60)}..."`,
  )

  const resp = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
        'User-Agent': UPSTREAM_USER_AGENT,
      },
      body: JSON.stringify(body),
    },
    req.signal,
    HTTP_TIMEOUT_MS,
  )

  const text = await resp.text()
  if (!resp.ok) {
    throw Object.assign(new Error(parseUpstreamErrorMessage(resp.status, text)), {
      code: 'PROVIDER_ERROR',
    })
  }

  let parsed: SubmitTaskResponse
  try {
    parsed = text ? (JSON.parse(text) as SubmitTaskResponse) : {}
  } catch {
    throw Object.assign(
      new Error(`RightAPI 提交任务响应无法解析: ${text.slice(0, 200)}`),
      { code: 'PROVIDER_ERROR' },
    )
  }

  // 少数情况上游可能忽略 async 直接返回结果，直接取用避免多余轮询
  const immediate = extractRightApiImagePayload(parsed)
  if (immediate) {
    log.info('[rightapi] 上游直接返回结果，跳过轮询')
    return { payload: immediate }
  }

  const taskId = parsed.task_id ?? parsed.taskId ?? parsed.id
  if (!taskId?.trim()) {
    throw Object.assign(
      new Error(
        `RightAPI 未返回 task_id（model=${req.modelId}）。响应片段: ${text.slice(0, 200)}`,
      ),
      { code: 'PROVIDER_ERROR' },
    )
  }
  log.info(`[rightapi] 任务已提交 task_id=${taskId}`)
  return { taskId }
}

/**
 * 可中断的等待。
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' }))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 轮询任务直到产出结果或失败。
 *
 * 仅需 baseUrl / apiKey / signal，故也可供同步路径的异步兜底复用
 * （见 right-codes-draw-client 的 pollAsyncTaskAsFallback）。
 */
export async function pollRightApiTaskById(
  taskId: string,
  req: Pick<RightApiImageRequest, 'baseUrl' | 'apiKey' | 'signal'>,
): Promise<ExtractedImagePayload> {
  const url = buildRightApiTaskUrl(req.baseUrl, taskId)
  const deadline = Date.now() + POLL_TOTAL_TIMEOUT_MS
  let interval = POLL_INTERVAL_START_MS
  let attempt = 0
  let lastProgress = -1

  while (true) {
    await delay(interval, req.signal)
    attempt += 1

    if (Date.now() > deadline) {
      throw Object.assign(
        new Error(`RightAPI 生图超时（已等待 ${Math.round(POLL_TOTAL_TIMEOUT_MS / 1000)}s，task_id=${taskId}）`),
        { code: 'PROVIDER_TIMEOUT' },
      )
    }

    const resp = await fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${req.apiKey}`,
          'User-Agent': UPSTREAM_USER_AGENT,
        },
      },
      req.signal,
      HTTP_TIMEOUT_MS,
    )

    const text = await resp.text()

    // 5xx 多为中转站瞬时抖动，继续轮询；4xx 视为确定性失败
    if (!resp.ok) {
      if (resp.status >= 500) {
        log.warn(`[rightapi] 查询任务 HTTP ${resp.status}，第 ${attempt} 次，继续轮询`)
        interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), POLL_INTERVAL_MAX_MS)
        continue
      }
      throw Object.assign(new Error(parseUpstreamErrorMessage(resp.status, text)), {
        code: 'PROVIDER_ERROR',
      })
    }

    let parsed: TaskQueryResponse
    try {
      parsed = text ? (JSON.parse(text) as TaskQueryResponse) : {}
    } catch {
      log.warn(`[rightapi] 查询任务响应无法解析，第 ${attempt} 次，继续轮询`)
      interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), POLL_INTERVAL_MAX_MS)
      continue
    }

    const status = parsed.status?.toLowerCase()
    if (status === 'failed' || status === 'error') {
      const msg = parsed.error?.message ?? parsed.message ?? '上游生成失败'
      throw Object.assign(new Error(`RightAPI 生图失败: ${msg}`), { code: 'PROVIDER_ERROR' })
    }

    // 结果按提交协议回译，完成时不一定带 status 字段，以能否提取到图片为准
    const payload = extractRightApiImagePayload(parsed)
    if (payload) {
      log.info(`[rightapi] 任务完成 task_id=${taskId}，轮询 ${attempt} 次`)
      return payload
    }

    if (typeof parsed.progress === 'number' && parsed.progress !== lastProgress) {
      lastProgress = parsed.progress
      log.info(`[rightapi] 任务进行中 task_id=${taskId} status=${status ?? 'unknown'} progress=${parsed.progress}%`)
    }

    if (status === 'completed') {
      throw Object.assign(
        new Error(`RightAPI 任务已完成但未返回图片（task_id=${taskId}）。响应片段: ${text.slice(0, 200)}`),
        { code: 'PROVIDER_ERROR' },
      )
    }

    interval = Math.min(Math.round(interval * POLL_BACKOFF_FACTOR), POLL_INTERVAL_MAX_MS)
  }
}

/**
 * RightAPI 异步生图：提交任务 → 轮询结果 → 下载图片。
 */
export async function generateImageViaRightApi(
  req: RightApiImageRequest,
): Promise<RightApiImageResult> {
  if (!req.apiKey?.trim()) {
    throw Object.assign(
      new Error('未配置 RightAPI Key：请在「设置 → 模型配置 → 图片生成」填写 API Key'),
      { code: 'DRAW_API_KEY_MISSING' },
    )
  }
  if (req.signal?.aborted) {
    throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
  }

  const started = Date.now()
  const { taskId, payload } = await submitRightApiTask(req)
  const resolved = payload ?? (await pollRightApiTaskById(taskId!, req))

  // 异步任务结果多为有时效的 CDN URL，必须立即下载
  const { imageBase64, mimeType } = resolved.imageBase64
    ? {
        imageBase64: resolved.imageBase64,
        mimeType: resolved.mimeType ?? ('image/png' as const),
      }
    : await downloadRightApiImage(resolved.imageUrl!, req.signal)

  log.info(
    `[rightapi] 生图完成 model=${req.modelId} 耗时=${Math.round((Date.now() - started) / 1000)}s ` +
      `大小=${Math.round(imageBase64.length * 0.75 / 1024)}KB`,
  )

  const { size } = normalizeRightApiSize(req.width, req.height)
  const [w, h] = size.split('x').map(Number) as [number, number]
  return {
    imageBase64,
    mimeType,
    width: w,
    height: h,
    revisedPrompt: resolved.revisedPrompt?.trim() || req.prompt,
    effectiveModelId: req.modelId,
  }
}
