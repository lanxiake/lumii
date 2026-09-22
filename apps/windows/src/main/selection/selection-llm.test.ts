import { describe, expect, it, vi } from 'vitest'
import { SelectionLlmService, type SelectionChatStream } from './selection-llm'
import type { SelectionLlmAction } from '../../shared/selection-llm-types'

vi.mock('../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

/** 一个可控的假 stream：先吐 chunk，然后等 signal 或自行结束 */
function makeStream(options: { chunks: string[]; error?: string; neverEnds?: boolean }): {
  stream: SelectionChatStream
  aborted: () => boolean
} {
  let signalSeen: AbortSignal | undefined

  const streamFn = (async (_model: unknown, _context: unknown, opts: unknown) => {
    const signal = (opts as { signal?: AbortSignal })?.signal
    signalSeen = signal
    return (async function* () {
      for (const chunk of options.chunks) {
        yield { type: 'text_delta', delta: chunk }
      }
      if (options.error) yield { type: 'error', message: options.error }
      if (options.neverEnds) {
        // 挂住直到 signal 被触发，模拟端点排队中
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) return reject(new Error('aborted'))
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
    })()
  }) as unknown as SelectionChatStream['streamFn']

  return {
    stream: { streamFn, model: { id: 'fake' } as never },
    aborted: () => signalSeen?.aborted ?? false,
  }
}

function makeService(stream: SelectionChatStream | undefined): SelectionLlmService {
  return new SelectionLlmService({ resolveChatStream: () => stream })
}

const REQ = { requestId: 'r1', action: 'translate' as SelectionLlmAction, text: 'hello world' }

describe('SelectionLlmService', () => {
  it('正常返回累积的文本（首尾空白已裁）', async () => {
    const { stream } = makeStream({ chunks: ['  你好', '世界  '] })
    const result = await makeService(stream).run(REQ)
    expect(result).toEqual({ ok: true, text: '你好世界' })
  })

  it('空文本直接拒，不发起调用', async () => {
    const resolveChatStream = vi.fn()
    const service = new SelectionLlmService({ resolveChatStream })
    expect(await service.run({ ...REQ, text: '   ' })).toEqual({
      ok: false,
      error: '没有可处理的文本',
    })
    expect(resolveChatStream).not.toHaveBeenCalled()
  })

  it('超长文本拒（不截断 —— 截断后的翻译是错的）', async () => {
    const { stream } = makeStream({ chunks: ['x'] })
    const result = await makeService(stream).run({ ...REQ, text: 'a'.repeat(4001) })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('4001')
  })

  it('未配置模型时给可读错误', async () => {
    const result = await makeService(undefined).run(REQ)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('文本模型')
  })

  it('模型无输出时不是「成功但空白」', async () => {
    const { stream } = makeStream({ chunks: ['   '] })
    const result = await makeService(stream).run(REQ)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('没有返回内容')
  })

  it('流内 error 事件转成失败结果', async () => {
    const { stream } = makeStream({ chunks: [], error: 'rate limited' })
    const result = await makeService(stream).run(REQ)
    expect(result).toEqual({ ok: false, error: '模型返回错误：rate limited' })
  })

  it('abort 掐断在飞请求，结果是「已取消」而不是失败', async () => {
    const { stream, aborted } = makeStream({ chunks: [], neverEnds: true })
    const service = makeService(stream)
    const pending = service.run(REQ)
    // 等 stream 真的挂上去
    await new Promise((r) => setTimeout(r, 0))
    expect(service.activeCount).toBe(1)
    expect(service.abort(REQ.requestId)).toBe(true)
    const result = await pending
    expect(aborted()).toBe(true)
    expect(result).toEqual({ ok: false, error: '已取消' })
    expect(service.activeCount).toBe(0)
  })

  it('abort 不在飞的 id 返回 false，不抛', async () => {
    const { stream } = makeStream({ chunks: ['x'] })
    const service = makeService(stream)
    expect(service.abort('never-existed')).toBe(false)
  })

  it('完成后不再占着 active（重复 abort 返回 false）', async () => {
    const { stream } = makeStream({ chunks: ['ok'] })
    const service = makeService(stream)
    await service.run(REQ)
    expect(service.activeCount).toBe(0)
    expect(service.abort(REQ.requestId)).toBe(false)
  })
})
