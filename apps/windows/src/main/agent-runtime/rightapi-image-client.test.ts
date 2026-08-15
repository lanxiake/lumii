/**
 * RightAPI 异步生图客户端单测
 *
 * 覆盖：URL 推导、尺寸归一化、结果提取（Images/Gemini 形状）、
 * 提交→轮询→下载完整链路、失败与中断路径。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  buildRightApiGenerationsUrl,
  buildRightApiTaskUrl,
  normalizeRightApiSize,
  extractRightApiImagePayload,
  generateImageViaRightApi,
} from './rightapi-image-client'

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')

describe('buildRightApiGenerationsUrl', () => {
  it('在 /draw/v1 后追加 images/generations', () => {
    expect(buildRightApiGenerationsUrl('https://www.rightapi.ai/draw/v1')).toBe(
      'https://www.rightapi.ai/draw/v1/images/generations',
    )
  })

  it('用户只填到 /draw 时自动补 /v1', () => {
    expect(buildRightApiGenerationsUrl('https://www.rightapi.ai/draw')).toBe(
      'https://www.rightapi.ai/draw/v1/images/generations',
    )
  })

  it('已含完整路径时不重复拼接', () => {
    const full = 'https://www.rightapi.ai/draw/v1/images/generations'
    expect(buildRightApiGenerationsUrl(full)).toBe(full)
  })

  it('忽略尾部斜杠', () => {
    expect(buildRightApiGenerationsUrl('https://www.rightapi.ai/draw/v1/')).toBe(
      'https://www.rightapi.ai/draw/v1/images/generations',
    )
  })
})

describe('buildRightApiTaskUrl', () => {
  it('剥掉 /draw 前缀，回到站点级 /v1/tasks', () => {
    expect(buildRightApiTaskUrl('https://www.rightapi.ai/draw/v1', 'task_abc')).toBe(
      'https://www.rightapi.ai/v1/tasks/task_abc',
    )
  })

  it('保留站点自身的路径前缀', () => {
    expect(buildRightApiTaskUrl('https://host.com/proxy/draw/v1', 'task_abc')).toBe(
      'https://host.com/proxy/v1/tasks/task_abc',
    )
  })

  it('从完整绘图端点也能推导', () => {
    expect(
      buildRightApiTaskUrl('https://www.rightapi.ai/draw/v1/images/generations', 'task_1'),
    ).toBe('https://www.rightapi.ai/v1/tasks/task_1')
  })
})

describe('normalizeRightApiSize', () => {
  it('缺省 1024x1024，不下发 imageSize', () => {
    expect(normalizeRightApiSize()).toEqual({ size: '1024x1024', imageSize: undefined })
  })

  it('长边超 1024 时给 2K', () => {
    expect(normalizeRightApiSize(1536, 1024)).toEqual({ size: '1536x1024', imageSize: '2K' })
  })

  it('长边超 2048 时给 4K', () => {
    expect(normalizeRightApiSize(4096, 2048).imageSize).toBe('4K')
  })
})

describe('extractRightApiImagePayload', () => {
  it('提取 Images 形状的 url', () => {
    expect(
      extractRightApiImagePayload({ data: [{ url: 'https://cdn.example.com/a.png' }] }),
    ).toEqual({ imageUrl: 'https://cdn.example.com/a.png', revisedPrompt: undefined })
  })

  it('提取 Images 形状的 b64_json 并带回 revised_prompt', () => {
    expect(
      extractRightApiImagePayload({
        data: [{ b64_json: PNG_BASE64, revised_prompt: '优化后的描述' }],
      }),
    ).toEqual({ imageBase64: PNG_BASE64, revisedPrompt: '优化后的描述' })
  })

  it('提取 Gemini 形状 parts 里的 URL 文本', () => {
    expect(
      extractRightApiImagePayload({
        candidates: [
          { content: { parts: [{ text: 'https://cdn.example.com/results/x.png' }] } },
        ],
      }),
    ).toEqual({ imageUrl: 'https://cdn.example.com/results/x.png' })
  })

  it('提取 Gemini 形状的 inlineData', () => {
    expect(
      extractRightApiImagePayload({
        candidates: [
          { content: { parts: [{ inlineData: { data: PNG_BASE64, mimeType: 'image/webp' } }] } },
        ],
      }),
    ).toEqual({ imageBase64: PNG_BASE64, mimeType: 'image/webp' })
  })

  it('处理中状态提取不到结果', () => {
    expect(
      extractRightApiImagePayload({ status: 'in_progress', progress: 45 }),
    ).toBeNull()
  })
})

/** 构造 JSON 响应 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 构造图片二进制响应 */
function imageResponse(): Response {
  return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
}

const BASE_REQ = {
  prompt: '一只戴太空头盔的橘猫',
  modelId: 'nano-banana-fast',
  baseUrl: 'https://www.rightapi.ai/draw/v1',
  apiKey: 'sk-test',
}

describe('generateImageViaRightApi', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('提交任务后轮询直到完成，并下载图片', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_1', status: 'processing', progress: 0 }))
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_1', status: 'in_progress', progress: 45 }))
      .mockResolvedValueOnce(
        jsonResponse({ created: 1782800000, data: [{ url: 'https://cdn.example.com/r.png' }] }),
      )
      .mockResolvedValueOnce(imageResponse())

    const promise = generateImageViaRightApi(BASE_REQ)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.imageBase64).toBe(PNG_BASE64)
    expect(result.mimeType).toBe('image/png')
    expect(result.effectiveModelId).toBe('nano-banana-fast')
    expect(result.revisedPrompt).toBe(BASE_REQ.prompt)

    // 第一次是提交，请求体必须带 async:true
    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(submitBody).toMatchObject({ model: 'nano-banana-fast', async: true, n: 1 })
    expect(submitBody.image).toBeUndefined()

    // 后续轮询走站点级任务地址
    expect(fetchMock.mock.calls[1][0]).toBe('https://www.rightapi.ai/v1/tasks/task_1')
    expect(fetchMock.mock.calls[2][0]).toBe('https://www.rightapi.ai/v1/tasks/task_1')
    // 最后一次是下载 CDN 图片
    expect(fetchMock.mock.calls[3][0]).toBe('https://cdn.example.com/r.png')
  })

  it('带参考图时以 data URL 数组提交', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_2' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }))

    const promise = generateImageViaRightApi({
      ...BASE_REQ,
      referenceImageDataUrls: [`data:image/png;base64,${PNG_BASE64}`],
    })
    await vi.runAllTimersAsync()
    await promise

    const submitBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(submitBody.image).toEqual([`data:image/png;base64,${PNG_BASE64}`])
  })

  it('b64_json 结果不再发起下载请求', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_3' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }))

    const promise = generateImageViaRightApi(BASE_REQ)
    await vi.runAllTimersAsync()
    await promise

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('任务 failed 时抛出上游错误信息', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_4' }))
      .mockResolvedValueOnce(
        jsonResponse({ task_id: 'task_4', status: 'failed', error: { message: '上游生成失败' } }),
      )

    const promise = generateImageViaRightApi(BASE_REQ)
    const assertion = expect(promise).rejects.toThrow('上游生成失败')
    await vi.runAllTimersAsync()
    await assertion
  })

  it('轮询遇 5xx 抖动继续重试', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: 'task_5' }))
      .mockResolvedValueOnce(new Response('<html>502 Bad gateway</html>', { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ b64_json: PNG_BASE64 }] }))

    const promise = generateImageViaRightApi(BASE_REQ)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.imageBase64).toBe(PNG_BASE64)
  })

  it('提交返回 HTML 错误页时给出可读信息而非原始 HTML', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<!DOCTYPE html><title>502: Bad gateway</title>', { status: 502 }),
    )

    const promise = generateImageViaRightApi(BASE_REQ)
    const assertion = expect(promise).rejects.toThrow(/HTTP 502/)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('缺少 API Key 时直接失败且不发请求', async () => {
    await expect(
      generateImageViaRightApi({ ...BASE_REQ, apiKey: '' }),
    ).rejects.toThrow(/未配置 RightAPI Key/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('已中断的 signal 不发起请求', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateImageViaRightApi({ ...BASE_REQ, signal: controller.signal }),
    ).rejects.toThrow('图片生成已被用户中断')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('上游忽略 async 直接返回结果时跳过轮询', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://cdn.example.com/direct.png' }] }))
      .mockResolvedValueOnce(imageResponse())

    const promise = generateImageViaRightApi(BASE_REQ)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.imageBase64).toBe(PNG_BASE64)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://cdn.example.com/direct.png')
  })

  it('未返回 task_id 时报错', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'processing' }))

    const promise = generateImageViaRightApi(BASE_REQ)
    const assertion = expect(promise).rejects.toThrow(/未返回 task_id/)
    await vi.runAllTimersAsync()
    await assertion
  })
})
