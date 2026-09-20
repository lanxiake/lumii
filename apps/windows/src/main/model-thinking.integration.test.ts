/**
 * 端到端回归：思考开关 → 请求体
 *
 * 真起一个本地假端点，走真实的 resolveModelThinking + createDirectStreamFn，
 * 抓 pi-ai 实际发出的请求体。这是「思考开关失效」缺陷的回归防线：
 * 此前 model.reasoning 恒为 false，开关怎么切请求体都不变。
 *
 * `@vitest-environment node`：pi-ai 内部走 undici 的 globalThis.fetch，而 jsdom 的
 * AbortSignal 过不了 undici 的跨 realm 校验（`RequestInit: Expected signal
 * ("AbortSignal {}") to be an instance of AbortSignal`），表现为端点一个请求都收不到。
 * 与同目录 local-proxy.test.ts 同因，那里也是同一处 docblock。
 *
 * @vitest-environment node
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDirectStreamFn } from '@mtbot/agent-runtime'
import { resolveModelThinking, resolveReasoningOptions } from './model-thinking'
import type { LocalProviderConfigView } from './provider-config'

let server: http.Server
let port = 0
const captured: Record<string, unknown>[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        captured.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        captured.push({ raw: body })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as { port: number }).port
})

afterAll(() => {
  server.close()
})

function makeCfg(modelId: string): LocalProviderConfigView {
  return {
    enabled: true,
    type: 'openai',
    baseUrl: `http://127.0.0.1:${port}`,
    modelId,
    apiKey: 'test-key',
    allowedModelIds: [modelId],
    apiFormat: 'completions',
    modelReasoning: {},
    thinkingFormat: 'auto',
  }
}

/** 复刻 bridge wrapStreamFn 的传参：真实 resolver + resolveReasoningOptions */
async function callStream(
  cfg: LocalProviderConfigView,
  thinking: { enabled: boolean; effort: 'high' | 'max' },
): Promise<void> {
  const level = resolveReasoningOptions(thinking.effort, 'openai', cfg.baseUrl)
  const streamFn = createDirectStreamFn({
    credentials: { baseUrl: `${cfg.baseUrl}/v1`, apiKey: cfg.apiKey, apiFormat: cfg.apiFormat },
    resolveModelProfile: (modelId) => resolveModelThinking(cfg, modelId),
  })
  const options = thinking.enabled
    ? {
        reasoning: level.reasoning,
        ...(level.thinkingBudgets ? { thinkingBudgets: level.thinkingBudgets } : {}),
      }
    : { reasoning: undefined }

  const stream = await streamFn(
    { id: cfg.modelId, api: 'openai' } as never,
    { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] } as never,
    options as never,
  )
  try {
    await stream.result()
  } catch {
    // 假端点没有合法 SSE 消息体，流解析报错无所谓——请求体已发出
  }
}

describe('思考开关 → 请求体（qwen 中转，chat_template_kwargs）', () => {
  it('开思考：注入 enable_thinking=true，且不发 reasoning_effort（该端点只认 low/medium/xhigh）', async () => {
    captured.length = 0
    await callStream(makeCfg('Qwen3.8-Flash-Next'), { enabled: true, effort: 'high' })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.chat_template_kwargs).toEqual({ enable_thinking: true })
    expect(captured[0]!.reasoning_effort).toBeUndefined()
  })

  it('关思考：显式 enable_thinking=false（服务端默认开思考，不发参数关不掉）', async () => {
    captured.length = 0
    await callStream(makeCfg('Qwen3.8-Flash-Next'), { enabled: false, effort: 'high' })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(captured[0]!.reasoning_effort).toBeUndefined()
  })

  it('Max 档在中转上等同 High（不发 xhigh，避免端点 400）', async () => {
    captured.length = 0
    await callStream(makeCfg('Qwen3.8-Flash-Next'), { enabled: true, effort: 'max' })

    expect(captured[0]!.reasoning_effort).toBeUndefined()
    expect(captured[0]!.chat_template_kwargs).toEqual({ enable_thinking: true })
  })

  it('端点不支持思考的模型：不发任何思考参数', async () => {
    captured.length = 0
    await callStream(makeCfg('my-custom-model'), { enabled: true, effort: 'high' })

    expect(captured).toHaveLength(1)
    expect(captured[0]!.chat_template_kwargs).toBeUndefined()
    expect(captured[0]!.reasoning_effort).toBeUndefined()
  })
})
