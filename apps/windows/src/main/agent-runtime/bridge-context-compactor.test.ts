/**
 * BridgeContextCompactor.callLLM：无 Agent 实例时须能走 fallback stream。
 * 覆盖定时任务 / companion workflow 在无人会话打开时仍需单次 LLM 的场景。
 */
import { describe, expect, it, vi } from 'vitest'
import { BridgeContextCompactor } from './bridge-context-compactor'

/** 构造最小 deps，默认全部 stream getter 返回空 */
function makeDeps(overrides: Partial<ConstructorParameters<typeof BridgeContextCompactor>[0]> = {}) {
  return {
    getConversationRepo: () => null,
    getInstanceStream: () => undefined,
    getMainInnerStream: () => null,
    getMainModel: () => null,
    getDb: () => ({ prepare: () => ({ all: () => [], run: () => undefined }) }) as never,
    ipcChannel: { forwardIpcEvent: vi.fn() } as never,
    restoreHistoryForInstance: vi.fn(),
    createSummaryGenerator: vi.fn(),
    ...overrides,
  }
}

describe('BridgeContextCompactor.callLLM', () => {
  it('无任何 Agent 实例 stream 时抛出明确错误', async () => {
    const compactor = new BridgeContextCompactor(makeDeps())
    await expect(compactor.callLLM('写综述', undefined, 'news_digest')).rejects.toThrow(
      /没有可用的 Agent 实例 stream/,
    )
  })

  it('无实例时走 getFallbackStream，仍可完成单次 LLM 调用', async () => {
    const fallbackStream = vi.fn(async () => {
      return (async function* () {
        yield { type: 'text_delta' as const, delta: '趋势是本地优先。' }
      })()
    })
    const model = { id: 'deepseek-v4-flash', api: 'openai' } as never

    const compactor = new BridgeContextCompactor(
      makeDeps({
        getFallbackStream: () => ({ innerStream: fallbackStream as never, model }),
      }),
    )

    const text = await compactor.callLLM('写综述', undefined, 'news_digest')
    expect(text).toBe('趋势是本地优先。')
    expect(fallbackStream).toHaveBeenCalledOnce()
    expect(fallbackStream.mock.calls[0]?.[2]).toMatchObject({ purpose: 'news_digest' })
  })

  it('有主实例 stream 时优先用主实例，不调用 fallback', async () => {
    const mainStream = vi.fn(async () => {
      return (async function* () {
        yield { type: 'text_delta' as const, delta: '来自主实例' }
      })()
    })
    const fallbackStream = vi.fn()

    const compactor = new BridgeContextCompactor(
      makeDeps({
        getMainInnerStream: () => mainStream as never,
        getMainModel: () => ({ id: 'main-model', api: 'openai' }) as never,
        getFallbackStream: () => ({
          innerStream: fallbackStream as never,
          model: { id: 'fb', api: 'openai' } as never,
        }),
      }),
    )

    await expect(compactor.callLLM('hi')).resolves.toBe('来自主实例')
    expect(fallbackStream).not.toHaveBeenCalled()
  })
})
