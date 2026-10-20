/**
 * 探测 OpenAI 兼容端点是否支持 Responses API。
 *
 * New API / One API 等中转多数只实现 /v1/chat/completions；对 /v1/responses
 * 直接 404。用「轻量 POST + 看状态码」区分「路由不存在」与「路由在但参数/鉴权不对」。
 */

import {
  ensureProviderBaseUrl,
  type ApiFormat,
  type LocalProviderConfigView,
  type ProviderType,
} from './provider-config.js'

export interface ApiFormatProbeResult {
  /** 建议写入槽级的格式 */
  recommended: ApiFormat
  /** responses 路由是否存在（404 = 不存在） */
  responsesAvailable: boolean
  /** completions 路由是否可达（非网络失败） */
  completionsAvailable: boolean
  /** 给用户看的说明 */
  message: string
  latencyMs: number
}

/**
 * 判断 HTTP 状态是否表示「端点存在」（鉴权/参数错误也算存在）
 */
function routeExists(status: number): boolean {
  // 404/405/501：路由不存在或方法不允许 → 当作不支持
  if (status === 404 || status === 405 || status === 501) return false
  // 其它（含 400/401/403/422/429/5xx）都说明打到了处理器
  return status > 0
}

/**
 * 对指定 path 发一次极简 POST，返回状态码；网络失败返回 0
 */
async function probePost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
    // 消费一点 body，避免部分网关挂起连接
    void res.text().catch(() => undefined)
    return res.status
  } catch {
    return 0
  }
}

/**
 * 探测 baseUrl 对 completions / responses 的支持情况，给出推荐 apiFormat。
 *
 * 规则：responses 不可用且 completions 可用 → completions；
 * responses 可用 → 保留/推荐 responses（官方 DeepSeek 等）；
 * 两边都失败 → 回退 completions（中转最常见）。
 */
export async function probeApiFormat(
  cfg: Pick<LocalProviderConfigView, 'baseUrl' | 'type' | 'apiKey' | 'modelId'>,
): Promise<ApiFormatProbeResult> {
  const started = Date.now()
  const type = cfg.type as ProviderType
  const base = ensureProviderBaseUrl(cfg.baseUrl, type)
  const model = (cfg.modelId?.trim() || 'gpt-4o-mini').slice(0, 128)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (cfg.apiKey?.trim()) {
    headers.Authorization = `Bearer ${cfg.apiKey.trim()}`
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const [completionsStatus, responsesStatus] = await Promise.all([
      probePost(
        `${base}/chat/completions`,
        headers,
        {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        },
        ctrl.signal,
      ),
      probePost(
        `${base}/responses`,
        headers,
        {
          model,
          input: 'ping',
          max_output_tokens: 1,
        },
        ctrl.signal,
      ),
    ])

    const completionsAvailable = routeExists(completionsStatus)
    const responsesAvailable = routeExists(responsesStatus)
    const latencyMs = Date.now() - started

    if (responsesAvailable) {
      return {
        recommended: 'responses',
        responsesAvailable: true,
        completionsAvailable,
        message: `探测到 Responses 可用（HTTP ${responsesStatus}），建议用 Responses（支持缓存）`,
        latencyMs,
      }
    }
    if (completionsAvailable) {
      return {
        recommended: 'completions',
        responsesAvailable: false,
        completionsAvailable: true,
        message: `Responses 不可用（HTTP ${responsesStatus || '网络失败'}），已建议 Completions（HTTP ${completionsStatus}）`,
        latencyMs,
      }
    }
    return {
      recommended: 'completions',
      responsesAvailable: false,
      completionsAvailable: false,
      message: `两端点均未确认可用（completions=${completionsStatus || '失败'}, responses=${responsesStatus || '失败'}），默认 Completions`,
      latencyMs,
    }
  } finally {
    clearTimeout(timer)
  }
}
