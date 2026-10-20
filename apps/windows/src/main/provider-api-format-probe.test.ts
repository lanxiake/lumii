/**
 * API 格式探测：用 mock fetch 覆盖「Responses 404 → Completions」主路径
 */
/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeApiFormat } from './provider-api-format-probe'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('probeApiFormat', () => {
  it('Responses 404 且 Completions 可达时推荐 completions', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = String(url)
        if (path.includes('/responses')) {
          return new Response('not found', { status: 404 })
        }
        // completions：401 也算路由存在
        return new Response('unauthorized', { status: 401 })
      }),
    )

    const result = await probeApiFormat({
      baseUrl: 'https://kms.example.com',
      type: 'openai',
      apiKey: 'sk-test',
      modelId: 'qwen3.8-flash-next',
    })

    expect(result.recommended).toBe('completions')
    expect(result.responsesAvailable).toBe(false)
    expect(result.completionsAvailable).toBe(true)
  })

  it('Responses 返回 400 时视为可用并推荐 responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad request', { status: 400 })),
    )

    const result = await probeApiFormat({
      baseUrl: 'https://api.deepseek.com',
      type: 'deepseek',
      apiKey: 'sk-test',
      modelId: 'deepseek-v4-flash',
    })

    expect(result.recommended).toBe('responses')
    expect(result.responsesAvailable).toBe(true)
  })
})
