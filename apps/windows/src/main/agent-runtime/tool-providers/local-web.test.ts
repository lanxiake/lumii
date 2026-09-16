import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyFetchError, fetchLocal, isProxyWorthTrying } from './local-web'

/**
 * 把代理交给这个 mock 控制。
 *
 * 不 mock 的话，`fetchLocal` 的失败路径会去**真实探测本机代理**（环境变量 → 注册表 →
 * 常见端口），单测就变成联网测试了：慢、不确定、还会因为别人机器上的端口不同而飘。
 * 这里只切断 IO，不改被验的行为——「什么时候该试代理」仍由真实的 `isProxyWorthTrying` 决定。
 */
const retryViaLocalProxyMock = vi.fn(
  async (..._args: unknown[]): Promise<{ status: number; body: string; via: string } | null> => null,
)
vi.mock('./local-proxy', () => ({
  retryViaLocalProxy: (...args: unknown[]) => retryViaLocalProxyMock(...args),
}))

/** 复刻 undici 真实的错误形状：message 永远是 "fetch failed"，原因挂在 cause 上 */
function undiciError(cause: unknown): Error {
  const err = new Error('fetch failed')
  ;(err as { cause?: unknown }).cause = cause
  return err
}

describe('classifyFetchError', () => {
  it('从 cause 的 code 读出真实原因（而不是只说 fetch failed）', () => {
    const err = undiciError(
      Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT', name: 'ConnectTimeoutError' }),
    )
    expect(classifyFetchError(err)).toBe('连接超时（10 秒内没建立起连接）（UND_ERR_CONNECT_TIMEOUT）')
  })

  it('认得常见的连接层错误码', () => {
    const cases: Array<[string, string]> = [
      ['ECONNRESET', '连接被重置'],
      ['ECONNREFUSED', '连接被拒绝'],
      ['ENOTFOUND', '域名解析不到'],
      ['CERT_HAS_EXPIRED', '证书已过期'],
    ]
    for (const [code, hint] of cases) {
      expect(classifyFetchError(undiciError(Object.assign(new Error(''), { code })))).toContain(hint)
    }
  })

  it('AggregateError 的 errors[] 也要挖（DNS 失败常走这条）', () => {
    const agg = Object.assign(new Error(''), {
      errors: [Object.assign(new Error(''), { code: 'ENOTFOUND' })],
    })
    expect(classifyFetchError(undiciError(agg))).toContain('域名解析不到')
  })

  it('表里没有的码原样带出来，仍比 fetch failed 有信息量', () => {
    const err = undiciError(Object.assign(new Error(''), { code: 'WEIRD_CODE' }))
    expect(classifyFetchError(err)).toBe('网络请求失败（WEIRD_CODE）')
  })

  it('完全没有可挖信息时，至少不谎称知道原因', () => {
    expect(classifyFetchError(new Error('fetch failed'))).toBe('网络请求失败（fetch failed）')
  })

  it('超时/中止优先于码表（宿主与调用方都用 AbortSignal）', () => {
    expect(classifyFetchError(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))).toBe(
      '请求超时（已中止）',
    )
    expect(classifyFetchError(Object.assign(new Error(''), { name: 'TimeoutError' }))).toBe('请求超时（已中止）')
  })

  it('null 不抛异常', () => {
    expect(classifyFetchError(null)).toBe('网络请求失败（未知错误）')
  })
})

describe('fetchLocal · 重试策略', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('连接层就建不起来时不重试（实测重试对同一目标 4 次结果完全一致）', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      })
    }) as typeof fetch

    const result = await fetchLocal('https://blocked.example/x')

    expect(calls).toBe(1)
    expect(result.status).toBe(0)
    expect(result.body).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('已经拿到响应、读正文时才断掉，仍然重试一次（这种可能是真抖动）', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return {
        status: 200,
        text: async () => {
          throw Object.assign(new Error('terminated'), { cause: { code: 'ECONNRESET' } })
        },
      }
    }) as unknown as typeof fetch

    const result = await fetchLocal('https://flaky.example/x')

    expect(calls).toBe(2)
    expect(result.status).toBe(0)
    expect(result.body).toContain('连接被重置')
  }, 15_000)

  it('重试时不再把 URL 重复塞进 body（调用方本来就知道 URL）', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error(''), { code: 'ENOTFOUND' }),
      })
    }) as typeof fetch

    const result = await fetchLocal('https://nope.example/very/long/path')

    expect(result.body).not.toContain('https://nope.example')
  })
})

describe('isProxyWorthTrying', () => {
  it('连接层失败与按 IP 的拦截/限流值得换出口', () => {
    // 0 = 连接层就没成功——本次要解决的主要对象（76% 的 web_fetch 失败是这一类）
    expect(isProxyWorthTrying(0)).toBe(true)
    expect(isProxyWorthTrying(403)).toBe(true)
    expect(isProxyWorthTrying(451)).toBe(true)
    expect(isProxyWorthTrying(429)).toBe(true)
  })

  it('换出口改变不了的失败不试（省一次无谓的往返）', () => {
    expect(isProxyWorthTrying(404)).toBe(false) // 页面不存在，换个 IP 也不会凭空出现
    expect(isProxyWorthTrying(410)).toBe(false)
    expect(isProxyWorthTrying(401)).toBe(false) // 缺凭据，与走哪条线路无关
    expect(isProxyWorthTrying(200)).toBe(false)
  })

  it('5xx 不试：那是服务器回的，说明我们已经连上它了', () => {
    expect(isProxyWorthTrying(500)).toBe(false)
    expect(isProxyWorthTrying(503)).toBe(false)
  })
})

describe('fetchLocal · 直连失败后经本机代理', () => {
  const realFetch = globalThis.fetch

  const throwConnectTimeout = (): void => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error(''), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      })
    }) as typeof fetch
  }
  const respond = (status: number, body: string): void => {
    globalThis.fetch = (async () => ({ status, text: async () => body })) as unknown as typeof fetch
  }

  beforeEach(() => retryViaLocalProxyMock.mockClear())
  afterEach(() => {
    globalThis.fetch = realFetch
    retryViaLocalProxyMock.mockReset()
    retryViaLocalProxyMock.mockResolvedValue(null)
  })

  it('直连连接层失败 → 经代理取回的内容被当作结果返回', async () => {
    throwConnectTimeout()
    retryViaLocalProxyMock.mockResolvedValue({ status: 200, body: '经代理取到了', via: '测试代理' })

    const result = await fetchLocal('https://blocked.example/x')

    expect(result).toEqual({ status: 200, body: '经代理取到了' })
    expect(retryViaLocalProxyMock).toHaveBeenCalledTimes(1)
    expect(retryViaLocalProxyMock.mock.calls[0][0]).toBe('https://blocked.example/x')
  })

  it('代理也拿不到时，返回的是**直连**的错误（不是代理的）', async () => {
    throwConnectTimeout()
    retryViaLocalProxyMock.mockResolvedValue(null)

    const result = await fetchLocal('https://blocked.example/x')

    expect(result.status).toBe(0)
    expect(result.body).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('代理拿回一个 404 也照实返回——那是真实答案，比「连接超时」有用', async () => {
    throwConnectTimeout()
    retryViaLocalProxyMock.mockResolvedValue({ status: 404, body: 'Not Found', via: '测试代理' })

    const result = await fetchLocal('https://blocked.example/x')

    expect(result).toEqual({ status: 404, body: 'Not Found' })
  })

  it('403 也走代理（常见的按 IP / 地区拦截）', async () => {
    respond(403, 'Forbidden')
    retryViaLocalProxyMock.mockResolvedValue({ status: 200, body: '过了', via: '测试代理' })

    expect(await fetchLocal('https://geo.example/x')).toEqual({ status: 200, body: '过了' })
  })

  it('404 完全不碰代理（换出口改变不了「页面不存在」）', async () => {
    respond(404, 'Not Found')
    retryViaLocalProxyMock.mockResolvedValue({ status: 200, body: '不该走到这', via: '测试代理' })

    expect(await fetchLocal('https://x.example/missing')).toEqual({ status: 404, body: 'Not Found' })
    expect(retryViaLocalProxyMock).not.toHaveBeenCalled()
  })

  it('直连成功时一次都不碰代理', async () => {
    respond(200, '好的')
    expect(await fetchLocal('https://ok.example/')).toEqual({ status: 200, body: '好的' })
    expect(retryViaLocalProxyMock).not.toHaveBeenCalled()
  })
})
