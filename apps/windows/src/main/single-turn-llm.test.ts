/**
 * 单轮 LLM：正常返回 / 取消 / 超时 / 无模型 / 空输出。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Model } from '@earendil-works/pi-ai/compat'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { SingleTurnLlmService, type SingleTurnStream } from './single-turn-llm'

const MODEL = { id: 'fake-model' } as unknown as Model<any>

function streamOnce(text: string): SingleTurnStream {
  const streamFn = (async () =>
    (async function* () {
      yield { type: 'text_delta', delta: text }
    })()) as unknown as StreamFn
  return { streamFn, model: MODEL }
}

function streamUntilAborted(): SingleTurnStream {
  const streamFn = (async (
    _model: unknown,
    _context: unknown,
    options: { signal?: AbortSignal },
  ) =>
    (async function* () {
      // 取消可能发生在生成器开始迭代之前（同 requestId 重入）：先查一次
      if (options.signal?.aborted) throw new Error('aborted')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000)
        options.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
      yield { type: 'text_delta', delta: 'late' }
    })()) as unknown as StreamFn
  return { streamFn, model: MODEL }
}

describe('SingleTurnLlmService', () => {
  it('返回完整文本', async () => {
    const service = new SingleTurnLlmService({ resolveStream: () => streamOnce('Hello') })
    const result = await service.run({ requestId: 'r1', prompt: 'rewrite this', purpose: 'artifact-edit' })
    expect(result).toEqual({ ok: true, text: 'Hello' })
    expect(service.activeCount).toBe(0)
  })

  it('按 requestId 取消', async () => {
    const service = new SingleTurnLlmService({ resolveStream: () => streamUntilAborted() })
    const promise = service.run({ requestId: 'r2', prompt: 'x', purpose: 'artifact-edit' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(service.abort('r2')).toBe(true)
    const result = await promise
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(service.activeCount).toBe(0)
  })

  it('超时按取消返回可读错误', async () => {
    const service = new SingleTurnLlmService({ resolveStream: () => streamUntilAborted() })
    const result = await service.run({
      requestId: 'r3',
      prompt: 'x',
      purpose: 'artifact-edit',
      timeoutMs: 10,
    })
    expect(result).toMatchObject({ ok: false, cancelled: true })
    if (!result.ok) expect(result.error).toContain('没有响应')
  })

  it('没有可用模型 / 空输出都给可读错误', async () => {
    const noModel = new SingleTurnLlmService({ resolveStream: () => undefined })
    expect(await noModel.run({ requestId: 'r4', prompt: 'x', purpose: 'p' })).toMatchObject({
      ok: false,
    })

    const empty = new SingleTurnLlmService({ resolveStream: () => streamOnce('') })
    expect(await empty.run({ requestId: 'r5', prompt: 'x', purpose: 'p' })).toMatchObject({
      ok: false,
    })
  })

  it('取消先于 run 到达也生效（读文件期间点了取消）', async () => {
    const streamFn = vi.fn() as unknown as StreamFn
    const service = new SingleTurnLlmService({ resolveStream: () => ({ streamFn, model: MODEL }) })
    expect(service.abort('early')).toBe(true)
    const result = await service.run({ requestId: 'early', prompt: 'x', purpose: 'p' })
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(streamFn).not.toHaveBeenCalled()
    expect(service.activeCount).toBe(0)
  })

  it('同 requestId 重入会先取消旧请求', async () => {
    let calls = 0
    const service = new SingleTurnLlmService({
      resolveStream: () => (++calls === 1 ? streamUntilAborted() : streamOnce('second wins')),
    })
    const first = service.run({ requestId: 'same', prompt: 'x', purpose: 'p' })
    const second = service.run({ requestId: 'same', prompt: 'y', purpose: 'p' })
    const [a, b] = await Promise.all([first, second])
    expect(a).toMatchObject({ ok: false, cancelled: true })
    expect(b).toEqual({ ok: true, text: 'second wins' })
    expect(service.activeCount).toBe(0)
  })
})
