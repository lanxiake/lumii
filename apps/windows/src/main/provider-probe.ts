/**
 * 本地 Provider 探测：拉取模型列表与连通性测试
 */

import {
  type CapabilitySlot,
  type LocalProviderConfigView,
  type ProviderType,
  PROVIDER_DEFAULT_BASE_URL,
  ensureProviderBaseUrl,
} from './provider-config.js'

export interface ListedModel {
  id: string
  name: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/**
 * 规范化 baseUrl（自动补全 /v1）
 */
function normalizeBaseUrl(baseUrl: string, type: ProviderType): string {
  return ensureProviderBaseUrl(baseUrl, type)
}

/**
 * 构造带鉴权的请求头
 */
function authHeaders(cfg: LocalProviderConfigView): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (!cfg.apiKey) return headers
  if (cfg.type === 'anthropic') {
    headers['x-api-key'] = cfg.apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (cfg.type === 'gemini') {
    // Gemini 常用 query key；头里也带一份兼容代理
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  } else {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }
  return headers
}

/**
 * 从 OpenAI 兼容 /models 响应提取 id 列表
 */
function parseOpenAiModels(json: unknown): ListedModel[] {
  const data = (json as { data?: Array<{ id?: string }> })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (typeof m?.id === 'string' ? { id: m.id, name: m.id } : null))
    .filter((m): m is ListedModel => !!m)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 拉取远端模型列表（按 Provider 类型适配端点）
 */
export async function listProviderModels(cfg: LocalProviderConfigView): Promise<ListedModel[]> {
  const base = normalizeBaseUrl(cfg.baseUrl, cfg.type)
  const headers = authHeaders(cfg)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20_000)

  try {
    if (cfg.type === 'ollama') {
      // Ollama 原生 tags；兼容 /v1/models
      const tagsUrl = base.includes('/v1') ? `${base.replace(/\/v1$/, '')}/api/tags` : `${base}/api/tags`
      try {
        const res = await fetch(tagsUrl, { signal: ctrl.signal })
        if (res.ok) {
          const json = (await res.json()) as { models?: Array<{ name?: string }> }
          const models = (json.models ?? [])
            .map((m) => (m.name ? { id: m.name, name: m.name } : null))
            .filter((m): m is ListedModel => !!m)
          if (models.length) return models
        }
      } catch {
        /* fall through to /models */
      }
    }

    if (cfg.type === 'anthropic') {
      const res = await fetch(`${base}/v1/models`, { headers, signal: ctrl.signal })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      return parseOpenAiModels(await res.json())
    }

    if (cfg.type === 'gemini') {
      const keyQ = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : ''
      const url = base.includes('generativelanguage.googleapis.com')
        ? `${base}/v1beta/models${keyQ}`
        : `${base}/models${keyQ}`
      const res = await fetch(url, { headers, signal: ctrl.signal })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const json = (await res.json()) as { models?: Array<{ name?: string; displayName?: string }> }
      return (json.models ?? [])
        .map((m) => {
          const raw = m.name?.replace(/^models\//, '') ?? ''
          if (!raw) return null
          return { id: raw, name: m.displayName || raw }
        })
        .filter((m): m is ListedModel => !!m)
    }

    // OpenAI / LM Studio / 兼容代理
    const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    return parseOpenAiModels(await res.json())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 测试指定能力槽连通性（最小请求）
 */
export async function testProviderConnection(
  slot: CapabilitySlot,
  cfg: LocalProviderConfigView,
): Promise<ProviderTestResult> {
  if (!cfg.enabled) {
    return { ok: false, message: '请先启用该能力槽' }
  }
  if (!cfg.modelId?.trim()) {
    return { ok: false, message: '请填写模型 ID' }
  }
  const isLocal = cfg.type === 'ollama' || cfg.type === 'lmstudio'
  if (!isLocal && !cfg.apiKey?.trim()) {
    return { ok: false, message: '请填写 API Key' }
  }

  const started = Date.now()
  const base = normalizeBaseUrl(cfg.baseUrl, cfg.type)
  const headers = authHeaders(cfg)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30_000)

  try {
    if (slot === 'image') {
      // 生图：优先拉模型列表验证鉴权；失败再尝试 images/generations 干跑提示
      try {
        const models = await listProviderModels(cfg)
        const latencyMs = Date.now() - started
        if (models.length > 0) {
          return {
            ok: true,
            message: `连接成功，已发现 ${models.length} 个模型（耗时 ${latencyMs}ms）`,
            latencyMs,
          }
        }
      } catch {
        /* continue */
      }
      // OpenAI Images 轻量校验：发极小请求可能扣费，改为 GET models 已失败时再测 chat
      const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal })
      const latencyMs = Date.now() - started
      if (res.ok) {
        return { ok: true, message: `连接成功（耗时 ${latencyMs}ms）`, latencyMs }
      }
      const body = (await res.text()).slice(0, 180)
      return { ok: false, message: `连接失败 HTTP ${res.status}: ${body}`, latencyMs }
    }

    // chat / vision：发最短 completion
    if (cfg.type === 'anthropic') {
      const res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: JSON.stringify({
          model: cfg.modelId,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        return {
          ok: false,
          message: `连接失败 HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`,
          latencyMs,
        }
      }
      return { ok: true, message: `连接成功（耗时 ${latencyMs}ms）`, latencyMs }
    }

    if (cfg.type === 'gemini') {
      const keyQ = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : ''
      const url = base.includes('generativelanguage.googleapis.com')
        ? `${base}/v1beta/models/${encodeURIComponent(cfg.modelId)}:generateContent${keyQ}`
        : `${base}/chat/completions`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: ctrl.signal,
        body: base.includes('generativelanguage.googleapis.com')
          ? JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] })
          : JSON.stringify({
              model: cfg.modelId,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 16,
            }),
      })
      const latencyMs = Date.now() - started
      if (!res.ok) {
        return {
          ok: false,
          message: `连接失败 HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`,
          latencyMs,
        }
      }
      return { ok: true, message: `连接成功（耗时 ${latencyMs}ms）`, latencyMs }
    }

    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.modelId,
        messages: [{ role: 'user', content: slot === 'vision' ? 'ping' : 'ping' }],
        max_tokens: 16,
      }),
    })
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return {
        ok: false,
        message: `连接失败 HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`,
        latencyMs,
      }
    }
    return { ok: true, message: `连接成功（耗时 ${latencyMs}ms）`, latencyMs }
  } catch (err) {
    const latencyMs = Date.now() - started
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `连接失败: ${msg}`, latencyMs }
  } finally {
    clearTimeout(timer)
  }
}
