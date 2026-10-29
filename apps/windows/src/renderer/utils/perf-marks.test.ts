import { describe, it, expect, vi, afterEach } from 'vitest'

const recordEvent = vi.fn(async (_e: unknown) => ({ success: true }))

function withPerfApi(available: boolean) {
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = available
    ? { performance: { recordEvent } }
    : {}
}

async function load() {
  vi.resetModules()
  recordEvent.mockClear()
  return import('./perf-marks')
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('perf-marks', () => {
  it('超过 500ms 才上报关键交互', async () => {
    withPerfApi(true)
    const { markInteractionStart, markInteractionEnd } = await load()
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0) // 起点
      .mockReturnValueOnce(300) // 快：不上报
      .mockReturnValueOnce(1000) // 起点
      .mockReturnValueOnce(1800) // 慢：800ms，上报

    markInteractionStart('send-message')
    markInteractionEnd('send-message')
    expect(recordEvent).not.toHaveBeenCalled()

    markInteractionStart('switch-session')
    markInteractionEnd('switch-session')
    expect(recordEvent).toHaveBeenCalledWith({
      kind: 'renderer.interaction',
      name: 'switch-session',
      duration: 800,
    })
  })

  it('没有 perf 通道时静默，不影响业务', async () => {
    withPerfApi(false)
    const { markInteractionStart, markInteractionEnd } = await load()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(5000)
    markInteractionStart('send-message')
    expect(() => markInteractionEnd('send-message')).not.toThrow()
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('重复开始只保留最早的起点', async () => {
    withPerfApi(true)
    const { markInteractionStart, markInteractionEnd } = await load()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(4000)

    markInteractionStart('send-message')
    markInteractionStart('send-message') // 第二次不该推后起点
    markInteractionEnd('send-message')
    expect(recordEvent.mock.calls[0]![0]).toMatchObject({ duration: 4000 })
  })

  it('abortInteraction 丢弃起点且不上报', async () => {
    withPerfApi(true)
    const { markInteractionStart, markInteractionEnd, abortInteraction } = await load()
    vi.spyOn(performance, 'now').mockReturnValue(0)

    markInteractionStart('send-message')
    abortInteraction('send-message')
    markInteractionEnd('send-message')
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('没有起点时结束不报错', async () => {
    withPerfApi(true)
    const { markInteractionEnd } = await load()
    expect(() => markInteractionEnd('switch-session')).not.toThrow()
    expect(recordEvent).not.toHaveBeenCalled()
  })
})

describe('first-token 阈值单独一档', () => {
  it('5.8 秒的模型往返不算慢交互（阈值 10 秒）', async () => {
    withPerfApi(true)
    const { markInteractionStart, markInteractionEnd } = await load()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(5800)
    markInteractionStart('first-token')
    markInteractionEnd('first-token')
    expect(recordEvent).not.toHaveBeenCalled()
  })

  it('超过 10 秒才报（上游卡住 / 排队）', async () => {
    withPerfApi(true)
    const { markInteractionStart, markInteractionEnd } = await load()
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(15000)
    markInteractionStart('first-token')
    markInteractionEnd('first-token')
    expect(recordEvent).toHaveBeenCalledWith({
      kind: 'renderer.interaction',
      name: 'first-token',
      duration: 15000,
    })
  })
})
