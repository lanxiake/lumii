/**
 * 端到端回归：Anthropic 新模型的 adaptive thinking
 *
 * 缺陷：用户配置 claude-opus-5-5 后请求被 400 拒绝 ——
 * "claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive
 * and output_config.effort"。
 *
 * 根因：调用方传给 pi-ai 的模型只有 {id, api}，pi-ai 不知道这个模型必须走 adaptive，
 * 于是按老式 thinking:{type:'enabled',budget_tokens} 发送。能力标记在 pi-ai 内置目录里，
 * 由 direct-stream 补进模型对象。
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

function makeCfg(modelId: string, modelReasoning: Record<string, boolean>): LocalProviderConfigView {
  return {
    enabled: true,
    type: 'anthropic',
    baseUrl: `http://127.0.0.1:${port}`,
    modelId,
    apiKey: 'test-key',
    allowedModelIds: [modelId],
    modelReasoning,
    thinkingFormat: 'auto',
  }
}

/** 复刻 bridge wrapStreamFn 的传参：真实 resolver + resolveReasoningOptions */
async function callStream(cfg: LocalProviderConfigView, thinkingEnabled: boolean): Promise<void> {
  captured.length = 0
  const level = resolveReasoningOptions('high', 'anthropic-messages', cfg.baseUrl)
  const streamFn = createDirectStreamFn({
    credentials: { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey },
    resolveModelProfile: (modelId) => resolveModelThinking(cfg, modelId),
  })
  const stream = streamFn(
    { id: cfg.modelId, api: 'anthropic-messages' } as never,
    { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] } as never,
    (thinkingEnabled ? { reasoning: level.reasoning, temperature: 0.7 } : { reasoning: undefined, temperature: 0.7 }) as never,
  )
  try {
    // StreamFn 可能同步返回事件流也可能返回 Promise，先归一化成流再取结果
    const resolved = await Promise.resolve(stream)
    await resolved.result()
  } catch {
    // 假端点没有合法 SSE 消息体，流解析报错无所谓——请求体已发出
  }
}

describe('adaptive thinking 模型（claude-opus-5-5）', () => {
  it('开思考：发 thinking.type=adaptive + output_config.effort，不发 temperature', async () => {
    await callStream(makeCfg('claude-opus-5-5', { 'claude-opus-5-5': true }), true)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.thinking).toMatchObject({ type: 'adaptive' })
    expect(captured[0]!.output_config).toEqual({ effort: 'high' })
    // Opus 4.7+ 拒收非默认 temperature
    expect(captured[0]!.temperature).toBeUndefined()
  })

  it('关思考：整个省略 thinking（thinkingLevelMap.off=null，发 disabled 会 400）', async () => {
    await callStream(makeCfg('claude-opus-5-5', { 'claude-opus-5-5': false }), false)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.thinking).toBeUndefined()
    expect(captured[0]!.output_config).toBeUndefined()
  })
})

describe('不支持 adaptive 的老模型行为不变', () => {
  it('claude-sonnet-4-5 仍走 thinking.type=enabled + budget_tokens', async () => {
    await callStream(makeCfg('claude-sonnet-4-5', { 'claude-sonnet-4-5': true }), true)

    expect(captured).toHaveLength(1)
    expect(captured[0]!.thinking).toMatchObject({ type: 'enabled' })
    expect(captured[0]!.output_config).toBeUndefined()
  })
})
