/**
 * 同步生图路径的异步兜底单测
 *
 * 场景：用户把 baseUrl 指向了异步生图站点（如 RightAPI）但 Provider 类型仍选 openai。
 * 上游对 POST /v1/images/generations 立即返回 task_id 而非图片，
 * 原实现会一直同步等待直到 Cloudflare 502；现应自动转入轮询取回结果。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateImageViaRightCodesDraw } from './right-codes-draw-client'

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('generateImageViaRightCodesDraw 异步兜底', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  // 这里不用 fake timers：loadDrawConfig 会做真实 fs 读取，
  // fake timers 不会等待该 macrotask，导致轮询定时器无人推进而挂死。
  // 首次轮询间隔仅 1.5s，用真实计时器更稳。
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL = 'https://www.rightapi.ai/draw/v1'
    process.env.MTBOT_IMAGE_UPSTREAM_API_KEY = 'sk-test'
    delete process.env.MTBOT_DRAW_API_KEY
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL
    delete process.env.MTBOT_IMAGE_UPSTREAM_API_KEY
  })

  it('上游返回 task_id 时转入轮询而非同步等待', async () => {
    fetchMock
      // POST images/generations → 只回 task_id
      .mockResolvedValueOnce(
        jsonResponse({
          task_id: 'task_fallback_1',
          status: 'processing',
          progress: 0,
          message: '任务还在处理中',
        }),
      )
      // 轮询站点级任务地址 → 完成
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }))

    const result = await generateImageViaRightCodesDraw({
      prompt: '一只可爱的中国龙',
      modelId: 'gpt-image-2',
      width: 1024,
      height: 1024,
    })

    expect(result.imageBase64).toBe(PNG_BASE64)
    expect(result.effectiveModelId).toBe('gpt-image-2')
    // 轮询必须打到站点级 /v1/tasks（不带 /draw）
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://www.rightapi.ai/v1/tasks/task_fallback_1',
    )
  })

  it('同步返回图片时不触发轮询（原有行为不变）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ b64_json: PNG_BASE64, revised_prompt: '优化描述' }] }),
    )

    const result = await generateImageViaRightCodesDraw({
      prompt: '一只猫',
      modelId: 'gpt-image-2',
    })

    expect(result.imageBase64).toBe(PNG_BASE64)
    expect(result.revisedPrompt).toBe('优化描述')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
