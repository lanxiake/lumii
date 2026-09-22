/**
 * 气泡状态机测试
 *
 * 覆盖三件最容易出竞态的事：旧请求的响应不许覆盖新请求、换请求要掐掉上一个、
 * 关闭时要 abort 在飞的请求。这些都是「看起来对但会静默错」的地方。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SnapshotRect } from './snapshot'

const runMock = vi.fn()
const abortMock = vi.fn()

vi.mock('./selection-llm-service', () => ({
  runSelectionAction: (...args: unknown[]) => runMock(...args),
  abortSelectionAction: (...args: unknown[]) => abortMock(...args),
}))

const ANCHOR: SnapshotRect = { top: 100, left: 100, width: 200, height: 20 }

async function loadStore() {
  vi.resetModules()
  return import('./bubble-store')
}

/** 手动控制的 promise，用来制造「响应在路上」的窗口 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  runMock.mockReset()
  abortMock.mockReset()
  abortMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('bubble-store', () => {
  it('pending → done，结果为模型输出', async () => {
    runMock.mockResolvedValue({ ok: true, text: '译文' })
    const store = await loadStore()

    store.runSingleAction('translate', 'hello', ANCHOR)
    expect(store.getBubbleState()?.status).toBe('pending')

    await vi.waitFor(() => expect(store.getBubbleState()?.status).toBe('done'))
    expect(store.getBubbleState()?.result).toBe('译文')
  })

  it('失败进 error 态并带可读原因', async () => {
    runMock.mockResolvedValue({ ok: false, error: '端点排队中' })
    const store = await loadStore()

    store.runSingleAction('explain', 'text', ANCHOR)
    await vi.waitFor(() => expect(store.getBubbleState()?.status).toBe('error'))
    expect(store.getBubbleState()?.error).toBe('端点排队中')
    store.closeBubble()
  })

  it('旧请求的响应不许覆盖新请求（requestId 不匹配即丢弃）', async () => {
    const first = deferred<{ ok: boolean; text?: string }>()
    const second = deferred<{ ok: boolean; text?: string }>()
    runMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const store = await loadStore()

    store.runSingleAction('translate', '第一次', ANCHOR)
    const firstId = store.getBubbleState()!.requestId

    store.runSingleAction('explain', '第二次', ANCHOR)
    const secondId = store.getBubbleState()!.requestId
    expect(secondId).not.toBe(firstId)

    // 第一次的响应迟到
    first.resolve({ ok: true, text: '迟到的结果' })
    await first.promise
    await Promise.resolve()
    expect(store.getBubbleState()?.status).toBe('pending')

    second.resolve({ ok: true, text: '正确的结果' })
    await vi.waitFor(() => expect(store.getBubbleState()?.result).toBe('正确的结果'))
  })

  it('发新请求时掐掉上一个在飞的请求', async () => {
    runMock.mockReturnValue(deferred<{ ok: boolean }>().promise)
    const store = await loadStore()

    store.runSingleAction('translate', 'a', ANCHOR)
    const firstId = store.getBubbleState()!.requestId
    store.runSingleAction('translate', 'b', ANCHOR)

    expect(abortMock).toHaveBeenCalledWith(firstId)
  })

  it('关闭 pending 气泡会 abort 在飞请求', async () => {
    runMock.mockReturnValue(deferred<{ ok: boolean }>().promise)
    const store = await loadStore()

    store.runSingleAction('summarize', 'a', ANCHOR)
    const id = store.getBubbleState()!.requestId
    store.closeBubble()

    expect(store.getBubbleState()).toBeNull()
    expect(abortMock).toHaveBeenCalledWith(id)
  })

  it('已出结果时关闭不发 abort（请求早就结束了）', async () => {
    runMock.mockResolvedValue({ ok: true, text: 'ok' })
    const store = await loadStore()

    store.runSingleAction('polish', 'a', ANCHOR)
    await vi.waitFor(() => expect(store.getBubbleState()?.status).toBe('done'))
    store.closeBubble()

    expect(abortMock).not.toHaveBeenCalled()
  })
})
