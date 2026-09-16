import { describe, expect, it } from 'vitest'
import { classifyFetchError } from './local-web'

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
